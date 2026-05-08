import { Injectable, Logger, Inject } from '@nestjs/common';
import { DB_TENANT } from '../../core/database/database.module';
import type { Db } from '@flicks/db';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import type {
  ApplyLeaveDto,
  CancelLeaveDto,
  ReviewLeaveDto,
  CreateLeaveTypeDto,
  LeaveListQueryDto,
} from './leave.dto';

@Injectable()
export class LeaveService {
  private readonly logger = new Logger(LeaveService.name);

  constructor(
    @Inject(DB_TENANT) private readonly db: Db,
    private readonly auditService: AuditService,
    private readonly notificationsService: NotificationsService,
  ) {}

  /**
   * Lists configured leave types for the tenant.
   * TODO: select from leave_types where tenant_id and is_active.
   */
  async listLeaveTypes(tenantId: string) {
    return {
      data: [] as Array<{
        id: string;
        name: string;
        code: string;
        defaultQuotaDays: number;
        isPaid: boolean;
      }>,
      total: 0,
    };
  }

  /**
   * Creates a new leave type for the tenant (admin only).
   * TODO: insert into leave_types; ensure unique (tenant_id, code).
   */
  async createLeaveType(
    tenantId: string,
    actorUserId: string,
    dto: CreateLeaveTypeDto,
  ) {
    await this.auditService.log({
      tenantId,
      actorUserId,
      action: 'leave_type.created',
      resourceType: 'leave_type',
      afterState: { name: dto.name, code: dto.code },
    });

    return {
      id: '',
      name: dto.name,
      code: dto.code,
      defaultQuotaDays: dto.defaultQuotaDays,
      isPaid: dto.isPaid ?? true,
    };
  }

  /**
   * Returns the caller's leave balances for the current leave year.
   * TODO: select leave_balances joined with leave_types; group by leaveTypeId.
   */
  async getMyBalances(userId: string, tenantId: string) {
    return {
      leaveYear: new Date().getFullYear(),
      balances: [] as Array<{
        leaveTypeId: string;
        leaveTypeName: string;
        opening: number;
        accrued: number;
        used: number;
        pending: number;
        available: number;
      }>,
    };
  }

  /**
   * Applies for leave. TODO: validate balance, check overlapping requests,
   * compute total_days using working_days/holidays, create leave_requests, debit pending.
   */
  async applyLeave(userId: string, tenantId: string, dto: ApplyLeaveDto) {
    this.logger.log(
      `Leave application user=${userId} type=${dto.leaveTypeId} ${dto.startDate}->${dto.endDate}`,
    );

    await this.auditService.log({
      tenantId,
      actorUserId: userId,
      action: 'leave.applied',
      resourceType: 'leave_request',
      afterState: {
        leaveTypeId: dto.leaveTypeId,
        startDate: dto.startDate,
        endDate: dto.endDate,
      },
    });

    return {
      id: '',
      leaveTypeId: dto.leaveTypeId,
      startDate: dto.startDate,
      endDate: dto.endDate,
      isHalfDay: dto.isHalfDay ?? false,
      totalDays: 0,
      status: 'pending' as const,
      reason: dto.reason,
    };
  }

  /**
   * Lists the caller's leave requests.
   * TODO: filter leave_requests by employee_id from membership.
   */
  async listMine(userId: string, tenantId: string, query: LeaveListQueryDto) {
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, 100);

    return {
      data: [] as Array<{
        id: string;
        leaveTypeId: string;
        startDate: string;
        endDate: string;
        status: string;
      }>,
      pagination: { page, limit, total: 0 },
    };
  }

  /**
   * Cancels a pending or approved leave request.
   * TODO: validate ownership/state, refund pending or used balance, update status=cancelled.
   */
  async cancelLeave(
    leaveRequestId: string,
    userId: string,
    tenantId: string,
    dto: CancelLeaveDto,
  ) {
    await this.auditService.log({
      tenantId,
      actorUserId: userId,
      action: 'leave.cancelled',
      resourceType: 'leave_request',
      resourceId: leaveRequestId,
      metadata: { reason: dto.reason },
    });

    return {
      id: leaveRequestId,
      status: 'cancelled' as const,
      cancelledAt: new Date().toISOString(),
    };
  }

  /**
   * Lists leave requests pending the caller's approval (manager/admin).
   * TODO: filter by approver_id or team membership; include employee summary.
   */
  async listPending(
    userId: string,
    tenantId: string,
    query: LeaveListQueryDto,
  ) {
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, 100);

    return {
      data: [] as Array<{
        id: string;
        employeeId: string;
        leaveTypeId: string;
        startDate: string;
        endDate: string;
      }>,
      pagination: { page, limit, total: 0 },
    };
  }

  /**
   * Approves or rejects a leave request and notifies the requester.
   * TODO: update status, on approve move pending -> used and emit calendar event,
   * on reject release pending; send appropriate email.
   */
  async reviewLeave(
    leaveRequestId: string,
    reviewerUserId: string,
    tenantId: string,
    dto: ReviewLeaveDto,
  ) {
    const newStatus = dto.action === 'approve' ? 'approved' : 'rejected';

    await this.auditService.log({
      tenantId,
      actorUserId: reviewerUserId,
      action: `leave.${newStatus}`,
      resourceType: 'leave_request',
      resourceId: leaveRequestId,
      metadata: { comment: dto.comment },
    });

    return {
      id: leaveRequestId,
      status: newStatus as 'approved' | 'rejected',
      reviewedAt: new Date().toISOString(),
    };
  }

  /**
   * Returns a list of holidays applicable to the tenant (and optionally a location).
   * TODO: select from holidays for tenant_id, filter by year/location.
   */
  async listHolidays(tenantId: string, year?: number) {
    const targetYear = year ?? new Date().getFullYear();
    return {
      year: targetYear,
      holidays: [] as Array<{
        id: string;
        date: string;
        name: string;
        type: string;
      }>,
    };
  }
}
