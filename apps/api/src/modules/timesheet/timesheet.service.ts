import { Injectable, Logger, Inject } from '@nestjs/common';
import { DB_TENANT } from '../../core/database/database.module';
import type { Db } from '@flicks/db';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import type {
  BulkSaveEntriesDto,
  SubmitTimesheetDto,
  ReviewTimesheetDto,
  TimesheetListQueryDto,
} from './timesheet.dto';

@Injectable()
export class TimesheetService {
  private readonly logger = new Logger(TimesheetService.name);

  constructor(
    @Inject(DB_TENANT) private readonly db: Db,
    private readonly auditService: AuditService,
    private readonly notificationsService: NotificationsService,
  ) {}

  /**
   * Returns the caller's current open period (creates one if missing).
   * TODO: derive period_start/period_end from tenant settings (weekly/monthly),
   * upsert timesheet_periods row in 'draft' state.
   */
  async getMyCurrentPeriod(userId: string, tenantId: string) {
    const today = new Date().toISOString().split('T')[0];
    return {
      id: '',
      employeeId: '',
      periodStart: today,
      periodEnd: today,
      status: 'draft' as const,
      totalHours: 0,
      totalBillableHours: 0,
    };
  }

  /**
   * Lists the caller's timesheet periods.
   * TODO: select timesheet_periods by employee_id with optional status filter.
   */
  async listMine(
    userId: string,
    tenantId: string,
    query: TimesheetListQueryDto,
  ) {
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, 100);

    return {
      data: [] as Array<{
        id: string;
        periodStart: string;
        periodEnd: string;
        totalHours: number;
        status: string;
      }>,
      pagination: { page, limit, total: 0 },
    };
  }

  /**
   * Returns entries for a specific period (must belong to caller or be reviewable).
   * TODO: select timesheet_entries where timesheet_period_id and authz check.
   */
  async getEntries(
    timesheetPeriodId: string,
    userId: string,
    tenantId: string,
  ) {
    return {
      timesheetPeriodId,
      entries: [] as Array<{
        id: string;
        entryDate: string;
        hours: number;
        category: string;
        isBillable: boolean;
        description: string | null;
      }>,
    };
  }

  /**
   * Bulk creates / replaces entries for a draft period.
   * TODO: validate period.status='draft', delete existing entries, insert new,
   * recompute total_hours / total_billable_hours.
   */
  async saveEntries(
    userId: string,
    tenantId: string,
    dto: BulkSaveEntriesDto,
  ) {
    this.logger.log(
      `Saving ${dto.entries.length} entries for period=${dto.timesheetPeriodId}`,
    );

    await this.auditService.log({
      tenantId,
      actorUserId: userId,
      action: 'timesheet.entries.saved',
      resourceType: 'timesheet_period',
      resourceId: dto.timesheetPeriodId,
      metadata: { entryCount: dto.entries.length },
    });

    return {
      timesheetPeriodId: dto.timesheetPeriodId,
      entryCount: dto.entries.length,
      totalHours: dto.entries.reduce((sum, e) => sum + e.hours, 0),
    };
  }

  /**
   * Submits a draft period for approval.
   * TODO: transition period.status to 'submitted', set submitted_at,
   * send timesheet-submitted email to approver.
   */
  async submitTimesheet(
    userId: string,
    tenantId: string,
    dto: SubmitTimesheetDto,
  ) {
    await this.auditService.log({
      tenantId,
      actorUserId: userId,
      action: 'timesheet.submitted',
      resourceType: 'timesheet_period',
      resourceId: dto.timesheetPeriodId,
    });

    return {
      id: dto.timesheetPeriodId,
      status: 'submitted' as const,
      submittedAt: new Date().toISOString(),
    };
  }

  /**
   * Lists timesheet periods awaiting the caller's review.
   * TODO: filter by approver_id and status='submitted'.
   */
  async listPending(
    userId: string,
    tenantId: string,
    query: TimesheetListQueryDto,
  ) {
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, 100);

    return {
      data: [] as Array<{
        id: string;
        employeeId: string;
        periodStart: string;
        periodEnd: string;
        totalHours: number;
      }>,
      pagination: { page, limit, total: 0 },
    };
  }

  /**
   * Approves, rejects or sends a timesheet back for rework.
   * TODO: status transition + on rework create timesheet_rework_requests row.
   */
  async reviewTimesheet(
    timesheetPeriodId: string,
    reviewerUserId: string,
    tenantId: string,
    dto: ReviewTimesheetDto,
  ) {
    let newStatus: 'approved' | 'rejected' | 'draft';
    switch (dto.action) {
      case 'approve':
        newStatus = 'approved';
        break;
      case 'reject':
        newStatus = 'rejected';
        break;
      case 'rework':
        newStatus = 'draft';
        break;
    }

    await this.auditService.log({
      tenantId,
      actorUserId: reviewerUserId,
      action: `timesheet.${dto.action}d`,
      resourceType: 'timesheet_period',
      resourceId: timesheetPeriodId,
      metadata: { comment: dto.comment },
    });

    return {
      id: timesheetPeriodId,
      status: newStatus,
      reviewedAt: new Date().toISOString(),
    };
  }
}
