import { Injectable, Logger } from '@nestjs/common';
import { and, asc, desc, eq, gte, lt, lte, ne, sql, isNull } from 'drizzle-orm';
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
import type { AdminOverviewDto, ActivityItemDto } from './dashboard.dto';

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  constructor(private readonly databaseService: DatabaseService) {}

  /**
   * Returns everything the customer admin dashboard renders, in one
   * round-trip. All sub-queries run in parallel inside a single
   * tenant-scoped transaction so RLS context is set once per request
   * (PRD §10.6: dashboard must load <1.5s for a 50-employee tenant).
   */
  async getAdminOverview(
    tenantId: string,
    opts: { callerUserId: string; includeOnboarding: boolean },
  ): Promise<AdminOverviewDto> {
    const today = todayISO();
    const thirtyDaysAgo = isoDaysAgo(30);

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
            leaveTypeName: leaveTypes.name,
            leaveTypeCode: leaveTypes.code,
          })
          .from(leaveRequests)
          .leftJoin(employees, eq(leaveRequests.employee_id, employees.id))
          .leftJoin(leaveTypes, eq(leaveRequests.leave_type_id, leaveTypes.id))
          .where(
            and(
              eq(leaveRequests.tenant_id, tenantId),
              eq(leaveRequests.status, 'pending'),
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
          onboarding: pendingOnboardingRows,
          leaves: pendingLeaveRows.map((r) => ({
            id: r.id,
            employeeId: r.employeeId,
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
          })),
          regularizations: pendingRegRows.map((r) => ({
            id: r.id,
            employeeId: r.employeeId,
            employeeName: r.employeeName,
            employeeCode: r.employeeCode,
            attendanceDate: r.attendanceDate,
            requestType: r.requestType,
            reason: r.reason,
            requestedAt:
              r.requestedAt instanceof Date
                ? r.requestedAt.toISOString()
                : String(r.requestedAt),
          })),
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
