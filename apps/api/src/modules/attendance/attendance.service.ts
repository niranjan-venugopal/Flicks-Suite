import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { eq, and, gte, lte, isNull, or, sql, desc, asc } from 'drizzle-orm';
import {
  attendanceRecords,
  attendancePunches,
  attendanceRegularizations,
  shiftTemplates,
  employeeShifts,
  employees,
  memberships,
  users,
} from '@flicks/db/schema';
import { DatabaseService } from '../../core/database/database.service';
import { DB_SERVICE_ROLE } from '../../core/database/database.module';
import type { DbAdmin } from '@flicks/db';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import type {
  PunchDto,
  RegularizationRequestDto,
  ReviewRegularizationDto,
  AttendanceListQueryDto,
} from './attendance.dto';

// ─── Time helpers ───────────────────────────────────────────────────────────

/**
 * Returns YYYY-MM-DD as observed in `tz` for the given UTC instant.
 * Uses 'sv-SE' locale because it produces ISO-8601 'YYYY-MM-DD HH:mm:ss'.
 */
function dateInTimezone(instant: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const y = parts.find((p) => p.type === 'year')!.value;
  const m = parts.find((p) => p.type === 'month')!.value;
  const d = parts.find((p) => p.type === 'day')!.value;
  return `${y}-${m}-${d}`;
}

/**
 * Returns the day-of-week (0=Sunday..6=Saturday) for a date observed in `tz`.
 */
function dayOfWeekInTimezone(instant: Date, tz: string): number {
  const wd = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
  }).format(instant);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd);
}

/**
 * Converts wall-clock time-of-day in a timezone to a UTC Date.
 * Iterates twice to converge across DST transitions.
 *
 * Example: localTimeToUTC('2026-05-08', '09:00', 'Asia/Kolkata')
 *   → Date representing 2026-05-08T03:30:00Z
 */
function localTimeToUTC(dateISO: string, hhmm: string, tz: string): Date {
  const [hh, mm] = hhmm.split(':').map(Number);
  const dtf = new Intl.DateTimeFormat('sv-SE', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  // Initial guess: pretend the local time *is* UTC.
  let guess = new Date(`${dateISO}T${hhmm}:00Z`);
  for (let i = 0; i < 2; i++) {
    const parts = dtf.formatToParts(guess);
    const observedH = parseInt(
      parts.find((p) => p.type === 'hour')!.value,
      10,
    );
    const observedM = parseInt(
      parts.find((p) => p.type === 'minute')!.value,
      10,
    );
    const targetH = hh ?? 0;
    const targetM = mm ?? 0;
    const diffMin = (targetH - observedH) * 60 + (targetM - observedM);
    if (diffMin === 0) break;
    guess = new Date(guess.getTime() + diffMin * 60_000);
  }
  return guess;
}

/**
 * Returns "minutes worked" given an array of punches in chronological order.
 * Pairs consecutive (in, out) and sums the diffs. Unmatched punches contribute
 * 0 minutes (the manager has to regularize before they count).
 */
function computeWorkedMinutes(
  punches: Array<{ punch_type: string; punched_at: Date }>,
): number {
  let total = 0;
  let openIn: Date | null = null;
  for (const p of punches) {
    if (p.punch_type === 'in') {
      openIn = p.punched_at;
    } else if (p.punch_type === 'out' && openIn) {
      total += Math.max(0, p.punched_at.getTime() - openIn.getTime());
      openIn = null;
    }
  }
  return Math.floor(total / 60_000);
}

/**
 * Sums break minutes from an array of punches. Pairs (break_start, break_end).
 */
function computeBreakMinutes(
  punches: Array<{ punch_type: string; punched_at: Date }>,
): number {
  let total = 0;
  let openBreak: Date | null = null;
  for (const p of punches) {
    if (p.punch_type === 'break_start') {
      openBreak = p.punched_at;
    } else if (p.punch_type === 'break_end' && openBreak) {
      total += Math.max(0, p.punched_at.getTime() - openBreak.getTime());
      openBreak = null;
    }
  }
  return Math.floor(total / 60_000);
}

// ─── Service ────────────────────────────────────────────────────────────────

@Injectable()
export class AttendanceService {
  private readonly logger = new Logger(AttendanceService.name);

  constructor(
    private readonly databaseService: DatabaseService,
    @Inject(DB_SERVICE_ROLE) private readonly dbAdmin: DbAdmin,
    private readonly auditService: AuditService,
    private readonly notificationsService: NotificationsService,
  ) {}

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /** Resolves the employee_id for a logged-in user inside the active tenant. */
  private async getEmployeeIdForUser(
    userId: string,
    tenantId: string,
  ): Promise<string> {
    return this.databaseService.withTenant(tenantId, async (tx) => {
      const [m] = await tx
        .select({ employeeId: memberships.employee_id })
        .from(memberships)
        .where(
          and(
            eq(memberships.user_id, userId),
            eq(memberships.tenant_id, tenantId),
          ),
        )
        .limit(1);
      if (!m?.employeeId) {
        throw new NotFoundException(
          'No employee record found for the current user',
        );
      }
      return m.employeeId;
    });
  }

  /**
   * Returns the shift_template applicable to `employeeId` on `attendanceDate`.
   * Tries employee_shifts first; falls back to the tenant's default shift.
   */
  private async resolveShiftTemplate(
    tenantId: string,
    employeeId: string,
    attendanceDate: string, // YYYY-MM-DD
  ) {
    return this.databaseService.withTenant(tenantId, async (tx) => {
      // Active employee_shifts assignment for that date
      const [assignment] = await tx
        .select({
          template: shiftTemplates,
        })
        .from(employeeShifts)
        .innerJoin(
          shiftTemplates,
          eq(employeeShifts.shift_template_id, shiftTemplates.id),
        )
        .where(
          and(
            eq(employeeShifts.tenant_id, tenantId),
            eq(employeeShifts.employee_id, employeeId),
            lte(employeeShifts.effective_from, attendanceDate),
            or(
              isNull(employeeShifts.effective_to),
              gte(employeeShifts.effective_to, attendanceDate),
            ),
          ),
        )
        .orderBy(desc(employeeShifts.effective_from))
        .limit(1);
      if (assignment?.template) return assignment.template;

      // Fallback: tenant's default shift template
      const [fallback] = await tx
        .select()
        .from(shiftTemplates)
        .where(
          and(
            eq(shiftTemplates.tenant_id, tenantId),
            eq(shiftTemplates.is_default, true),
            eq(shiftTemplates.is_active, true),
          ),
        )
        .limit(1);
      if (!fallback) {
        throw new NotFoundException(
          'No shift assignment and no default shift template configured for this tenant',
        );
      }
      return fallback;
    });
  }

  // ─── Punch flow ───────────────────────────────────────────────────────────

  async punchIn(userId: string, tenantId: string, dto: PunchDto, ip?: string) {
    const employeeId = await this.getEmployeeIdForUser(userId, tenantId);
    const now = new Date();

    // Resolve shift first so we know the timezone for "today"
    const today = dateInTimezone(now, 'Asia/Kolkata'); // bootstrap default
    const shift = await this.resolveShiftTemplate(tenantId, employeeId, today);
    const attendanceDate = dateInTimezone(now, shift.timezone);

    // Late check
    const shiftStartUTC = localTimeToUTC(
      attendanceDate,
      shift.start_time,
      shift.timezone,
    );
    const lateThreshold = new Date(
      shiftStartUTC.getTime() + shift.grace_period_minutes * 60_000,
    );
    const isLate = now > lateThreshold;
    const lateBy = isLate
      ? Math.floor((now.getTime() - shiftStartUTC.getTime()) / 60_000)
      : 0;

    const result = await this.databaseService.withTenant(
      tenantId,
      async (tx) => {
        // Check for an open punch-in (no matching out yet) — reject duplicates
        const [existing] = await tx
          .select()
          .from(attendanceRecords)
          .where(
            and(
              eq(attendanceRecords.tenant_id, tenantId),
              eq(attendanceRecords.employee_id, employeeId),
              eq(attendanceRecords.attendance_date, attendanceDate),
            ),
          )
          .limit(1);

        let recordId: string;
        if (existing) {
          // Day is already complete (both in + out logged). Reject — the
          // user has to wait until tomorrow before they can punch in again.
          // Multi-segment punches within the same day should use break_start
          // / break_end, not a fresh punch-in.
          if (
            existing.first_punch_in_at !== null &&
            existing.last_punch_out_at !== null
          ) {
            throw new ConflictException(
              "You've already clocked out for today. Come back tomorrow!",
            );
          }

          // Update first_punch_in_at only if it's null
          if (existing.first_punch_in_at === null) {
            await tx
              .update(attendanceRecords)
              .set({
                first_punch_in_at: now,
                shift_template_id: shift.id,
                is_late: isLate,
                late_by_minutes: lateBy,
                attendance_status: isLate ? 'late' : 'present',
                source: 'web',
                updated_at: new Date(),
              })
              .where(eq(attendanceRecords.id, existing.id));
          }
          // Else: punched in earlier today but not yet out — this is a
          // re-punch (e.g. after a break that wasn't recorded properly).
          // Don't reset first_punch_in_at. The punches table below logs it.
          recordId = existing.id;
        } else {
          const [created] = await tx
            .insert(attendanceRecords)
            .values({
              tenant_id: tenantId,
              employee_id: employeeId,
              attendance_date: attendanceDate,
              shift_template_id: shift.id,
              first_punch_in_at: now,
              attendance_status: isLate ? 'late' : 'present',
              is_late: isLate,
              late_by_minutes: lateBy,
              source: 'web',
            })
            .returning();
          recordId = created!.id;
        }

        // Insert the punch row
        const [punch] = await tx
          .insert(attendancePunches)
          .values({
            tenant_id: tenantId,
            attendance_record_id: recordId,
            employee_id: employeeId,
            punch_type: 'in',
            punched_at: now,
            source: 'web',
            ip_address: ip ?? null,
            geo_lat: dto.lat ?? null,
            geo_lng: dto.lng ?? null,
            geo_accuracy_m: dto.accuracy ?? null,
            location_id: dto.locationId ?? null,
            is_within_geofence: null, // geofence resolution deferred to Settings (PRD §6.8)
            notes: dto.notes ?? null,
          })
          .returning();

        return { record_id: recordId, punch: punch! };
      },
    );

    await this.auditService.log({
      tenantId,
      actorUserId: userId,
      action: 'attendance.punched_in',
      resourceType: 'attendance_record',
      resourceId: result.record_id,
      metadata: {
        attendanceDate,
        isLate,
        lateBy,
        timezone: shift.timezone,
      },
    });

    return {
      id: result.punch.id,
      attendanceRecordId: result.record_id,
      attendanceDate,
      punchedAt: result.punch.punched_at.toISOString(),
      type: 'in' as const,
      isLate,
      lateByMinutes: lateBy,
      shiftStart: shift.start_time,
      shiftTimezone: shift.timezone,
    };
  }

  async punchOut(userId: string, tenantId: string, dto: PunchDto, ip?: string) {
    const employeeId = await this.getEmployeeIdForUser(userId, tenantId);
    const now = new Date();
    const today = dateInTimezone(now, 'Asia/Kolkata');
    const shift = await this.resolveShiftTemplate(tenantId, employeeId, today);
    const attendanceDate = dateInTimezone(now, shift.timezone);

    const result = await this.databaseService.withTenant(
      tenantId,
      async (tx) => {
        const [record] = await tx
          .select()
          .from(attendanceRecords)
          .where(
            and(
              eq(attendanceRecords.tenant_id, tenantId),
              eq(attendanceRecords.employee_id, employeeId),
              eq(attendanceRecords.attendance_date, attendanceDate),
            ),
          )
          .limit(1);
        if (!record || record.first_punch_in_at === null) {
          throw new BadRequestException(
            'No punch-in recorded for today — clock in first.',
          );
        }
        if (record.last_punch_out_at !== null) {
          throw new ConflictException(
            "You've already clocked out for today. Come back tomorrow!",
          );
        }

        // Insert out punch
        const [punch] = await tx
          .insert(attendancePunches)
          .values({
            tenant_id: tenantId,
            attendance_record_id: record.id,
            employee_id: employeeId,
            punch_type: 'out',
            punched_at: now,
            source: 'web',
            ip_address: ip ?? null,
            geo_lat: dto.lat ?? null,
            geo_lng: dto.lng ?? null,
            geo_accuracy_m: dto.accuracy ?? null,
            location_id: dto.locationId ?? null,
            notes: dto.notes ?? null,
          })
          .returning();

        // Recompute totals from full punch history for the record
        const allPunches = await tx
          .select({
            punch_type: attendancePunches.punch_type,
            punched_at: attendancePunches.punched_at,
          })
          .from(attendancePunches)
          .where(eq(attendancePunches.attendance_record_id, record.id))
          .orderBy(asc(attendancePunches.punched_at));

        const breakMin = computeBreakMinutes(allPunches);
        const grossMin = computeWorkedMinutes(allPunches);
        // PRD §6.4: total_worked_minutes = (out − in) summed, minus break.
        // computeWorkedMinutes already excludes break gaps because they're
        // tracked as break_start/break_end (not in/out), so subtract paid-only.
        const workedMin = shift.break_paid ? grossMin : grossMin - breakMin;

        // Determine attendance_status from worked minutes
        let status: 'present' | 'absent' | 'half_day' | 'late' =
          record.attendance_status as 'present' | 'absent' | 'half_day' | 'late';
        if (workedMin >= shift.full_day_threshold_minutes) {
          status = record.is_late ? 'late' : 'present';
        } else if (workedMin >= shift.half_day_threshold_minutes) {
          status = 'half_day';
        } else if (workedMin > 0) {
          status = 'half_day';
        } else {
          status = 'absent';
        }

        // Early departure
        const shiftEndUTC = localTimeToUTC(
          attendanceDate,
          shift.end_time,
          shift.timezone,
        );
        const isEarly = now < shiftEndUTC;
        const earlyBy = isEarly
          ? Math.floor((shiftEndUTC.getTime() - now.getTime()) / 60_000)
          : 0;

        await tx
          .update(attendanceRecords)
          .set({
            last_punch_out_at: now,
            total_worked_minutes: Math.max(0, workedMin),
            total_break_minutes: breakMin,
            attendance_status: status,
            is_early_departure: isEarly,
            early_by_minutes: earlyBy,
            updated_at: new Date(),
          })
          .where(eq(attendanceRecords.id, record.id));

        return {
          punch: punch!,
          recordId: record.id,
          workedMin,
          breakMin,
          status,
          isEarly,
          earlyBy,
        };
      },
    );

    await this.auditService.log({
      tenantId,
      actorUserId: userId,
      action: 'attendance.punched_out',
      resourceType: 'attendance_record',
      resourceId: result.recordId,
      metadata: {
        attendanceDate,
        workedMin: result.workedMin,
        breakMin: result.breakMin,
        status: result.status,
      },
    });

    return {
      id: result.punch.id,
      attendanceRecordId: result.recordId,
      attendanceDate,
      punchedAt: result.punch.punched_at.toISOString(),
      type: 'out' as const,
      totalWorkedMinutes: result.workedMin,
      totalBreakMinutes: result.breakMin,
      attendanceStatus: result.status,
      isEarlyDeparture: result.isEarly,
      earlyByMinutes: result.earlyBy,
    };
  }

  async breakStart(userId: string, tenantId: string) {
    return this.recordSimplePunch(userId, tenantId, 'break_start');
  }

  async breakEnd(userId: string, tenantId: string) {
    return this.recordSimplePunch(userId, tenantId, 'break_end');
  }

  private async recordSimplePunch(
    userId: string,
    tenantId: string,
    punchType: 'break_start' | 'break_end',
  ) {
    const employeeId = await this.getEmployeeIdForUser(userId, tenantId);
    const now = new Date();
    const today = dateInTimezone(now, 'Asia/Kolkata');
    const shift = await this.resolveShiftTemplate(tenantId, employeeId, today);
    const attendanceDate = dateInTimezone(now, shift.timezone);

    return this.databaseService.withTenant(tenantId, async (tx) => {
      const [record] = await tx
        .select({ id: attendanceRecords.id })
        .from(attendanceRecords)
        .where(
          and(
            eq(attendanceRecords.tenant_id, tenantId),
            eq(attendanceRecords.employee_id, employeeId),
            eq(attendanceRecords.attendance_date, attendanceDate),
          ),
        )
        .limit(1);
      if (!record) {
        throw new BadRequestException('Punch in before starting/ending a break');
      }

      const [punch] = await tx
        .insert(attendancePunches)
        .values({
          tenant_id: tenantId,
          attendance_record_id: record.id,
          employee_id: employeeId,
          punch_type: punchType,
          punched_at: now,
          source: 'web',
        })
        .returning();

      // Recompute break_minutes if ending a break
      if (punchType === 'break_end') {
        const allPunches = await tx
          .select({
            punch_type: attendancePunches.punch_type,
            punched_at: attendancePunches.punched_at,
          })
          .from(attendancePunches)
          .where(eq(attendancePunches.attendance_record_id, record.id))
          .orderBy(asc(attendancePunches.punched_at));
        await tx
          .update(attendanceRecords)
          .set({
            total_break_minutes: computeBreakMinutes(allPunches),
            updated_at: new Date(),
          })
          .where(eq(attendanceRecords.id, record.id));
      }

      return {
        id: punch!.id,
        attendanceRecordId: record.id,
        attendanceDate,
        punchedAt: punch!.punched_at.toISOString(),
        type: punchType,
      };
    });
  }

  // ─── Today + history ──────────────────────────────────────────────────────

  async getMyToday(userId: string, tenantId: string) {
    const employeeId = await this.getEmployeeIdForUser(userId, tenantId);
    const now = new Date();
    // Use the employee's effective shift to determine "today"
    const bootDate = dateInTimezone(now, 'Asia/Kolkata');
    const shift = await this.resolveShiftTemplate(
      tenantId,
      employeeId,
      bootDate,
    );
    const attendanceDate = dateInTimezone(now, shift.timezone);

    const [record] = await this.databaseService.withTenant(tenantId, (tx) =>
      tx
        .select()
        .from(attendanceRecords)
        .where(
          and(
            eq(attendanceRecords.tenant_id, tenantId),
            eq(attendanceRecords.employee_id, employeeId),
            eq(attendanceRecords.attendance_date, attendanceDate),
          ),
        )
        .limit(1),
    );

    // Determine isOnBreak by inspecting last punch
    let isOnBreak = false;
    let lastPunchType: string | null = null;
    if (record) {
      const punches = await this.databaseService.withTenant(tenantId, (tx) =>
        tx
          .select({
            punch_type: attendancePunches.punch_type,
            punched_at: attendancePunches.punched_at,
          })
          .from(attendancePunches)
          .where(eq(attendancePunches.attendance_record_id, record.id))
          .orderBy(desc(attendancePunches.punched_at))
          .limit(1),
      );
      lastPunchType = punches[0]?.punch_type ?? null;
      isOnBreak = lastPunchType === 'break_start';
    }

    // Working day check (per shift's working_days)
    const dow = dayOfWeekInTimezone(now, shift.timezone);
    const isWorkingDay = (shift.working_days ?? []).includes(dow);

    return {
      employeeId,
      attendanceDate,
      attendanceStatus: record?.attendance_status ?? 'absent',
      firstPunchInAt: record?.first_punch_in_at?.toISOString() ?? null,
      lastPunchOutAt: record?.last_punch_out_at?.toISOString() ?? null,
      totalWorkedMinutes: record?.total_worked_minutes ?? 0,
      totalBreakMinutes: record?.total_break_minutes ?? 0,
      isLate: record?.is_late ?? false,
      lateByMinutes: record?.late_by_minutes ?? 0,
      isOnBreak,
      lastPunchType,
      shift: {
        id: shift.id,
        name: shift.name,
        startTime: shift.start_time,
        endTime: shift.end_time,
        timezone: shift.timezone,
        gracePeriodMinutes: shift.grace_period_minutes,
      },
      isWorkingDay,
      now: now.toISOString(),
    };
  }

  async listMine(
    userId: string,
    tenantId: string,
    query: AttendanceListQueryDto,
  ) {
    const employeeId = await this.getEmployeeIdForUser(userId, tenantId);
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 31, 100);
    const offset = (page - 1) * limit;

    const conditions = [
      eq(attendanceRecords.tenant_id, tenantId),
      eq(attendanceRecords.employee_id, employeeId),
    ];
    if (query.fromDate) {
      conditions.push(gte(attendanceRecords.attendance_date, query.fromDate));
    }
    if (query.toDate) {
      conditions.push(lte(attendanceRecords.attendance_date, query.toDate));
    }
    if (query.status) {
      // Cast string to enum-compatible
      conditions.push(
        eq(
          attendanceRecords.attendance_status,
          query.status as typeof attendanceRecords.$inferSelect['attendance_status'],
        ),
      );
    }

    const data = await this.databaseService.withTenant(tenantId, (tx) =>
      tx
        .select({
          id: attendanceRecords.id,
          attendanceDate: attendanceRecords.attendance_date,
          attendanceStatus: attendanceRecords.attendance_status,
          firstPunchInAt: attendanceRecords.first_punch_in_at,
          lastPunchOutAt: attendanceRecords.last_punch_out_at,
          totalWorkedMinutes: attendanceRecords.total_worked_minutes,
          totalBreakMinutes: attendanceRecords.total_break_minutes,
          isLate: attendanceRecords.is_late,
          lateByMinutes: attendanceRecords.late_by_minutes,
          isRegularized: attendanceRecords.is_regularized,
        })
        .from(attendanceRecords)
        .where(and(...conditions))
        .orderBy(desc(attendanceRecords.attendance_date))
        .limit(limit)
        .offset(offset),
    );

    return { data, pagination: { page, limit, total: data.length } };
  }

  async listTeamToday(userId: string, tenantId: string) {
    const reviewerEmployeeId = await this.getEmployeeIdForUser(
      userId,
      tenantId,
    );
    const now = new Date();
    const today = dateInTimezone(now, 'Asia/Kolkata');

    return this.databaseService.withTenant(tenantId, (tx) =>
      tx
        .select({
          employeeId: employees.id,
          employeeName: sql<string>`${employees.first_name} || ' ' || ${employees.last_name}`,
          employeeCode: employees.employee_code,
          recordId: attendanceRecords.id,
          attendanceStatus: attendanceRecords.attendance_status,
          firstPunchInAt: attendanceRecords.first_punch_in_at,
          lastPunchOutAt: attendanceRecords.last_punch_out_at,
          totalWorkedMinutes: attendanceRecords.total_worked_minutes,
          isLate: attendanceRecords.is_late,
        })
        .from(employees)
        .leftJoin(
          attendanceRecords,
          and(
            eq(attendanceRecords.employee_id, employees.id),
            eq(attendanceRecords.attendance_date, today),
          ),
        )
        .where(
          and(
            eq(employees.tenant_id, tenantId),
            eq(employees.reporting_manager_id, reviewerEmployeeId),
            eq(employees.status, 'active'),
          ),
        )
        .orderBy(employees.first_name),
    );
  }

  // ─── Regularization ───────────────────────────────────────────────────────

  async requestRegularization(
    userId: string,
    tenantId: string,
    dto: RegularizationRequestDto,
  ) {
    const employeeId = await this.getEmployeeIdForUser(userId, tenantId);

    const result = await this.databaseService.withTenant(
      tenantId,
      async (tx) => {
        // Reject duplicate pending requests for the same date
        const [existing] = await tx
          .select({ id: attendanceRegularizations.id })
          .from(attendanceRegularizations)
          .where(
            and(
              eq(attendanceRegularizations.tenant_id, tenantId),
              eq(attendanceRegularizations.employee_id, employeeId),
              eq(attendanceRegularizations.attendance_date, dto.attendanceDate),
              eq(attendanceRegularizations.status, 'pending'),
            ),
          )
          .limit(1);
        if (existing) {
          throw new BadRequestException(
            'A pending regularization already exists for this date',
          );
        }

        const [created] = await tx
          .insert(attendanceRegularizations)
          .values({
            tenant_id: tenantId,
            employee_id: employeeId,
            attendance_date: dto.attendanceDate,
            request_type: dto.requestType,
            proposed_in_time: dto.proposedInTime
              ? new Date(dto.proposedInTime)
              : null,
            proposed_out_time: dto.proposedOutTime
              ? new Date(dto.proposedOutTime)
              : null,
            reason: dto.reason,
            status: 'pending',
          })
          .returning();
        return created!;
      },
    );

    // Notify the employee's manager (best-effort)
    this.notifyManagerOfRegularization(tenantId, employeeId, result.id).catch(
      (err) =>
        this.logger.warn(`Regularization notification failed: ${err}`),
    );

    await this.auditService.log({
      tenantId,
      actorUserId: userId,
      action: 'attendance.regularization.requested',
      resourceType: 'attendance_regularization',
      resourceId: result.id,
      metadata: {
        attendanceDate: dto.attendanceDate,
        requestType: dto.requestType,
      },
    });

    return {
      id: result.id,
      attendanceDate: result.attendance_date,
      requestType: result.request_type,
      status: result.status,
      reason: result.reason,
      proposedInTime: result.proposed_in_time?.toISOString() ?? null,
      proposedOutTime: result.proposed_out_time?.toISOString() ?? null,
    };
  }

  private async notifyManagerOfRegularization(
    tenantId: string,
    employeeId: string,
    regId: string,
  ) {
    const [employee] = await this.databaseService.withTenant(tenantId, (tx) =>
      tx
        .select({
          firstName: employees.first_name,
          lastName: employees.last_name,
          managerId: employees.reporting_manager_id,
        })
        .from(employees)
        .where(eq(employees.id, employeeId))
        .limit(1),
    );
    if (!employee?.managerId) return;
    const [manager] = await this.databaseService.withTenant(tenantId, (tx) =>
      tx
        .select({
          email: employees.work_email,
          firstName: employees.first_name,
          lastName: employees.last_name,
        })
        .from(employees)
        .where(eq(employees.id, employee.managerId!))
        .limit(1),
    );
    if (!manager?.email) return;

    const [reg] = await this.databaseService.withTenant(tenantId, (tx) =>
      tx
        .select({
          attendanceDate: attendanceRegularizations.attendance_date,
          requestType: attendanceRegularizations.request_type,
          reason: attendanceRegularizations.reason,
        })
        .from(attendanceRegularizations)
        .where(eq(attendanceRegularizations.id, regId))
        .limit(1),
    );

    await this.notificationsService.sendEmail(
      'attendance-regularization-requested',
      manager.email,
      {
        managerName: `${manager.firstName} ${manager.lastName}`.trim() || 'there',
        employeeName: `${employee.firstName} ${employee.lastName}`.trim(),
        attendanceDate: reg?.attendanceDate ?? '',
        requestType: reg?.requestType,
        reason: reg?.reason ?? undefined,
      },
    );
    this.logger.log(
      `Regularization email queued to ${manager.email} (reg=${regId})`,
    );
  }

  async listPendingRegularizations(
    userId: string,
    tenantId: string,
    query: AttendanceListQueryDto,
  ) {
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, 100);
    const offset = (page - 1) * limit;

    const data = await this.databaseService.withTenant(tenantId, (tx) =>
      tx
        .select({
          id: attendanceRegularizations.id,
          employeeId: attendanceRegularizations.employee_id,
          attendanceDate: attendanceRegularizations.attendance_date,
          requestType: attendanceRegularizations.request_type,
          proposedInTime: attendanceRegularizations.proposed_in_time,
          proposedOutTime: attendanceRegularizations.proposed_out_time,
          reason: attendanceRegularizations.reason,
          createdAt: attendanceRegularizations.created_at,
          employeeName: sql<string>`${employees.first_name} || ' ' || ${employees.last_name}`,
          employeeCode: employees.employee_code,
        })
        .from(attendanceRegularizations)
        .leftJoin(
          employees,
          eq(attendanceRegularizations.employee_id, employees.id),
        )
        .where(
          and(
            eq(attendanceRegularizations.tenant_id, tenantId),
            eq(attendanceRegularizations.status, 'pending'),
          ),
        )
        .orderBy(desc(attendanceRegularizations.created_at))
        .limit(limit)
        .offset(offset),
    );

    return { data, pagination: { page, limit, total: data.length } };
  }

  async reviewRegularization(
    regularizationId: string,
    reviewerUserId: string,
    tenantId: string,
    dto: ReviewRegularizationDto,
  ) {
    const reviewerEmployeeId = await this.getEmployeeIdForUser(
      reviewerUserId,
      tenantId,
    );

    const result = await this.databaseService.withTenant(
      tenantId,
      async (tx) => {
        const [reg] = await tx
          .select()
          .from(attendanceRegularizations)
          .where(
            and(
              eq(attendanceRegularizations.id, regularizationId),
              eq(attendanceRegularizations.tenant_id, tenantId),
            ),
          )
          .limit(1);
        if (!reg) throw new NotFoundException('Regularization not found');
        if (reg.status !== 'pending') {
          throw new BadRequestException(`Cannot review a ${reg.status} request`);
        }

        const newStatus =
          dto.action === 'approve' ? ('approved' as const) : ('rejected' as const);
        const now = new Date();

        const [updated] = await tx
          .update(attendanceRegularizations)
          .set({
            status: newStatus,
            approver_id: reviewerEmployeeId,
            approver_comment: dto.comment ?? null,
            reviewed_at: now,
          })
          .where(eq(attendanceRegularizations.id, regularizationId))
          .returning();

        // On approval, back-fill the attendance_records row with proposed times
        if (dto.action === 'approve') {
          const [existing] = await tx
            .select({ id: attendanceRecords.id })
            .from(attendanceRecords)
            .where(
              and(
                eq(attendanceRecords.tenant_id, tenantId),
                eq(attendanceRecords.employee_id, reg.employee_id),
                eq(attendanceRecords.attendance_date, reg.attendance_date),
              ),
            )
            .limit(1);

          if (existing) {
            await tx
              .update(attendanceRecords)
              .set({
                first_punch_in_at: reg.proposed_in_time ?? undefined,
                last_punch_out_at: reg.proposed_out_time ?? undefined,
                is_regularized: true,
                regularization_request_id: regularizationId,
                source: 'manual',
                attendance_status: 'present',
                updated_at: now,
              })
              .where(eq(attendanceRecords.id, existing.id));
          } else {
            await tx.insert(attendanceRecords).values({
              tenant_id: tenantId,
              employee_id: reg.employee_id,
              attendance_date: reg.attendance_date,
              first_punch_in_at: reg.proposed_in_time,
              last_punch_out_at: reg.proposed_out_time,
              is_regularized: true,
              regularization_request_id: regularizationId,
              attendance_status: 'present',
              source: 'manual',
            });
          }
        }

        // Notify the requester
        const [requester] = await tx
          .select({
            firstName: employees.first_name,
            lastName: employees.last_name,
            email: employees.work_email,
          })
          .from(employees)
          .where(eq(employees.id, reg.employee_id))
          .limit(1);

        return { updated: updated!, requester };
      },
    );

    if (result.requester?.email) {
      const tpl =
        dto.action === 'approve'
          ? 'attendance-regularization-approved'
          : 'attendance-regularization-rejected';
      this.notificationsService
        .sendEmail(tpl, result.requester.email, {
          employeeName:
            `${result.requester.firstName ?? ''} ${result.requester.lastName ?? ''}`.trim(),
          attendanceDate: result.updated.attendance_date,
          comment: dto.comment,
        })
        .catch((err) =>
          this.logger.warn(`Regularization-review notification failed: ${err}`),
        );
    }

    await this.auditService.log({
      tenantId,
      actorUserId: reviewerUserId,
      action: `attendance.regularization.${result.updated.status}`,
      resourceType: 'attendance_regularization',
      resourceId: regularizationId,
      afterState: { status: result.updated.status },
      metadata: { comment: dto.comment },
    });

    return {
      id: result.updated.id,
      status: result.updated.status,
      reviewedAt: result.updated.reviewed_at?.toISOString() ?? null,
    };
  }
}
