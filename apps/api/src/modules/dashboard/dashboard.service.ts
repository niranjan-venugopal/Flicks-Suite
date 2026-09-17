import { Injectable, Logger, Optional } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, lt, ne, sql, isNull } from 'drizzle-orm';
import type { AnyColumn, SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  employees,
  attendanceRecords,
  attendanceRegularizations,
  leaveRequests,
  leaveTypes,
  timesheetPeriods,
  auditLog,
  users,
  designations,
  memberships,
} from '@flicks/db/schema';
import type { Db } from '@flicks/db';
import { DatabaseService } from '../../core/database/database.service';
import { resolveExpectationsTx, tenantTodayISOTx } from '../../core/common/workday';
import { MediaService } from '../media/media.service';
import { ApprovalRoutingService, shapeEscalation } from '../approvals/public';
import type { ReviewerCtx, RoutedColumns } from '../approvals/public';
import type { AdminOverviewDto, ActivityItemDto } from './dashboard.dto';

/** Empty "attendance today" pivot — every bucket present, all zero. */
function emptyAttendanceToday(): AdminOverviewDto['attendanceToday'] {
  return {
    present: 0,
    late: 0,
    onLeave: 0,
    yetToClockIn: 0,
    holiday: 0,
    weekend: 0,
    pendingLeave: 0,
    expectedToday: 0,
  };
}

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  /** Round L — the routed approval queue (who sees which pending item). */
  private readonly routing: ApprovalRoutingService;

  constructor(
    private readonly databaseService: DatabaseService,
    // Approval rows in the Inbox render faces; the photo lives in
    // users.avatar_key and has to be signed before it reaches the client.
    private readonly mediaService: MediaService,
    // Optional so the specs that build `new DashboardService(db, media)` keep
    // compiling; the dashboard only READS routing (predicate + reviewer), so
    // an unbound routing service is fully functional here.
    @Optional() routing?: ApprovalRoutingService,
  ) {
    this.routing = routing ?? new ApprovalRoutingService();
  }

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
      /**
       * Round I — `team` narrows every people-derived number (headcount,
       * attendance today, trends, pending requests) to the caller's DIRECT
       * REPORTS (`employees.reporting_manager_id`). The manager dashboard
       * used to label the tenant-wide headcount "Direct reports" while the
       * Direct reports page showed the manager-scoped list — 7 vs 3. Default
       * `org` keeps every existing caller unchanged.
       */
      scope?: 'org' | 'team';
      /**
       * Round K — how many pending leaves / regularizations to LIST (the
       * counts are unaffected). Default 5 for the dashboard card; the Inbox
       * asks for 50 so a 6th request is reachable. Clamped to 1..50; scope
       * and the own-request exclusion apply exactly as before.
       */
      pendingLimit?: number;
    },
  ): Promise<AdminOverviewDto> {
    const thirtyDaysAgo = isoDaysAgo(30);
    const scope = opts.scope ?? 'org';
    const pendingLimit = Number.isFinite(opts.pendingLimit)
      ? Math.min(50, Math.max(1, Math.floor(opts.pendingLimit as number)))
      : 5;

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
      // Team scope: resolve the caller's employee row FIRST (inside the same
      // tenant transaction) so every query below can be narrowed to their
      // direct reports. A manager seat without an employee row has no team —
      // that yields an EMPTY dashboard, never a tenant-wide one.
      let managerEmployeeId: string | null = null;
      if (scope === 'team') {
        const [m] = await tx
          .select({ employeeId: memberships.employee_id })
          .from(memberships)
          .where(
            and(
              eq(memberships.tenant_id, tenantId),
              eq(memberships.user_id, opts.callerUserId),
              eq(memberships.status, 'active'),
            ),
          )
          .limit(1);
        managerEmployeeId = m?.employeeId ?? null;
      }
      /**
       * `inScope(employeeIdCol)` — true for every row in org scope; in team
       * scope, true only when the row's employee reports directly to the
       * caller (and is not removed). Applied to every people-derived query.
       */
      const inScope = (employeeIdCol: SQL | AnyColumn): SQL =>
        scope === 'org'
          ? sql`true`
          : managerEmployeeId
            ? sql`EXISTS (
                SELECT 1 FROM employees r
                 WHERE r.id = ${employeeIdCol}
                   AND r.tenant_id = ${tenantId}
                   AND r.reporting_manager_id = ${managerEmployeeId}
                   AND r.deleted_at IS NULL
              )`
            : sql`false`;

      // Round L: "today" for workspace-wide numbers is the tenant's day
      // (default shift timezone → tenant timezone → IST). The old UTC date
      // named tomorrow for every Indian tenant after 17:30 IST.
      const today = await tenantTodayISOTx(tx, tenantId);

      /**
       * Round L (item 2): the approval buckets are ROUTED, not scoped — an
       * owner/HR admin used to see (and act on) every request from minute
       * zero, ahead of the manager. `routedTo(table, col)` is the one queue
       * predicate every approval surface shares (modules/approvals): direct
       * reports, items escalated to the caller, and for owner/admin items at
       * level 2 or with no manager at all; never the caller's own.
       */
      const reviewer: ReviewerCtx | null = opts.includeApprovals
        ? await this.routing.resolveReviewerTx(
            tx,
            tenantId,
            opts.callerUserId,
            scope === 'team' ? 'manager' : undefined,
          )
        : null;
      const routedTo = (table: RoutedColumns, employeeIdCol: SQL | AnyColumn): SQL =>
        reviewer ? this.routing.queuePredicate(reviewer, table, employeeIdCol) : sql`false`;
      const escalatedTo = alias(employees, 'dash_escalated_to');
      const escalatedToName = sql<string | null>`CASE WHEN ${escalatedTo.id} IS NULL THEN NULL ELSE ${escalatedTo.first_name} || ' ' || ${escalatedTo.last_name} END`;

      const [
        headcountRows,
        attendanceToday,
        pendingLeaveCountRow,
        pendingRegCountRow,
        pendingLeaveRows,
        pendingRegRows,
        pendingTsCountRow,
        pendingTsRows,
        complianceRow,
        leaveConsumedRow,
        joinersExitsRow,
        avgHoursRow,
        pendingOnboardingRows,
      ] = await Promise.all([
        // Headcount by employee_status
        tx
          .select({
            status: employees.status,
            count: sql<number>`COUNT(*)::int`,
          })
          .from(employees)
          // Removed employees leave the headcount tiles (round 21).
          .where(and(eq(employees.tenant_id, tenantId), isNull(employees.deleted_at), inScope(employees.id)))
          .groupBy(employees.status),

        // Attendance today — Round L (founder item 1): active roster →
        // per-employee day expectation (holiday / weekend / leave, from the
        // shared resolver) → today's records, pivoted in code. "Yet to clock
        // in" is now expected ∧ no record ∧ no pending leave, instead of
        // "headcount minus rows" (which counted everyone on leave, on a
        // holiday or on their weekend as a missed punch).
        this.attendanceTodayPivot(tx, tenantId, today, inScope, opts.includeApprovals),

        // Pending leaves count (routed — Round L)
        tx
          .select({ count: sql<number>`COUNT(*)::int` })
          .from(leaveRequests)
          .where(
            and(
              eq(leaveRequests.tenant_id, tenantId),
              eq(leaveRequests.status, 'pending'),
              notOwnRequest(leaveRequests.employee_id),
              routedTo(leaveRequests, leaveRequests.employee_id),
            ),
          ),

        // Pending regularizations count (routed — Round L)
        tx
          .select({ count: sql<number>`COUNT(*)::int` })
          .from(attendanceRegularizations)
          .where(
            and(
              eq(attendanceRegularizations.tenant_id, tenantId),
              eq(attendanceRegularizations.status, 'pending'),
              notOwnRequest(attendanceRegularizations.employee_id),
              routedTo(attendanceRegularizations, attendanceRegularizations.employee_id),
            ),
          ),

        // Top `pendingLimit` pending leaves with employee + type names
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
            escalationLevel: leaveRequests.escalation_level,
            escalationReason: leaveRequests.escalation_reason,
            escalatedAt: leaveRequests.escalated_at,
            escalatedToName,
          })
          .from(leaveRequests)
          .leftJoin(employees, eq(leaveRequests.employee_id, employees.id))
          .leftJoin(users, eq(employees.user_id, users.id))
          .leftJoin(leaveTypes, eq(leaveRequests.leave_type_id, leaveTypes.id))
          .leftJoin(
            escalatedTo,
            and(eq(escalatedTo.id, leaveRequests.escalated_to_employee_id), eq(escalatedTo.tenant_id, tenantId)),
          )
          .where(
            and(
              eq(leaveRequests.tenant_id, tenantId),
              eq(leaveRequests.status, 'pending'),
              notOwnRequest(leaveRequests.employee_id),
              routedTo(leaveRequests, leaveRequests.employee_id),
            ),
          )
          .orderBy(desc(leaveRequests.applied_at))
          .limit(pendingLimit),

        // Top `pendingLimit` pending regularizations
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
            // Round K: the Inbox detail shows the proposed times the
            // reviewer is about to write into the attendance record.
            proposedInTime: attendanceRegularizations.proposed_in_time,
            proposedOutTime: attendanceRegularizations.proposed_out_time,
            reason: attendanceRegularizations.reason,
            requestedAt: attendanceRegularizations.created_at,
            avatarUrl: users.avatar_url,
            avatarKey: users.avatar_key,
            escalationLevel: attendanceRegularizations.escalation_level,
            escalationReason: attendanceRegularizations.escalation_reason,
            escalatedAt: attendanceRegularizations.escalated_at,
            escalatedToName,
          })
          .from(attendanceRegularizations)
          .leftJoin(
            employees,
            eq(attendanceRegularizations.employee_id, employees.id),
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
              eq(attendanceRegularizations.tenant_id, tenantId),
              eq(attendanceRegularizations.status, 'pending'),
              notOwnRequest(attendanceRegularizations.employee_id),
              routedTo(attendanceRegularizations, attendanceRegularizations.employee_id),
            ),
          )
          .orderBy(desc(attendanceRegularizations.created_at))
          .limit(pendingLimit),

        // Round L: submitted timesheets routed to the caller — count + rows.
        tx
          .select({ count: sql<number>`COUNT(*)::int` })
          .from(timesheetPeriods)
          .where(
            and(
              eq(timesheetPeriods.tenant_id, tenantId),
              eq(timesheetPeriods.status, 'submitted'),
              notOwnRequest(timesheetPeriods.employee_id),
              routedTo(timesheetPeriods, timesheetPeriods.employee_id),
            ),
          ),
        tx
          .select({
            id: timesheetPeriods.id,
            employeeId: timesheetPeriods.employee_id,
            userId: sql<string | null>`(SELECT m.user_id FROM memberships m WHERE m.employee_id = ${timesheetPeriods.employee_id} AND m.tenant_id = ${timesheetPeriods.tenant_id} AND m.status = 'active' LIMIT 1)`,
            employeeName: sql<string>`${employees.first_name} || ' ' || ${employees.last_name}`,
            employeeCode: employees.employee_code,
            periodStart: timesheetPeriods.period_start,
            periodEnd: timesheetPeriods.period_end,
            totalHours: timesheetPeriods.total_hours,
            totalBillableHours: timesheetPeriods.total_billable_hours,
            submittedAt: timesheetPeriods.submitted_at,
            avatarUrl: users.avatar_url,
            avatarKey: users.avatar_key,
            escalationLevel: timesheetPeriods.escalation_level,
            escalationReason: timesheetPeriods.escalation_reason,
            escalatedAt: timesheetPeriods.escalated_at,
            escalatedToName,
          })
          .from(timesheetPeriods)
          .leftJoin(employees, eq(timesheetPeriods.employee_id, employees.id))
          .leftJoin(users, eq(employees.user_id, users.id))
          .leftJoin(
            escalatedTo,
            and(eq(escalatedTo.id, timesheetPeriods.escalated_to_employee_id), eq(escalatedTo.tenant_id, tenantId)),
          )
          .where(
            and(
              eq(timesheetPeriods.tenant_id, tenantId),
              eq(timesheetPeriods.status, 'submitted'),
              notOwnRequest(timesheetPeriods.employee_id),
              routedTo(timesheetPeriods, timesheetPeriods.employee_id),
            ),
          )
          .orderBy(desc(timesheetPeriods.submitted_at))
          .limit(pendingLimit),

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
              inScope(attendanceRecords.employee_id),
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
              inScope(leaveRequests.employee_id),
            ),
          ),

        // Joiners (date_of_joining within 30d) + exits (date_of_exit within 30d)
        tx
          .select({
            joiners: sql<number>`SUM(CASE WHEN ${employees.date_of_joining} >= ${thirtyDaysAgo} THEN 1 ELSE 0 END)::int`,
            exits: sql<number>`SUM(CASE WHEN ${employees.date_of_exit} IS NOT NULL AND ${employees.date_of_exit} >= ${thirtyDaysAgo} THEN 1 ELSE 0 END)::int`,
          })
          .from(employees)
          // ...and the 30-day joiners/exits trend.
          .where(and(eq(employees.tenant_id, tenantId), isNull(employees.deleted_at), inScope(employees.id))),

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
              inScope(attendanceRecords.employee_id),
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

      // ── Attendance today ── pivoted by attendanceTodayPivot (Round L).
      const att = attendanceToday;

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
        scope,
        stats: {
          totalEmployees,
          // Round L: `present` already includes the late arrivals (late is
          // the subset the snapshot calls out), so this is no longer a sum.
          presentToday: att.present,
          onLeaveToday: att.onLeave,
          // Round L: timesheets join the badge count.
          pendingApprovals:
            (pendingLeaveCountRow[0]?.count ?? 0) +
            (pendingRegCountRow[0]?.count ?? 0) +
            (pendingTsCountRow[0]?.count ?? 0) +
            pendingOnboardingRows.length,
        },
        headcount,
        attendanceToday: att,
        pending: {
          leaveCount: pendingLeaveCountRow[0]?.count ?? 0,
          regularizationCount: pendingRegCountRow[0]?.count ?? 0,
          timesheetCount: pendingTsCountRow[0]?.count ?? 0,
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
            escalation: shapeEscalation(r, r.escalatedToName),
          }))),
          regularizations: await Promise.all(pendingRegRows.map(async (r) => ({
            id: r.id,
            employeeId: r.employeeId,
            userId: r.userId,
            employeeName: r.employeeName,
            employeeCode: r.employeeCode,
            attendanceDate: r.attendanceDate,
            requestType: r.requestType,
            proposedInTime: r.proposedInTime?.toISOString() ?? null,
            proposedOutTime: r.proposedOutTime?.toISOString() ?? null,
            reason: r.reason,
            requestedAt:
              r.requestedAt instanceof Date
                ? r.requestedAt.toISOString()
                : String(r.requestedAt),
            avatarUrl: await this.mediaService.servedUrl(r.avatarKey, r.avatarUrl, 64),
            escalation: shapeEscalation(r, r.escalatedToName),
          }))),
          timesheets: await Promise.all(pendingTsRows.map(async (r) => ({
            id: r.id,
            employeeId: r.employeeId,
            userId: r.userId,
            employeeName: r.employeeName,
            employeeCode: r.employeeCode,
            periodStart: r.periodStart,
            periodEnd: r.periodEnd,
            totalHours: Number(r.totalHours),
            totalBillableHours: Number(r.totalBillableHours),
            submittedAt: r.submittedAt instanceof Date ? r.submittedAt.toISOString() : r.submittedAt ? String(r.submittedAt) : null,
            avatarUrl: await this.mediaService.servedUrl(r.avatarKey, r.avatarUrl, 64),
            escalation: shapeEscalation(r, r.escalatedToName),
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
   * Round L — the "Attendance today" buckets for the snapshot card, derived
   * from the shared day resolver (core/common/workday.ts):
   *
   *   present       rows in present/late/wfh/on_duty/comp_off, or half_day
   *                 with a punch (late arrivals INCLUDED — `late` is a subset)
   *   late          rows in late
   *   onLeave       on_leave rows + approved full-day leave without a row
   *   holiday       holiday rows + a blocking holiday without a row
   *   weekend       weekend rows + a non-working day (shift) without a row
   *   pendingLeave  expected, no row, a pending request covers the day
   *   yetToClockIn  expected, no row, no pending request
   *   expectedToday everyone whose day is a working (or half-day-leave) day
   */
  private async attendanceTodayPivot(
    tx: Db,
    tenantId: string,
    today: string,
    inScope: (employeeIdCol: SQL | AnyColumn) => SQL,
    /** Only approvers get `pendingLeave` (the same gate as the pending buckets). */
    includeApprovals: boolean,
  ): Promise<AdminOverviewDto['attendanceToday']> {
    const att = emptyAttendanceToday();
    const roster = await tx
      .select({ id: employees.id })
      .from(employees)
      .where(
        and(
          eq(employees.tenant_id, tenantId),
          isNull(employees.deleted_at),
          eq(employees.status, 'active'),
          inScope(employees.id),
        ),
      );
    const ids = roster.map((r) => r.id);
    if (ids.length === 0) return att;

    const [expectations, records] = await Promise.all([
      resolveExpectationsTx(tx, tenantId, ids, today),
      tx
        .select({
          employeeId: attendanceRecords.employee_id,
          status: attendanceRecords.attendance_status,
          firstPunchInAt: attendanceRecords.first_punch_in_at,
        })
        .from(attendanceRecords)
        .where(
          and(
            eq(attendanceRecords.tenant_id, tenantId),
            inArray(attendanceRecords.employee_id, ids),
            eq(attendanceRecords.attendance_date, today),
          ),
        ),
    ]);
    const recordBy = new Map(records.map((r) => [r.employeeId, r]));

    for (const id of ids) {
      const exp = expectations.get(id) ?? null;
      const rec = recordBy.get(id) ?? null;
      const expected = exp?.expected ?? true;
      if (expected) att.expectedToday++;

      const hasPunch = !!rec?.firstPunchInAt;
      // A row that says nothing about the day (absent, or a leave backfill —
      // half_day / on_leave — before any punch) is read from the expectation:
      // a cancelled leave may leave its row behind.
      const usable =
        rec !== null &&
        rec.status !== 'absent' &&
        !(!hasPunch && (rec.status === 'half_day' || rec.status === 'on_leave'));

      if (usable && rec) {
        switch (rec.status) {
          case 'present':
          case 'work_from_home':
          case 'on_duty':
          case 'comp_off':
          case 'half_day':
            att.present++;
            break;
          case 'late':
            att.present++;
            att.late++;
            break;
          case 'on_leave':
            att.onLeave++;
            break;
          case 'holiday':
            att.holiday++;
            break;
          case 'weekend':
            att.weekend++;
            break;
          default:
            break;
        }
        continue;
      }

      switch (exp?.kind ?? 'working') {
        case 'leave':
          att.onLeave++;
          break;
        case 'holiday':
          att.holiday++;
          break;
        case 'weekend':
          att.weekend++;
          break;
        default:
          // A pending request is an approvals fact: only reviewers get the
          // count; everyone else sees the person under "yet to clock in",
          // which they still are.
          if (exp?.pendingLeave && includeApprovals) att.pendingLeave++;
          else if (expected) att.yetToClockIn++;
          break;
      }
    }
    return att;
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
// (Round L: the UTC `todayISO()` is gone — "today" comes from tenantTodayISOTx
// inside the transaction. The 30-day trend windows below stay UTC-based.)

/** Returns YYYY-MM-DD for `n` days ago (negative = in the future). */
function isoDaysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}
