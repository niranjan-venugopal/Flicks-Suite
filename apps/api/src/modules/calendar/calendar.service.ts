import { Injectable, Inject, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { eq, and, gte, lte, or, inArray, isNull, sql } from 'drizzle-orm';
import {
  holidays,
  leaveRequests,
  leaveTypes,
  employees,
  memberships,
} from '@flicks/db/schema';
import { DatabaseService } from '../../core/database/database.service';
import { DB_SERVICE_ROLE } from '../../core/database/database.module';
import type { DbAdmin } from '@flicks/db';

/**
 * A calendar event combining different sources into one unified shape so the
 * web UI can render holidays / leave / events without having to know about
 * each table.
 */
export interface CalendarEvent {
  id: string;
  type: 'holiday' | 'my_leave' | 'team_leave';
  title: string;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD inclusive
  status?: string;
  color?: string;
  meta?: Record<string, unknown>;
}

@Injectable()
export class CalendarService {
  constructor(
    private readonly databaseService: DatabaseService,
    @Inject(DB_SERVICE_ROLE) private readonly dbAdmin: DbAdmin,
    private readonly config: ConfigService,
  ) {}

  /**
   * Lists holidays + the caller's own leave requests (any status) + their
   * direct reports' approved leaves. The shape is intentionally flat for the
   * UI; the `type` field tells the renderer which colour/icon to use.
   */
  async listEvents(
    userId: string,
    tenantId: string,
    from: string,
    to: string,
  ): Promise<CalendarEvent[]> {
    const employeeId = await this.getEmployeeIdForUser(userId, tenantId);

    return this.databaseService.withTenant(tenantId, async (tx) => {
      // 1. Holidays in range — scoped to the viewer: company-wide rows plus
      // their own location's rows (a Chennai employee doesn't see Dubai's).
      const [viewer] = await tx
        .select({ locationId: employees.location_id })
        .from(employees)
        .where(
          and(eq(employees.id, employeeId), eq(employees.tenant_id, tenantId)),
        )
        .limit(1);
      const viewerLocationId = viewer?.locationId ?? null;
      const holidayRows = await tx
        .select({
          id: holidays.id,
          date: holidays.holiday_date,
          name: holidays.name,
          type: holidays.type,
          description: holidays.description,
        })
        .from(holidays)
        .where(
          and(
            eq(holidays.tenant_id, tenantId),
            gte(holidays.holiday_date, from),
            lte(holidays.holiday_date, to),
            viewerLocationId
              ? or(
                  isNull(holidays.location_id),
                  eq(holidays.location_id, viewerLocationId),
                )
              : isNull(holidays.location_id),
          ),
        );

      // 2. My leave requests (any status, range overlap)
      const myLeaves = await tx
        .select({
          id: leaveRequests.id,
          startDate: leaveRequests.start_date,
          endDate: leaveRequests.end_date,
          status: leaveRequests.status,
          reason: leaveRequests.reason,
          totalDays: leaveRequests.total_days,
          leaveTypeName: leaveTypes.name,
          leaveTypeCode: leaveTypes.code,
          leaveTypeColor: leaveTypes.color,
        })
        .from(leaveRequests)
        .leftJoin(leaveTypes, eq(leaveRequests.leave_type_id, leaveTypes.id))
        .where(
          and(
            eq(leaveRequests.tenant_id, tenantId),
            eq(leaveRequests.employee_id, employeeId),
            // overlap: leave starts on/before `to` and ends on/after `from`
            lte(leaveRequests.start_date, to),
            gte(leaveRequests.end_date, from),
          ),
        );

      // 3. Direct reports' approved leaves (managers see team availability)
      const teamLeaves = await tx
        .select({
          id: leaveRequests.id,
          startDate: leaveRequests.start_date,
          endDate: leaveRequests.end_date,
          status: leaveRequests.status,
          totalDays: leaveRequests.total_days,
          employeeName: sql<string>`${employees.first_name} || ' ' || ${employees.last_name}`,
          employeeId: leaveRequests.employee_id,
          leaveTypeName: leaveTypes.name,
          leaveTypeCode: leaveTypes.code,
        })
        .from(leaveRequests)
        .innerJoin(employees, eq(leaveRequests.employee_id, employees.id))
        .leftJoin(leaveTypes, eq(leaveRequests.leave_type_id, leaveTypes.id))
        .where(
          and(
            eq(leaveRequests.tenant_id, tenantId),
            eq(leaveRequests.status, 'approved'),
            eq(employees.reporting_manager_id, employeeId),
            lte(leaveRequests.start_date, to),
            gte(leaveRequests.end_date, from),
          ),
        );

      const events: CalendarEvent[] = [];

      for (const h of holidayRows) {
        events.push({
          id: `holiday:${h.id}`,
          type: 'holiday',
          title: h.name,
          startDate: h.date,
          endDate: h.date,
          color: '#ef4444',
          meta: { type: h.type, description: h.description },
        });
      }
      for (const l of myLeaves) {
        events.push({
          id: `my_leave:${l.id}`,
          type: 'my_leave',
          title: `${l.leaveTypeCode ?? 'Leave'}${l.status === 'pending' ? ' · pending' : ''}`,
          startDate: l.startDate,
          endDate: l.endDate,
          status: l.status,
          color: l.leaveTypeColor ?? '#6366f1',
          meta: { reason: l.reason, leaveTypeName: l.leaveTypeName, totalDays: l.totalDays },
        });
      }
      for (const l of teamLeaves) {
        events.push({
          id: `team_leave:${l.id}`,
          type: 'team_leave',
          title: `${l.employeeName} · ${l.leaveTypeCode ?? 'Leave'}`,
          startDate: l.startDate,
          endDate: l.endDate,
          status: l.status,
          color: '#94a3b8',
          meta: { employeeId: l.employeeId, leaveTypeName: l.leaveTypeName, totalDays: l.totalDays },
        });
      }

      return events;
    });
  }

  /**
   * Generates a stateless personal calendar feed token. The token is an HMAC
   * of `userId:tenantId` keyed by the JWT secret, so it's:
   *   • impossible to forge without the secret
   *   • stable for the lifetime of the secret
   *   • revocable globally by rotating the secret
   *   • requires no DB column
   * The user can copy the URL into Google Calendar's "From URL" subscribe.
   */
  generateIcalToken(userId: string, tenantId: string): string {
    const secret = this.config.get<string>('JWT_SECRET') ?? '';
    return crypto
      .createHmac('sha256', secret)
      .update(`ical:${userId}:${tenantId}`)
      .digest('hex')
      .slice(0, 40);
  }

  verifyIcalToken(
    userId: string,
    tenantId: string,
    token: string,
  ): boolean {
    const expected = this.generateIcalToken(userId, tenantId);
    // constant-time compare
    const a = Buffer.from(expected);
    const b = Buffer.from(token);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  /**
   * Returns the iCal feed URL for the given user/tenant.
   */
  buildIcalUrl(userId: string, tenantId: string): string {
    const apiUrl =
      this.config.get<string>('API_URL') ?? 'http://localhost:4000';
    const token = this.generateIcalToken(userId, tenantId);
    return `${apiUrl}/api/v1/calendar/me.ics?uid=${userId}&tid=${tenantId}&token=${token}`;
  }

  /**
   * Resolves a (uid, tid, token) tuple into a user — used by the iCal feed
   * endpoint which can't rely on cookies (Google Calendar / Outlook fetch
   * with no cookies).
   */
  async resolveIcalSubscriber(
    uid: string,
    tid: string,
    token: string,
  ): Promise<{ userId: string; tenantId: string; employeeId: string }> {
    if (!this.verifyIcalToken(uid, tid, token)) {
      throw new UnauthorizedException('Invalid iCal token');
    }
    // Confirm membership exists (uses admin client — RLS bypassed because we
    // can't yet establish tenant context for an unauthenticated request)
    const [m] = await this.dbAdmin
      .select({ employeeId: memberships.employee_id })
      .from(memberships)
      .where(
        and(
          eq(memberships.user_id, uid),
          eq(memberships.tenant_id, tid),
          eq(memberships.status, 'active'),
        ),
      )
      .limit(1);
    if (!m?.employeeId) {
      throw new UnauthorizedException('No active membership for this token');
    }
    return { userId: uid, tenantId: tid, employeeId: m.employeeId };
  }

  /**
   * Builds RFC 5545 iCal text for a user's holidays + own leaves over the
   * next 12 months (rolling window). Designed to be served at
   * `text/calendar; charset=utf-8` for Google Calendar to ingest.
   */
  async buildIcal(
    userId: string,
    tenantId: string,
    employeeId: string,
  ): Promise<string> {
    const today = new Date();
    const from = today.toISOString().slice(0, 10);
    const yearOut = new Date(today);
    yearOut.setFullYear(yearOut.getFullYear() + 1);
    const to = yearOut.toISOString().slice(0, 10);

    // Use admin client because RLS context can't be set without auth here.
    const [holidayRows, myLeaves] = await Promise.all([
      this.dbAdmin
        .select({
          id: holidays.id,
          date: holidays.holiday_date,
          name: holidays.name,
          description: holidays.description,
        })
        .from(holidays)
        .where(
          and(
            eq(holidays.tenant_id, tenantId),
            gte(holidays.holiday_date, from),
            lte(holidays.holiday_date, to),
          ),
        ),
      this.dbAdmin
        .select({
          id: leaveRequests.id,
          startDate: leaveRequests.start_date,
          endDate: leaveRequests.end_date,
          status: leaveRequests.status,
          reason: leaveRequests.reason,
          leaveTypeCode: leaveTypes.code,
          leaveTypeName: leaveTypes.name,
        })
        .from(leaveRequests)
        .leftJoin(leaveTypes, eq(leaveRequests.leave_type_id, leaveTypes.id))
        .where(
          and(
            eq(leaveRequests.tenant_id, tenantId),
            eq(leaveRequests.employee_id, employeeId),
            inArray(leaveRequests.status, ['approved', 'pending']),
            lte(leaveRequests.start_date, to),
            gte(leaveRequests.end_date, from),
          ),
        ),
    ]);

    return this.renderIcal(holidayRows, myLeaves, tenantId);
  }

  // ─── helpers ──────────────────────────────────────────────────────────────

  private async getEmployeeIdForUser(
    userId: string,
    tenantId: string,
  ): Promise<string> {
    const [m] = await this.dbAdmin
      .select({ employeeId: memberships.employee_id })
      .from(memberships)
      .where(
        and(
          eq(memberships.user_id, userId),
          eq(memberships.tenant_id, tenantId),
          eq(memberships.status, 'active'),
        ),
      )
      .limit(1);
    if (!m?.employeeId) {
      throw new UnauthorizedException(
        'No employee record for current user/tenant',
      );
    }
    return m.employeeId;
  }

  /** Escapes a value per RFC 5545 §3.3.11 (TEXT value type). */
  private escapeIcal(value: string): string {
    return value
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\n/g, '\\n');
  }

  private icalDate(dateISO: string): string {
    return dateISO.replace(/-/g, '');
  }

  /** Adds one day to a YYYY-MM-DD date (iCal DTEND for all-day is exclusive). */
  private addOneDay(dateISO: string): string {
    const d = new Date(`${dateISO}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  }

  private renderIcal(
    holidayRows: Array<{
      id: string;
      date: string;
      name: string;
      description: string | null;
    }>,
    leaveRows: Array<{
      id: string;
      startDate: string;
      endDate: string;
      status: string;
      reason: string | null;
      leaveTypeCode: string | null;
      leaveTypeName: string | null;
    }>,
    tenantId: string,
  ): string {
    const now = new Date();
    const dtstamp = now
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d+/, '');
    const lines: string[] = [];
    lines.push('BEGIN:VCALENDAR');
    lines.push('VERSION:2.0');
    lines.push('PRODID:-//Flicks Suite//HRMS//EN');
    lines.push('CALSCALE:GREGORIAN');
    lines.push('METHOD:PUBLISH');
    lines.push('X-WR-CALNAME:Flicks Suite — My calendar');
    lines.push(`X-WR-TIMEZONE:Asia/Kolkata`);

    for (const h of holidayRows) {
      lines.push('BEGIN:VEVENT');
      lines.push(`UID:holiday-${h.id}@flicks.${tenantId}`);
      lines.push(`DTSTAMP:${dtstamp}`);
      lines.push(`DTSTART;VALUE=DATE:${this.icalDate(h.date)}`);
      // All-day events use exclusive DTEND
      lines.push(
        `DTEND;VALUE=DATE:${this.icalDate(this.addOneDay(h.date))}`,
      );
      lines.push(`SUMMARY:🪔 ${this.escapeIcal(h.name)}`);
      if (h.description) {
        lines.push(`DESCRIPTION:${this.escapeIcal(h.description)}`);
      }
      lines.push('TRANSP:TRANSPARENT');
      lines.push('END:VEVENT');
    }

    for (const l of leaveRows) {
      lines.push('BEGIN:VEVENT');
      lines.push(`UID:leave-${l.id}@flicks.${tenantId}`);
      lines.push(`DTSTAMP:${dtstamp}`);
      lines.push(`DTSTART;VALUE=DATE:${this.icalDate(l.startDate)}`);
      lines.push(
        `DTEND;VALUE=DATE:${this.icalDate(this.addOneDay(l.endDate))}`,
      );
      const summary = `${l.leaveTypeCode ?? 'Leave'}${l.status === 'pending' ? ' (pending)' : ''}`;
      lines.push(`SUMMARY:${this.escapeIcal(summary)}`);
      const desc = [
        l.leaveTypeName ? `Type: ${l.leaveTypeName}` : null,
        l.reason ? `Reason: ${l.reason}` : null,
        `Status: ${l.status}`,
      ]
        .filter(Boolean)
        .join('\n');
      if (desc) lines.push(`DESCRIPTION:${this.escapeIcal(desc)}`);
      lines.push(
        l.status === 'approved' ? 'STATUS:CONFIRMED' : 'STATUS:TENTATIVE',
      );
      lines.push('TRANSP:OPAQUE');
      lines.push('END:VEVENT');
    }

    lines.push('END:VCALENDAR');
    // RFC 5545 line endings are CRLF.
    return lines.join('\r\n') + '\r\n';
  }
}
