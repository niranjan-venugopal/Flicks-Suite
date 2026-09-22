import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  eq,
  and,
  desc,
  gte,
  lte,
  ne,
  or,
  sql,
  inArray,
  isNull,
  notInArray,
} from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  leaveTypes,
  leaveBalances,
  leaveRequests,
  holidays,
  memberships,
  employees,
  locations,
  users,
  attendanceRecords,
} from '@flicks/db/schema';
import { DatabaseService } from '../../core/database/database.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { MediaService } from '../media/media.service';
import { withSignedAvatars } from '../../core/storage/signed-avatar';
import { resolveShiftsTx, tenantTodayISOTx } from '../../core/common/workday';
import {
  ApprovalRoutingService,
  authorRoutingView,
  routeStateColumns,
  shapeEscalation,
} from '../approvals/public';
import type { ReviewerCtx } from '../approvals/public';
import type { Db } from '@flicks/db';
import type {
  ApplyLeaveDto,
  CancelLeaveDto,
  ReviewLeaveDto,
  CreateLeaveTypeDto,
  CreateHolidayDto,
  UpdateHolidayDto,
  ImportHolidaysDto,
  LeaveListQueryDto,
  TeamLeaveQueryDto,
} from './leave.dto';
import { getHolidayPresets, PRESET_COUNTRIES } from './holiday-presets';

// Round L: the org-wide role list (ORG_WIDE_REVIEW_ROLES), the queue predicate
// and the may-act guard live in modules/approvals — consumed via public.ts.

/**
 * Holiday types that actually block work. 'optional'/'restricted' holidays
 * are elective (the Keka/Zoho semantics): an employee who works that day is
 * simply working, so they never reduce leave-day counts or mark attendance.
 */
const WORKING_HOLIDAY_TYPES_EXCLUDED = ['optional', 'restricted'] as const;

/**
 * Yields each YYYY-MM-DD between startISO and endISO inclusive.
 */
function* eachDay(startISO: string, endISO: string): Generator<string> {
  const start = new Date(`${startISO}T00:00:00Z`);
  const end = new Date(`${endISO}T00:00:00Z`);
  if (end < start) return;
  const cursor = new Date(start);
  while (cursor <= end) {
    yield cursor.toISOString().slice(0, 10);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
}

/** Mon–Fri — the literal fallback when an employee has no shift at all. */
const DEFAULT_WORKING_DAYS: ReadonlySet<number> = new Set([1, 2, 3, 4, 5]);

/**
 * Counts business days between two YYYY-MM-DD dates inclusive: the shift's
 * working days (Round L — was hard-coded Mon–Fri, so a Saturday-working
 * shift lost a day per week) minus the holidays that apply to the employee.
 *
 * PRD §7.7 acceptance: "Holiday on a leave date does not double-count: leave
 * for Mon–Fri including Republic Day on Wed = 4 days, not 5."
 *
 * @param holidayDates set of YYYY-MM-DD holiday dates that fall in the range
 * @param workingDays  0=Sun..6=Sat from the employee's shift template
 */
export function countBusinessDays(
  startISO: string,
  endISO: string,
  holidayDates: Set<string> = new Set(),
  workingDays: ReadonlySet<number> = DEFAULT_WORKING_DAYS,
): number {
  let count = 0;
  for (const _d of businessDays(startISO, endISO, holidayDates, workingDays)) count++;
  return count;
}

/**
 * Yields business days (shift working days, non-holiday) between two
 * YYYY-MM-DD dates. Used to back-fill attendance_records on leave approval.
 */
export function* businessDays(
  startISO: string,
  endISO: string,
  holidayDates: Set<string>,
  workingDays: ReadonlySet<number> = DEFAULT_WORKING_DAYS,
): Generator<string> {
  for (const d of eachDay(startISO, endISO)) {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay(); // 0=Sun, 6=Sat
    if (!workingDays.has(dow)) continue;
    if (holidayDates.has(d)) continue;
    yield d;
  }
}

@Injectable()
export class LeaveService {
  private readonly logger = new Logger(LeaveService.name);

  /** Round L — routing (who reviews, who may act) + escalation state. */
  private readonly routing: ApprovalRoutingService;

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly auditService: AuditService,
    private readonly notificationsService: NotificationsService,
    // Optional so the many specs that build `new LeaveService(db, audit,
    // notifications)` keep compiling; only the email deep links need it.
    @Optional() private readonly configService?: ConfigService,
    // Optional for the same reason: under Nest DI the ApprovalsModule provides
    // it; a hand-built service falls back to a routing service bound to the
    // same notifications + config it was given.
    @Optional() routing?: ApprovalRoutingService,
    // Round N: Team → Leave rows carry the requester's photo
    // (users.avatar_key needs signing). Optional + LAST for the same
    // hand-built-spec reason as configService above.
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

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /** Public web origin for links in emails (no trailing slash). */
  private appUrl(): string {
    const raw =
      this.configService?.get<string>('APP_URL') ??
      process.env.APP_URL ??
      'http://localhost:3000';
    return raw.replace(/\/$/, '');
  }

  /**
   * Who is reviewing, and how far can they see? `orgWide` for owner/admin
   * (and platform staff); managers get their own employee id and are scoped
   * to direct reports. `roleHint` is the JWT role the guard already trusted;
   * without it (service-level callers) the active membership decides.
   * Never self-heals an employee row — a manager seat with no employee
   * record has an EMPTY team, never the whole workspace.
   */
  private resolveReviewer(
    tx: Db,
    userId: string,
    tenantId: string,
    roleHint?: string,
  ): Promise<ReviewerCtx> {
    // Round L: one resolver for every approval surface (modules/approvals).
    return this.routing.resolveReviewerTx(tx, tenantId, userId, roleHint);
  }

  /**
   * Predicate narrowing `employees` rows to the reviewer's scope: everything
   * for org-wide roles; direct reports for a manager; nothing for a manager
   * without an employee row. Requires `employees` to be joined.
   */
  private reviewerScope(reviewer: { employeeId: string | null; orgWide: boolean }): SQL {
    if (reviewer.orgWide) return sql`true`;
    if (!reviewer.employeeId) return sql`false`;
    return sql`${employees.reporting_manager_id} = ${reviewer.employeeId}`;
  }

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
   * Employee id + gender for the logged-in user — gender scopes which leave
   * types they see (maternity/paternity, PRD §7.2 applicable_genders).
   */
  private async getEmployeeForUser(
    userId: string,
    tenantId: string,
  ): Promise<{ id: string; gender: string | null }> {
    return this.databaseService.withTenant(tenantId, async (tx) => {
      const [m] = await tx
        .select({
          employeeId: memberships.employee_id,
          gender: employees.gender,
        })
        .from(memberships)
        .leftJoin(employees, eq(memberships.employee_id, employees.id))
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
      return { id: m.employeeId, gender: m.gender ?? null };
    });
  }

  /**
   * WHERE fragment: untagged leave types apply to everyone; gender-tagged
   * types only to a matching gender. No/other/undisclosed gender ⇒ untagged
   * types only — never show Maternity to someone who hasn't set a gender.
   */
  private genderScope(gender: string | null) {
    return or(
      isNull(leaveTypes.applicable_genders),
      gender
        ? sql`${gender} = ANY(${leaveTypes.applicable_genders})`
        : sql`false`,
    );
  }

  /**
   * WHERE clause for holidays that block work in [from, to]: excludes
   * elective types and scopes by location — company-wide rows
   * (location_id NULL) always apply; location rows only apply to employees
   * AT that location. An employee with no location gets company-wide only.
   */
  private workingHolidayFilter(
    tenantId: string,
    fromISO: string,
    toISO: string,
    employeeLocationId: string | null,
  ) {
    return and(
      eq(holidays.tenant_id, tenantId),
      gte(holidays.holiday_date, fromISO),
      lte(holidays.holiday_date, toISO),
      notInArray(holidays.type, [...WORKING_HOLIDAY_TYPES_EXCLUDED]),
      employeeLocationId
        ? or(
            isNull(holidays.location_id),
            eq(holidays.location_id, employeeLocationId),
          )
        : isNull(holidays.location_id),
    );
  }

  /**
   * Returns the set of YYYY-MM-DD working-holiday dates in [from, to] as they
   * apply to one employee (location-scoped; elective types excluded).
   */
  private async fetchHolidayDates(
    tenantId: string,
    fromISO: string,
    toISO: string,
    employeeId?: string,
  ): Promise<Set<string>> {
    const rows = await this.databaseService.withTenant(tenantId, async (tx) => {
      let employeeLocationId: string | null = null;
      if (employeeId) {
        const [emp] = await tx
          .select({ locationId: employees.location_id })
          .from(employees)
          .where(
            and(eq(employees.id, employeeId), eq(employees.tenant_id, tenantId)),
          )
          .limit(1);
        employeeLocationId = emp?.locationId ?? null;
      }
      return tx
        .select({ date: holidays.holiday_date })
        .from(holidays)
        .where(
          this.workingHolidayFilter(tenantId, fromISO, toISO, employeeLocationId),
        );
    });
    return new Set(rows.map((r) => r.date));
  }

  /**
   * Round L: the employee's shift working days (0=Sun..6=Sat) as of
   * `dateISO` — assignment → tenant default → Mon–Fri. Read-only; never
   * seeds a template.
   */
  private async workingDaysFor(
    tx: Db,
    tenantId: string,
    employeeId: string,
    dateISO: string,
  ): Promise<Set<number>> {
    const shifts = await resolveShiftsTx(tx, tenantId, [employeeId], dateISO);
    return new Set(shifts.get(employeeId)?.workingDays ?? [...DEFAULT_WORKING_DAYS]);
  }

  // ─── Leave Types ───────────────────────────────────────────────────────────

  async listLeaveTypes(tenantId: string, userId?: string) {
    // Gender-scoped for the calling employee (a user with no employee record
    // — e.g. an admin-only seat — sees the untagged types).
    let gender: string | null = null;
    if (userId) {
      try {
        gender = (await this.getEmployeeForUser(userId, tenantId)).gender;
      } catch {
        gender = null;
      }
    }
    const rows = await this.databaseService.withTenant(tenantId, (tx) =>
      tx
        .select({
          id: leaveTypes.id,
          name: leaveTypes.name,
          code: leaveTypes.code,
          description: leaveTypes.description,
          defaultQuotaDays: leaveTypes.default_quota_days,
          isPaid: leaveTypes.is_paid,
          allowHalfDay: leaveTypes.allow_half_day,
          color: leaveTypes.color,
          displayOrder: leaveTypes.display_order,
        })
        .from(leaveTypes)
        .where(
          and(
            eq(leaveTypes.tenant_id, tenantId),
            eq(leaveTypes.is_active, true),
            this.genderScope(gender),
          ),
        )
        .orderBy(leaveTypes.display_order, leaveTypes.name),
    );
    return { data: rows, total: rows.length };
  }

  async createLeaveType(
    tenantId: string,
    actorUserId: string,
    dto: CreateLeaveTypeDto,
  ) {
    const [created] = await this.databaseService.withTenant(
      tenantId,
      (tx) =>
        tx
          .insert(leaveTypes)
          .values({
            tenant_id: tenantId,
            name: dto.name,
            code: dto.code.toUpperCase(),
            description: dto.description,
            default_quota_days: dto.defaultQuotaDays,
            is_paid: dto.isPaid ?? true,
          })
          .returning(),
    );

    if (!created) {
      throw new BadRequestException('Leave type could not be created');
    }

    await this.auditService.log({
      tenantId,
      actorUserId,
      action: 'leave_type.created',
      resourceType: 'leave_type',
      resourceId: created.id,
      afterState: { name: created.name, code: created.code },
    });

    return {
      id: created.id,
      name: created.name,
      code: created.code,
      defaultQuotaDays: created.default_quota_days,
      isPaid: created.is_paid,
    };
  }

  // ─── Balances ──────────────────────────────────────────────────────────────

  async getMyBalances(userId: string, tenantId: string) {
    const { id: employeeId, gender } = await this.getEmployeeForUser(
      userId,
      tenantId,
    );
    const leaveYear = new Date().getFullYear();

    return this.databaseService.withTenant(tenantId, async (tx) => {
      // For each active leave type, compute the balance row if it exists; otherwise
      // synthesise a default from the leave-type quota.
      const types = await tx
        .select()
        .from(leaveTypes)
        .where(
          and(
            eq(leaveTypes.tenant_id, tenantId),
            eq(leaveTypes.is_active, true),
            this.genderScope(gender),
          ),
        );

      const existing = await tx
        .select()
        .from(leaveBalances)
        .where(
          and(
            eq(leaveBalances.tenant_id, tenantId),
            eq(leaveBalances.employee_id, employeeId),
            eq(leaveBalances.leave_year, leaveYear),
          ),
        );
      const byType = new Map(existing.map((b) => [b.leave_type_id, b]));

      const balances = types.map((t) => {
        const b = byType.get(t.id);
        if (b) {
          return {
            leaveTypeId: t.id,
            leaveTypeName: t.name,
            code: t.code,
            color: t.color,
            opening: b.opening_balance,
            accrued: b.accrued,
            used: b.used,
            pending: b.pending,
            available: b.available ?? 0,
          };
        }
        return {
          leaveTypeId: t.id,
          leaveTypeName: t.name,
          code: t.code,
          color: t.color,
          opening: t.default_quota_days,
          accrued: 0,
          used: 0,
          pending: 0,
          available: t.default_quota_days,
        };
      });

      return { leaveYear, balances };
    });
  }

  // ─── Apply ─────────────────────────────────────────────────────────────────

  async applyLeave(userId: string, tenantId: string, dto: ApplyLeaveDto) {
    const { id: employeeId, gender } = await this.getEmployeeForUser(
      userId,
      tenantId,
    );

    // Holiday-aware day counting (PRD §7.7 acceptance #8): subtract any
    // tenant holidays falling within the leave range so a Mon–Fri leave
    // straddling a Wed holiday counts as 4 days, not 5.
    const holidayDates = await this.fetchHolidayDates(
      tenantId,
      dto.startDate,
      dto.endDate,
      employeeId,
    );
    // Round L: count on the employee's shift working days, not a Mon–Fri
    // literal — a Saturday shift takes a Saturday off as a leave day.
    const workingDays = await this.databaseService.withTenant(tenantId, (tx) =>
      this.workingDaysFor(tx, tenantId, employeeId, dto.startDate),
    );
    const totalDays = dto.isHalfDay
      ? 0.5
      : countBusinessDays(dto.startDate, dto.endDate, holidayDates, workingDays);
    if (totalDays <= 0) {
      throw new BadRequestException(
        'Leave dates do not include any business day',
      );
    }

    const result = await this.databaseService.withTenant(
      tenantId,
      async (tx) => {
        // Reject overlapping pending or approved requests for the same employee.
        const overlapping = await tx
          .select({ id: leaveRequests.id })
          .from(leaveRequests)
          .where(
            and(
              eq(leaveRequests.tenant_id, tenantId),
              eq(leaveRequests.employee_id, employeeId),
              or(
                eq(leaveRequests.status, 'pending'),
                eq(leaveRequests.status, 'approved'),
              ),
              lte(leaveRequests.start_date, dto.endDate),
              gte(leaveRequests.end_date, dto.startDate),
            ),
          )
          .limit(1);
        if (overlapping.length > 0) {
          throw new BadRequestException(
            'You already have an overlapping leave request for these dates',
          );
        }

        // Verify the leave type exists, is active, and applies to the
        // applicant's gender (a male employee cannot apply for Maternity).
        const [type] = await tx
          .select()
          .from(leaveTypes)
          .where(
            and(
              eq(leaveTypes.tenant_id, tenantId),
              eq(leaveTypes.id, dto.leaveTypeId),
              eq(leaveTypes.is_active, true),
              this.genderScope(gender),
            ),
          )
          .limit(1);
        if (!type) {
          throw new BadRequestException(
            'Leave type not found, inactive, or not applicable to you',
          );
        }

        // Round L (item 2): where the request is born — level 0 with the
        // reporting manager snapshotted; straight to the manager's manager
        // when the manager is on approved full-day leave today; straight to
        // Owner + HR Admins (`no_manager`) when there is no valid manager.
        const today = await tenantTodayISOTx(tx, tenantId);
        const { state } = await this.routing.initialStateTx(tx, tenantId, employeeId, today);

        // Insert the request.
        const [request] = await tx
          .insert(leaveRequests)
          .values({
            tenant_id: tenantId,
            employee_id: employeeId,
            leave_type_id: dto.leaveTypeId,
            start_date: dto.startDate,
            end_date: dto.endDate,
            is_half_day: dto.isHalfDay ?? false,
            half_day_session: dto.halfDaySession ?? null,
            total_days: totalDays,
            reason: dto.reason,
            cover_employee_id: dto.coverEmployeeId ?? null,
            status: 'pending',
            ...routeStateColumns(state),
          })
          .returning();

        // Increment the employee's pending balance for that leave type/year.
        const leaveYear = new Date(dto.startDate).getFullYear();
        await tx
          .insert(leaveBalances)
          .values({
            tenant_id: tenantId,
            employee_id: employeeId,
            leave_type_id: dto.leaveTypeId,
            leave_year: leaveYear,
            opening_balance: type.default_quota_days,
            pending: totalDays,
          })
          .onConflictDoUpdate({
            target: [
              leaveBalances.tenant_id,
              leaveBalances.employee_id,
              leaveBalances.leave_type_id,
              leaveBalances.leave_year,
            ],
            set: {
              pending: sql`${leaveBalances.pending} + ${totalDays}`,
              updated_at: new Date(),
            },
          });

        return { request: request!, type, state };
      },
    );

    // Notify (best-effort — service swallows email failures).
    // The "approver" is the requesting employee's reporting manager. To find their
    // email we step outside RLS via the admin client (manager may be in same
    // tenant but resolving the user record requires a join we don't need scoped).
    this.notifyOnApply(tenantId, employeeId, result.request.id, result.type.name, {
      startDate: result.request.start_date,
      endDate: result.request.end_date,
      days: Number(result.request.total_days),
      reason: result.request.reason ?? undefined,
    }).catch((err) => this.logger.warn(`Leave apply notification failed: ${err}`));

    await this.auditService.log({
      tenantId,
      actorUserId: userId,
      action: 'leave.applied',
      resourceType: 'leave_request',
      resourceId: result.request.id,
      afterState: {
        leaveTypeId: dto.leaveTypeId,
        startDate: dto.startDate,
        endDate: dto.endDate,
        totalDays,
      },
    });

    return {
      id: result.request.id,
      leaveTypeId: result.request.leave_type_id,
      startDate: result.request.start_date,
      endDate: result.request.end_date,
      isHalfDay: result.request.is_half_day,
      totalDays: result.request.total_days,
      status: result.request.status,
      reason: result.request.reason,
      // Round L — employee-facing: the level only ("With your manager" /
      // "With HR"), never the reason or a reviewer's name.
      ...authorRoutingView(result.state.level),
    };
  }

  private async notifyOnApply(
    tenantId: string,
    employeeId: string,
    requestId: string,
    leaveTypeName: string,
    dates: { startDate: string; endDate: string; days: number; reason?: string },
  ) {
    // Resolve the requesting employee + their manager's email.
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

    const employeeName = `${employee.firstName} ${employee.lastName}`.trim();

    // Round L: who gets pinged is the routing chain — the reporting manager
    // (level 0), the manager's manager (level 1, manager on leave today) or
    // Owner + HR Admins (level 2, no manager). The applicant is never a
    // recipient (employees.user_id + the membership bridge), and a level
    // whose reviewer does not exist falls through to HR — an owner's own
    // request never dead-ends (house rule 8).
    const { route, level, reason } = await this.databaseService.withTenant(tenantId, async (tx) => {
      const route = await this.routing.resolveRouteTx(tx, tenantId, employeeId);
      const live = await this.routing.readStateTx(tx, tenantId, 'leave', requestId);
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

    // Round I: deep links straight to THIS request on the Team → Leave page.
    // `action=` only pre-selects the decision in a confirm dialog — the link
    // itself never approves or rejects anything (a scanner following it must
    // change nothing), and the page still requires a signed-in reviewer.
    const reviewUrl = `${this.appUrl()}/team/leave?request=${encodeURIComponent(requestId)}`;
    const approveUrl = `${reviewUrl}&action=approve`;
    const rejectUrl = `${reviewUrl}&action=reject`;

    for (const reviewer of reviewers) {
      // Real-time in-app ping to the approver — surfaces in the Topbar bell
      // even when the email lands in spam or is disabled. Best-effort.
      if (reviewer.userId) {
        await this.notificationsService
          .createInAppNotification(
            reviewer.userId,
            'leave.requested',
            `${employeeName || 'An employee'} requested ${leaveTypeName} (${dates.days} day${dates.days === 1 ? '' : 's'})${why}`,
            `/team/leave?request=${encodeURIComponent(requestId)}`,
            tenantId,
          )
          .catch((err) =>
            this.logger.warn(`Leave-apply in-app notification failed: ${err}`),
          );
      }

      if (!reviewer.email) continue;

      await this.notificationsService.sendEmail(
        'leave-requested',
        reviewer.email,
        {
          employeeName,
          leaveType: leaveTypeName,
          startDate: dates.startDate,
          endDate: dates.endDate,
          days: dates.days,
          reason: dates.reason,
          reviewUrl,
          approveUrl,
          rejectUrl,
        },
        // Preference-gated like the in-app ping already is (a reviewer who
        // muted leave_requested/email stops getting these).
        reviewer.userId
          ? { userId: reviewer.userId, event: 'leave_requested' }
          : undefined,
      );
      this.logger.log(
        `Leave-apply email queued to ${reviewer.email} (req=${requestId})`,
      );
    }
  }

  // (Round L: `resolveLeaveReviewers` is gone — ApprovalRoutingService
  // .recipientsFor(route, level) is the one source of "who reviews".)

  // ─── List ──────────────────────────────────────────────────────────────────

  async listMine(userId: string, tenantId: string, query: LeaveListQueryDto) {
    const employeeId = await this.getEmployeeIdForUser(userId, tenantId);
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, 100);
    const offset = (page - 1) * limit;

    const rows = await this.databaseService.withTenant(tenantId, (tx) =>
      tx
        .select({
          id: leaveRequests.id,
          leaveTypeId: leaveRequests.leave_type_id,
          startDate: leaveRequests.start_date,
          endDate: leaveRequests.end_date,
          isHalfDay: leaveRequests.is_half_day,
          totalDays: leaveRequests.total_days,
          status: leaveRequests.status,
          reason: leaveRequests.reason,
          appliedAt: leaveRequests.applied_at,
          leaveTypeName: leaveTypes.name,
          leaveTypeColor: leaveTypes.color,
          escalationLevel: leaveRequests.escalation_level,
        })
        .from(leaveRequests)
        .leftJoin(leaveTypes, eq(leaveRequests.leave_type_id, leaveTypes.id))
        .where(
          and(
            eq(leaveRequests.tenant_id, tenantId),
            eq(leaveRequests.employee_id, employeeId),
          ),
        )
        .orderBy(desc(leaveRequests.created_at))
        .limit(limit)
        .offset(offset),
    );
    // Round L — employee-facing: the level only ("With your manager" / "With
    // HR"), never the reason or a reviewer's name.
    const data = rows.map(({ escalationLevel, ...r }) => ({ ...r, ...authorRoutingView(escalationLevel) }));

    return { data, pagination: { page, limit, total: data.length } };
  }

  // ─── Cancel ────────────────────────────────────────────────────────────────

  async cancelLeave(
    leaveRequestId: string,
    userId: string,
    tenantId: string,
    dto: CancelLeaveDto,
  ) {
    const employeeId = await this.getEmployeeIdForUser(userId, tenantId);

    return this.databaseService.withTenant(tenantId, async (tx) => {
      const [req] = await tx
        .select()
        .from(leaveRequests)
        .where(
          and(
            eq(leaveRequests.id, leaveRequestId),
            eq(leaveRequests.tenant_id, tenantId),
          ),
        )
        .limit(1);
      if (!req) throw new NotFoundException('Leave request not found');
      if (req.employee_id !== employeeId) {
        throw new ForbiddenException('You can only cancel your own leave');
      }
      if (req.status === 'cancelled' || req.status === 'rejected') {
        throw new BadRequestException(`Cannot cancel a ${req.status} request`);
      }

      const wasPending = req.status === 'pending';
      const wasApproved = req.status === 'approved';

      // Round L: approval wrote on_leave / half_day rows for the leave's
      // days. Remove the ones nobody punched into, or the team board keeps
      // saying "On leave" after the person changed their mind (the day
      // resolver stops saying it the moment the request is cancelled).
      if (wasApproved) {
        await tx
          .delete(attendanceRecords)
          .where(
            and(
              eq(attendanceRecords.tenant_id, tenantId),
              eq(attendanceRecords.employee_id, employeeId),
              gte(attendanceRecords.attendance_date, req.start_date),
              lte(attendanceRecords.attendance_date, req.end_date),
              eq(attendanceRecords.source, 'system'),
              isNull(attendanceRecords.first_punch_in_at),
              inArray(attendanceRecords.attendance_status, ['on_leave', 'half_day']),
            ),
          );
      }

      const [updated] = await tx
        .update(leaveRequests)
        .set({
          status: 'cancelled',
          cancelled_at: new Date(),
          updated_at: new Date(),
        })
        .where(eq(leaveRequests.id, leaveRequestId))
        .returning();

      // Release balance: pending if was pending, used if was approved.
      if (wasPending || wasApproved) {
        const leaveYear = new Date(req.start_date).getFullYear();
        const column = wasPending ? leaveBalances.pending : leaveBalances.used;
        await tx
          .update(leaveBalances)
          .set({
            ...(wasPending
              ? { pending: sql`${leaveBalances.pending} - ${req.total_days}` }
              : { used: sql`${leaveBalances.used} - ${req.total_days}` }),
            updated_at: new Date(),
          })
          .where(
            and(
              eq(leaveBalances.tenant_id, tenantId),
              eq(leaveBalances.employee_id, employeeId),
              eq(leaveBalances.leave_type_id, req.leave_type_id),
              eq(leaveBalances.leave_year, leaveYear),
            ),
          );
      }

      await this.auditService.log({
        tenantId,
        actorUserId: userId,
        action: 'leave.cancelled',
        resourceType: 'leave_request',
        resourceId: leaveRequestId,
        beforeState: { status: req.status },
        afterState: { status: 'cancelled' },
        metadata: { reason: dto.reason },
      });

      return {
        id: updated!.id,
        status: 'cancelled' as const,
        cancelledAt: updated!.cancelled_at?.toISOString() ?? null,
      };
    });
  }

  // ─── Pending (manager queue) ──────────────────────────────────────────────

  async listPending(
    userId: string,
    tenantId: string,
    query: LeaveListQueryDto,
    roleHint?: string,
  ) {
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, 100);
    const offset = (page - 1) * limit;

    const data = await this.databaseService.withTenant(tenantId, async (tx) => {
      const reviewer = await this.resolveReviewer(tx, userId, tenantId, roleHint);
      const escalatedTo = alias(employees, 'escalated_to');
      const rows = await tx
        .select({
          id: leaveRequests.id,
          employeeId: leaveRequests.employee_id,
          leaveTypeId: leaveRequests.leave_type_id,
          startDate: leaveRequests.start_date,
          endDate: leaveRequests.end_date,
          totalDays: leaveRequests.total_days,
          reason: leaveRequests.reason,
          appliedAt: leaveRequests.applied_at,
          employeeName: sql<string>`${employees.first_name} || ' ' || ${employees.last_name}`,
          employeeCode: employees.employee_code,
          leaveTypeName: leaveTypes.name,
          leaveTypeCode: leaveTypes.code,
          escalationLevel: leaveRequests.escalation_level,
          escalationReason: leaveRequests.escalation_reason,
          escalatedAt: leaveRequests.escalated_at,
          escalatedToName: sql<string | null>`CASE WHEN ${escalatedTo.id} IS NULL THEN NULL ELSE ${escalatedTo.first_name} || ' ' || ${escalatedTo.last_name} END`,
        })
        .from(leaveRequests)
        .leftJoin(employees, eq(leaveRequests.employee_id, employees.id))
        .leftJoin(leaveTypes, eq(leaveRequests.leave_type_id, leaveTypes.id))
        .leftJoin(
          escalatedTo,
          and(eq(escalatedTo.id, leaveRequests.escalated_to_employee_id), eq(escalatedTo.tenant_id, tenantId)),
        )
        .where(
          and(
            eq(leaveRequests.tenant_id, tenantId),
            eq(leaveRequests.status, 'pending'),
            // Nobody reviews their own request. An owner/admin applying for
            // leave must be approved by ANOTHER approver, so their own row
            // never enters their queue (mirrors the onboarding-queue rule in
            // employees.service.ts). IS DISTINCT FROM keeps rows whose
            // employee has no linked user account.
            sql`${employees.user_id} IS DISTINCT FROM ${userId}`,
            // Round L: the ROUTED queue — direct reports, requests escalated
            // to me, and (owner/admin) requests at level 2 / with no manager.
            // Removed employees (round 21) never surface.
            this.routing.queuePredicate(reviewer, leaveRequests, leaveRequests.employee_id),
            isNull(employees.deleted_at),
          ),
        )
        .orderBy(desc(leaveRequests.applied_at))
        .limit(limit)
        .offset(offset);
      return rows.map(({ escalationLevel, escalationReason, escalatedAt, escalatedToName, ...r }) => ({
        ...r,
        escalation: shapeEscalation({ escalationLevel, escalationReason, escalatedAt }, escalatedToName),
        routedToMe: true as const,
      }));
    });

    return { data, pagination: { page, limit, total: data.length } };
  }

  // ─── Team (Round I: Team → Leave — Pending | Upcoming | History) ───────────

  /**
   * Every request from the reviewer's team, any status, with the leave type
   * and the approver resolved. Same scope rule as the pending queue
   * (owner/admin: whole workspace; manager: direct reports), the caller's own
   * requests excluded (those live under My leave).
   */
  async listTeam(
    userId: string,
    tenantId: string,
    query: TeamLeaveQueryDto,
    roleHint?: string,
  ) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(Math.max(1, query.limit ?? 50), 100);
    const offset = (page - 1) * limit;
    const status = query.status ?? 'all';

    const result = await this.databaseService.withTenant(tenantId, async (tx) => {
      const reviewer = await this.resolveReviewer(tx, userId, tenantId, roleHint);
      const approver = alias(employees, 'approver');
      // Round L: the org chart still decides the SCOPE (owner/admin: the
      // workspace — the "open directly" surface; managers: direct reports);
      // `routedToMe` says whether a row is in the caller's queue, and the
      // manager / escalation columns feed the chips.
      const manager = alias(employees, 'live_manager');
      const escalatedTo = alias(employees, 'escalated_to');
      const routedToMe = this.routing.queuePredicate(reviewer, leaveRequests, leaveRequests.employee_id);
      // A manager's page shows their direct reports PLUS anything escalated
      // to them (the manager's manager follows the bell's deep link here —
      // it must never say "not waiting on you"). Owner/admin: the workspace.
      const scopeOrRouted = reviewer.orgWide
        ? sql`true`
        : reviewer.employeeId
          ? sql`(${employees.reporting_manager_id} = ${reviewer.employeeId} OR (${leaveRequests.escalation_level} >= 1 AND ${leaveRequests.escalated_to_employee_id} = ${reviewer.employeeId}))`
          : sql`false`;
      const where = and(
        eq(leaveRequests.tenant_id, tenantId),
        status === 'all' ? undefined : eq(leaveRequests.status, status),
        query.from ? gte(leaveRequests.end_date, query.from) : undefined,
        query.to ? lte(leaveRequests.start_date, query.to) : undefined,
        sql`${employees.user_id} IS DISTINCT FROM ${userId}`,
        scopeOrRouted,
        isNull(employees.deleted_at),
      );

      const [rows, [countRow]] = await Promise.all([
        tx
          .select({
            id: leaveRequests.id,
            employeeId: leaveRequests.employee_id,
            employeeUserId: employees.user_id,
            employeeName: sql<string>`${employees.first_name} || ' ' || ${employees.last_name}`,
            employeeCode: employees.employee_code,
            // Round N — the requester's photo; signed AFTER the tx, the key
            // is stripped by the mapper and never reaches a response.
            avatarKey: users.avatar_key,
            avatarUrl: users.avatar_url,
            leaveTypeId: leaveRequests.leave_type_id,
            leaveTypeName: leaveTypes.name,
            leaveTypeCode: leaveTypes.code,
            startDate: leaveRequests.start_date,
            endDate: leaveRequests.end_date,
            isHalfDay: leaveRequests.is_half_day,
            totalDays: leaveRequests.total_days,
            reason: leaveRequests.reason,
            status: leaveRequests.status,
            appliedAt: leaveRequests.applied_at,
            approverId: leaveRequests.approver_id,
            approverName: sql<string | null>`CASE WHEN ${approver.id} IS NULL THEN NULL ELSE ${approver.first_name} || ' ' || ${approver.last_name} END`,
            approverComment: leaveRequests.approver_comment,
            approvedAt: leaveRequests.approved_at,
            rejectedAt: leaveRequests.rejected_at,
            cancelledAt: leaveRequests.cancelled_at,
            routedToMe: sql<boolean>`(${routedToMe})`,
            managerName: sql<string | null>`CASE WHEN ${manager.id} IS NULL THEN NULL ELSE ${manager.first_name} || ' ' || ${manager.last_name} END`,
            escalationLevel: leaveRequests.escalation_level,
            escalationReason: leaveRequests.escalation_reason,
            escalatedAt: leaveRequests.escalated_at,
            escalatedToName: sql<string | null>`CASE WHEN ${escalatedTo.id} IS NULL THEN NULL ELSE ${escalatedTo.first_name} || ' ' || ${escalatedTo.last_name} END`,
          })
          .from(leaveRequests)
          .leftJoin(employees, eq(leaveRequests.employee_id, employees.id))
          // Round N — the requester's account row carries the photo key.
          .leftJoin(users, eq(employees.user_id, users.id))
          .leftJoin(leaveTypes, eq(leaveRequests.leave_type_id, leaveTypes.id))
          .leftJoin(
            approver,
            and(eq(approver.id, leaveRequests.approver_id), eq(approver.tenant_id, tenantId)),
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
            and(eq(escalatedTo.id, leaveRequests.escalated_to_employee_id), eq(escalatedTo.tenant_id, tenantId)),
          )
          .where(where)
          .orderBy(
            // Pending first-in-first-out by application; everything else
            // most recent leave first.
            status === 'pending' ? desc(leaveRequests.applied_at) : desc(leaveRequests.start_date),
            desc(leaveRequests.id),
          )
          .limit(limit)
          .offset(offset),
        tx
          .select({ total: sql<number>`COUNT(*)::int` })
          .from(leaveRequests)
          .leftJoin(employees, eq(leaveRequests.employee_id, employees.id))
          .where(where),
      ]);

      const total = countRow?.total ?? 0;
      const data = rows.map(({ escalationLevel, escalationReason, escalatedAt, escalatedToName, ...r }) => ({
        ...r,
        routedToMe: r.routedToMe === true,
        escalation: shapeEscalation({ escalationLevel, escalationReason, escalatedAt }, escalatedToName),
      }));
      return {
        data,
        pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
        scope: reviewer.orgWide ? ('org' as const) : ('team' as const),
      };
    });
    // Round N — sign the photos AFTER the tenant transaction (local SigV4
    // crypto, no DB); the mapper strips avatarKey from every row.
    return { ...result, data: await withSignedAvatars(this.signAvatar, result.data) };
  }

  // ─── Review (approve/reject) ──────────────────────────────────────────────

  async reviewLeave(
    leaveRequestId: string,
    reviewerUserId: string,
    tenantId: string,
    dto: ReviewLeaveDto,
    roleHint?: string,
  ) {
    const reviewerEmployeeId = await this.getEmployeeIdForUser(
      reviewerUserId,
      tenantId,
    );

    const result = await this.databaseService.withTenant(
      tenantId,
      async (tx) => {
        const [req] = await tx
          .select()
          .from(leaveRequests)
          .where(
            and(
              eq(leaveRequests.id, leaveRequestId),
              eq(leaveRequests.tenant_id, tenantId),
            ),
          )
          .limit(1);
        if (!req) throw new NotFoundException('Leave request not found');
        if (req.status !== 'pending') {
          throw new BadRequestException(
            `Cannot review a ${req.status} request`,
          );
        }

        // Round L: one guard for every review path — the live reporting
        // manager always may act; the manager's manager once the request was
        // escalated to them; owner/admin always (opened directly from Team →
        // Leave); never the applicant (employees.user_id AND the membership
        // bridge — which closes the old self-approval gap for a seat linked
        // only through memberships.employee_id).
        const reviewerCtx = await this.resolveReviewer(tx, reviewerUserId, tenantId, roleHint);
        const how = await this.routing.assertMayActTx(
          tx,
          tenantId,
          reviewerCtx,
          {
            applicantEmployeeId: req.employee_id,
            level: req.escalation_level,
            escalatedTo: req.escalated_to_employee_id,
          },
          'leave',
        );
        // Decided over the routed manager's head (owner/admin directly, or
        // the skip-level manager)? They are told after commit.
        const onBehalfRoute =
          how === 'manager' ? null : await this.routing.resolveRouteTx(tx, tenantId, req.employee_id);

        const newStatus =
          dto.action === 'approve' ? ('approved' as const) : ('rejected' as const);
        const now = new Date();

        const [updated] = await tx
          .update(leaveRequests)
          .set({
            status: newStatus,
            approver_id: reviewerEmployeeId,
            approver_comment: dto.comment ?? null,
            approved_at: dto.action === 'approve' ? now : null,
            rejected_at: dto.action === 'reject' ? now : null,
            updated_at: now,
          })
          .where(eq(leaveRequests.id, leaveRequestId))
          .returning();

        // Move pending balance to used (approve) or release (reject).
        const leaveYear = new Date(req.start_date).getFullYear();
        if (dto.action === 'approve') {
          await tx
            .update(leaveBalances)
            .set({
              pending: sql`${leaveBalances.pending} - ${req.total_days}`,
              used: sql`${leaveBalances.used} + ${req.total_days}`,
              updated_at: now,
            })
            .where(
              and(
                eq(leaveBalances.tenant_id, tenantId),
                eq(leaveBalances.employee_id, req.employee_id),
                eq(leaveBalances.leave_type_id, req.leave_type_id),
                eq(leaveBalances.leave_year, leaveYear),
              ),
            );

          // PRD §7.7 acceptance #7: approved leave creates attendance_records
          // with status='on_leave' so daily/weekly reports show the day off.
          // Skip weekends and holidays (already excluded by total_days math).
          const [reqEmp] = await tx
            .select({ locationId: employees.location_id })
            .from(employees)
            .where(
              and(
                eq(employees.id, req.employee_id),
                eq(employees.tenant_id, tenantId),
              ),
            )
            .limit(1);
          const holidayRows = await tx
            .select({ d: holidays.holiday_date })
            .from(holidays)
            .where(
              this.workingHolidayFilter(
                tenantId,
                req.start_date,
                req.end_date,
                reqEmp?.locationId ?? null,
              ),
            );
          const holidayDates = new Set(holidayRows.map((h) => h.d));
          // Round L: the shift's working days decide which dates get a row
          // (a Saturday-working shift's Saturday leave is a leave day).
          const workingDays = await this.workingDaysFor(
            tx,
            tenantId,
            req.employee_id,
            req.start_date,
          );
          // Round C: ONE bulk upsert — the serial per-day loop cost a
          // round-trip per business day (a two-week leave = 10 extra RTs on
          // the approver's click).
          const days = [
            ...businessDays(req.start_date, req.end_date, holidayDates, workingDays),
          ];
          if (days.length && req.is_half_day) {
            // Round L: a half-day request marks the day 'half_day', never
            // 'on_leave' — the person is expected for the other half. The
            // upsert never demotes a day already worked (present/late/WFH…).
            await tx
              .insert(attendanceRecords)
              .values(
                days.map((day) => ({
                  tenant_id: tenantId,
                  employee_id: req.employee_id,
                  attendance_date: day,
                  attendance_status: 'half_day' as const,
                  source: 'system' as const,
                  notes: `Half-day leave (${req.half_day_session ?? 'half'}): ${req.reason ?? ''}`.slice(0, 500),
                })),
              )
              .onConflictDoUpdate({
                target: [
                  attendanceRecords.tenant_id,
                  attendanceRecords.employee_id,
                  attendanceRecords.attendance_date,
                ],
                set: {
                  attendance_status: sql`CASE WHEN ${attendanceRecords.attendance_status} IN ('present','late','work_from_home','on_duty','comp_off') THEN ${attendanceRecords.attendance_status} ELSE 'half_day'::attendance_status END`,
                  notes: sql`COALESCE(${attendanceRecords.notes}, '') || E'\nHalf-day leave approved'`,
                  updated_at: now,
                },
              });
          } else if (days.length) {
            // Full-day leave: on_leave, except a day already WORKED (present,
            // late, WFH, on duty, comp off — same protected list as the
            // half-day branch) or regularised by the manager: the fact on the
            // ground stands, the leave only fills the empty days.
            await tx
              .insert(attendanceRecords)
              .values(
                days.map((day) => ({
                  tenant_id: tenantId,
                  employee_id: req.employee_id,
                  attendance_date: day,
                  attendance_status: 'on_leave' as const,
                  source: 'system' as const,
                  notes: `Leave: ${req.reason ?? ''}`.slice(0, 500),
                })),
              )
              .onConflictDoUpdate({
                target: [
                  attendanceRecords.tenant_id,
                  attendanceRecords.employee_id,
                  attendanceRecords.attendance_date,
                ],
                set: {
                  attendance_status: sql`CASE WHEN ${attendanceRecords.is_regularized} OR ${attendanceRecords.attendance_status} IN ('present','late','work_from_home','on_duty','comp_off') THEN ${attendanceRecords.attendance_status} ELSE 'on_leave'::attendance_status END`,
                  notes: sql`COALESCE(${attendanceRecords.notes}, '') || E'\nLeave approved'`,
                  updated_at: now,
                },
              });
          }
        } else {
          await tx
            .update(leaveBalances)
            .set({
              pending: sql`${leaveBalances.pending} - ${req.total_days}`,
              updated_at: now,
            })
            .where(
              and(
                eq(leaveBalances.tenant_id, tenantId),
                eq(leaveBalances.employee_id, req.employee_id),
                eq(leaveBalances.leave_type_id, req.leave_type_id),
                eq(leaveBalances.leave_year, leaveYear),
              ),
            );
        }

        // Resolve emails for the notification.
        const [requester] = await tx
          .select({
            firstName: employees.first_name,
            lastName: employees.last_name,
            email: employees.work_email,
            userId: employees.user_id,
          })
          .from(employees)
          .where(eq(employees.id, req.employee_id))
          .limit(1);
        const [reviewer] = await tx
          .select({
            firstName: employees.first_name,
            lastName: employees.last_name,
          })
          .from(employees)
          .where(eq(employees.id, reviewerEmployeeId))
          .limit(1);
        const [type] = await tx
          .select({ name: leaveTypes.name })
          .from(leaveTypes)
          .where(eq(leaveTypes.id, req.leave_type_id))
          .limit(1);

        return {
          updated: updated!,
          requesterEmail: requester?.email ?? null,
          requesterUserId: requester?.userId ?? null,
          requesterName:
            `${requester?.firstName ?? ''} ${requester?.lastName ?? ''}`.trim(),
          reviewerName:
            `${reviewer?.firstName ?? ''} ${reviewer?.lastName ?? ''}`.trim(),
          leaveTypeName: type?.name ?? 'Leave',
          startDate: req.start_date,
          endDate: req.end_date,
          onBehalfRoute,
          escalationLevel: req.escalation_level,
        };
      },
    );

    // Round L: the routed manager (and the skip-level manager, once it had
    // reached them) learn that someone decided on their behalf. Best-effort.
    if (result.onBehalfRoute) {
      void this.routing.notifyDecidedOnBehalf(tenantId, 'leave', leaveRequestId, result.onBehalfRoute, result.escalationLevel, {
        deciderUserId: reviewerUserId,
        deciderName: result.reviewerName,
        employeeName: result.requesterName,
        action: dto.action,
      });
    }

    if (result.requesterEmail) {
      const tpl =
        dto.action === 'approve' ? 'leave-approved' : 'leave-rejected';
      this.notificationsService
        .sendEmail(tpl, result.requesterEmail, {
          employeeName: result.requesterName,
          leaveType: result.leaveTypeName,
          startDate: result.startDate,
          endDate: result.endDate,
          approverName: result.reviewerName,
          comment: dto.comment,
        })
        .catch((err) =>
          this.logger.warn(`Leave-review notification failed: ${err}`),
        );
    }

    // Real-time in-app ping to the requester with the decision. Best-effort,
    // detached (round C) — createInAppNotification never throws at source.
    if (result.requesterUserId) {
      const approved = dto.action === 'approve';
      void this.notificationsService.createInAppNotification(
        result.requesterUserId,
        approved ? 'leave.approved' : 'leave.rejected',
        `Your ${result.leaveTypeName} (${result.startDate} – ${result.endDate}) was ${approved ? 'approved' : 'declined'}${result.reviewerName ? ` by ${result.reviewerName}` : ''}.`,
        '/leave',
        tenantId,
      );
    }

    // Detached (round C): committed decision; audit must not delay the CTA.
    void this.auditService.log({
      tenantId,
      actorUserId: reviewerUserId,
      action: `leave.${result.updated.status}`,
      resourceType: 'leave_request',
      resourceId: leaveRequestId,
      afterState: { status: result.updated.status },
      metadata: { comment: dto.comment },
    });

    return {
      id: result.updated.id,
      status: result.updated.status,
      reviewedAt:
        (dto.action === 'approve'
          ? result.updated.approved_at
          : result.updated.rejected_at
        )?.toISOString() ?? null,
    };
  }

  // ─── Holidays ──────────────────────────────────────────────────────────────

  /**
   * Lists holidays for a year. Default scope is "as they apply to the
   * caller": company-wide rows plus the caller's own location's rows (an
   * employee in Chennai never sees Dubai's holidays). Admin screens pass
   * locationScope='all' (everything, with location names), 'company'
   * (company-wide only) or a location id.
   */
  async listHolidays(
    tenantId: string,
    opts: { year?: number; locationScope?: string; userId?: string } = {},
  ) {
    const targetYear = opts.year ?? new Date().getFullYear();
    const yearStart = `${targetYear}-01-01`;
    const yearEnd = `${targetYear}-12-31`;
    const scope = opts.locationScope;

    const rows = await this.databaseService.withTenant(tenantId, async (tx) => {
      let locationCond;
      if (scope === 'all') {
        locationCond = undefined;
      } else if (scope === 'company') {
        locationCond = isNull(holidays.location_id);
      } else if (scope) {
        // Explicit location: that location's rows + company-wide rows.
        locationCond = or(
          isNull(holidays.location_id),
          eq(holidays.location_id, scope),
        );
      } else {
        // Caller-scoped: resolve their employee row's location. No employee
        // row (e.g. auditor) → company-wide only.
        let callerLocationId: string | null = null;
        if (opts.userId) {
          const [emp] = await tx
            .select({ locationId: employees.location_id })
            .from(employees)
            .where(
              and(
                eq(employees.tenant_id, tenantId),
                eq(employees.user_id, opts.userId),
              ),
            )
            .limit(1);
          callerLocationId = emp?.locationId ?? null;
        }
        locationCond = callerLocationId
          ? or(
              isNull(holidays.location_id),
              eq(holidays.location_id, callerLocationId),
            )
          : isNull(holidays.location_id);
      }

      return tx
        .select({
          id: holidays.id,
          date: holidays.holiday_date,
          name: holidays.name,
          type: holidays.type,
          description: holidays.description,
          locationId: holidays.location_id,
          locationName: locations.name,
          isRecurring: holidays.is_recurring,
        })
        .from(holidays)
        .leftJoin(locations, eq(holidays.location_id, locations.id))
        .where(
          and(
            eq(holidays.tenant_id, tenantId),
            gte(holidays.holiday_date, yearStart),
            lte(holidays.holiday_date, yearEnd),
            ...(locationCond ? [locationCond] : []),
          ),
        )
        .orderBy(holidays.holiday_date);
    });

    return { year: targetYear, holidays: rows };
  }

  // ─── Holiday admin CRUD (Owner/HR) ─────────────────────────────────────────

  /** locationId from a DTO must exist in this tenant (FK checks bypass RLS). */
  private async assertLocationInTenant(
    tx: Db,
    tenantId: string,
    locationId: string,
  ) {
    const [row] = await tx
      .select({ id: locations.id })
      .from(locations)
      .where(
        and(eq(locations.id, locationId), eq(locations.tenant_id, tenantId)),
      )
      .limit(1);
    if (!row)
      throw new BadRequestException(
        'locationId does not belong to this workspace',
      );
  }

  async createHoliday(tenantId: string, dto: CreateHolidayDto) {
    return this.databaseService.withTenant(tenantId, async (tx) => {
      if (dto.locationId) {
        await this.assertLocationInTenant(tx, tenantId, dto.locationId);
      }
      // Same date + name + scope twice is always a double-submit, not intent.
      const [dup] = await tx
        .select({ id: holidays.id })
        .from(holidays)
        .where(
          and(
            eq(holidays.tenant_id, tenantId),
            eq(holidays.holiday_date, dto.date),
            eq(holidays.name, dto.name),
            dto.locationId
              ? eq(holidays.location_id, dto.locationId)
              : isNull(holidays.location_id),
          ),
        )
        .limit(1);
      if (dup) {
        throw new ConflictException(
          'That holiday already exists for this date and location',
        );
      }
      const [row] = await tx
        .insert(holidays)
        .values({
          tenant_id: tenantId,
          holiday_date: dto.date,
          name: dto.name,
          type: dto.type ?? 'company',
          description: dto.description,
          location_id: dto.locationId ?? null,
          is_recurring: dto.isRecurring ?? false,
        })
        .returning();
      return row;
    });
  }

  async updateHoliday(tenantId: string, id: string, dto: UpdateHolidayDto) {
    return this.databaseService.withTenant(tenantId, async (tx) => {
      const [existing] = await tx
        .select({ id: holidays.id })
        .from(holidays)
        .where(and(eq(holidays.id, id), eq(holidays.tenant_id, tenantId)))
        .limit(1);
      if (!existing) throw new NotFoundException('Holiday not found');
      if (dto.locationId) {
        await this.assertLocationInTenant(tx, tenantId, dto.locationId);
      }
      const [row] = await tx
        .update(holidays)
        .set({
          ...(dto.date !== undefined && { holiday_date: dto.date }),
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.type !== undefined && { type: dto.type }),
          ...(dto.description !== undefined && { description: dto.description }),
          // null = back to company-wide; undefined = unchanged.
          ...(dto.locationId !== undefined && { location_id: dto.locationId }),
          ...(dto.isRecurring !== undefined && { is_recurring: dto.isRecurring }),
        })
        .where(and(eq(holidays.id, id), eq(holidays.tenant_id, tenantId)))
        .returning();
      return row;
    });
  }

  async deleteHoliday(tenantId: string, id: string) {
    return this.databaseService.withTenant(tenantId, async (tx) => {
      const deleted = await tx
        .delete(holidays)
        .where(and(eq(holidays.id, id), eq(holidays.tenant_id, tenantId)))
        .returning({ id: holidays.id });
      if (deleted.length === 0) throw new NotFoundException('Holiday not found');
      return { deleted: true };
    });
  }

  /**
   * Bulk import (the country-preset flow). Rows whose date+name+location
   * already exist are skipped, so re-importing a preset is harmless.
   */
  async importHolidays(tenantId: string, dto: ImportHolidaysDto) {
    if (dto.holidays.length === 0) return { imported: 0, skipped: 0 };
    return this.databaseService.withTenant(tenantId, async (tx) => {
      if (dto.locationId) {
        await this.assertLocationInTenant(tx, tenantId, dto.locationId);
      }
      const dates = dto.holidays.map((h) => h.date);
      const existing = await tx
        .select({
          date: holidays.holiday_date,
          name: holidays.name,
          locationId: holidays.location_id,
        })
        .from(holidays)
        .where(
          and(
            eq(holidays.tenant_id, tenantId),
            inArray(holidays.holiday_date, dates),
          ),
        );
      const seen = new Set(
        existing.map((e) => `${e.date}|${e.name}|${e.locationId ?? ''}`),
      );
      const fresh = dto.holidays.filter(
        (h) => !seen.has(`${h.date}|${h.name}|${dto.locationId ?? ''}`),
      );
      if (fresh.length > 0) {
        await tx.insert(holidays).values(
          fresh.map((h) => ({
            tenant_id: tenantId,
            holiday_date: h.date,
            name: h.name,
            type: h.type ?? 'national',
            description: h.description,
            location_id: dto.locationId ?? null,
            is_recurring: false,
          })),
        );
      }
      return { imported: fresh.length, skipped: dto.holidays.length - fresh.length };
    });
  }

  /** Curated country lists that seed the import flow (static data). */
  listHolidayPresets(country: string, year: number) {
    return {
      country,
      year,
      countries: PRESET_COUNTRIES,
      holidays: getHolidayPresets(country, year),
    };
  }
}
