import {
  Injectable,
  Logger,
  Inject,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { and, eq, gte, lte, desc, asc, sql, isNull } from 'drizzle-orm';
import {
  timesheetPeriods,
  timesheetEntries,
  timesheetReworkRequests,
  employees,
  users,
  memberships,
} from '@flicks/db/schema';
import { DB_TENANT, DB_SERVICE_ROLE } from '../../core/database/database.module';
import type { Db, DbAdmin } from '@flicks/db';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import type {
  BulkSaveEntriesDto,
  SubmitTimesheetDto,
  ReviewTimesheetDto,
  TimesheetListQueryDto,
} from './timesheet.dto';

/**
 * Returns the Monday–Sunday week containing the given date as
 * { start, end } in YYYY-MM-DD form. Uses UTC-day arithmetic — calendar
 * weeks, not wall-clock instants.
 */
function weekBoundaries(d: Date): { start: string; end: string } {
  const day = d.getUTCDay() || 7; // 1=Mon..7=Sun (Sun maps to 7 not 0)
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - (day - 1));
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return {
    start: monday.toISOString().slice(0, 10),
    end: sunday.toISOString().slice(0, 10),
  };
}

@Injectable()
export class TimesheetService {
  private readonly logger = new Logger(TimesheetService.name);

  constructor(
    @Inject(DB_TENANT) private readonly db: Db,
    @Inject(DB_SERVICE_ROLE) private readonly dbAdmin: DbAdmin,
    private readonly auditService: AuditService,
    private readonly notificationsService: NotificationsService,
  ) {}

  // ─── Internal helpers ──────────────────────────────────────────────────

  private async resolveCaller(userId: string, tenantId: string) {
    const [row] = await this.db
      .select({
        employeeId: employees.id,
        reportingManagerId: employees.reporting_manager_id,
      })
      .from(memberships)
      .innerJoin(employees, eq(memberships.employee_id, employees.id))
      .where(
        and(
          eq(memberships.user_id, userId),
          eq(memberships.tenant_id, tenantId),
        ),
      )
      .limit(1);
    if (!row?.employeeId) {
      throw new NotFoundException('No employee record for this user');
    }
    return row as { employeeId: string; reportingManagerId: string | null };
  }

  private rollup(entries: Array<{ hours: number; isBillable?: boolean | null }>) {
    let total = 0;
    let billable = 0;
    for (const e of entries) {
      total += e.hours;
      if (e.isBillable) billable += e.hours;
    }
    return { total, billable, nonBillable: total - billable };
  }

  private shapePeriod(
    p: typeof timesheetPeriods.$inferSelect,
    rework?: { comment: string; createdAt: Date } | null,
  ) {
    return {
      id: p.id,
      employeeId: p.employee_id,
      periodStart: p.period_start,
      periodEnd: p.period_end,
      status: p.status,
      totalHours: p.total_hours,
      totalBillableHours: p.total_billable_hours,
      totalNonBillableHours: p.total_non_billable_hours,
      approverId: p.approver_id,
      submittedAt: p.submitted_at?.toISOString() ?? null,
      approvedAt: p.approved_at?.toISOString() ?? null,
      rejectedAt: p.rejected_at?.toISOString() ?? null,
      rejectionComment: p.rejection_comment,
      latestReworkComment: rework?.comment ?? null,
      latestReworkAt: rework?.createdAt?.toISOString() ?? null,
    };
  }

  /** Latest open (unresolved) rework request for a period, or null. */
  private async getLatestRework(periodId: string) {
    const [r] = await this.db
      .select({
        comment: timesheetReworkRequests.comment,
        createdAt: timesheetReworkRequests.created_at,
      })
      .from(timesheetReworkRequests)
      .where(
        and(
          eq(timesheetReworkRequests.timesheet_period_id, periodId),
          isNull(timesheetReworkRequests.resolved_at),
        ),
      )
      .orderBy(desc(timesheetReworkRequests.created_at))
      .limit(1);
    return r ?? null;
  }

  // ─── 1. Get-or-create the caller's current week period ────────────────

  async getMyCurrentPeriod(userId: string, tenantId: string) {
    const { employeeId, reportingManagerId } = await this.resolveCaller(
      userId,
      tenantId,
    );
    const { start, end } = weekBoundaries(new Date());

    const [existing] = await this.db
      .select()
      .from(timesheetPeriods)
      .where(
        and(
          eq(timesheetPeriods.tenant_id, tenantId),
          eq(timesheetPeriods.employee_id, employeeId),
          eq(timesheetPeriods.period_start, start),
          eq(timesheetPeriods.period_end, end),
        ),
      )
      .limit(1);

    if (existing) {
      const rework = await this.getLatestRework(existing.id);
      return this.shapePeriod(existing, rework);
    }

    const [created] = await this.db
      .insert(timesheetPeriods)
      .values({
        tenant_id: tenantId,
        employee_id: employeeId,
        period_start: start,
        period_end: end,
        status: 'draft',
        approver_id: reportingManagerId,
      })
      .returning();

    return this.shapePeriod(created);
  }

  // ─── 2. List the caller's periods ──────────────────────────────────────

  async listMine(
    userId: string,
    tenantId: string,
    query: TimesheetListQueryDto,
  ) {
    const { employeeId } = await this.resolveCaller(userId, tenantId);
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, 100);
    const offset = (page - 1) * limit;

    const conditions = [
      eq(timesheetPeriods.tenant_id, tenantId),
      eq(timesheetPeriods.employee_id, employeeId),
    ];
    if (query.status) {
      conditions.push(
        eq(
          timesheetPeriods.status,
          query.status as 'draft' | 'submitted' | 'approved' | 'rejected' | 'locked',
        ),
      );
    }
    if (query.fromDate) {
      conditions.push(gte(timesheetPeriods.period_start, query.fromDate));
    }
    if (query.toDate) {
      conditions.push(lte(timesheetPeriods.period_end, query.toDate));
    }

    const [rows, totalRow] = await Promise.all([
      this.db
        .select()
        .from(timesheetPeriods)
        .where(and(...conditions))
        .orderBy(desc(timesheetPeriods.period_start))
        .limit(limit)
        .offset(offset),
      this.db
        .select({ n: sql<number>`COUNT(*)::int` })
        .from(timesheetPeriods)
        .where(and(...conditions)),
    ]);

    const reworks = await Promise.all(
      rows.map((r) => this.getLatestRework(r.id)),
    );

    return {
      data: rows.map((r, i) => this.shapePeriod(r, reworks[i])),
      pagination: { page, limit, total: Number(totalRow[0]?.n ?? 0) },
    };
  }

  // ─── 3. Entries for a given period ─────────────────────────────────────

  async getEntries(
    timesheetPeriodId: string,
    userId: string,
    tenantId: string,
  ) {
    const [period] = await this.db
      .select()
      .from(timesheetPeriods)
      .where(
        and(
          eq(timesheetPeriods.id, timesheetPeriodId),
          eq(timesheetPeriods.tenant_id, tenantId),
        ),
      )
      .limit(1);

    if (!period) {
      throw new NotFoundException('Timesheet period not found');
    }

    const { employeeId } = await this.resolveCaller(userId, tenantId);
    const isAuthor = period.employee_id === employeeId;
    const isApprover = period.approver_id === employeeId;
    if (!isAuthor && !isApprover) {
      throw new ForbiddenException('Not allowed to view this timesheet');
    }

    const entries = await this.db
      .select()
      .from(timesheetEntries)
      .where(eq(timesheetEntries.timesheet_period_id, timesheetPeriodId))
      .orderBy(asc(timesheetEntries.entry_date));

    const rework = await this.getLatestRework(period.id);

    return {
      timesheetPeriodId,
      period: this.shapePeriod(period, rework),
      entries: entries.map((e) => ({
        id: e.id,
        entryDate: e.entry_date,
        hours: e.hours,
        category: e.category,
        isBillable: e.is_billable,
        description: e.description,
        projectId: e.project_id,
        taskId: e.task_id,
      })),
    };
  }

  // ─── 4. Bulk save entries (replace-all on a draft) ─────────────────────

  async saveEntries(
    userId: string,
    tenantId: string,
    dto: BulkSaveEntriesDto,
  ) {
    const { employeeId } = await this.resolveCaller(userId, tenantId);

    const [period] = await this.db
      .select()
      .from(timesheetPeriods)
      .where(
        and(
          eq(timesheetPeriods.id, dto.timesheetPeriodId),
          eq(timesheetPeriods.tenant_id, tenantId),
        ),
      )
      .limit(1);

    if (!period) throw new NotFoundException('Timesheet period not found');
    if (period.employee_id !== employeeId) {
      throw new ForbiddenException("Cannot save another employee's timesheet");
    }
    if (period.status !== 'draft') {
      throw new BadRequestException(
        `Timesheet is ${period.status} and cannot be edited`,
      );
    }

    // Reject >24h on any single day across the submitted entries.
    const dayTotals = new Map<string, number>();
    for (const e of dto.entries) {
      dayTotals.set(e.entryDate, (dayTotals.get(e.entryDate) ?? 0) + e.hours);
    }
    for (const [day, hours] of dayTotals) {
      if (hours > 24) {
        throw new BadRequestException(`More than 24 hours logged on ${day}`);
      }
    }

    // Replace-all: drop the period's existing entries then insert new ones.
    await this.db
      .delete(timesheetEntries)
      .where(eq(timesheetEntries.timesheet_period_id, period.id));

    if (dto.entries.length > 0) {
      await this.db.insert(timesheetEntries).values(
        dto.entries.map((e) => ({
          tenant_id: tenantId,
          timesheet_period_id: period.id,
          employee_id: employeeId,
          entry_date: e.entryDate,
          hours: e.hours,
          category: e.category as typeof timesheetEntries.$inferInsert['category'],
          is_billable: e.isBillable ?? false,
          description: e.description ?? null,
          project_id: e.projectId ?? null,
          task_id: e.taskId ?? null,
        })),
      );
    }

    // Refresh the totals on the period header.
    const totals = this.rollup(
      dto.entries.map((e) => ({
        hours: e.hours,
        isBillable: e.isBillable ?? false,
      })),
    );
    await this.db
      .update(timesheetPeriods)
      .set({
        total_hours: totals.total,
        total_billable_hours: totals.billable,
        total_non_billable_hours: totals.nonBillable,
        updated_at: new Date(),
      })
      .where(eq(timesheetPeriods.id, period.id));

    await this.auditService.log({
      tenantId,
      actorUserId: userId,
      action: 'timesheet.entries.saved',
      resourceType: 'timesheet_period',
      resourceId: period.id,
      metadata: {
        entryCount: dto.entries.length,
        totalHours: totals.total,
      },
    });

    return {
      timesheetPeriodId: period.id,
      entryCount: dto.entries.length,
      totalHours: totals.total,
      totalBillableHours: totals.billable,
    };
  }

  // ─── 5. Submit for review ──────────────────────────────────────────────

  async submitTimesheet(
    userId: string,
    tenantId: string,
    dto: SubmitTimesheetDto,
  ) {
    const { employeeId, reportingManagerId } = await this.resolveCaller(
      userId,
      tenantId,
    );

    const [period] = await this.db
      .select()
      .from(timesheetPeriods)
      .where(
        and(
          eq(timesheetPeriods.id, dto.timesheetPeriodId),
          eq(timesheetPeriods.tenant_id, tenantId),
        ),
      )
      .limit(1);

    if (!period) throw new NotFoundException('Timesheet period not found');
    if (period.employee_id !== employeeId) {
      throw new ForbiddenException("Cannot submit another employee's timesheet");
    }
    if (period.status !== 'draft') {
      throw new BadRequestException(
        `Timesheet is ${period.status}; only draft timesheets can be submitted`,
      );
    }
    if (period.total_hours <= 0) {
      throw new BadRequestException('Add at least one entry before submitting');
    }

    const approverId = period.approver_id ?? reportingManagerId;
    if (!approverId) {
      throw new BadRequestException(
        'No approver configured. Ask HR to set your reporting manager first.',
      );
    }

    const submittedAt = new Date();
    await this.db
      .update(timesheetPeriods)
      .set({
        status: 'submitted',
        submitted_at: submittedAt,
        approver_id: approverId,
        updated_at: submittedAt,
      })
      .where(eq(timesheetPeriods.id, period.id));

    // Any open rework requests are addressed by this submission.
    await this.db
      .update(timesheetReworkRequests)
      .set({ resolved_at: submittedAt })
      .where(
        and(
          eq(timesheetReworkRequests.timesheet_period_id, period.id),
          isNull(timesheetReworkRequests.resolved_at),
        ),
      );

    // Resolve approver email + name for the notification.
    const [approver] = await this.dbAdmin
      .select({
        email: users.email,
        fullName: users.full_name,
      })
      .from(employees)
      .leftJoin(users, eq(employees.user_id, users.id))
      .where(eq(employees.id, approverId))
      .limit(1);

    if (approver?.email) {
      try {
        await this.notificationsService.sendEmail(
          'timesheet-submitted',
          approver.email,
          {
            approverName: approver.fullName ?? 'there',
            periodStart: period.period_start,
            periodEnd: period.period_end,
            totalHours: period.total_hours,
          },
        );
      } catch (e) {
        this.logger.warn(
          `Could not send timesheet-submitted email to ${approver.email}: ${(e as Error).message}`,
        );
      }
    }

    await this.auditService.log({
      tenantId,
      actorUserId: userId,
      action: 'timesheet.submitted',
      resourceType: 'timesheet_period',
      resourceId: period.id,
      metadata: { totalHours: period.total_hours, approverId },
    });

    return {
      id: period.id,
      status: 'submitted' as const,
      submittedAt: submittedAt.toISOString(),
    };
  }

  // ─── 6. List pending (manager view) ────────────────────────────────────

  async listPending(
    userId: string,
    tenantId: string,
    query: TimesheetListQueryDto,
  ) {
    const { employeeId } = await this.resolveCaller(userId, tenantId);
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, 100);
    const offset = (page - 1) * limit;

    const conditions = [
      eq(timesheetPeriods.tenant_id, tenantId),
      eq(timesheetPeriods.approver_id, employeeId),
      eq(timesheetPeriods.status, 'submitted' as const),
    ];

    const [rows, totalRow] = await Promise.all([
      this.db
        .select({
          id: timesheetPeriods.id,
          employeeId: timesheetPeriods.employee_id,
          employeeCode: employees.employee_code,
          employeeName: sql<string>`COALESCE(${employees.first_name}, '') || ' ' || COALESCE(${employees.last_name}, '')`,
          periodStart: timesheetPeriods.period_start,
          periodEnd: timesheetPeriods.period_end,
          totalHours: timesheetPeriods.total_hours,
          totalBillableHours: timesheetPeriods.total_billable_hours,
          submittedAt: timesheetPeriods.submitted_at,
        })
        .from(timesheetPeriods)
        .leftJoin(employees, eq(timesheetPeriods.employee_id, employees.id))
        .where(and(...conditions))
        .orderBy(desc(timesheetPeriods.submitted_at))
        .limit(limit)
        .offset(offset),
      this.db
        .select({ n: sql<number>`COUNT(*)::int` })
        .from(timesheetPeriods)
        .where(and(...conditions)),
    ]);

    return {
      data: rows,
      pagination: { page, limit, total: Number(totalRow[0]?.n ?? 0) },
    };
  }

  // ─── 7. Review (approve / reject / rework) ─────────────────────────────

  async reviewTimesheet(
    timesheetPeriodId: string,
    reviewerUserId: string,
    tenantId: string,
    dto: ReviewTimesheetDto,
  ) {
    const { employeeId } = await this.resolveCaller(reviewerUserId, tenantId);

    const [period] = await this.db
      .select()
      .from(timesheetPeriods)
      .where(
        and(
          eq(timesheetPeriods.id, timesheetPeriodId),
          eq(timesheetPeriods.tenant_id, tenantId),
        ),
      )
      .limit(1);

    if (!period) throw new NotFoundException('Timesheet period not found');
    if (period.approver_id !== employeeId) {
      throw new ForbiddenException('You are not the approver for this timesheet');
    }
    if (period.status !== 'submitted') {
      throw new BadRequestException(
        `Timesheet is ${period.status}; only submitted timesheets can be reviewed`,
      );
    }
    if (dto.action === 'reject' && !dto.comment?.trim()) {
      throw new BadRequestException('A comment is required when rejecting');
    }
    if (dto.action === 'rework' && !dto.comment?.trim()) {
      throw new BadRequestException(
        'A comment explaining the changes is required when requesting rework',
      );
    }

    const now = new Date();
    let newStatus: 'approved' | 'rejected' | 'draft';
    const update: Record<string, unknown> = { updated_at: now };

    if (dto.action === 'approve') {
      newStatus = 'approved';
      update.status = 'approved';
      update.approved_at = now;
    } else if (dto.action === 'reject') {
      newStatus = 'rejected';
      update.status = 'rejected';
      update.rejected_at = now;
      update.rejection_comment = dto.comment;
    } else {
      // rework — re-open the period for editing
      newStatus = 'draft';
      update.status = 'draft';
      update.submitted_at = null;
    }

    await this.db
      .update(timesheetPeriods)
      .set(update)
      .where(eq(timesheetPeriods.id, period.id));

    if (dto.action === 'rework') {
      await this.db.insert(timesheetReworkRequests).values({
        tenant_id: tenantId,
        timesheet_period_id: period.id,
        requested_by: reviewerUserId,
        comment: dto.comment!,
      });
    }

    await this.auditService.log({
      tenantId,
      actorUserId: reviewerUserId,
      action:
        dto.action === 'approve'
          ? 'timesheet.approved'
          : dto.action === 'reject'
            ? 'timesheet.rejected'
            : 'timesheet.rework_requested',
      resourceType: 'timesheet_period',
      resourceId: period.id,
      metadata: { comment: dto.comment },
    });

    // Push an in-app notification to the timesheet's owner so they see
    // the manager's decision next time they open the app.
    const [ownerUser] = await this.dbAdmin
      .select({ userId: employees.user_id })
      .from(employees)
      .where(eq(employees.id, period.employee_id))
      .limit(1);
    if (ownerUser?.userId) {
      const verb =
        dto.action === 'approve'
          ? 'approved'
          : dto.action === 'reject'
            ? 'rejected'
            : 'sent back for changes';
      await this.notificationsService.createInAppNotification(
        ownerUser.userId,
        `timesheet.${dto.action}`,
        `Your timesheet for ${period.period_start} was ${verb}.`,
        '/timesheets',
        period.tenant_id,
      );
    }

    return {
      id: period.id,
      status: newStatus,
      reviewedAt: now.toISOString(),
    };
  }
}
