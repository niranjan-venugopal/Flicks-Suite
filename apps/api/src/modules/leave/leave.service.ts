import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { eq, and, desc, gte, lte, ne, or, sql } from 'drizzle-orm';
import {
  leaveTypes,
  leaveBalances,
  leaveRequests,
  holidays,
  memberships,
  employees,
  users,
} from '@flicks/db/schema';
import { DatabaseService } from '../../core/database/database.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import type {
  ApplyLeaveDto,
  CancelLeaveDto,
  ReviewLeaveDto,
  CreateLeaveTypeDto,
  LeaveListQueryDto,
} from './leave.dto';

/**
 * Counts business days (Mon-Fri) between two YYYY-MM-DD dates inclusive.
 * Used as the v1 day-count heuristic. A future iteration should subtract
 * holidays and respect the tenant's working-week / shift configuration.
 */
function countBusinessDays(startISO: string, endISO: string): number {
  const start = new Date(`${startISO}T00:00:00Z`);
  const end = new Date(`${endISO}T00:00:00Z`);
  if (end < start) return 0;
  let count = 0;
  const cursor = new Date(start);
  while (cursor <= end) {
    const dow = cursor.getUTCDay(); // 0 = Sun, 6 = Sat
    if (dow !== 0 && dow !== 6) count++;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return count;
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

  // ─── Leave Types ───────────────────────────────────────────────────────────

  async listLeaveTypes(tenantId: string) {
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
    const employeeId = await this.getEmployeeIdForUser(userId, tenantId);
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
    const employeeId = await this.getEmployeeIdForUser(userId, tenantId);

    // total_days: half-day = 0.5, otherwise count business days inclusive.
    const totalDays = dto.isHalfDay
      ? 0.5
      : countBusinessDays(dto.startDate, dto.endDate);
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

        // Verify the leave type exists and is active for this tenant.
        const [type] = await tx
          .select()
          .from(leaveTypes)
          .where(
            and(
              eq(leaveTypes.tenant_id, tenantId),
              eq(leaveTypes.id, dto.leaveTypeId),
              eq(leaveTypes.is_active, true),
            ),
          )
          .limit(1);
        if (!type) {
          throw new BadRequestException('Leave type not found or inactive');
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
    this.notifyOnApply(tenantId, employeeId, result.request.id, result.type.name).catch(
      (err) => this.logger.warn(`Leave apply notification failed: ${err}`),
    );

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
  ) {
    // Resolve the requesting employee + their manager's email.
    const [employee] = await this.databaseService.withTenant(tenantId, (tx) =>
      tx
        .select({
          firstName: employees.first_name,
          lastName: employees.last_name,
          managerId: employees.reporting_manager_id,
        })
        .from(employees)
        .where(eq(employees.id, employeeId))
        .limit(1),
    );

    if (!employee?.managerId) return; // No manager → silently skip.

    const [manager] = await this.databaseService.withTenant(tenantId, (tx) =>
      tx
        .select({
          email: employees.work_email,
          firstName: employees.first_name,
        })
        .from(employees)
        .where(eq(employees.id, employee.managerId!))
        .limit(1),
    );
    if (!manager?.email) return;

    await this.notificationsService.sendEmail('leave-request', manager.email, {
      employeeName: `${employee.firstName} ${employee.lastName}`.trim(),
      leaveType: leaveTypeName,
      startDate: '',
      endDate: '',
      days: 0,
    });
    this.logger.log(`Leave-apply email queued to ${manager.email} (req=${requestId})`);
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

  async listHolidays(tenantId: string, year?: number) {
    const targetYear = year ?? new Date().getFullYear();
    const yearStart = `${targetYear}-01-01`;
    const yearEnd = `${targetYear}-12-31`;

    const rows = await this.databaseService.withTenant(tenantId, (tx) =>
      tx
        .select({
          id: holidays.id,
          date: holidays.holiday_date,
          name: holidays.name,
          type: holidays.type,
          description: holidays.description,
        })
        .from(holidays)
        .where(
          and(
            eq(holidays.tenant_id, tenantId),
            gte(holidays.holiday_date, yearStart),
            lte(holidays.holiday_date, yearEnd),
          ),
        )
        .orderBy(holidays.holiday_date),
    );

    return { year: targetYear, holidays: rows };
  }
}
