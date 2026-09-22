import {
  Injectable,
  Logger,
  Inject,
  Optional,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { and, eq, gte, lte, desc, asc, sql, isNull } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  timesheetPeriods,
  timesheetEntries,
  timesheetReworkRequests,
  employees,
  users,
  memberships,
  tenants,
} from '@flicks/db/schema';
import { DB_SERVICE_ROLE } from '../../core/database/database.module';
import type { Db, DbAdmin } from '@flicks/db';
import { DatabaseService } from '../../core/database/database.service';
import { tenantTodayISOTx } from '../../core/common/workday';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  ApprovalRoutingService,
  RESET_ESCALATION,
  approvalDeepLink,
  authorRoutingView,
  routeStateColumns,
  shapeEscalation,
} from '../approvals/public';
import { MediaService } from '../media/media.service';
import { withSignedAvatars } from '../../core/storage/signed-avatar';
import type {
  BulkSaveEntriesDto,
  SubmitTimesheetDto,
  ReviewTimesheetDto,
  TimesheetListQueryDto,
  TeamTimesheetQueryDto,
} from './timesheet.dto';

// Round L: the org-wide role list, the queue predicate and the may-act guard
// live in modules/approvals (ORG_WIDE_REVIEW_ROLES is exported from there).

/**
 * Returns the 7-day week containing the given date as { start, end } in
 * YYYY-MM-DD form, starting on the tenant's `week_starts_on` day
 * (0=Sunday..6=Saturday; default Monday). Uses UTC-day arithmetic —
 * calendar weeks, not wall-clock instants. Historical periods keep their
 * stored dates when the setting changes; only future get-or-creates key on
 * the new boundary.
 */
function weekBoundaries(
  d: Date,
  weekStartsOn = 1,
): { start: string; end: string } {
  const diff = (d.getUTCDay() - weekStartsOn + 7) % 7;
  const start = new Date(d);
  start.setUTCDate(d.getUTCDate() - diff);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

@Injectable()
export class TimesheetService {
  private readonly logger = new Logger(TimesheetService.name);

  // Tenant-table reads/writes go through databaseService.withTenant(tenantId, …)
  // so app.tenant_id is set and RLS resolves correctly under the NOBYPASSRLS
  // app role. The dbAdmin connection is kept only for the notification lookups
  // (resolving approver/submitter/owner identity), which intentionally bypass
  // RLS the same way they did before.
  constructor(
    @Inject(DB_SERVICE_ROLE) private readonly dbAdmin: DbAdmin,
    private readonly databaseService: DatabaseService,
    private readonly auditService: AuditService,
    private readonly notificationsService: NotificationsService,
    // Round L: routing (who reviews, who may act) + escalation state.
    private readonly routing: ApprovalRoutingService,
    // Round N: the team list and the utilization report render the person's
    // photo (users.avatar_key needs signing). Optional + LAST so hand-built
    // specs — `new TimesheetService(dbAdmin, db, audit, notifications, routing)`
    // — keep compiling; without it the legacy users.avatar_url still serves.
    @Optional() private readonly mediaService?: MediaService,
  ) {}

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

  // ─── Internal helpers ──────────────────────────────────────────────────

  private async resolveCaller(db: Db, userId: string, tenantId: string) {
    const [row] = await db
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
      // Round L — employee-facing: the level only ("With your manager" /
      // "With HR"), never the reason or a reviewer's name.
      ...authorRoutingView(p.escalation_level),
    };
  }

  /** Latest open (unresolved) rework request for a period, or null. */
  private async getLatestRework(db: Db, periodId: string) {
    const [r] = await db
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

  /** The tenant's configured week-start day (0=Sun..6=Sat; default Monday). */
  private async tenantWeekStartsOn(tenantId: string): Promise<number> {
    const [t] = await this.dbAdmin
      .select({ weekStartsOn: tenants.week_starts_on })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    return t?.weekStartsOn ?? 1;
  }

  // ─── 1. Get-or-create the caller's current week period ────────────────

  async getMyCurrentPeriod(userId: string, tenantId: string) {
    const weekStartsOn = await this.tenantWeekStartsOn(tenantId);
    return this.databaseService.withTenant(tenantId, async (db) => {
      const { employeeId, reportingManagerId } = await this.resolveCaller(
        db,
        userId,
        tenantId,
      );
      const { start, end } = weekBoundaries(new Date(), weekStartsOn);

      const [existing] = await db
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
        const rework = await this.getLatestRework(db, existing.id);
        return this.shapePeriod(existing, rework);
      }

      const [created] = await db
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
    });
  }

  // ─── 1b. "Copy last week": prior week's category rows (structure only) ──
  // Returns the distinct categories the caller logged in the previous week so
  // the grid can seed those rows with empty hours. Hours are intentionally
  // NOT copied (PRD §8.3 — bring forward structure, not hours).
  async getPreviousWeekCategories(
    userId: string,
    tenantId: string,
  ): Promise<{ categories: string[] }> {
    const weekStartsOn = await this.tenantWeekStartsOn(tenantId);
    return this.databaseService.withTenant(tenantId, async (db) => {
      const { employeeId } = await this.resolveCaller(db, userId, tenantId);
      const prev = weekBoundaries(
        new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
        weekStartsOn,
      );

      const [prevPeriod] = await db
        .select({ id: timesheetPeriods.id })
        .from(timesheetPeriods)
        .where(
          and(
            eq(timesheetPeriods.tenant_id, tenantId),
            eq(timesheetPeriods.employee_id, employeeId),
            eq(timesheetPeriods.period_start, prev.start),
          ),
        )
        .limit(1);

      if (!prevPeriod) return { categories: [] };

      const rows = await db
        .selectDistinct({ category: timesheetEntries.category })
        .from(timesheetEntries)
        .where(eq(timesheetEntries.timesheet_period_id, prevPeriod.id));

      return { categories: rows.map((r) => r.category) };
    });
  }

  // ─── 1c. Utilization report (billable vs non-billable per employee) ─────
  // PRD §8.4 /timesheets/reports/utilization. Manager/admin only (gated in
  // the controller). Defaults to the last 30 days when no range given.
  async getUtilizationReport(
    tenantId: string,
    range: { from?: string; to?: string },
  ) {
    const to = range.to ?? new Date().toISOString().slice(0, 10);
    const from =
      range.from ??
      new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);

    const rows = await this.databaseService.withTenant(tenantId, (db) =>
      db
        .select({
          employeeId: timesheetEntries.employee_id,
          name: users.full_name,
          employeeCode: employees.employee_code,
          // Round N: the report renders faces. Both columns are functionally
          // dependent on the grouped employee, so adding them to GROUP BY
          // (Postgres requires it) cannot change the aggregates.
          avatarKey: users.avatar_key,
          avatarUrl: users.avatar_url,
          billable: sql<number>`COALESCE(SUM(CASE WHEN ${timesheetEntries.is_billable} THEN ${timesheetEntries.hours} ELSE 0 END), 0)::float`,
          nonBillable: sql<number>`COALESCE(SUM(CASE WHEN NOT ${timesheetEntries.is_billable} THEN ${timesheetEntries.hours} ELSE 0 END), 0)::float`,
        })
        .from(timesheetEntries)
        .leftJoin(employees, eq(timesheetEntries.employee_id, employees.id))
        .leftJoin(users, eq(employees.user_id, users.id))
        .where(
          and(
            eq(timesheetEntries.tenant_id, tenantId),
            gte(timesheetEntries.entry_date, from),
            lte(timesheetEntries.entry_date, to),
          ),
        )
        .groupBy(
          timesheetEntries.employee_id,
          users.full_name,
          employees.employee_code,
          users.avatar_key,
          users.avatar_url,
        ),
    );

    // Signing is local crypto (no network, no DB) and the tx has returned —
    // the mapper drops avatarKey so the private R2 key never ships.
    const byEmployee = await Promise.all(
      rows.map(async (r) => {
        const billable = Number(r.billable ?? 0);
        const nonBillable = Number(r.nonBillable ?? 0);
        const total = billable + nonBillable;
        return {
          employeeId: r.employeeId,
          name: r.name,
          employeeCode: r.employeeCode,
          avatarUrl: await this.signAvatar(r.avatarKey, r.avatarUrl),
          billableHours: billable,
          nonBillableHours: nonBillable,
          totalHours: total,
          utilization: total > 0 ? billable / total : 0,
        };
      }),
    );
    byEmployee.sort((a, b) => b.totalHours - a.totalHours);

    const totals = byEmployee.reduce(
      (acc, r) => {
        acc.billableHours += r.billableHours;
        acc.nonBillableHours += r.nonBillableHours;
        acc.totalHours += r.totalHours;
        return acc;
      },
      { billableHours: 0, nonBillableHours: 0, totalHours: 0 },
    );

    return {
      range: { from, to },
      totals: {
        ...totals,
        utilization:
          totals.totalHours > 0 ? totals.billableHours / totals.totalHours : 0,
      },
      byEmployee,
    };
  }

  // ─── 2. List the caller's periods ──────────────────────────────────────

  async listMine(
    userId: string,
    tenantId: string,
    query: TimesheetListQueryDto,
  ) {
    return this.databaseService.withTenant(tenantId, async (db) => {
      const { employeeId } = await this.resolveCaller(db, userId, tenantId);
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
        db
          .select()
          .from(timesheetPeriods)
          .where(and(...conditions))
          .orderBy(desc(timesheetPeriods.period_start))
          .limit(limit)
          .offset(offset),
        db
          .select({ n: sql<number>`COUNT(*)::int` })
          .from(timesheetPeriods)
          .where(and(...conditions)),
      ]);

      const reworks = await Promise.all(
        rows.map((r) => this.getLatestRework(db, r.id)),
      );

      return {
        data: rows.map((r, i) => this.shapePeriod(r, reworks[i])),
        pagination: { page, limit, total: Number(totalRow[0]?.n ?? 0) },
      };
    });
  }

  // ─── 3. Entries for a given period ─────────────────────────────────────

  async getEntries(
    timesheetPeriodId: string,
    userId: string,
    tenantId: string,
  ) {
    return this.databaseService.withTenant(tenantId, async (db) => {
      const [period] = await db
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

      // Round L: the author, or anyone the routing model lets act on it (the
      // live manager, the skip-level manager once escalated, owner/admin) —
      // no longer only the stamped approver_id.
      const reviewer = await this.routing.resolveReviewerTx(db, tenantId, userId);
      const isAuthor = !!reviewer.employeeId && period.employee_id === reviewer.employeeId;
      if (!isAuthor) {
        try {
          await this.routing.assertMayActTx(
            db,
            tenantId,
            reviewer,
            {
              applicantEmployeeId: period.employee_id,
              level: period.escalation_level,
              escalatedTo: period.escalated_to_employee_id,
            },
            'timesheet',
          );
        } catch (e) {
          if (e instanceof ForbiddenException) {
            throw new ForbiddenException('Not allowed to view this timesheet');
          }
          throw e;
        }
      }

      const entries = await db
        .select()
        .from(timesheetEntries)
        .where(eq(timesheetEntries.timesheet_period_id, timesheetPeriodId))
        .orderBy(asc(timesheetEntries.entry_date));

      const rework = await this.getLatestRework(db, period.id);

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
    });
  }

  // ─── 4. Bulk save entries (replace-all on a draft) ─────────────────────

  async saveEntries(
    userId: string,
    tenantId: string,
    dto: BulkSaveEntriesDto,
  ) {
    const result = await this.databaseService.withTenant(
      tenantId,
      async (db) => {
        const { employeeId } = await this.resolveCaller(db, userId, tenantId);

        const [period] = await db
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
        await db
          .delete(timesheetEntries)
          .where(eq(timesheetEntries.timesheet_period_id, period.id));

        if (dto.entries.length > 0) {
          await db.insert(timesheetEntries).values(
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
        await db
          .update(timesheetPeriods)
          .set({
            total_hours: totals.total,
            total_billable_hours: totals.billable,
            total_non_billable_hours: totals.nonBillable,
            updated_at: new Date(),
          })
          .where(eq(timesheetPeriods.id, period.id));

        return { periodId: period.id, totals };
      },
    );

    await this.auditService.log({
      tenantId,
      actorUserId: userId,
      action: 'timesheet.entries.saved',
      resourceType: 'timesheet_period',
      resourceId: result.periodId,
      metadata: {
        entryCount: dto.entries.length,
        totalHours: result.totals.total,
      },
    });

    return {
      timesheetPeriodId: result.periodId,
      entryCount: dto.entries.length,
      totalHours: result.totals.total,
      totalBillableHours: result.totals.billable,
    };
  }

  // ─── 5. Submit for review ──────────────────────────────────────────────

  async submitTimesheet(
    userId: string,
    tenantId: string,
    dto: SubmitTimesheetDto,
  ) {
    const { period, approverId, submittedAt, state, route } =
      await this.databaseService.withTenant(tenantId, async (db) => {
        const { employeeId } = await this.resolveCaller(db, userId, tenantId);
        // Round L: "today" in the tenant's timezone (A's day resolver) decides
        // whether the manager is on leave right now.
        const today = await tenantTodayISOTx(db, tenantId);

        const [period] = await db
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

        // Round L: no more "No approver configured" dead end — a period
        // without a reporting manager routes straight to Owner + HR Admins
        // (level 2, `no_manager`); a manager on approved full-day leave today
        // is skipped at submit time. `approver_id` stays a display/legacy
        // stamp: the routing columns decide who sees and may act.
        const submittedAt = new Date();
        const { state, route } = await this.routing.initialStateTx(
          db,
          tenantId,
          employeeId,
          today,
          submittedAt,
        );
        // Recomputed from the live route on EVERY submit (a rework by HR must
        // not leave HR as the approver of a level-0 period).
        const approverId = route.l0?.employeeId ?? null;

        await db
          .update(timesheetPeriods)
          .set({
            status: 'submitted',
            submitted_at: submittedAt,
            approver_id: approverId,
            updated_at: submittedAt,
            ...routeStateColumns(state),
          })
          .where(eq(timesheetPeriods.id, period.id));

        // Any open rework requests are addressed by this submission.
        await db
          .update(timesheetReworkRequests)
          .set({ resolved_at: submittedAt })
          .where(
            and(
              eq(timesheetReworkRequests.timesheet_period_id, period.id),
              isNull(timesheetReworkRequests.resolved_at),
            ),
          );

        return { period, approverId, submittedAt, state, route };
      });

    // The submitter's display name so the reviewer notification reads
    // "Alice Sharma submitted her timesheet" not just "Someone submitted…".
    const [submitter] = await this.dbAdmin
      .select({ fullName: users.full_name, first: employees.first_name, last: employees.last_name })
      .from(employees)
      .leftJoin(users, eq(employees.user_id, users.id))
      .where(and(eq(employees.id, period.employee_id), eq(employees.tenant_id, tenantId)))
      .limit(1);
    const submitterName =
      submitter?.fullName || `${submitter?.first ?? ''} ${submitter?.last ?? ''}`.trim() || 'An employee';

    // Round L: whoever the period landed with — the manager (L0), the
    // manager's manager (L1, manager on leave) or Owner + HR Admins (L2, no
    // manager). Best-effort, after commit. The message says WHY it is with
    // them when it skipped a level.
    const recipients = this.routing.recipientsFor(route, state.level);
    const why =
      state.level === 2 && state.reason === 'no_manager'
        ? ' — no reporting manager is set, so it is with you as HR.'
        : state.level >= 1 && state.reason === 'reviewer_on_leave'
          ? ' — their manager is on leave today, so it is with you.'
          : '.';
    const reviewPath = approvalDeepLink('timesheet', period.id);
    for (const r of recipients) {
      if (r.userId) {
        // Detached (round C): createInAppNotification never throws at source.
        void this.notificationsService.createInAppNotification(
          r.userId,
          'timesheet.submitted',
          `${submitterName || 'An employee'} submitted a timesheet for ${period.period_start}${why}`,
          reviewPath,
          tenantId,
          { groupKey: `timesheet:${period.id}` },
        );
      }
      if (!r.email) continue;
      try {
        await this.notificationsService.sendEmail(
          'timesheet-submitted',
          r.email,
          {
            approverName: r.name || 'there',
            periodStart: period.period_start,
            periodEnd: period.period_end,
            totalHours: period.total_hours,
          },
          r.userId ? { userId: r.userId, event: 'timesheet_submitted' } : undefined,
        );
      } catch (e) {
        this.logger.warn(
          `Could not send timesheet-submitted email to ${r.email}: ${(e as Error).message}`,
        );
      }
    }

    await this.auditService.log({
      tenantId,
      actorUserId: userId,
      action: 'timesheet.submitted',
      resourceType: 'timesheet_period',
      resourceId: period.id,
      metadata: {
        totalHours: period.total_hours,
        approverId,
        escalationLevel: state.level,
        escalationReason: state.reason,
      },
    });

    return {
      id: period.id,
      status: 'submitted' as const,
      submittedAt: submittedAt.toISOString(),
      // Employee-facing: the level only — never the reason or a name.
      ...authorRoutingView(state.level),
    };
  }

  // ─── 6. List pending (manager view) ────────────────────────────────────

  /**
   * Round L: the ROUTED queue — what the Inbox badge counts. Direct reports'
   * submitted periods, periods escalated to me (level >= 1), and for
   * owner/admin the level-2 ones; never the caller's own. `approver_id` is
   * no longer the key (it is a display/legacy stamp).
   */
  async listPending(
    userId: string,
    tenantId: string,
    query: TimesheetListQueryDto,
    roleHint?: string,
  ) {
    const result = await this.databaseService.withTenant(tenantId, async (db) => {
      const reviewer = await this.routing.resolveReviewerTx(db, tenantId, userId, roleHint);
      const page = query.page ?? 1;
      const limit = Math.min(query.limit ?? 20, 100);
      const offset = (page - 1) * limit;
      const escalatedTo = alias(employees, 'ts_escalated_to');

      const where = and(
        eq(timesheetPeriods.tenant_id, tenantId),
        eq(timesheetPeriods.status, 'submitted' as const),
        this.routing.queuePredicate(reviewer, timesheetPeriods, timesheetPeriods.employee_id),
        isNull(employees.deleted_at),
      );

      const [rows, totalRow] = await Promise.all([
        db
          .select({
            id: timesheetPeriods.id,
            employeeId: timesheetPeriods.employee_id,
            employeeUserId: employees.user_id,
            // Round N — the approval queue renders the same face as the team
            // list (/team/timesheets reads both); signed AFTER the tx and the
            // private key stripped by the mapper.
            avatarKey: users.avatar_key,
            avatarUrl: users.avatar_url,
            employeeCode: employees.employee_code,
            employeeName: sql<string>`COALESCE(${employees.first_name}, '') || ' ' || COALESCE(${employees.last_name}, '')`,
            periodStart: timesheetPeriods.period_start,
            periodEnd: timesheetPeriods.period_end,
            status: timesheetPeriods.status,
            totalHours: timesheetPeriods.total_hours,
            totalBillableHours: timesheetPeriods.total_billable_hours,
            submittedAt: timesheetPeriods.submitted_at,
            approverId: timesheetPeriods.approver_id,
            escalationLevel: timesheetPeriods.escalation_level,
            escalationReason: timesheetPeriods.escalation_reason,
            escalatedAt: timesheetPeriods.escalated_at,
            escalatedToName: sql<string | null>`CASE WHEN ${escalatedTo.id} IS NULL THEN NULL ELSE COALESCE(${escalatedTo.first_name}, '') || ' ' || COALESCE(${escalatedTo.last_name}, '') END`,
          })
          .from(timesheetPeriods)
          .leftJoin(employees, eq(timesheetPeriods.employee_id, employees.id))
          // LEFT — an employee with no user account keeps its row in the queue.
          .leftJoin(users, eq(employees.user_id, users.id))
          .leftJoin(
            escalatedTo,
            and(
              eq(escalatedTo.id, timesheetPeriods.escalated_to_employee_id),
              eq(escalatedTo.tenant_id, tenantId),
            ),
          )
          .where(where)
          .orderBy(desc(timesheetPeriods.submitted_at))
          .limit(limit)
          .offset(offset),
        db
          .select({ n: sql<number>`COUNT(*)::int` })
          .from(timesheetPeriods)
          .leftJoin(employees, eq(timesheetPeriods.employee_id, employees.id))
          .where(where),
      ]);

      return {
        data: rows.map(({ escalationLevel, escalationReason, escalatedAt, escalatedToName, ...r }) => ({
          ...r,
          escalation: shapeEscalation({ escalationLevel, escalationReason, escalatedAt }, escalatedToName),
          // Everything in the routed queue is, by definition, with the caller.
          routedToMe: true as const,
        })),
        pagination: { page, limit, total: Number(totalRow[0]?.n ?? 0) },
      };
    });
    // Round N — sign AFTER the tenant transaction (local SigV4 crypto, no DB);
    // the mapper strips avatarKey from every row.
    return { ...result, data: await withSignedAvatars(this.signAvatar, result.data) };
  }

  // ─── 6b. Team periods (Round I: Team → Timesheets — Pending review | All) ──

  /**
   * Every period of the caller's team, any status. Unlike `listPending`
   * (which keys on `approver_id = me`), scope is the org chart itself:
   * managers get their direct reports' periods, owner/admin the workspace.
   * Periods created before a manager was assigned still carry
   * `approver_id NULL` — they show up here with `approverId: null`, and
   * `reviewTimesheet` stamps the reporting manager on first review.
   */
  async listTeam(
    userId: string,
    tenantId: string,
    query: TeamTimesheetQueryDto,
    roleHint?: string,
  ) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(Math.max(1, query.limit ?? 50), 100);
    const offset = (page - 1) * limit;
    const status = query.status ?? 'all';

    const result = await this.databaseService.withTenant(tenantId, async (db) => {
      // Round L: the org chart still decides the SCOPE (owner/admin: the
      // workspace — the "open directly" surface; managers: direct reports),
      // while `routedToMe` says whether the row is in the caller's queue.
      const reviewer = await this.routing.resolveReviewerTx(db, tenantId, userId, roleHint);
      const orgWide = reviewer.orgWide;
      // A manager's page shows their direct reports PLUS anything escalated
      // to them (the manager's manager follows the bell's deep link here).
      const scope = orgWide
        ? sql`true`
        : reviewer.employeeId
          ? sql`(${employees.reporting_manager_id} = ${reviewer.employeeId} OR (${timesheetPeriods.escalation_level} >= 1 AND ${timesheetPeriods.escalated_to_employee_id} = ${reviewer.employeeId}))`
          : sql`false`;
      const approver = alias(employees, 'ts_approver');
      const manager = alias(employees, 'ts_manager');
      const escalatedTo = alias(employees, 'ts_escalated_to');
      const routedToMe = this.routing.queuePredicate(
        reviewer,
        timesheetPeriods,
        timesheetPeriods.employee_id,
      );
      const where = and(
        eq(timesheetPeriods.tenant_id, tenantId),
        status === 'all' ? undefined : eq(timesheetPeriods.status, status),
        // The caller's own periods live under My timesheets.
        sql`${employees.user_id} IS DISTINCT FROM ${userId}`,
        scope,
        isNull(employees.deleted_at),
      );

      const [rows, [countRow]] = await Promise.all([
        db
          .select({
            id: timesheetPeriods.id,
            employeeId: timesheetPeriods.employee_id,
            employeeUserId: employees.user_id,
            // Round N: the row renders the person's face. `users` is
            // platform-global — joined by id off the tenant-scoped employee,
            // which keeps the tenant predicate on timesheet_periods.
            avatarKey: users.avatar_key,
            avatarUrl: users.avatar_url,
            employeeCode: employees.employee_code,
            employeeName: sql<string>`COALESCE(${employees.first_name}, '') || ' ' || COALESCE(${employees.last_name}, '')`,
            periodStart: timesheetPeriods.period_start,
            periodEnd: timesheetPeriods.period_end,
            status: timesheetPeriods.status,
            totalHours: timesheetPeriods.total_hours,
            totalBillableHours: timesheetPeriods.total_billable_hours,
            submittedAt: timesheetPeriods.submitted_at,
            approverId: timesheetPeriods.approver_id,
            approverName: sql<string | null>`CASE WHEN ${approver.id} IS NULL THEN NULL ELSE COALESCE(${approver.first_name}, '') || ' ' || COALESCE(${approver.last_name}, '') END`,
            approvedAt: timesheetPeriods.approved_at,
            rejectedAt: timesheetPeriods.rejected_at,
            rejectionComment: timesheetPeriods.rejection_comment,
            updatedAt: timesheetPeriods.updated_at,
            // Round L — routing columns for the chips.
            routedToMe: sql<boolean>`(${routedToMe})`,
            managerName: sql<string | null>`CASE WHEN ${manager.id} IS NULL THEN NULL ELSE COALESCE(${manager.first_name}, '') || ' ' || COALESCE(${manager.last_name}, '') END`,
            escalationLevel: timesheetPeriods.escalation_level,
            escalationReason: timesheetPeriods.escalation_reason,
            escalatedAt: timesheetPeriods.escalated_at,
            escalatedToName: sql<string | null>`CASE WHEN ${escalatedTo.id} IS NULL THEN NULL ELSE COALESCE(${escalatedTo.first_name}, '') || ' ' || COALESCE(${escalatedTo.last_name}, '') END`,
          })
          .from(timesheetPeriods)
          .leftJoin(employees, eq(timesheetPeriods.employee_id, employees.id))
          .leftJoin(users, eq(employees.user_id, users.id))
          .leftJoin(
            approver,
            and(eq(approver.id, timesheetPeriods.approver_id), eq(approver.tenant_id, tenantId)),
          )
          .leftJoin(
            manager,
            and(
              eq(manager.id, employees.reporting_manager_id),
              eq(manager.tenant_id, tenantId),
              isNull(manager.deleted_at),
            ),
          )
          .leftJoin(
            escalatedTo,
            and(
              eq(escalatedTo.id, timesheetPeriods.escalated_to_employee_id),
              eq(escalatedTo.tenant_id, tenantId),
            ),
          )
          .where(where)
          .orderBy(desc(timesheetPeriods.period_start), asc(employees.first_name), desc(timesheetPeriods.id))
          .limit(limit)
          .offset(offset),
        db
          .select({ n: sql<number>`COUNT(*)::int` })
          .from(timesheetPeriods)
          .leftJoin(employees, eq(timesheetPeriods.employee_id, employees.id))
          .where(where),
      ]);

      const total = Number(countRow?.n ?? 0);
      return {
        data: rows.map(({ escalationLevel, escalationReason, escalatedAt, escalatedToName, ...r }) => ({
          ...r,
          routedToMe: r.routedToMe === true,
          escalation: shapeEscalation({ escalationLevel, escalationReason, escalatedAt }, escalatedToName),
        })),
        pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
        scope: orgWide ? ('org' as const) : ('team' as const),
      };
    });
    // Round N — sign the photos AFTER the tenant transaction (local SigV4
    // crypto, no DB); the mapper strips avatarKey from every row.
    return { ...result, data: await withSignedAvatars(this.signAvatar, result.data) };
  }

  // ─── 7. Review (approve / reject / rework) ─────────────────────────────

  async reviewTimesheet(
    timesheetPeriodId: string,
    reviewerUserId: string,
    tenantId: string,
    dto: ReviewTimesheetDto,
    roleHint?: string,
  ) {
    const { period, newStatus, now, onBehalfRoute, deciderName } = await this.databaseService.withTenant(
      tenantId,
      async (db) => {
        // Round L: the routing guard replaces "approver_id = me". The live
        // reporting manager always may act; the skip-level manager once the
        // period was escalated to them; owner/admin always (opened directly
        // from Team → Timesheets); never the applicant (user_id + bridge).
        const reviewer = await this.routing.resolveReviewerTx(db, tenantId, reviewerUserId, roleHint);

        const [period] = await db
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
        const how = await this.routing.assertMayActTx(
          db,
          tenantId,
          reviewer,
          {
            applicantEmployeeId: period.employee_id,
            level: period.escalation_level,
            escalatedTo: period.escalated_to_employee_id,
          },
          'timesheet',
        );
        // Decided over the routed manager's head (owner/admin directly, or
        // the skip-level manager)? They are told after commit.
        const onBehalfRoute =
          how === 'manager' ? null : await this.routing.resolveRouteTx(db, tenantId, period.employee_id);
        const [decider] = onBehalfRoute
          ? await db.select({ name: users.full_name }).from(users).where(eq(users.id, reviewerUserId)).limit(1)
          : [undefined];
        const deciderName = decider?.name ?? '';
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
        // Whoever decides is stamped as the approver (display/legacy column);
        // a seat without an employee row keeps whatever was there.
        const update: Record<string, unknown> = {
          updated_at: now,
          approver_id: reviewer.employeeId ?? period.approver_id,
        };

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
          // rework — re-open the period for editing; the escalation clock
          // restarts from scratch on the next submit, and the approver is
          // recomputed from the route then (not left as whoever sent it back).
          newStatus = 'draft';
          update.status = 'draft';
          update.submitted_at = null;
          Object.assign(update, RESET_ESCALATION, { approver_id: null });
        }

        await db
          .update(timesheetPeriods)
          .set(update)
          .where(and(eq(timesheetPeriods.id, period.id), eq(timesheetPeriods.tenant_id, tenantId)));

        if (dto.action === 'rework') {
          await db.insert(timesheetReworkRequests).values({
            tenant_id: tenantId,
            timesheet_period_id: period.id,
            requested_by: reviewerUserId,
            comment: dto.comment!,
          });
        }

        return { period, newStatus, now, onBehalfRoute, deciderName };
      },
    );

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

    // Round L: the routed manager (and the skip-level manager, once it had
    // reached them) learn that someone decided on their behalf. Best-effort.
    if (onBehalfRoute) {
      const [emp] = await this.dbAdmin
        .select({ first: employees.first_name, last: employees.last_name })
        .from(employees)
        .where(and(eq(employees.id, period.employee_id), eq(employees.tenant_id, tenantId)))
        .limit(1);
      void this.routing.notifyDecidedOnBehalf(tenantId, 'timesheet', period.id, onBehalfRoute, period.escalation_level, {
        deciderUserId: reviewerUserId,
        deciderName,
        employeeName: `${emp?.first ?? ''} ${emp?.last ?? ''}`.trim(),
        action: dto.action,
      });
    }

    // Push an in-app notification to the timesheet's owner so they see
    // the manager's decision next time they open the app.
    const [ownerUser] = await this.dbAdmin
      .select({
        userId: employees.user_id,
        email: users.email,
        fullName: users.full_name,
      })
      .from(employees)
      .leftJoin(users, eq(employees.user_id, users.id))
      .where(eq(employees.id, period.employee_id))
      .limit(1);
    if (ownerUser?.userId) {
      const verb =
        dto.action === 'approve'
          ? 'approved'
          : dto.action === 'reject'
            ? 'rejected'
            : 'sent back for changes';
      // Detached (round C): createInAppNotification never throws at source
      // and the reviewer's CTA shouldn't wait for the inbox row.
      void this.notificationsService.createInAppNotification(
        ownerUser.userId,
        `timesheet.${dto.action}`,
        `Your timesheet for ${period.period_start} was ${verb}.`,
        '/timesheets',
        period.tenant_id,
      );

      if (ownerUser.email) {
        const tpl =
          dto.action === 'approve'
            ? 'timesheet-approved'
            : dto.action === 'reject'
              ? 'timesheet-rejected'
              : 'timesheet-rework';
        await this.notificationsService
          .sendEmail(
            tpl,
            ownerUser.email,
            {
              employeeName: ownerUser.fullName ?? 'there',
              periodStart: period.period_start,
              periodEnd: period.period_end,
              comment: dto.comment,
            },
            { userId: ownerUser.userId, event: 'timesheet_reviewed' },
          )
          .catch((e) =>
            this.logger.warn(
              `Could not send ${tpl} email to ${ownerUser.email}: ${(e as Error).message}`,
            ),
          );
      }
    }

    return {
      id: period.id,
      status: newStatus,
      reviewedAt: now.toISOString(),
    };
  }
}
