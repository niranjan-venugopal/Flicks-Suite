import { Injectable, Inject } from '@nestjs/common';
import { and, eq, inArray, isNull, sql, desc, asc, count } from 'drizzle-orm';
import {
  attendanceRecords,
  employees,
  users,
  departments,
  locations,
  leaveRequests,
  leaveTypes,
} from '@flicks/db/schema';
import { DB_SERVICE_ROLE } from '../../core/database/database.module';
import type { DbAdmin } from '@flicks/db';
import { MediaService } from '../media/media.service';
import type { ReportRangeDto } from './reports.dto';

// Default lookback windows when the caller doesn't pass from/to.
const DEFAULT_ATTENDANCE_DAYS = 30;

function rangeOrDefault(dto: ReportRangeDto, defaultDays: number) {
  const today = new Date();
  const to = dto.to ?? today.toISOString().slice(0, 10);
  const fromDate = new Date(`${to}T00:00:00`);
  fromDate.setUTCDate(fromDate.getUTCDate() - (defaultDays - 1));
  const from = dto.from ?? fromDate.toISOString().slice(0, 10);
  return { from, to };
}

@Injectable()
export class ReportsService {
  constructor(
    @Inject(DB_SERVICE_ROLE) private readonly db: DbAdmin,
    // Report rows show faces; the photo lives in users.avatar_key, so it has
    // to be signed here rather than read from the legacy avatar_url column.
    private readonly mediaService: MediaService,
  ) {}

  // ─── Attendance compliance ────────────────────────────────────────────────
  //
  // Aggregates attendance_records over a date range into:
  //   • range          { from, to, daysInRange }
  //   • totals         counts by attendance_status across all employees
  //   • compliance     present-rate, late-rate, avg lateness
  //   • dailyTrend     one row per date: present / late / on_leave / absent
  //   • byEmployee     top-20 by attendance count this period, with stats
  //
  async getAttendanceReport(tenantId: string, dto: ReportRangeDto) {
    const { from, to } = rangeOrDefault(dto, DEFAULT_ATTENDANCE_DAYS);

    const where = and(
      eq(attendanceRecords.tenant_id, tenantId),
      sql`${attendanceRecords.attendance_date} >= ${from}::date`,
      sql`${attendanceRecords.attendance_date} <= ${to}::date`,
    );

    // Totals by status
    const totalsRows = await this.db
      .select({
        status: attendanceRecords.attendance_status,
        n: sql<number>`COUNT(*)::int`,
      })
      .from(attendanceRecords)
      .where(where)
      .groupBy(attendanceRecords.attendance_status);

    const totals: Record<string, number> = {};
    let totalRecords = 0;
    for (const r of totalsRows) {
      totals[r.status] = Number(r.n);
      totalRecords += Number(r.n);
    }

    // Compliance — present-rate, late-rate, avg lateness minutes
    const [compliance] = await this.db
      .select({
        avgLateMinutes: sql<string>`COALESCE(AVG(${attendanceRecords.late_by_minutes}) FILTER (WHERE ${attendanceRecords.is_late} = true), 0)::text`,
        lateCount: sql<number>`COUNT(*) FILTER (WHERE ${attendanceRecords.is_late} = true)::int`,
        presentCount: sql<number>`COUNT(*) FILTER (WHERE ${attendanceRecords.attendance_status} IN ('present','late','work_from_home','on_duty'))::int`,
      })
      .from(attendanceRecords)
      .where(where);

    // Daily trend
    const dailyTrend = await this.db
      .select({
        date: attendanceRecords.attendance_date,
        present: sql<number>`COUNT(*) FILTER (WHERE ${attendanceRecords.attendance_status} = 'present')::int`,
        late: sql<number>`COUNT(*) FILTER (WHERE ${attendanceRecords.attendance_status} = 'late')::int`,
        onLeave: sql<number>`COUNT(*) FILTER (WHERE ${attendanceRecords.attendance_status} = 'on_leave')::int`,
        absent: sql<number>`COUNT(*) FILTER (WHERE ${attendanceRecords.attendance_status} = 'absent')::int`,
        wfh: sql<number>`COUNT(*) FILTER (WHERE ${attendanceRecords.attendance_status} = 'work_from_home')::int`,
      })
      .from(attendanceRecords)
      .where(where)
      .groupBy(attendanceRecords.attendance_date)
      .orderBy(asc(attendanceRecords.attendance_date));

    // Per-employee summary
    const byEmployee = await this.db
      .select({
        employeeId: attendanceRecords.employee_id,
        employeeCode: employees.employee_code,
        name: users.full_name,
        departmentName: departments.name,
        avatarUrl: users.avatar_url,
        avatarKey: users.avatar_key,
        recordCount: sql<number>`COUNT(*)::int`,
        presentCount: sql<number>`COUNT(*) FILTER (WHERE ${attendanceRecords.attendance_status} = 'present')::int`,
        lateCount: sql<number>`COUNT(*) FILTER (WHERE ${attendanceRecords.is_late} = true)::int`,
        avgLateMinutes: sql<string>`COALESCE(AVG(${attendanceRecords.late_by_minutes}) FILTER (WHERE ${attendanceRecords.is_late} = true), 0)::text`,
        minutesWorked: sql<number>`COALESCE(SUM(${attendanceRecords.total_worked_minutes}), 0)::int`,
      })
      .from(attendanceRecords)
      .leftJoin(employees, eq(attendanceRecords.employee_id, employees.id))
      .leftJoin(users, eq(employees.user_id, users.id))
      .leftJoin(departments, eq(employees.department_id, departments.id))
      .where(where)
      .groupBy(
        attendanceRecords.employee_id,
        employees.employee_code,
        users.full_name,
        users.avatar_url,
        users.avatar_key,
        departments.name,
      )
      .orderBy(desc(sql`COUNT(*)`))
      .limit(20);

    const daysInRange =
      Math.round(
        (new Date(`${to}T00:00:00`).getTime() -
          new Date(`${from}T00:00:00`).getTime()) /
          (1000 * 60 * 60 * 24),
      ) + 1;

    return {
      range: { from, to, daysInRange },
      totals: {
        total: totalRecords,
        present: totals['present'] ?? 0,
        late: totals['late'] ?? 0,
        absent: totals['absent'] ?? 0,
        onLeave: totals['on_leave'] ?? 0,
        workFromHome: totals['work_from_home'] ?? 0,
        holiday: totals['holiday'] ?? 0,
        weekend: totals['weekend'] ?? 0,
      },
      compliance: {
        presentRate:
          totalRecords > 0
            ? Number(compliance?.presentCount ?? 0) / totalRecords
            : 0,
        lateRate:
          totalRecords > 0
            ? Number(compliance?.lateCount ?? 0) / totalRecords
            : 0,
        avgLateMinutes: Math.round(Number(compliance?.avgLateMinutes ?? 0)),
      },
      dailyTrend: dailyTrend.map((r) => ({
        date: r.date,
        present: Number(r.present),
        late: Number(r.late),
        onLeave: Number(r.onLeave),
        absent: Number(r.absent),
        wfh: Number(r.wfh),
      })),
      byEmployee: await Promise.all(byEmployee.map(async (r) => ({
        employeeId: r.employeeId,
        employeeCode: r.employeeCode,
        name: r.name,
        avatarUrl: await this.mediaService.servedUrl(r.avatarKey, r.avatarUrl, 64),
        departmentName: r.departmentName,
        recordCount: Number(r.recordCount),
        presentCount: Number(r.presentCount),
        lateCount: Number(r.lateCount),
        avgLateMinutes: Math.round(Number(r.avgLateMinutes ?? 0)),
        hoursWorked: Math.round(Number(r.minutesWorked ?? 0) / 60),
        complianceRate:
          Number(r.recordCount) > 0
            ? Number(r.presentCount) / Number(r.recordCount)
            : 0,
      }))),
    };
  }

  // ─── Leave consumption ────────────────────────────────────────────────────
  //
  // Aggregates leave_requests in the date window (defaults to current year):
  //   • range
  //   • totals         counts by status, and grand totals
  //   • byType         per leave_type breakdown (with code + colour)
  //   • monthlyTrend   12 rows of approved days per month for the year
  //   • topConsumers   top-10 employees by approved days in the window
  //
  async getLeaveReport(tenantId: string, dto: ReportRangeDto) {
    const today = new Date();
    const year = today.getFullYear();
    const yearStart = `${year}-01-01`;
    const yearEnd = `${year}-12-31`;
    const from = dto.from ?? yearStart;
    const to = dto.to ?? yearEnd;

    const where = and(
      eq(leaveRequests.tenant_id, tenantId),
      sql`${leaveRequests.start_date} >= ${from}::date`,
      sql`${leaveRequests.start_date} <= ${to}::date`,
    );

    // Totals by status (count + sum of total_days)
    const statusRows = await this.db
      .select({
        status: leaveRequests.status,
        n: sql<number>`COUNT(*)::int`,
        days: sql<string>`COALESCE(SUM(${leaveRequests.total_days}), 0)::text`,
      })
      .from(leaveRequests)
      .where(where)
      .groupBy(leaveRequests.status);

    const totals = {
      requests: 0,
      pending: 0,
      approved: 0,
      rejected: 0,
      cancelled: 0,
      approvedDays: 0,
    };
    for (const r of statusRows) {
      totals.requests += Number(r.n);
      if (r.status === 'pending') totals.pending = Number(r.n);
      if (r.status === 'approved') {
        totals.approved = Number(r.n);
        totals.approvedDays = Number(r.days);
      }
      if (r.status === 'rejected') totals.rejected = Number(r.n);
      if (r.status === 'cancelled') totals.cancelled = Number(r.n);
    }

    // By leave type
    const byType = await this.db
      .select({
        leaveTypeId: leaveTypes.id,
        name: leaveTypes.name,
        code: leaveTypes.code,
        color: leaveTypes.color,
        approvedRequests: sql<number>`COUNT(${leaveRequests.id}) FILTER (WHERE ${leaveRequests.status} = 'approved')::int`,
        approvedDays: sql<string>`COALESCE(SUM(${leaveRequests.total_days}) FILTER (WHERE ${leaveRequests.status} = 'approved'), 0)::text`,
        pendingRequests: sql<number>`COUNT(${leaveRequests.id}) FILTER (WHERE ${leaveRequests.status} = 'pending')::int`,
      })
      .from(leaveTypes)
      .leftJoin(
        leaveRequests,
        and(
          eq(leaveRequests.leave_type_id, leaveTypes.id),
          sql`${leaveRequests.start_date} >= ${from}::date`,
          sql`${leaveRequests.start_date} <= ${to}::date`,
        ),
      )
      .where(eq(leaveTypes.tenant_id, tenantId))
      .groupBy(leaveTypes.id, leaveTypes.name, leaveTypes.code, leaveTypes.color, leaveTypes.display_order)
      .orderBy(asc(leaveTypes.display_order));

    // Monthly trend — 12 buckets across the calendar year
    const monthlyRows = await this.db
      .select({
        month: sql<string>`to_char(${leaveRequests.start_date}, 'YYYY-MM')`,
        days: sql<string>`COALESCE(SUM(${leaveRequests.total_days}), 0)::text`,
      })
      .from(leaveRequests)
      .where(
        and(
          eq(leaveRequests.tenant_id, tenantId),
          eq(leaveRequests.status, 'approved'),
          sql`${leaveRequests.start_date} >= ${yearStart}::date`,
          sql`${leaveRequests.start_date} <= ${yearEnd}::date`,
        ),
      )
      .groupBy(sql`to_char(${leaveRequests.start_date}, 'YYYY-MM')`)
      .orderBy(asc(sql`to_char(${leaveRequests.start_date}, 'YYYY-MM')`));

    const monthMap = new Map(monthlyRows.map((r) => [r.month, Number(r.days)]));
    const monthlyTrend = Array.from({ length: 12 }, (_, i) => {
      const m = String(i + 1).padStart(2, '0');
      const key = `${year}-${m}`;
      return { month: key, days: monthMap.get(key) ?? 0 };
    });

    // Top consumers (approved days)
    const topConsumers = await this.db
      .select({
        employeeId: leaveRequests.employee_id,
        name: users.full_name,
        employeeCode: employees.employee_code,
        avatarUrl: users.avatar_url,
        avatarKey: users.avatar_key,
        departmentName: departments.name,
        approvedDays: sql<string>`COALESCE(SUM(${leaveRequests.total_days}), 0)::text`,
        requestCount: sql<number>`COUNT(*)::int`,
      })
      .from(leaveRequests)
      .leftJoin(employees, eq(leaveRequests.employee_id, employees.id))
      .leftJoin(users, eq(employees.user_id, users.id))
      .leftJoin(departments, eq(employees.department_id, departments.id))
      .where(
        and(
          eq(leaveRequests.tenant_id, tenantId),
          eq(leaveRequests.status, 'approved'),
          sql`${leaveRequests.start_date} >= ${from}::date`,
          sql`${leaveRequests.start_date} <= ${to}::date`,
        ),
      )
      .groupBy(
        leaveRequests.employee_id,
        users.full_name,
        employees.employee_code,
        users.avatar_url,
        users.avatar_key,
        departments.name,
      )
      .orderBy(desc(sql`COALESCE(SUM(${leaveRequests.total_days}), 0)`))
      .limit(10);

    return {
      range: { from, to },
      totals,
      byType: byType.map((t) => ({
        leaveTypeId: t.leaveTypeId,
        name: t.name,
        code: t.code,
        color: t.color,
        approvedRequests: Number(t.approvedRequests),
        approvedDays: Number(t.approvedDays),
        pendingRequests: Number(t.pendingRequests),
      })),
      monthlyTrend,
      topConsumers: await Promise.all(topConsumers.map(async (c) => ({
        employeeId: c.employeeId,
        name: c.name,
        employeeCode: c.employeeCode,
        avatarUrl: await this.mediaService.servedUrl(c.avatarKey, c.avatarUrl, 64),
        departmentName: c.departmentName,
        approvedDays: Number(c.approvedDays),
        requestCount: Number(c.requestCount),
      }))),
    };
  }

  // ─── Headcount summary ────────────────────────────────────────────────────
  //
  // Snapshot of the workforce + a 12-month running headcount trend.
  //   • totals       active / on_leave / notice_period / separated counts
  //                  + joinedYTD + exitedYTD
  //   • monthlyTrend { month, joined, exited, runningBalance } for the last
  //                  12 months. runningBalance is computed in JS (no window
  //                  function gymnastics) — start from the current active
  //                  count and walk back month by month subtracting joins
  //                  and re-adding exits.
  //   • byDepartment dept name + active headcount
  //   • byLocation   location name + active headcount
  //   • byEmploymentType  full_time / part_time / contract / etc counts
  //
  async getHeadcountReport(tenantId: string) {
    const today = new Date();
    const year = today.getFullYear();
    const yearStart = `${year}-01-01`;
    const yearEnd = `${year}-12-31`;

    // Every employee query in this report funnels through here, so the
    // removed-employee filter belongs here too (round 21). A removed person
    // must not sit in headcount, attrition or the department/location splits —
    // and an ARCHIVED one still has their attendance rows, so leaving them in
    // would double-count against a re-hire.
    const tenantWhere = and(
      eq(employees.tenant_id, tenantId),
      isNull(employees.deleted_at),
    )!;

    // 1. Status counts (active / on_leave / notice_period / separated)
    const statusRows = await this.db
      .select({
        status: employees.status,
        n: sql<number>`COUNT(*)::int`,
      })
      .from(employees)
      .where(tenantWhere)
      .groupBy(employees.status);

    const statusCounts: Record<string, number> = {};
    for (const r of statusRows) statusCounts[r.status] = Number(r.n);

    const active = statusCounts['active'] ?? 0;
    const onLeave = statusCounts['on_leave'] ?? 0;
    const noticePeriod = statusCounts['notice_period'] ?? 0;
    const separated = statusCounts['separated'] ?? 0;
    const totalEverHired =
      active + onLeave + noticePeriod + separated + (statusCounts['absconded'] ?? 0);

    // 2. YTD joins / exits
    const [joinedYtd] = await this.db
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(employees)
      .where(
        and(
          tenantWhere,
          sql`${employees.date_of_joining} >= ${yearStart}::date`,
          sql`${employees.date_of_joining} <= ${yearEnd}::date`,
        ),
      );

    const [exitedYtd] = await this.db
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(employees)
      .where(
        and(
          tenantWhere,
          sql`${employees.date_of_exit} IS NOT NULL`,
          sql`${employees.date_of_exit} >= ${yearStart}::date`,
          sql`${employees.date_of_exit} <= ${yearEnd}::date`,
        ),
      );

    // 3. Monthly join/exit counts for the last 12 months (one row per month
    //    that has any activity — we backfill missing months in JS).
    const since = new Date(today);
    since.setUTCMonth(since.getUTCMonth() - 11);
    since.setUTCDate(1);
    const sinceStr = since.toISOString().slice(0, 10);

    const joinRows = await this.db
      .select({
        month: sql<string>`to_char(${employees.date_of_joining}, 'YYYY-MM')`,
        n: sql<number>`COUNT(*)::int`,
      })
      .from(employees)
      .where(
        and(
          tenantWhere,
          sql`${employees.date_of_joining} >= ${sinceStr}::date`,
        ),
      )
      .groupBy(sql`to_char(${employees.date_of_joining}, 'YYYY-MM')`);

    const exitRows = await this.db
      .select({
        month: sql<string>`to_char(${employees.date_of_exit}, 'YYYY-MM')`,
        n: sql<number>`COUNT(*)::int`,
      })
      .from(employees)
      .where(
        and(
          tenantWhere,
          sql`${employees.date_of_exit} IS NOT NULL`,
          sql`${employees.date_of_exit} >= ${sinceStr}::date`,
        ),
      )
      .groupBy(sql`to_char(${employees.date_of_exit}, 'YYYY-MM')`);

    const joinMap = new Map(joinRows.map((r) => [r.month, Number(r.n)]));
    const exitMap = new Map(exitRows.map((r) => [r.month, Number(r.n)]));

    // Build month list (oldest → newest)
    const months: string[] = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(today);
      d.setUTCMonth(d.getUTCMonth() - i);
      d.setUTCDate(1);
      months.push(d.toISOString().slice(0, 7)); // YYYY-MM
    }

    // Walk forward computing running balance.
    // Start from headcount AS OF the start of `months[0]`:
    //   activeNow - joinsAfterMonths[0] + exitsAfterMonths[0]
    //
    // Simpler: count of employees joined BEFORE months[0] and not exited
    // before months[0].
    const firstMonthStart = `${months[0]}-01`;
    const [{ baseline }] = await this.db
      .select({
        baseline: sql<number>`COUNT(*)::int`,
      })
      .from(employees)
      .where(
        and(
          tenantWhere,
          sql`${employees.date_of_joining} < ${firstMonthStart}::date`,
          sql`(${employees.date_of_exit} IS NULL OR ${employees.date_of_exit} >= ${firstMonthStart}::date)`,
        ),
      );

    let running = Number(baseline ?? 0);
    const monthlyTrend = months.map((m) => {
      const joined = joinMap.get(m) ?? 0;
      const exited = exitMap.get(m) ?? 0;
      running = running + joined - exited;
      return { month: m, joined, exited, headcount: running };
    });

    // 4. By department (active only)
    const byDepartment = await this.db
      .select({
        departmentId: departments.id,
        name: departments.name,
        headcount: sql<number>`COUNT(${employees.id})::int`,
      })
      .from(departments)
      .leftJoin(
        employees,
        and(
          eq(employees.department_id, departments.id),
          eq(employees.status, 'active'),
        ),
      )
      .where(eq(departments.tenant_id, tenantId))
      .groupBy(departments.id, departments.name)
      .orderBy(desc(sql`COUNT(${employees.id})`));

    // 5. By location (active only)
    const locationsRows = await this.db
      .select({
        locationId: employees.location_id,
        headcount: sql<number>`COUNT(*)::int`,
      })
      .from(employees)
      .where(and(tenantWhere, eq(employees.status, 'active')))
      .groupBy(employees.location_id);
    // Resolve names with a small lookup
    const locationIds = locationsRows
      .map((r) => r.locationId)
      .filter((id): id is string => Boolean(id));
    // Resolve names with a small lookup using proper Drizzle helpers.
    // (The earlier raw-SQL approach failed at runtime — `from(sql\`locations\`)`
    // isn't supported and `${ids}::uuid[]` interpolation was malformed.)
    const locationNames = locationIds.length
      ? await this.db
          .select({ id: locations.id, name: locations.name })
          .from(locations)
          .where(inArray(locations.id, locationIds))
      : [];
    const nameById = new Map(locationNames.map((n) => [n.id, n.name]));
    const byLocation = locationsRows
      .map((r) => ({
        locationId: r.locationId,
        name: r.locationId ? nameById.get(r.locationId) ?? 'Unknown' : 'Unassigned',
        headcount: Number(r.headcount),
      }))
      .sort((a, b) => b.headcount - a.headcount);

    // 6. By employment type (active only)
    const empTypeRows = await this.db
      .select({
        type: employees.employment_type,
        headcount: sql<number>`COUNT(*)::int`,
      })
      .from(employees)
      .where(and(tenantWhere, eq(employees.status, 'active')))
      .groupBy(employees.employment_type);

    return {
      asOf: today.toISOString().slice(0, 10),
      year,
      totals: {
        totalEverHired,
        active,
        onLeave,
        noticePeriod,
        separated,
        joinedYtd: Number(joinedYtd?.n ?? 0),
        exitedYtd: Number(exitedYtd?.n ?? 0),
        netChangeYtd: Number(joinedYtd?.n ?? 0) - Number(exitedYtd?.n ?? 0),
      },
      monthlyTrend,
      byDepartment: byDepartment.map((d) => ({
        departmentId: d.departmentId,
        name: d.name,
        headcount: Number(d.headcount),
      })),
      byLocation,
      byEmploymentType: empTypeRows.map((r) => ({
        type: r.type,
        headcount: Number(r.headcount),
      })),
    };
  }
}
