import { Injectable, Logger } from '@nestjs/common';
import { and, asc, desc, eq, gte, lt, lte, ne, sql, isNull } from 'drizzle-orm';
import type { AnyColumn, SQL } from 'drizzle-orm';
import {
  employees,
  attendanceRecords,
  attendanceRegularizations,
  leaveRequests,
  leaveTypes,
  holidays,
  auditLog,
  users,
  designations,
} from '@flicks/db/schema';
import { DatabaseService } from '../../core/database/database.service';
import { MediaService } from '../media/media.service';
import type { AdminOverviewDto, ActivityItemDto } from './dashboard.dto';

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  constructor(
    private readonly databaseService: DatabaseService,
    // Approval rows in the Inbox render faces; the photo lives in
    // users.avatar_key and has to be signed before it reaches the client.
    private readonly mediaService: MediaService,
  ) {}

  /** Signed-URL swap for a row set carrying `avatarKey` (§4 media pipeline). */
  private async withAvatars<
    T extends { avatarKey: string | null; avatarUrl: string | null },
  >(rows: T[]): Promise<Omit<T, 'avatarKey'>[]> {
    return Promise.all(
      rows.map(async ({ avatarKey, ...row }) => ({
        ...(row as Omit<T, 'avatarKey'>),
        avatarUrl: await this.mediaService.servedUrl(avatarKey, row.avatarUrl, 64),
      })),
    );
  }

  /**
   * Returns everything the customer admin dashboard renders, in one
   * round-trip. All sub-queries run in parallel inside a single
   * tenant-scoped transaction so RLS context is set once per request
   * (PRD §10.6: dashboard must load <1.5s for a 50-employee tenant).
   */
  async getAdminOverview(
    tenantId: string,
    opts: {
      callerUserId: string;
      includeOnboarding: boolean;
      /** Approver roles only — a plain employee has no approvals queue. */
      includeApprovals: boolean;
    },
  ): Promise<AdminOverviewDto> {
    const today = todayISO();
    const thirtyDaysAgo = isoDaysAgo(30);

    /**
     * Approvals a caller may act on: never their own. An owner/admin clears
     * the review guard by role, so their own leave/regularization must be kept
     * out of their queue and counts — another approver has to act on it (the
     * same rule the onboarding bucket below already applies).
     *
     * The employee↔user link exists in two places (employees.user_id and the
     * active membership), so both are checked: a request is "mine" if either
     * points at the caller.
     */
    const notOwnRequest = (employeeIdCol: SQL | AnyColumn) =>
      opts.includeApprovals
        ? sql`NOT EXISTS (
              SELECT 1 FROM employees e
               WHERE e.id = ${employeeIdCol}
                 AND e.tenant_id = ${tenantId}
                 AND e.user_id = ${opts.callerUserId}
            )
            AND NOT EXISTS (
              SELECT 1 FROM memberships m
               WHERE m.employee_id = ${employeeIdCol}
                 AND m.tenant_id = ${tenantId}
                 AND m.status = 'active'
                 AND m.user_id = ${opts.callerUserId}
            )`
        : sql`false`;

    return this.databaseService.withTenant(tenantId, async (tx) => {
      const [
        headcountRows,
        attendanceTodayRows,
        pendingLeaveCountRow,
        pendingRegCountRow,
        pendingLeaveRows,
        pendingRegRows,
        complianceRow,
        leaveConsumedRow,
        joinersExitsRow,
        avgHoursRow,
        holidayTodayRow,
        pendingOnboardingRows,
      ] = await Promise.all([
        // Headcount by employee_status
        tx
          .select({
            status: employees.status,
            count: sql<number>`COUNT(*)::int`,
          })
          .from(employees)
          .where(eq(employees.tenant_id, tenantId))
          .groupBy(employees.status),

        // Attendance today by status
        tx
          .select({
            status: attendanceRecords.attendance_status,
            count: sql<number>`COUNT(*)::int`,
          })
          .from(attendanceRecords)
          .where(
            and(
              eq(attendanceRecords.tenant_id, tenantId),
              eq(attendanceRecords.attendance_date, today),
            ),
          )
          .groupBy(attendanceRecords.attendance_status),

        // Pending leaves count
        tx
          .select({ count: sql<number>`COUNT(*)::int` })
          .from(leaveRequests)
          .where(
            and(
              eq(leaveRequests.tenant_id, tenantId),
              eq(leaveRequests.status, 'pending'),
              notOwnRequest(leaveRequests.employee_id),
            ),
          ),

        // Pending regularizations count
        tx
          .select({ count: sql<number>`COUNT(*)::int` })
          .from(attendanceRegularizations)
          .where(
            and(
              eq(attendanceRegularizations.tenant_id, tenantId),
              eq(attendanceRegularizations.status, 'pending'),
              notOwnRequest(attendanceRegularizations.employee_id),
            ),
          ),

        // Top 5 pending leaves with employee + type names
        tx
          .select({
            id: leaveRequests.id,
            employeeId: leaveRequests.employee_id,
            // Correlated subquery, not a join: (tenant_id, employee_id) is not
            // unique on memberships, so a join could duplicate pending rows.
            userId: sql<string | null>`(SELECT m.user_id FROM memberships m WHERE m.employee_id = ${leaveRequests.employee_id} AND m.tenant_id = ${leaveRequests.tenant_id} AND m.status = 'active' LIMIT 1)`,
            employeeName: sql<string>`${employees.first_name} || ' ' || ${employees.last_name}`,
            employeeCode: employees.employee_code,
            startDate: leaveRequests.start_date,
            endDate: leaveRequests.end_date,
            totalDays: leaveRequests.total_days,
            reason: leaveRequests.reason,
            appliedAt: leaveRequests.applied_at,
            avatarUrl: users.avatar_url,
            avatarKey: users.avatar_key,
            leaveTypeName: leaveTypes.name,
            leaveTypeCode: leaveTypes.code,
          })
          .from(leaveRequests)
          .leftJoin(employees, eq(leaveRequests.employee_id, employees.id))
          .leftJoin(users, eq(employees.user_id, users.id))
          .leftJoin(leaveTypes, eq(leaveRequests.leave_type_id, leaveTypes.id))
          .where(
            and(
              eq(leaveRequests.tenant_id, tenantId),
              eq(leaveRequests.status, 'pending'),
              notOwnRequest(leaveRequests.employee_id),
            ),
          )
          .orderBy(desc(leaveRequests.applied_at))
          .limit(5),

        // Top 5 pending regularizations
        tx
          .select({
            id: attendanceRegularizations.id,
            employeeId: attendanceRegularizations.employee_id,
            // Same correlated-subquery rationale as the leaves select above.
            userId: sql<string | null>`(SELECT m.user_id FROM memberships m WHERE m.employee_id = ${attendanceRegularizations.employee_id} AND m.tenant_id = ${attendanceRegularizations.tenant_id} AND m.status = 'active' LIMIT 1)`,
            employeeName: sql<string>`${employees.first_name} || ' ' || ${employees.last_name}`,
            employeeCode: employees.employee_code,
            attendanceDate: attendanceRegularizations.attendance_date,
            requestType: attendanceRegularizations.request_type,
            reason: attendanceRegularizations.reason,
            requestedAt: attendanceRegularizations.created_at,
            avatarUrl: users.avatar_url,
            avatarKey: users.avatar_key,
          })
          .from(attendanceRegularizations)
          .leftJoin(
            employees,
            eq(attendanceRegularizations.employee_id, employees.id),
          )
          .leftJoin(users, eq(employees.user_id, users.id))
          .where(
            and(
              eq(attendanceRegularizations.tenant_id, tenantId),
              eq(attendanceRegularizations.status, 'pending'),
              notOwnRequest(attendanceRegularizations.employee_id),
            ),
          )
          .orderBy(desc(attendanceRegularizations.created_at))
          .limit(5),

        // 30-day attendance compliance: count('present' OR 'late' OR 'work_from_home')
        // / count(non-weekend, non-holiday rows). Returned as one row of two ints.
        tx
          .select({
            present: sql<number>`SUM(CASE WHEN ${attendanceRecords.attendance_status} IN ('present','late','work_from_home') THEN 1 ELSE 0 END)::int`,
            workingTotal: sql<number>`SUM(CASE WHEN ${attendanceRecords.attendance_status} NOT IN ('weekend','holiday') THEN 1 ELSE 0 END)::int`,
          })
          .from(attendanceRecords)
          .where(
            and(
              eq(attendanceRecords.tenant_id, tenantId),
              gte(attendanceRecords.attendance_date, thirtyDaysAgo),
              lt(attendanceRecords.attendance_date, isoDaysAgo(-1)), // up to today inclusive
            ),
          ),

        // Sum of approved leave_days in last 30 days (overlap on start_date)
        tx
          .select({
            total: sql<number>`COALESCE(SUM(${leaveRequests.total_days}), 0)::float`,
          })
          .from(leaveRequests)
          .where(
            and(
              eq(leaveRequests.tenant_id, tenantId),
              eq(leaveRequests.status, 'approved'),
              gte(leaveRequests.start_date, thirtyDaysAgo),
            ),
          ),

        // Joiners (date_of_joining within 30d) + exits (date_of_exit within 30d)
        tx
          .select({
            joiners: sql<number>`SUM(CASE WHEN ${employees.date_of_joining} >= ${thirtyDaysAgo} THEN 1 ELSE 0 END)::int`,
            exits: sql<number>`SUM(CASE WHEN ${employees.date_of_exit} IS NOT NULL AND ${employees.date_of_exit} >= ${thirtyDaysAgo} THEN 1 ELSE 0 END)::int`,
          })
          .from(employees)
          .where(eq(employees.tenant_id, tenantId)),

        // Avg working hours for fully-worked days in last 30d
        tx
          .select({
            avgMinutes: sql<number | null>`AVG(${attendanceRecords.total_worked_minutes})::float`,
            sampleCount: sql<number>`COUNT(*)::int`,
          })
          .from(attendanceRecords)
          .where(
            and(
              eq(attendanceRecords.tenant_id, tenantId),
              gte(attendanceRecords.attendance_date, thirtyDaysAgo),
              eq(attendanceRecords.attendance_status, 'present'),
            ),
          ),

        // Is today a holiday for this tenant?
        tx
          .select({ count: sql<number>`COUNT(*)::int` })
          .from(holidays)
          .where(
            and(
              eq(holidays.tenant_id, tenantId),
              eq(holidays.holiday_date, today),
            ),
          ),

        // Pending onboarding reviews (Inbox → Approvals). Admin+-only — the
        // endpoint has no @Roles, so the controller gates via
        // includeOnboarding; lower roles get an empty bucket. The caller's
        // own row is excluded (nobody reviews their own profile) with
        // IS DISTINCT FROM so invited rows (user_id NULL) stay visible.
        opts.includeOnboarding
          ? tx
              .select({
                employeeId: employees.id,
                userId: employees.user_id,
                employeeName: sql<string>`COALESCE(NULLIF(TRIM(COALESCE(${employees.first_name},'') || ' ' || COALESCE(${employees.last_name},'')), ''), ${users.full_name}, '')`,
                employeeCode: employees.employee_code,
                designationTitle: designations.title,
                avatarUrl: users.avatar_url,
                avatarKey: users.avatar_key,
                submittedAt: sql<string | null>`${employees.custom_fields}->>'onboarding_submitted_at'`,
              })
              .from(employees)
              .leftJoin(users, eq(employees.user_id, users.id))
              .leftJoin(
                designations,
                eq(employees.designation_id, designations.id),
              )
              .where(
                and(
                  eq(employees.tenant_id, tenantId),
                  sql`(${employees.custom_fields}->>'onboarding_submitted_for_review')::boolean = true`,
                  ne(employees.status, 'active'),
                  sql`${employees.user_id} IS DISTINCT FROM ${opts.callerUserId}`,
                  // Round 18: an owner/admin seat is the owners' to sign off —
                  // a peer admin holds the same powers, so it would be
                  // self-review by proxy. Expressed in SQL (not a new opts
                  // field) so getAdminOverview's signature — and its five
                  // call sites in founder-round8.spec.ts — stay untouched.
                  // Mirrors employees.service.getOnboardingQueue, including
                  // the no-active-owner escape hatch.
                  sql`(
                    NOT EXISTS (
                      SELECT 1 FROM memberships mt
                       WHERE mt.tenant_id = ${tenantId}
                         AND mt.role IN ('owner','admin')
                         AND (mt.employee_id = ${employees.id}
                              OR mt.user_id = ${employees.user_id})
                    )
                    OR EXISTS (
                      SELECT 1 FROM memberships mc
                       WHERE mc.tenant_id = ${tenantId}
                         AND mc.user_id = ${opts.callerUserId}
                         AND mc.status = 'active'
                         AND mc.role = 'owner'
                    )
                    OR NOT EXISTS (
                      SELECT 1 FROM memberships mo
                       WHERE mo.tenant_id = ${tenantId}
                         AND mo.status = 'active'
                         AND mo.role = 'owner'
                    )
                  )`,
                ),
              )
              .orderBy(asc(employees.created_at))
          : Promise.resolve(
              [] as Array<{
                employeeId: string;
                userId: string | null;
                employeeName: string;
                employeeCode: string | null;
                designationTitle: string | null;
                avatarUrl: string | null;
                avatarKey: string | null;
                submittedAt: string | null;
              }>,
            ),
      ]);

      // ── Aggregate the headcount rows by status enum ──
      const headcount = {
        active: 0,
        notice: 0,
        onLeave: 0,
        inactive: 0,
      };
      for (const r of headcountRows) {
        if (r.status === 'active') headcount.active = r.count;
        else if (r.status === 'notice_period') headcount.notice = r.count;
        else if (r.status === 'on_leave') headcount.onLeave = r.count;
        else if (r.status === 'inactive') headcount.inactive = r.count;
      }
      const totalEmployees =
        headcount.active + headcount.notice + headcount.onLeave;

      // ── Attendance today: pivot rows into named buckets ──
      const att = {
        present: 0,
        late: 0,
        onLeave: 0,
        yetToClockIn: 0,
        holiday: 0,
      };
      for (const r of attendanceTodayRows) {
        if (r.status === 'present') att.present += r.count;
        else if (r.status === 'late') att.late += r.count;
        else if (r.status === 'work_from_home') att.present += r.count;
        else if (r.status === 'on_leave') att.onLeave += r.count;
        else if (r.status === 'holiday') att.holiday += r.count;
      }
      // "yet to clock in" = active employees minus those already accounted for.
      // Holiday-aware: if today is a tenant-wide holiday, no one is expected.
      const isTodayHoliday = (holidayTodayRow[0]?.count ?? 0) > 0;
      if (!isTodayHoliday) {
        const accounted = att.present + att.late + att.onLeave;
        att.yetToClockIn = Math.max(0, headcount.active - accounted);
      }

      // ── Trends ──
      const c = complianceRow[0] ?? { present: 0, workingTotal: 0 };
      const compliance =
        (c.workingTotal ?? 0) > 0
          ? Math.round(((c.present ?? 0) / c.workingTotal) * 1000) / 10 // 1 decimal
          : null;

      const avgMinutes = avgHoursRow[0]?.avgMinutes ?? null;
      const avgHours =
        avgMinutes != null && (avgHoursRow[0]?.sampleCount ?? 0) > 0
          ? Math.round((avgMinutes / 60) * 100) / 100
          : null;

      const joiners = joinersExitsRow[0]?.joiners ?? 0;
      const exits = joinersExitsRow[0]?.exits ?? 0;

      // ── Build response ──
      return {
        generatedAt: new Date().toISOString(),
        stats: {
          totalEmployees,
          presentToday: att.present + att.late,
          onLeaveToday: att.onLeave,
          pendingApprovals:
            (pendingLeaveCountRow[0]?.count ?? 0) +
            (pendingRegCountRow[0]?.count ?? 0) +
            pendingOnboardingRows.length,
        },
        headcount,
        attendanceToday: att,
        pending: {
          leaveCount: pendingLeaveCountRow[0]?.count ?? 0,
          regularizationCount: pendingRegCountRow[0]?.count ?? 0,
          onboardingCount: pendingOnboardingRows.length,
          onboarding: await this.withAvatars(pendingOnboardingRows),
          leaves: await Promise.all(pendingLeaveRows.map(async (r) => ({
            id: r.id,
            employeeId: r.employeeId,
            // The requester's user id drives the Inbox presence dot — it is
            // selected above, so ship it instead of dropping it here.
            userId: r.userId,
            employeeName: r.employeeName,
            employeeCode: r.employeeCode,
            leaveTypeName: r.leaveTypeName,
            leaveTypeCode: r.leaveTypeCode,
            startDate: r.startDate,
            endDate: r.endDate,
            totalDays: Number(r.totalDays),
            reason: r.reason,
            appliedAt:
              r.appliedAt instanceof Date
                ? r.appliedAt.toISOString()
                : String(r.appliedAt),
            avatarUrl: await this.mediaService.servedUrl(r.avatarKey, r.avatarUrl, 64),
          }))),
          regularizations: await Promise.all(pendingRegRows.map(async (r) => ({
            id: r.id,
            employeeId: r.employeeId,
            userId: r.userId,
            employeeName: r.employeeName,
            employeeCode: r.employeeCode,
            attendanceDate: r.attendanceDate,
            requestType: r.requestType,
            reason: r.reason,
            requestedAt:
              r.requestedAt instanceof Date
                ? r.requestedAt.toISOString()
                : String(r.requestedAt),
            avatarUrl: await this.mediaService.servedUrl(r.avatarKey, r.avatarUrl, 64),
          }))),
        },
        trends: {
          attendanceCompliancePct: compliance,
          leaveDaysConsumed: Number(leaveConsumedRow[0]?.total ?? 0),
          headcountDelta: { joiners, exits, net: joiners - exits },
          avgWorkingHours: avgHours,
        },
      };
    });
  }

  /**
   * Returns the most recent tenant-scoped audit log entries with the
   * actor's full_name resolved. Cursor pagination via `before` (id of the
   * oldest item the client already has).
   */
  async getActivity(
    tenantId: string,
    opts: { limit?: number; before?: string } = {},
  ): Promise<ActivityItemDto[]> {
    const limit = Math.min(opts.limit ?? 20, 100);

    return this.databaseService.withTenant(tenantId, async (tx) => {
      // Resolve the cursor's created_at (if provided) — we paginate by
      // (created_at DESC, id DESC) to be deterministic with same-second rows.
      let cursorTimestamp: Date | null = null;
      if (opts.before) {
        const [cursorRow] = await tx
          .select({ ts: auditLog.created_at })
          .from(auditLog)
          .where(
            and(
              eq(auditLog.tenant_id, tenantId),
              eq(auditLog.id, opts.before),
            ),
          )
          .limit(1);
        if (cursorRow) cursorTimestamp = cursorRow.ts;
      }

      const rows = await tx
        .select({
          id: auditLog.id,
          action: auditLog.action,
          resourceType: auditLog.resource_type,
          resourceId: auditLog.resource_id,
          actorUserId: auditLog.actor_user_id,
          actorName: users.full_name,
          metadata: auditLog.metadata,
          createdAt: auditLog.created_at,
        })
        .from(auditLog)
        .leftJoin(users, eq(auditLog.actor_user_id, users.id))
        .where(
          and(
            eq(auditLog.tenant_id, tenantId),
            cursorTimestamp
              ? lt(auditLog.created_at, cursorTimestamp)
              : sql`TRUE`,
          ),
        )
        .orderBy(desc(auditLog.created_at), desc(auditLog.id))
        .limit(limit);

      return rows.map((r) => ({
        id: r.id,
        action: r.action,
        resourceType: r.resourceType,
        resourceId: r.resourceId,
        actorUserId: r.actorUserId,
        actorName: r.actorName,
        metadata: (r.metadata as Record<string, unknown> | null) ?? null,
        createdAt:
          r.createdAt instanceof Date
            ? r.createdAt.toISOString()
            : String(r.createdAt),
      }));
    });
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Returns YYYY-MM-DD for `n` days ago (negative = in the future). */
function isoDaysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}
