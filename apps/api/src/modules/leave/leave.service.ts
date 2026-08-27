import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
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
} from './leave.dto';
import { getHolidayPresets, PRESET_COUNTRIES } from './holiday-presets';

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

/**
 * Counts business days (Mon-Fri) between two YYYY-MM-DD dates inclusive.
 * Falls back to weekend-only exclusion when no holidays are passed.
 *
 * PRD §7.7 acceptance: "Holiday on a leave date does not double-count: leave
 * for Mon–Fri including Republic Day on Wed = 4 days, not 5."
 *
 * @param holidayDates set of YYYY-MM-DD holiday dates that fall in the range
 */
function countBusinessDays(
  startISO: string,
  endISO: string,
  holidayDates: Set<string> = new Set(),
): number {
  let count = 0;
  for (const d of eachDay(startISO, endISO)) {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay(); // 0=Sun, 6=Sat
    if (dow === 0 || dow === 6) continue;
    if (holidayDates.has(d)) continue;
    count++;
  }
  return count;
}

/**
 * Yields business days (Mon-Fri, non-holiday) between two YYYY-MM-DD dates.
 * Used to back-fill attendance_records on leave approval.
 */
function* businessDays(
  startISO: string,
  endISO: string,
  holidayDates: Set<string>,
): Generator<string> {
  for (const d of eachDay(startISO, endISO)) {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    if (holidayDates.has(d)) continue;
    yield d;
  }
}

@Injectable()
export class LeaveService {
  private readonly logger = new Logger(LeaveService.name);

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly auditService: AuditService,
    private readonly notificationsService: NotificationsService,
  ) {}

  // ─── Helpers ───────────────────────────────────────────────────────────────

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
    const totalDays = dto.isHalfDay
      ? 0.5
      : countBusinessDays(dto.startDate, dto.endDate, holidayDates);
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

        return { request: request!, type };
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
    };
  }

  private async notifyOnApply(
    tenantId: string,
    employeeId: string,
    requestId: string,
    leaveTypeName: string,
    dates: { startDate: string; endDate: string; days: number },
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

    // Who gets pinged: the reporting manager when there is one, otherwise
    // every OTHER owner/admin. Owners typically have no reporting manager, so
    // without the fan-out an owner's leave request notified nobody while still
    // sitting in everyone else's queue — a dead end (house rule 8).
    const reviewers = await this.resolveLeaveReviewers(
      tenantId,
      employee.managerId,
      employee.userId,
    );
    if (reviewers.length === 0) return;

    for (const reviewer of reviewers) {
      // Real-time in-app ping to the approver — surfaces in the Topbar bell
      // even when the email lands in spam or is disabled. Best-effort.
      if (reviewer.userId) {
        await this.notificationsService
          .createInAppNotification(
            reviewer.userId,
            'leave.requested',
            `${employeeName || 'An employee'} requested ${leaveTypeName} (${dates.days} day${dates.days === 1 ? '' : 's'}).`,
            '/team/leave',
            tenantId,
          )
          .catch((err) =>
            this.logger.warn(`Leave-apply in-app notification failed: ${err}`),
          );
      }

      if (!reviewer.email) continue;

      await this.notificationsService.sendEmail('leave-requested', reviewer.email, {
        employeeName,
        leaveType: leaveTypeName,
        startDate: dates.startDate,
        endDate: dates.endDate,
        days: dates.days,
      });
      this.logger.log(
        `Leave-apply email queued to ${reviewer.email} (req=${requestId})`,
      );
    }
  }

  /**
   * Approvers to notify for a request: the reporting manager if one is set,
   * otherwise the workspace's owners/admins. The applicant is always excluded
   * — they can never review their own request (see reviewLeave).
   */
  private async resolveLeaveReviewers(
    tenantId: string,
    managerId: string | null,
    applicantUserId: string | null,
  ): Promise<{ email: string | null; userId: string | null }[]> {
    if (managerId) {
      const [manager] = await this.databaseService.withTenant(tenantId, (tx) =>
        tx
          .select({ email: employees.work_email, userId: employees.user_id })
          .from(employees)
          .where(
            and(
              eq(employees.id, managerId),
              eq(employees.tenant_id, tenantId),
            ),
          )
          .limit(1),
      );
      // A manager who happens to be the applicant (self-referencing row) is
      // no reviewer — fall through to the owner/admin fan-out.
      if (manager && manager.userId !== applicantUserId) return [manager];
    }

    // Fan out to owners/admins, minus the applicant. Runs inside the tenant
    // transaction (RLS on memberships) with an explicit tenant predicate as
    // defence in depth.
    return this.databaseService.withTenant(tenantId, (tx) =>
      tx
        .select({ email: users.email, userId: users.id })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.user_id))
        .where(
          and(
            eq(memberships.tenant_id, tenantId),
            eq(memberships.status, 'active'),
            inArray(memberships.role, ['owner', 'admin']),
            applicantUserId
              ? ne(memberships.user_id, applicantUserId)
              : sql`true`,
          ),
        ),
    );
  }

  // ─── List ──────────────────────────────────────────────────────────────────

  async listMine(userId: string, tenantId: string, query: LeaveListQueryDto) {
    const employeeId = await this.getEmployeeIdForUser(userId, tenantId);
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, 100);
    const offset = (page - 1) * limit;

    const data = await this.databaseService.withTenant(tenantId, (tx) =>
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
  ) {
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, 100);
    const offset = (page - 1) * limit;

    const data = await this.databaseService.withTenant(tenantId, (tx) =>
      tx
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
        })
        .from(leaveRequests)
        .leftJoin(employees, eq(leaveRequests.employee_id, employees.id))
        .leftJoin(leaveTypes, eq(leaveRequests.leave_type_id, leaveTypes.id))
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
          ),
        )
        .orderBy(desc(leaveRequests.applied_at))
        .limit(limit)
        .offset(offset),
    );

    return { data, pagination: { page, limit, total: data.length } };
  }

  // ─── Review (approve/reject) ──────────────────────────────────────────────

  async reviewLeave(
    leaveRequestId: string,
    reviewerUserId: string,
    tenantId: string,
    dto: ReviewLeaveDto,
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

        // Separation of duties: an approver may never approve their own leave.
        // Owner/admin clear the @Roles('manager') gate on the route, so
        // without this an owner could self-approve. Same rule as onboarding
        // review (employees.service.ts) — another approver must act.
        const [applicant] = await tx
          .select({ userId: employees.user_id })
          .from(employees)
          .where(
            and(
              eq(employees.id, req.employee_id),
              eq(employees.tenant_id, tenantId),
            ),
          )
          .limit(1);
        if (applicant?.userId && applicant.userId === reviewerUserId) {
          throw new ForbiddenException(
            'You cannot approve your own leave request — another approver must review it.',
          );
        }

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
          for (const day of businessDays(
            req.start_date,
            req.end_date,
            holidayDates,
          )) {
            await tx
              .insert(attendanceRecords)
              .values({
                tenant_id: tenantId,
                employee_id: req.employee_id,
                attendance_date: day,
                attendance_status: 'on_leave',
                source: 'system',
                notes: `Leave: ${req.reason ?? ''}`.slice(0, 500),
              })
              .onConflictDoUpdate({
                target: [
                  attendanceRecords.tenant_id,
                  attendanceRecords.employee_id,
                  attendanceRecords.attendance_date,
                ],
                set: {
                  attendance_status: 'on_leave',
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
        };
      },
    );

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

    // Real-time in-app ping to the requester with the decision. Best-effort.
    if (result.requesterUserId) {
      const approved = dto.action === 'approve';
      await this.notificationsService
        .createInAppNotification(
          result.requesterUserId,
          approved ? 'leave.approved' : 'leave.rejected',
          `Your ${result.leaveTypeName} (${result.startDate} – ${result.endDate}) was ${approved ? 'approved' : 'declined'}${result.reviewerName ? ` by ${result.reviewerName}` : ''}.`,
          '/leave',
          tenantId,
        )
        .catch((err) =>
          this.logger.warn(`Leave-review in-app notification failed: ${err}`),
        );
    }

    await this.auditService.log({
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
