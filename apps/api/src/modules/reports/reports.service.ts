import { Injectable, Inject } from '@nestjs/common';
import { and, eq, sql, desc, asc, count } from 'drizzle-orm';
import {
  attendanceRecords,
  employees,
  users,
  departments,
  leaveRequests,
  leaveTypes,
} from '@flicks/db/schema';
import { DB_SERVICE_ROLE } from '../../core/database/database.module';
import type { DbAdmin } from '@flicks/db';
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
  constructor(@Inject(DB_SERVICE_ROLE) private readonly db: DbAdmin) {}

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
      byEmployee: byEmployee.map((r) => ({
        employeeId: r.employeeId,
        employeeCode: r.employeeCode,
        name: r.name,
        avatarUrl: r.avatarUrl,
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
      })),
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
      topConsumers: topConsumers.map((c) => ({
        employeeId: c.employeeId,
        name: c.name,
        employeeCode: c.employeeCode,
        avatarUrl: c.avatarUrl,
        departmentName: c.departmentName,
        approvedDays: Number(c.approvedDays),
        requestCount: Number(c.requestCount),
      })),
    };
  }
}
