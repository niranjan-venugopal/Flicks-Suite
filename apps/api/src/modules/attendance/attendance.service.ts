import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  Optional,
} from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq, and, gte, lte, isNull, notInArray, or, sql, desc, asc, inArray } from 'drizzle-orm';
import {
  attendanceRecords,
  attendancePunches,
  attendanceRegularizations,
  shiftTemplates,
  employeeShifts,
  employees,
  locations,
  memberships,
  users,
  holidays,
  leaveRequests,
  leaveTypes,
} from '@flicks/db/schema';
import { DatabaseService } from '../../core/database/database.service';
import { DB_SERVICE_ROLE } from '../../core/database/database.module';
import type { Db, DbAdmin } from '@flicks/db';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { MediaService } from '../media/media.service';
import { withSignedAvatars } from '../../core/storage/signed-avatar';
import {
  ApprovalRoutingService,
  routeStateColumns,
  shapeEscalation,
} from '../approvals/public';
import type { ReviewerCtx } from '../approvals/public';
import { alias as pgAlias } from 'drizzle-orm/pg-core';
import { addDaysISO, dateInTimezone, localTimeToUTC } from '../../core/common/time';
import { ORG_WIDE_REVIEW_ROLES } from '../approvals/public';
import {
  derivedStatus,
  pickLeaveForDate,
  resolveExpectationTx,
  resolveExpectationsTx,
} from '../../core/common/workday';
import type {
  PunchDto,
  RegularizationRequestDto,
  ReviewRegularizationDto,
  AttendanceListQueryDto,
} from './attendance.dto';

// ─── Time helpers ───────────────────────────────────────────────────────────
// Round L: dateInTimezone / dayOfWeekInTimezone / localTimeToUTC all come
// from core/common/time.ts now. The private localTimeToUTC that lived here
// corrected only the hour/minute delta, so evening wall times (≥ ~18:30 IST)
// landed on the next day — wrong late thresholds and shift ends for
// evening/overnight shifts. The web has the same port in apps/web/lib/time.ts.

/**
 * Haversine distance in metres between two WGS-84 points (PRD §6.4 step 3).
 */
function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6_371_000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
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

  /** Round L — routing (who reviews, who may act) + escalation state. */
  private readonly routing: ApprovalRoutingService;

  constructor(
    private readonly databaseService: DatabaseService,
    @Inject(DB_SERVICE_ROLE) private readonly dbAdmin: DbAdmin,
    private readonly auditService: AuditService,
    private readonly notificationsService: NotificationsService,
    // Optional so the specs that build `new AttendanceService(db, dbAdmin,
    // audit, notifications)` keep compiling; only the email deep links need it.
    @Optional() private readonly configService?: ConfigService,
    // Optional for the same reason: under Nest DI the ApprovalsModule provides
    // it; a hand-built service falls back to a routing service bound to the
    // same notifications + config it was given.
    @Optional() routing?: ApprovalRoutingService,
    // Round N: Team-today rows and the reviewer's regularization view carry
    // the person's photo (users.avatar_key needs signing). Optional + LAST
    // for the same hand-built-spec reason as configService above.
    @Optional() private readonly mediaService?: MediaService,
  ) {
    this.routing = routing ?? new ApprovalRoutingService(notificationsService, configService);
  }

  /**
   * Round N — 64 px signed avatar URL for a stored key, falling back to the
   * legacy users.avatar_url (and to it alone when built without MediaService).
   * Local SigV4 crypto — safe inside or after a tenant tx; prefer after.
   */
  private readonly signAvatar = (
    key: string | null,
    legacyUrl: string | null,
  ): Promise<string | null> =>
    this.mediaService ? this.mediaService.servedUrl(key, legacyUrl, 64) : Promise.resolve(legacyUrl);

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /** Public web origin for links in emails (no trailing slash). */
  private appUrl(): string {
    const raw =
      this.configService?.get<string>('APP_URL') ??
      process.env.APP_URL ??
      'http://localhost:3000';
    return raw.replace(/\/$/, '');
  }

  /**
   * Resolves the employee_id for a logged-in user inside the active tenant.
   *
   * SELF-HEALS when the membership has no employee bridge: workspaces that
   * start with CRM/Invoicing (or members added outside HR onboarding) have
   * `memberships.employee_id = NULL`, which used to make every attendance
   * call die with "No employee record found" — the clock-in button clicked
   * but the status never changed. Now we link an existing employee row by
   * work_email, or mint a minimal one from the user profile, so attendance
   * is never a dead end. HR can enrich the record later.
   */
  private async getEmployeeIdForUser(
    userId: string,
    tenantId: string,
  ): Promise<string> {
    const healed = await this.databaseService.withTenant(tenantId, (tx) =>
      this.getEmployeeIdForUserTx(tx, userId, tenantId),
    );
    this.logSelfHeal(tenantId, userId, healed);
    return healed.employeeId;
  }

  /**
   * Round C: hoisted out of the transaction (audit opens its own tx) and
   * detached — the self-heal is already durable; its paper trail is not
   * worth a serial round-trip on the clock-in path.
   */
  private logSelfHeal(
    tenantId: string,
    userId: string,
    healed: { employeeId: string; selfHealed: boolean; linkedExisting: boolean },
  ) {
    if (!healed.selfHealed) return;
    void this.auditService.log({
      tenantId,
      actorUserId: userId,
      action: 'attendance.employee_autolink',
      resourceType: 'employee',
      resourceId: healed.employeeId,
      metadata: { linked_existing: healed.linkedExisting },
    });
    this.logger.log(
      `attendance self-heal: ${healed.linkedExisting ? 'linked' : 'created'} employee ${healed.employeeId} for user ${userId}`,
    );
  }

  /** Tx-taking variant so punch-in/out can share ONE transaction (round C). */
  private async getEmployeeIdForUserTx(
    tx: Db,
    userId: string,
    tenantId: string,
  ): Promise<{ employeeId: string; selfHealed: boolean; linkedExisting: boolean }> {
    {
      const [m] = await tx
        .select({ membershipId: memberships.id, employeeId: memberships.employee_id })
        .from(memberships)
        .where(
          and(
            eq(memberships.user_id, userId),
            eq(memberships.tenant_id, tenantId),
          ),
        )
        .limit(1);
      if (!m) {
        throw new NotFoundException(
          'No membership found for the current user',
        );
      }
      if (m.employeeId) return { employeeId: m.employeeId, selfHealed: false, linkedExisting: false };

      const [u] = await tx
        .select({ email: users.email, fullName: users.full_name })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!u) {
        throw new NotFoundException('No user profile found');
      }

      // Prefer linking an employee HR already created with this work email.
      let employeeId: string | undefined;
      const [existing] = await tx
        .select({ id: employees.id })
        .from(employees)
        .where(and(eq(employees.tenant_id, tenantId), eq(employees.work_email, u.email)))
        .limit(1);
      if (existing) {
        employeeId = existing.id;
      } else {
        const nameParts = (u.fullName ?? u.email.split('@')[0] ?? 'Member').trim().split(/\s+/);
        const firstName = nameParts[0] || 'Member';
        const lastName = nameParts.slice(1).join(' ') || '—';
        // employee_code is unique per tenant — retry a few random suffixes.
        for (let attempt = 0; attempt < 4 && !employeeId; attempt++) {
          const code = `EMP-${Math.random().toString(16).slice(2, 6).toUpperCase()}`;
          try {
            const [created] = await tx
              .insert(employees)
              .values({
                tenant_id: tenantId,
                employee_code: code,
                first_name: firstName,
                last_name: lastName,
                work_email: u.email,
                date_of_joining: new Date().toISOString().slice(0, 10),
              })
              .returning({ id: employees.id });
            employeeId = created!.id;
          } catch (err) {
            if ((err as { code?: string })?.code !== '23505' || attempt === 3) throw err;
          }
        }
      }

      await tx
        .update(memberships)
        .set({ employee_id: employeeId! })
        .where(eq(memberships.id, m.membershipId));
      return { employeeId: employeeId!, selfHealed: true, linkedExisting: !!existing };
    }
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
    return this.databaseService.withTenant(tenantId, (tx) =>
      this.resolveShiftTemplateTx(tx, tenantId, employeeId, attendanceDate),
    );
  }

  /** Tx-taking variant so punch-in/out can share ONE transaction (round C). */
  private async resolveShiftTemplateTx(
    tx: Db,
    tenantId: string,
    employeeId: string,
    attendanceDate: string, // YYYY-MM-DD
  ) {
    {
      // Active employee_shifts assignment for that date
      const [assignment] = await tx
        .select({
          template: shiftTemplates,
        })
        .from(employeeShifts)
        .innerJoin(
          shiftTemplates,
          and(
            eq(employeeShifts.shift_template_id, shiftTemplates.id),
            // Round L review: an assignment pointing at another tenant's
            // template must not resolve (FK checks bypass RLS, house rule 2).
            eq(shiftTemplates.tenant_id, tenantId),
          ),
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
      if (fallback) return fallback;

      // SELF-HEAL: tenants that never ran HR onboarding have no shift templates
      // at all, which used to kill every punch with a 404. Seed the same
      // default "General" shift onboarding would have created (Mon–Fri,
      // 09:00–18:00 IST) so clocking in always works; admins can edit it later.
      const [seeded] = await tx
        .insert(shiftTemplates)
        .values({
          tenant_id: tenantId,
          name: 'General',
          description: 'Default 9-to-6 shift, Mon–Fri, IST. Auto-created on first clock-in.',
          start_time: '09:00',
          end_time: '18:00',
          is_overnight: false,
          break_minutes: 60,
          break_paid: false,
          working_days: [1, 2, 3, 4, 5],
          timezone: 'Asia/Kolkata',
          grace_period_minutes: 15,
          half_day_threshold_minutes: 240,
          full_day_threshold_minutes: 480,
          is_default: true,
          is_active: true,
        })
        .returning();
      this.logger.log(`attendance self-heal: seeded default shift for tenant ${tenantId}`);
      return seeded!;
    }
  }

  // ─── Geofence resolution (PRD §6.4) ───────────────────────────────────────

  /**
   * The employee's assigned office and its geofence, if configured. Used to
   * resolve `is_within_geofence`/`work_mode` on punches — location problems
   * must NEVER block the punch itself (PRD §6.4 graceful degradation).
   */
  private async getEmployeeGeofence(
    tx: Db,
    tenantId: string,
    employeeId: string,
  ) {
    const [row] = await tx
      .select({
        locationId: employees.location_id,
        locationName: locations.name,
        geofenceLat: locations.geofence_lat,
        geofenceLng: locations.geofence_lng,
        geofenceRadiusM: locations.geofence_radius_m,
      })
      .from(employees)
      .leftJoin(locations, eq(employees.location_id, locations.id))
      .where(
        and(eq(employees.tenant_id, tenantId), eq(employees.id, employeeId)),
      )
      .limit(1);
    const lat = row?.geofenceLat ? parseFloat(row.geofenceLat) : NaN;
    const lng = row?.geofenceLng ? parseFloat(row.geofenceLng) : NaN;
    const hasFence =
      Number.isFinite(lat) &&
      Number.isFinite(lng) &&
      typeof row?.geofenceRadiusM === 'number' &&
      row.geofenceRadiusM > 0;
    return {
      locationId: row?.locationId ?? null,
      locationName: row?.locationName ?? null,
      geofenceLat: hasFence ? lat : null,
      geofenceLng: hasFence ? lng : null,
      geofenceRadiusM: hasFence ? row!.geofenceRadiusM : null,
    };
  }

  /**
   * `is_within_geofence` for a punch: true/false only when BOTH the punch has
   * coordinates and the employee's location has a geofence; NULL otherwise.
   */
  private resolveWithinGeofence(
    dto: PunchDto,
    fence: Awaited<ReturnType<AttendanceService['getEmployeeGeofence']>>,
  ): boolean | null {
    if (
      dto.lat === undefined ||
      dto.lng === undefined ||
      fence.geofenceLat === null ||
      fence.geofenceLng === null ||
      fence.geofenceRadiusM === null
    ) {
      return null;
    }
    const distance = haversineMeters(
      dto.lat,
      dto.lng,
      fence.geofenceLat,
      fence.geofenceLng,
    );
    return distance <= fence.geofenceRadiusM;
  }

  // ─── Punch flow ───────────────────────────────────────────────────────────

  async punchIn(
    userId: string,
    tenantId: string,
    dto: PunchDto,
    ip?: string,
    userAgent?: string,
  ) {
    const now = new Date();
    const today = dateInTimezone(now, 'Asia/Kolkata'); // bootstrap default

    // Round C: employee resolution, shift lookup and the punch share ONE
    // transaction — this path used to open five (incl. two awaited audit
    // writes), ~24 serial round-trips per click through Supavisor.
    const result = await this.databaseService.withTenant(
      tenantId,
      async (tx) => {
        const healed = await this.getEmployeeIdForUserTx(tx, userId, tenantId);
        const employeeId = healed.employeeId;
        const shift = await this.resolveShiftTemplateTx(tx, tenantId, employeeId, today);
        const attendanceDate = dateInTimezone(now, shift.timezone);

        // Round L (founder item 1): approved full-day leave means no clock-in
        // — the old code happily overwrote the on_leave row with 'present'.
        // Decided by the day resolver (the approved request), not by the row:
        // a leave cancelled after approval leaves its on_leave row behind and
        // must not lock the person out (house rule 8).
        const expectation = await resolveExpectationTx(
          tx,
          tenantId,
          employeeId,
          attendanceDate,
          now,
        );
        if (expectation.kind === 'leave') {
          throw new ConflictException(
            "You're on approved leave today — no clock-in needed. If you are working today, cancel the leave first.",
          );
        }
        // Approved half-day leave: the day stays 'half_day' (the leave
        // backfill wrote it) and there is no late maths — which half they
        // are away is the leave's business, not the punch's.
        const halfDayLeave = expectation.kind === 'half_day_leave';

        // Late check
        const shiftStartUTC = localTimeToUTC(
          attendanceDate,
          shift.start_time,
          shift.timezone,
        );
        const lateThreshold = new Date(
          shiftStartUTC.getTime() + shift.grace_period_minutes * 60_000,
        );
        const isLate = !halfDayLeave && now > lateThreshold;
        const lateBy = isLate
          ? Math.floor((now.getTime() - shiftStartUTC.getTime()) / 60_000)
          : 0;
        const punchStatus = halfDayLeave
          ? ('half_day' as const)
          : isLate
            ? ('late' as const)
            : ('present' as const);

        // Geofence resolution (PRD §6.4): office when inside, remote when the
        // coordinates land outside, unknown (NULL) when either side is missing.
        const fence = await this.getEmployeeGeofence(tx, tenantId, employeeId);
        const isWithinGeofence = this.resolveWithinGeofence(dto, fence);
        const workMode: 'office' | 'remote' | null =
          isWithinGeofence === null ? null : isWithinGeofence ? 'office' : 'remote';

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
                attendance_status: punchStatus,
                work_mode: workMode,
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
              attendance_status: punchStatus,
              work_mode: workMode,
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
            user_agent: userAgent ?? null,
            geo_lat: dto.lat ?? null,
            geo_lng: dto.lng ?? null,
            geo_accuracy_m: dto.accuracy ?? null,
            location_id: dto.locationId ?? fence.locationId ?? null,
            is_within_geofence: isWithinGeofence,
            notes: dto.notes ?? null,
          })
          .returning();

        return {
          record_id: recordId,
          punch: punch!,
          isWithinGeofence,
          workMode,
          locationName: fence.locationName,
          healed,
          shift,
          attendanceDate,
          isLate,
          lateBy,
        };
      },
    );

    this.logSelfHeal(tenantId, userId, result.healed);
    // Detached (round C): the punch is committed — its audit row must not
    // hold the button hostage for another transaction's round-trips.
    void this.auditService.log({
      tenantId,
      actorUserId: userId,
      action: 'attendance.punched_in',
      resourceType: 'attendance_record',
      resourceId: result.record_id,
      metadata: {
        attendanceDate: result.attendanceDate,
        isLate: result.isLate,
        lateBy: result.lateBy,
        timezone: result.shift.timezone,
        isWithinGeofence: result.isWithinGeofence,
        workMode: result.workMode,
      },
    });

    return {
      id: result.punch.id,
      attendanceRecordId: result.record_id,
      attendanceDate: result.attendanceDate,
      punchedAt: result.punch.punched_at.toISOString(),
      type: 'in' as const,
      isLate: result.isLate,
      lateByMinutes: result.lateBy,
      shiftStart: result.shift.start_time,
      shiftTimezone: result.shift.timezone,
      isWithinGeofence: result.isWithinGeofence,
      workMode: result.workMode,
      locationName: result.locationName,
    };
  }

  async punchOut(
    userId: string,
    tenantId: string,
    dto: PunchDto,
    ip?: string,
    userAgent?: string,
  ) {
    const now = new Date();
    const today = dateInTimezone(now, 'Asia/Kolkata');

    // Round C: one transaction, same shape as punchIn above.
    const result = await this.databaseService.withTenant(
      tenantId,
      async (tx) => {
        const healed = await this.getEmployeeIdForUserTx(tx, userId, tenantId);
        const employeeId = healed.employeeId;
        const shift = await this.resolveShiftTemplateTx(tx, tenantId, employeeId, today);
        const attendanceDate = dateInTimezone(now, shift.timezone);

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

        // Same geofence resolution as punch-in, for the punch ROW only — the
        // record's work_mode is set at clock-in and never downgraded here
        // (clocking out from home must not flip an office day to remote).
        const fence = await this.getEmployeeGeofence(tx, tenantId, employeeId);
        const isWithinGeofence = this.resolveWithinGeofence(dto, fence);

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
            user_agent: userAgent ?? null,
            geo_lat: dto.lat ?? null,
            geo_lng: dto.lng ?? null,
            geo_accuracy_m: dto.accuracy ?? null,
            location_id: dto.locationId ?? fence.locationId ?? null,
            is_within_geofence: isWithinGeofence,
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
          healed,
          attendanceDate,
        };
      },
    );

    this.logSelfHeal(tenantId, userId, result.healed);
    // Detached (round C) — same reasoning as punchIn.
    void this.auditService.log({
      tenantId,
      actorUserId: userId,
      action: 'attendance.punched_out',
      resourceType: 'attendance_record',
      resourceId: result.recordId,
      metadata: {
        attendanceDate: result.attendanceDate,
        workedMin: result.workedMin,
        breakMin: result.breakMin,
        status: result.status,
      },
    });

    return {
      id: result.punch.id,
      attendanceRecordId: result.recordId,
      attendanceDate: result.attendanceDate,
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
    const now = new Date();
    const today = dateInTimezone(now, 'Asia/Kolkata');

    // Round C: one transaction (was three) — breaks are CTAs too.
    return this.databaseService.withTenant(tenantId, async (tx) => {
      const healed = await this.getEmployeeIdForUserTx(tx, userId, tenantId);
      const employeeId = healed.employeeId;
      const shift = await this.resolveShiftTemplateTx(tx, tenantId, employeeId, today);
      const attendanceDate = dateInTimezone(now, shift.timezone);

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
    const now = new Date();
    // Use the employee's effective shift to determine "today"
    const bootDate = dateInTimezone(now, 'Asia/Kolkata');

    // Round C: all six lookups share ONE transaction — this endpoint used to
    // open six (≈24 serial round-trips) and is refetched after every punch.
    const out = await this.databaseService.withTenant(tenantId, async (tx) => {
      const healed = await this.getEmployeeIdForUserTx(tx, userId, tenantId);
      const employeeId = healed.employeeId;
      const shift = await this.resolveShiftTemplateTx(tx, tenantId, employeeId, bootDate);
      const attendanceDate = dateInTimezone(now, shift.timezone);

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

      // Determine isOnBreak by inspecting last punch
      let isOnBreak = false;
      let lastPunchType: string | null = null;
      let lastPunchGeo: {
        lat: number;
        lng: number;
        accuracyM: number | null;
        isWithinGeofence: boolean | null;
      } | null = null;
      if (record) {
        const punches = await tx
          .select({
            punch_type: attendancePunches.punch_type,
            punched_at: attendancePunches.punched_at,
          })
          .from(attendancePunches)
          .where(eq(attendancePunches.attendance_record_id, record.id))
          .orderBy(desc(attendancePunches.punched_at))
          .limit(1);
        lastPunchType = punches[0]?.punch_type ?? null;
        isOnBreak = lastPunchType === 'break_start';

        // The clock-in position feeds the geofence strip on the clock card.
        const [inPunch] = await tx
          .select({
            lat: attendancePunches.geo_lat,
            lng: attendancePunches.geo_lng,
            accuracyM: attendancePunches.geo_accuracy_m,
            isWithinGeofence: attendancePunches.is_within_geofence,
          })
          .from(attendancePunches)
          .where(
            and(
              eq(attendancePunches.attendance_record_id, record.id),
              eq(attendancePunches.punch_type, 'in'),
            ),
          )
          .orderBy(desc(attendancePunches.punched_at))
          .limit(1);
        if (inPunch && inPunch.lat !== null && inPunch.lng !== null) {
          lastPunchGeo = {
            lat: inPunch.lat,
            lng: inPunch.lng,
            accuracyM: inPunch.accuracyM,
            isWithinGeofence: inPunch.isWithinGeofence,
          };
        }
      }

      // Assigned office + geofence — the web pre-checks the fence client-side
      // before punch-in so it can offer "Mark as WFH today" instead of failing.
      const fence = await this.getEmployeeGeofence(tx, tenantId, employeeId);

      // Round L: the day's expectation (holiday / weekend / leave) so the
      // clock card can say "On approved leave today" instead of offering a
      // Clock-in button the server would 409.
      const expectation = await resolveExpectationTx(tx, tenantId, employeeId, attendanceDate, now);

      return { healed, employeeId, shift, attendanceDate, record, isOnBreak, lastPunchType, lastPunchGeo, fence, expectation };
    });

    this.logSelfHeal(tenantId, userId, out.healed);
    const { employeeId, shift, attendanceDate, record, isOnBreak, lastPunchType, lastPunchGeo, fence, expectation } = out;

    // Working day = neither a weekend (per the shift's working_days) nor a
    // blocking holiday for this employee's location.
    const isWorkingDay = expectation.kind !== 'weekend' && expectation.kind !== 'holiday';

    return {
      employeeId,
      attendanceDate,
      // No record: the day reads as what it IS (on_leave / holiday / weekend)
      // rather than a blanket 'absent'.
      // A leave-backfilled row nobody punched into (on_leave / half_day, no
      // punch-in) is read from the resolver — a cancelled leave may leave one
      // behind and it must not keep saying "on leave".
      attendanceStatus:
        record &&
        !record.first_punch_in_at &&
        (record.attendance_status === 'on_leave' || record.attendance_status === 'half_day')
          ? (derivedStatus(expectation) ?? 'absent')
          : (record?.attendance_status ?? derivedStatus(expectation) ?? 'absent'),
      firstPunchInAt: record?.first_punch_in_at?.toISOString() ?? null,
      lastPunchOutAt: record?.last_punch_out_at?.toISOString() ?? null,
      totalWorkedMinutes: record?.total_worked_minutes ?? 0,
      totalBreakMinutes: record?.total_break_minutes ?? 0,
      isLate: record?.is_late ?? false,
      lateByMinutes: record?.late_by_minutes ?? 0,
      isOnBreak,
      lastPunchType,
      workMode: record?.work_mode ?? null,
      location: fence.locationId
        ? {
            id: fence.locationId,
            name: fence.locationName,
            geofenceLat: fence.geofenceLat,
            geofenceLng: fence.geofenceLng,
            geofenceRadiusM: fence.geofenceRadiusM,
          }
        : null,
      lastPunchGeo,
      shift: {
        id: shift.id,
        name: shift.name,
        startTime: shift.start_time,
        endTime: shift.end_time,
        timezone: shift.timezone,
        gracePeriodMinutes: shift.grace_period_minutes,
        /** Round L — the regularization dialog builds a next-day clock-out for these. */
        isOvernight: shift.is_overnight,
      },
      isWorkingDay,
      // Round L — day semantics (see core/common/workday.ts).
      expected: expectation.expected,
      dayKind: expectation.kind,
      holidayName: expectation.holidayName,
      leave: expectation.leave,
      pendingLeave: expectation.pendingLeave,
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

  /**
   * Attendance history for ONE employee — the employee-360° Attendance tab
   * (founder round 15). Visible to the employee themselves, their reporting
   * manager, and owner/admin/finance/fam. Same shape as listMine, plus
   * work_mode so the history can show WFH days.
   */
  async listForEmployee(
    userId: string,
    role: string | undefined,
    employeeId: string,
    tenantId: string,
    query: AttendanceListQueryDto,
  ) {
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 31, 100);
    const offset = (page - 1) * limit;

    return this.databaseService.withTenant(tenantId, async (tx) => {
      const [target] = await tx
        .select({
          id: employees.id,
          reportingManagerId: employees.reporting_manager_id,
        })
        .from(employees)
        .where(
          and(eq(employees.tenant_id, tenantId), eq(employees.id, employeeId)),
        )
        .limit(1);
      if (!target) throw new NotFoundException('Employee not found');

      // Caller's own employee bridge, WITHOUT the punch-flow self-heal — a
      // read must never mint employee records.
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
      const callerEmployeeId = m?.employeeId ?? null;

      const elevated = ['owner', 'admin', 'finance', 'fam', 'super_admin'].includes(role ?? '');
      const isSelf = callerEmployeeId !== null && callerEmployeeId === target.id;
      const managesTarget =
        role === 'manager' &&
        callerEmployeeId !== null &&
        target.reportingManagerId === callerEmployeeId;
      if (!elevated && !isSelf && !managesTarget) {
        throw new ForbiddenException(
          'Attendance history is visible to the employee, their manager, and admins',
        );
      }

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
        conditions.push(
          eq(
            attendanceRecords.attendance_status,
            query.status as typeof attendanceRecords.$inferSelect['attendance_status'],
          ),
        );
      }

      const data = await tx
        .select({
          id: attendanceRecords.id,
          attendanceDate: attendanceRecords.attendance_date,
          attendanceStatus: attendanceRecords.attendance_status,
          workMode: attendanceRecords.work_mode,
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
        .offset(offset);

      return { data, pagination: { page, limit, total: data.length } };
    });
  }


  /**
   * Unified month view (calendar redesign): one entry PER calendar day —
   * records + punch ids + the employee's own regularization status (never
   * exposed before) + holiday/weekend flags. Weekend derives from the shift
   * template resolved at month START (documented approximation for
   * mid-month shift changes).
   */
  async getMyMonth(userId: string, tenantId: string, month: string) {
    const employeeId = await this.getEmployeeIdForUser(userId, tenantId);
    const [y, m] = month.split('-').map(Number);
    const first = `${month}-01`;
    const daysInMonth = new Date(y!, m!, 0).getDate();
    const last = `${month}-${String(daysInMonth).padStart(2, '0')}`;

    const shift = await this.resolveShiftTemplate(tenantId, employeeId, first);
    const workingDays = new Set<number>(shift?.working_days ?? [1, 2, 3, 4, 5]);

    return this.databaseService.withTenant(tenantId, async (tx) => {
      const records = await tx
        .select()
        .from(attendanceRecords)
        .where(
          and(
            eq(attendanceRecords.tenant_id, tenantId),
            eq(attendanceRecords.employee_id, employeeId),
            gte(attendanceRecords.attendance_date, first),
            lte(attendanceRecords.attendance_date, last),
          ),
        );
      const recordIds = records.map((r) => r.id);
      const punches = recordIds.length
        ? await tx
            .select({
              id: attendancePunches.id,
              record_id: attendancePunches.attendance_record_id,
              punch_type: attendancePunches.punch_type,
              punched_at: attendancePunches.punched_at,
            })
            .from(attendancePunches)
            .where(inArray(attendancePunches.attendance_record_id, recordIds))
            .orderBy(asc(attendancePunches.punched_at))
        : [];
      const regs = await tx
        .select({
          id: attendanceRegularizations.id,
          attendance_date: attendanceRegularizations.attendance_date,
          status: attendanceRegularizations.status,
          request_type: attendanceRegularizations.request_type,
          created_at: attendanceRegularizations.created_at,
        })
        .from(attendanceRegularizations)
        .where(
          and(
            eq(attendanceRegularizations.tenant_id, tenantId),
            eq(attendanceRegularizations.employee_id, employeeId),
            gte(attendanceRegularizations.attendance_date, first),
            lte(attendanceRegularizations.attendance_date, last),
          ),
        )
        .orderBy(asc(attendanceRegularizations.created_at));
      // Location-scoped: company-wide rows (location_id NULL) apply to
      // everyone; location rows only to employees at that location. Elective
      // types (optional/restricted) don't mark the day as a holiday.
      const [empRow] = await tx
        .select({ locationId: employees.location_id })
        .from(employees)
        .where(
          and(eq(employees.id, employeeId), eq(employees.tenant_id, tenantId)),
        )
        .limit(1);
      const empLocationId = empRow?.locationId ?? null;
      const monthHolidays = await tx
        .select({ holiday_date: holidays.holiday_date, name: holidays.name })
        .from(holidays)
        .where(
          and(
            eq(holidays.tenant_id, tenantId),
            gte(holidays.holiday_date, first),
            lte(holidays.holiday_date, last),
            notInArray(holidays.type, ['optional', 'restricted']),
            empLocationId
              ? or(
                  isNull(holidays.location_id),
                  eq(holidays.location_id, empLocationId),
                )
              : isNull(holidays.location_id),
          ),
        );

      // Round L: leave overlay — approved AND pending requests overlapping the
      // month (same predicate as the day resolver / calendar).
      const monthLeaves = await tx
        .select({
          id: leaveRequests.id,
          startDate: leaveRequests.start_date,
          endDate: leaveRequests.end_date,
          status: leaveRequests.status,
          isHalfDay: leaveRequests.is_half_day,
          session: leaveRequests.half_day_session,
          leaveTypeName: leaveTypes.name,
        })
        .from(leaveRequests)
        .leftJoin(
          leaveTypes,
          and(eq(leaveRequests.leave_type_id, leaveTypes.id), eq(leaveTypes.tenant_id, tenantId)),
        )
        .where(
          and(
            eq(leaveRequests.tenant_id, tenantId),
            eq(leaveRequests.employee_id, employeeId),
            inArray(leaveRequests.status, ['approved', 'pending']),
            lte(leaveRequests.start_date, last),
            gte(leaveRequests.end_date, first),
          ),
        );

      const recordByDate = new Map(records.map((r) => [r.attendance_date, r]));
      const punchesByRecord = new Map<string, typeof punches>();
      for (const pch of punches) {
        const list = punchesByRecord.get(pch.record_id) ?? [];
        list.push(pch);
        punchesByRecord.set(pch.record_id, list);
      }
      // Latest regularization per date wins.
      const regByDate = new Map<string, (typeof regs)[number]>();
      for (const r of regs) regByDate.set(r.attendance_date, r);
      const holidayByDate = new Map(monthHolidays.map((h) => [h.holiday_date, h.name]));

      const days = Array.from({ length: daysInMonth }, (_, i) => {
        const date = `${month}-${String(i + 1).padStart(2, '0')}`;
        const dow = new Date(`${date}T00:00:00`).getDay();
        const record = recordByDate.get(date) ?? null;
        const reg = regByDate.get(date) ?? null;
        const isWeekend = !workingDays.has(dow);
        const isHoliday = holidayByDate.has(date);
        const leave = pickLeaveForDate(monthLeaves, date);
        // Same precedence as the resolver: holiday → weekend → approved
        // full-day leave. A day off on approved leave reads on_leave even
        // when the approval-time backfill never wrote a row.
        const leaveFallback =
          !isWeekend && !isHoliday && leave?.status === 'approved' && !leave.isHalfDay
            ? ('on_leave' as const)
            : null;
        return {
          date,
          attendanceStatus: record?.attendance_status ?? leaveFallback,
          isWeekend,
          isHoliday,
          holidayName: holidayByDate.get(date) ?? null,
          leave,
          pendingLeave: leave?.status === 'pending',
          firstPunchInAt: record?.first_punch_in_at ?? null,
          lastPunchOutAt: record?.last_punch_out_at ?? null,
          totalWorkedMinutes: record?.total_worked_minutes ?? 0,
          totalBreakMinutes: record?.total_break_minutes ?? 0,
          isLate: record?.is_late ?? false,
          isRegularized: record?.is_regularized ?? false,
          regularization: reg
            ? { id: reg.id, status: reg.status, requestType: reg.request_type }
            : null,
          punches: (record ? punchesByRecord.get(record.id) ?? [] : []).map((pch) => ({
            id: pch.id,
            punchType: pch.punch_type,
            punchedAt: pch.punched_at,
          })),
        };
      });

      return { month, days };
    });
  }

  async listTeamToday(
    userId: string,
    tenantId: string,
    role?: string,
    managerId?: string,
  ) {
    // Managers see their direct reports; owner/admin/finance/fam see the whole
    // org (precedent: reports.service tenant-wide reads behind the same guard).
    // An explicit ?managerId= narrows the org view to one manager's team.
    const orgWide = role !== undefined && role !== 'manager';
    const reviewerEmployeeId = orgWide
      ? null
      : await this.getEmployeeIdForUser(userId, tenantId);
    const now = new Date();
    // Round L review: leave DETAILS (type, half-day session, a pending
    // request) belong to the people who review leave — a manager for their
    // reports and the org-wide reviewer roles. Finance keeps the roster with
    // "On leave" / expected, never the request behind it.
    const canSeeLeave =
      role === undefined || role === 'manager' || ORG_WIDE_REVIEW_ROLES.includes(role);

    const scope = [
      eq(employees.tenant_id, tenantId),
      isNull(employees.deleted_at), // round 21 — removed staff leave the board
      eq(employees.status, 'active'),
    ];
    if (reviewerEmployeeId) {
      scope.push(eq(employees.reporting_manager_id, reviewerEmployeeId));
    } else if (managerId) {
      scope.push(eq(employees.reporting_manager_id, managerId));
    }

    // Round L (founder item 1): "today" is resolved PER EMPLOYEE from their
    // shift timezone (was a hard-coded IST date), and a row without a record
    // carries the day's expectation — on leave / holiday / weekend / leave
    // pending — instead of reading as "missed punch" to the manager.
    const teamRows = await this.databaseService.withTenant(tenantId, async (tx) => {
      const people = await tx
        .select({
          employeeId: employees.id,
          employeeUserId: employees.user_id,
          employeeName: sql<string>`${employees.first_name} || ' ' || ${employees.last_name}`,
          employeeCode: employees.employee_code,
          locationName: locations.name,
          // Round N — the photo lives in users.avatar_key (private R2 key);
          // signed AFTER the tx below, never returned raw. `users` is
          // platform-global, joined by id from the tenant-scoped employee row.
          avatarKey: users.avatar_key,
          avatarUrl: users.avatar_url,
        })
        .from(employees)
        .leftJoin(users, eq(employees.user_id, users.id))
        .leftJoin(
          locations,
          and(eq(employees.location_id, locations.id), eq(locations.tenant_id, tenantId)),
        )
        .where(and(...scope))
        .orderBy(employees.first_name);
      if (people.length === 0) return [];

      const ids = people.map((p) => p.employeeId);
      const expectations = await resolveExpectationsTx(tx, tenantId, ids, null, now);
      const dates = Array.from(new Set(Array.from(expectations.values()).map((e) => e.date)));
      const records = dates.length
        ? await tx
            .select({
              id: attendanceRecords.id,
              employeeId: attendanceRecords.employee_id,
              attendanceDate: attendanceRecords.attendance_date,
              attendanceStatus: attendanceRecords.attendance_status,
              workMode: attendanceRecords.work_mode,
              firstPunchInAt: attendanceRecords.first_punch_in_at,
              lastPunchOutAt: attendanceRecords.last_punch_out_at,
              totalWorkedMinutes: attendanceRecords.total_worked_minutes,
              isLate: attendanceRecords.is_late,
            })
            .from(attendanceRecords)
            .where(
              and(
                eq(attendanceRecords.tenant_id, tenantId),
                inArray(attendanceRecords.employee_id, ids),
                inArray(attendanceRecords.attendance_date, dates),
              ),
            )
        : [];
      const recordByKey = new Map(records.map((r) => [`${r.employeeId}|${r.attendanceDate}`, r]));

      return people.map((p) => {
        const exp = expectations.get(p.employeeId) ?? null;
        const attendanceDate = exp?.date ?? dateInTimezone(now, 'Asia/Kolkata');
        const rec = recordByKey.get(`${p.employeeId}|${attendanceDate}`) ?? null;
        // A leave-backfilled row nobody punched into (on_leave / half_day,
        // no punch-in) is read from the resolver: a cancelled leave may
        // leave one behind and must not keep the person "On leave".
        const stale =
          !!rec &&
          !rec.firstPunchInAt &&
          (rec.attendanceStatus === 'on_leave' || rec.attendanceStatus === 'half_day');
        const status = stale ? (exp ? derivedStatus(exp) : null) : (rec?.attendanceStatus ?? null);
        const kind = exp?.kind ?? ('working' as const);
        return {
          employeeId: p.employeeId,
          employeeUserId: p.employeeUserId,
          employeeName: p.employeeName,
          employeeCode: p.employeeCode,
          avatarKey: p.avatarKey,
          avatarUrl: p.avatarUrl,
          recordId: rec?.id ?? null,
          attendanceStatus: status,
          workMode: rec?.workMode ?? null,
          firstPunchInAt: rec?.firstPunchInAt ?? null,
          lastPunchOutAt: rec?.lastPunchOutAt ?? null,
          totalWorkedMinutes: rec?.totalWorkedMinutes ?? null,
          isLate: rec?.isLate ?? null,
          locationName: p.locationName,
          // Round L — day semantics. Leave details only for leave reviewers;
          // a half-day leave collapses to a plain working day for the rest
          // (they are expected either way).
          attendanceDate,
          expected: exp?.expected ?? true,
          dayKind: canSeeLeave ? kind : kind === 'half_day_leave' ? ('working' as const) : kind,
          holidayName: exp?.holidayName ?? null,
          leave: canSeeLeave ? (exp?.leave ?? null) : null,
          pendingLeave: canSeeLeave ? (exp?.pendingLeave ?? false) : false,
          /** Record status, else what the day reads as without one. */
          derivedStatus: status ?? (exp ? derivedStatus(exp) : null),
        };
      });
    });
    // Round N — sign after the tenant tx returns (local SigV4 crypto,
    // pm/teams precedent); the mapper strips avatarKey from every row.
    return withSignedAvatars(this.signAvatar, teamRows);
  }

  // ─── Regularization ───────────────────────────────────────────────────────

  async requestRegularization(
    userId: string,
    tenantId: string,
    dto: RegularizationRequestDto,
  ) {
    const employeeId = await this.getEmployeeIdForUser(userId, tenantId);
    const now = new Date();

    const result = await this.databaseService.withTenant(
      tenantId,
      async (tx) => {
        // Round L (founder item 3): the request used to accept anything —
        // a future day, instants on another day, out before in, and a
        // regularization for TODAY filed in the morning before clocking out
        // (which the approver then wrote over the real punches). Every check
        // runs in the shift's timezone, never the browser's.
        const parsedDate = new Date(`${dto.attendanceDate}T00:00:00Z`);
        if (
          !/^\d{4}-\d{2}-\d{2}$/.test(dto.attendanceDate) ||
          Number.isNaN(parsedDate.getTime()) ||
          parsedDate.toISOString().slice(0, 10) !== dto.attendanceDate
        ) {
          throw new BadRequestException('attendanceDate must be a valid YYYY-MM-DD date');
        }
        const shift = await this.resolveShiftTemplateTx(tx, tenantId, employeeId, dto.attendanceDate);
        const tz = shift.timezone;
        const today = dateInTimezone(now, tz);
        if (dto.attendanceDate > today) {
          throw new BadRequestException(
            'Regularization can only be requested for today or a past day.',
          );
        }

        const inAt = dto.proposedInTime ? new Date(dto.proposedInTime) : null;
        const outAt = dto.proposedOutTime ? new Date(dto.proposedOutTime) : null;
        if (inAt && Number.isNaN(inAt.getTime())) {
          throw new BadRequestException('proposedInTime must be an ISO-8601 instant');
        }
        if (outAt && Number.isNaN(outAt.getTime())) {
          throw new BadRequestException('proposedOutTime must be an ISO-8601 instant');
        }
        // Instants must fall on the attendance date as observed in the shift
        // timezone; an overnight shift may clock out on the following day.
        const nextDay = addDaysISO(dto.attendanceDate, 1);
        if (inAt && dateInTimezone(inAt, tz) !== dto.attendanceDate) {
          throw new BadRequestException(
            `Proposed clock-in must fall on ${dto.attendanceDate} (${tz}).`,
          );
        }
        if (outAt) {
          const outDay = dateInTimezone(outAt, tz);
          const onDay = outDay === dto.attendanceDate;
          const onNext = shift.is_overnight && outDay === nextDay;
          if (!onDay && !onNext) {
            throw new BadRequestException(
              shift.is_overnight
                ? `Proposed clock-out must fall on ${dto.attendanceDate} or the following day (${tz}).`
                : `Proposed clock-out must fall on ${dto.attendanceDate} (${tz}).`,
            );
          }
        }
        if (inAt && outAt && outAt.getTime() <= inAt.getTime()) {
          throw new BadRequestException(
            'Proposed clock-out must be after the proposed clock-in.',
          );
        }

        // The founder's case: "check whether the clock-out of the request
        // is ahead of time" — a proposed instant in the future is never
        // valid, for ANY date (an overnight shift at 02:00 on D+1 could
        // otherwise file D with a 06:00 clock-out that hasn't happened).
        const isToday = dto.attendanceDate === today;
        const afterClockOut = isToday
          ? ' — regularization for today can be requested after you clock out.'
          : ' — you can only regularize time that has already passed.';
        if (outAt && outAt.getTime() > now.getTime()) {
          throw new BadRequestException(`Proposed clock-out is later than now${afterClockOut}`);
        }
        if (inAt && inAt.getTime() > now.getTime()) {
          throw new BadRequestException(`Proposed clock-in is later than now${afterClockOut}`);
        }

        if (isToday) {
          // Founder's literal rule: a request for TODAY is taken only once the
          // day is clocked out — no record, no punch-in, or an open punch all
          // mean "come back after you clock out". Past days are unaffected.
          const [todayRecord] = await tx
            .select({
              firstPunchInAt: attendanceRecords.first_punch_in_at,
              lastPunchOutAt: attendanceRecords.last_punch_out_at,
            })
            .from(attendanceRecords)
            .where(
              and(
                eq(attendanceRecords.tenant_id, tenantId),
                eq(attendanceRecords.employee_id, employeeId),
                eq(attendanceRecords.attendance_date, today),
              ),
            )
            .limit(1);
          if (todayRecord?.firstPunchInAt && !todayRecord.lastPunchOutAt) {
            throw new BadRequestException(
              "You haven't clocked out yet today — regularization for today can be requested after you clock out.",
            );
          }
          if (!todayRecord?.lastPunchOutAt) {
            throw new BadRequestException(
              'Regularization for today can be requested after you clock out.',
            );
          }
        }

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

        // Round L (item 2): where the request is born — level 0 with the
        // reporting manager snapshotted; straight to the manager's manager
        // when the manager is on approved full-day leave today (`today` is
        // the shift-timezone day resolved above); straight to Owner + HR
        // Admins (`no_manager`) when there is no valid manager at all.
        const { state } = await this.routing.initialStateTx(tx, tenantId, employeeId, today, now);

        const [created] = await tx
          .insert(attendanceRegularizations)
          .values({
            tenant_id: tenantId,
            employee_id: employeeId,
            attendance_date: dto.attendanceDate,
            request_type: dto.requestType,
            proposed_in_time: inAt,
            proposed_out_time: outAt,
            reason: dto.reason,
            status: 'pending',
            ...routeStateColumns(state),
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

    // Detached (round C): committed request; audit must not delay the CTA.
    void this.auditService.log({
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
          userId: employees.user_id,
          managerId: employees.reporting_manager_id,
        })
        .from(employees)
        .where(eq(employees.id, employeeId))
        .limit(1),
    );
    if (!employee) return;

    // Round L: who gets pinged is the routing chain — the reporting manager
    // (level 0), the manager's manager (level 1, manager on leave today) or
    // Owner + HR Admins (level 2, no manager). The applicant is never a
    // recipient (employees.user_id + the membership bridge — Round K), and a
    // level whose reviewer does not exist falls through to HR: an owner's
    // own request never dead-ends (house rule 8).
    const { route, level, reason } = await this.databaseService.withTenant(tenantId, async (tx) => {
      const route = await this.routing.resolveRouteTx(tx, tenantId, employeeId);
      const live = await this.routing.readStateTx(tx, tenantId, 'regularization', regId);
      return { route, level: live?.level ?? 0, reason: live?.reason ?? null };
    });
    const reviewers = this.routing.recipientsFor(route, level);
    if (reviewers.length === 0) return;
    const why =
      reason === 'no_manager' || (!route.l0 && level >= 2)
        ? ' — no reporting manager is set, so it is with you as HR.'
        : reason === 'reviewer_on_leave'
          ? ' — their manager is on leave today, so it is with you.'
          : '.';

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

    const employeeName = `${employee.firstName} ${employee.lastName}`.trim();
    // Round K (founder): the link used to be '/team/attendance', which
    // redirected the manager to their OWN daily log. Now it opens Inbox →
    // Approvals with this request pre-selected (the web scrubs the param
    // once the row is focused or found to be gone).
    const reviewPath = `/inbox?tab=approvals&request=${encodeURIComponent(regId)}`;
    const reviewUrl = `${this.appUrl()}${reviewPath}`;

    for (const reviewer of reviewers) {
      // Real-time in-app ping to the approver (Topbar bell). Best-effort.
      if (reviewer.userId) {
        await this.notificationsService
          .createInAppNotification(
            reviewer.userId,
            'regularization.requested',
            `${employeeName || 'An employee'} requested a regularization for ${reg?.attendanceDate ?? ''}${why}`,
            reviewPath,
            tenantId,
          )
          .catch((err) =>
            this.logger.warn(`Regularization in-app notification failed: ${err}`),
          );
      }

      if (!reviewer.email) continue;

      await this.notificationsService.sendEmail(
        'attendance-regularization-requested',
        reviewer.email,
        {
          managerName: reviewer.name || 'there',
          employeeName,
          attendanceDate: reg?.attendanceDate ?? '',
          requestType: reg?.requestType,
          reason: reg?.reason ?? undefined,
          reviewUrl,
        },
      );
      this.logger.log(
        `Regularization email queued to ${reviewer.email} (reg=${regId})`,
      );
    }
  }

  // (Round L: `resolveRegularizationReviewers` and the local
  // `resolveReviewerScope` are gone — ApprovalRoutingService is the one
  // source of "who reviews" and "who may act".)

  /** Round L: one resolver for every approval surface (modules/approvals). */
  private resolveReviewerScope(
    tx: Db,
    userId: string,
    tenantId: string,
    roleHint?: string,
  ): Promise<ReviewerCtx> {
    return this.routing.resolveReviewerTx(tx, tenantId, userId, roleHint);
  }

  /**
   * Round L — the ROUTED queue: direct reports, requests escalated to me,
   * and (owner/admin) requests at level 2 or with no manager at all; never
   * the caller's own. Rows carry the escalation block for the Inbox pill.
   */
  async listPendingRegularizations(
    userId: string,
    tenantId: string,
    query: AttendanceListQueryDto,
    roleHint?: string,
  ) {
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, 100);
    const offset = (page - 1) * limit;

    const queueRows = await this.databaseService.withTenant(tenantId, async (tx) => {
      const reviewer = await this.resolveReviewerScope(tx, userId, tenantId, roleHint);
      const escalatedTo = pgAlias(employees, 'reg_escalated_to');
      const rows = await tx
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
          // Round N — the queue renders the same face as the detail view
          // (getRegularizationForReviewer); signed AFTER the tx, the private
          // key stripped by the mapper.
          avatarKey: users.avatar_key,
          avatarUrl: users.avatar_url,
          escalationLevel: attendanceRegularizations.escalation_level,
          escalationReason: attendanceRegularizations.escalation_reason,
          escalatedAt: attendanceRegularizations.escalated_at,
          escalatedToName: sql<string | null>`CASE WHEN ${escalatedTo.id} IS NULL THEN NULL ELSE ${escalatedTo.first_name} || ' ' || ${escalatedTo.last_name} END`,
        })
        .from(attendanceRegularizations)
        // Round N review: the tenant predicate rides the join, not RLS alone —
        // employee_id is an FK and FK checks bypass RLS (house rule 2), and
        // the requester's photo hangs off this row.
        .leftJoin(
          employees,
          and(
            eq(attendanceRegularizations.employee_id, employees.id),
            eq(employees.tenant_id, tenantId),
          ),
        )
        // LEFT — an employee with no user account keeps its row in the queue
        // (the `IS DISTINCT FROM` predicate below relies on exactly that).
        .leftJoin(users, eq(employees.user_id, users.id))
        .leftJoin(
          escalatedTo,
          and(
            eq(escalatedTo.id, attendanceRegularizations.escalated_to_employee_id),
            eq(escalatedTo.tenant_id, tenantId),
          ),
        )
        .where(
          and(
            eq(attendanceRegularizations.tenant_id, tenantId),
            eq(attendanceRegularizations.status, 'pending'),
            // Nobody reviews their own request — the caller's own row never
            // enters their queue (same rule as the leave queue and the
            // onboarding queue). IS DISTINCT FROM keeps rows whose employee
            // has no linked user account.
            sql`${employees.user_id} IS DISTINCT FROM ${userId}`,
            // Round L: the routed queue; removed employees (round 21) never
            // surface.
            this.routing.queuePredicate(
              reviewer,
              attendanceRegularizations,
              attendanceRegularizations.employee_id,
            ),
            isNull(employees.deleted_at),
          ),
        )
        .orderBy(desc(attendanceRegularizations.created_at))
        .limit(limit)
        .offset(offset);
      return rows.map(({ escalationLevel, escalationReason, escalatedAt, escalatedToName, ...r }) => ({
        ...r,
        escalation: shapeEscalation({ escalationLevel, escalationReason, escalatedAt }, escalatedToName),
        routedToMe: true as const,
      }));
    });

    // Round N — sign AFTER the tenant transaction (local SigV4 crypto, no DB);
    // the mapper strips avatarKey from every row.
    const data = await withSignedAvatars(this.signAvatar, queueRows);
    return { data, pagination: { page, limit, total: data.length } };
  }

  /**
   * Round L — one pending regularization the caller MAY ACT ON, whether or
   * not it is in their routed queue: the owner/HR-admin "open directly" path
   * behind the Inbox deep link (`/inbox?tab=approvals&request=<id>`). Same
   * row shape as `getAdminOverview().pending.regularizations[]`. 404 for
   * anything else — unknown, decided, or not the caller's to review — never
   * a 403 that would confirm the row exists.
   */
  async getRegularizationForReviewer(
    regularizationId: string,
    userId: string,
    tenantId: string,
    roleHint?: string,
  ) {
    const shaped = await this.databaseService.withTenant(tenantId, async (tx) => {
      const reviewer = await this.resolveReviewerScope(tx, userId, tenantId, roleHint);
      const escalatedTo = pgAlias(employees, 'reg_escalated_to');
      const [row] = await tx
        .select({
          id: attendanceRegularizations.id,
          employeeId: attendanceRegularizations.employee_id,
          userId: sql<string | null>`(SELECT m.user_id FROM memberships m WHERE m.employee_id = ${attendanceRegularizations.employee_id} AND m.tenant_id = ${attendanceRegularizations.tenant_id} AND m.status = 'active' LIMIT 1)`,
          employeeName: sql<string>`${employees.first_name} || ' ' || ${employees.last_name}`,
          employeeCode: employees.employee_code,
          employeeDeletedAt: employees.deleted_at,
          attendanceDate: attendanceRegularizations.attendance_date,
          requestType: attendanceRegularizations.request_type,
          proposedInTime: attendanceRegularizations.proposed_in_time,
          proposedOutTime: attendanceRegularizations.proposed_out_time,
          reason: attendanceRegularizations.reason,
          status: attendanceRegularizations.status,
          requestedAt: attendanceRegularizations.created_at,
          escalationLevel: attendanceRegularizations.escalation_level,
          escalationReason: attendanceRegularizations.escalation_reason,
          escalatedAt: attendanceRegularizations.escalated_at,
          escalatedTo: attendanceRegularizations.escalated_to_employee_id,
          escalatedToName: sql<string | null>`CASE WHEN ${escalatedTo.id} IS NULL THEN NULL ELSE ${escalatedTo.first_name} || ' ' || ${escalatedTo.last_name} END`,
          // Round N — signed below; neither field is ever returned raw.
          avatarKey: users.avatar_key,
          avatarUrlRaw: users.avatar_url,
        })
        .from(attendanceRegularizations)
        // Round N review: tenant-predicated join (see listPendingRegularizations)
        // — the detail view hands the reviewer this person's name AND photo.
        .leftJoin(
          employees,
          and(
            eq(attendanceRegularizations.employee_id, employees.id),
            eq(employees.tenant_id, tenantId),
          ),
        )
        .leftJoin(users, eq(employees.user_id, users.id))
        .leftJoin(
          escalatedTo,
          and(
            eq(escalatedTo.id, attendanceRegularizations.escalated_to_employee_id),
            eq(escalatedTo.tenant_id, tenantId),
          ),
        )
        .where(
          and(
            eq(attendanceRegularizations.id, regularizationId),
            eq(attendanceRegularizations.tenant_id, tenantId),
          ),
        )
        .limit(1);
      if (!row || row.status !== 'pending' || row.employeeDeletedAt) {
        throw new NotFoundException('Regularization not found');
      }
      try {
        await this.routing.assertMayActTx(
          tx,
          tenantId,
          reviewer,
          { applicantEmployeeId: row.employeeId, level: row.escalationLevel, escalatedTo: row.escalatedTo },
          'regularization',
        );
      } catch (e) {
        if (e instanceof ForbiddenException) throw new NotFoundException('Regularization not found');
        throw e;
      }
      return {
        id: row.id,
        employeeId: row.employeeId,
        userId: row.userId,
        employeeName: row.employeeName,
        employeeCode: row.employeeCode,
        attendanceDate: row.attendanceDate,
        requestType: row.requestType,
        proposedInTime: row.proposedInTime?.toISOString() ?? null,
        proposedOutTime: row.proposedOutTime?.toISOString() ?? null,
        reason: row.reason,
        status: row.status,
        requestedAt: row.requestedAt.toISOString(),
        // Round N — was a hard-coded null (initials forever). Carried out of
        // the tx as the key + legacy pair and signed below, so the pool
        // connection is never held for crypto.
        avatarKey: row.avatarKey,
        avatarUrlRaw: row.avatarUrlRaw,
        escalation: shapeEscalation(row, row.escalatedToName),
      };
    });
    // Round N — sign AFTER the tenant transaction; neither the key nor the
    // raw legacy column survives into the response.
    const { avatarKey, avatarUrlRaw, ...rest } = shaped;
    return { ...rest, avatarUrl: await this.signAvatar(avatarKey, avatarUrlRaw) };
  }

  async reviewRegularization(
    regularizationId: string,
    reviewerUserId: string,
    tenantId: string,
    dto: ReviewRegularizationDto,
    roleHint?: string,
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

        // Round L: one guard for every review path — the live reporting
        // manager always may act; the manager's manager once the request was
        // escalated to them; owner/admin always (opened directly); never the
        // applicant — through employees.user_id AND the membership bridge
        // (Round K: a row with user_id NULL used to skip the self check).
        const reviewer = await this.resolveReviewerScope(tx, reviewerUserId, tenantId, roleHint);
        const how = await this.routing.assertMayActTx(
          tx,
          tenantId,
          reviewer,
          {
            applicantEmployeeId: reg.employee_id,
            level: reg.escalation_level,
            escalatedTo: reg.escalated_to_employee_id,
          },
          'regularization',
        );
        // Decided over the routed manager's head (owner/admin directly, or
        // the skip-level manager)? They are told after commit.
        const onBehalfRoute =
          how === 'manager' ? null : await this.routing.resolveRouteTx(tx, tenantId, reg.employee_id);
        const [decider] = onBehalfRoute
          ? await tx
              .select({ firstName: employees.first_name, lastName: employees.last_name })
              .from(employees)
              .where(and(eq(employees.id, reviewerEmployeeId), eq(employees.tenant_id, tenantId)))
              .limit(1)
          : [undefined];

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

          // An approved WFH request marks the day's work_mode remote (status
          // stays 'present' — WFH is where you worked, not whether you did).
          const wfhMode =
            reg.request_type === 'wfh_request'
              ? { work_mode: 'remote' as const }
              : {};
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
                ...wfhMode,
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
              ...wfhMode,
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
            userId: employees.user_id,
          })
          .from(employees)
          .where(eq(employees.id, reg.employee_id))
          .limit(1);

        return {
          updated: updated!,
          requester,
          onBehalfRoute,
          deciderName: `${decider?.firstName ?? ''} ${decider?.lastName ?? ''}`.trim(),
          escalationLevel: reg.escalation_level,
        };
      },
    );

    // Round L: the routed manager (and the skip-level manager, once it had
    // reached them) learn that someone decided on their behalf. Best-effort.
    if (result.onBehalfRoute) {
      void this.routing.notifyDecidedOnBehalf(
        tenantId,
        'regularization',
        regularizationId,
        result.onBehalfRoute,
        result.escalationLevel,
        {
          deciderUserId: reviewerUserId,
          deciderName: result.deciderName,
          employeeName: `${result.requester?.firstName ?? ''} ${result.requester?.lastName ?? ''}`.trim(),
          action: dto.action,
        },
      );
    }

    // Round K: both decision notices open the requester's OWN log on that
    // month with the day highlighted (attendance_date is YYYY-MM-DD).
    const attendancePath = `/attendance?date=${result.updated.attendance_date}`;
    const attendanceUrl = `${this.appUrl()}${attendancePath}`;

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
          attendanceUrl,
        })
        .catch((err) =>
          this.logger.warn(`Regularization-review notification failed: ${err}`),
        );
    }

    // Real-time in-app ping to the requester with the decision. Best-effort.
    if (result.requester?.userId) {
      const approved = dto.action === 'approve';
      // Detached (round C): createInAppNotification never throws (enforced
      // at source) and the reviewer's CTA shouldn't wait for the inbox row.
      void this.notificationsService.createInAppNotification(
        result.requester.userId,
        approved ? 'regularization.approved' : 'regularization.rejected',
        `Your regularization for ${result.updated.attendance_date} was ${approved ? 'approved' : 'declined'}.`,
        attendancePath,
        tenantId,
      );
    }

    // Detached (round C): committed review; audit must not delay the CTA.
    void this.auditService.log({
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
