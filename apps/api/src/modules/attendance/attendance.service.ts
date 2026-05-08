import { Injectable, Logger, Inject } from '@nestjs/common';
import { DB_TENANT } from '../../core/database/database.module';
import type { Db } from '@flicks/db';
import { AuditService } from '../audit/audit.service';
import type {
  PunchDto,
  RegularizationRequestDto,
  ReviewRegularizationDto,
  AttendanceListQueryDto,
} from './attendance.dto';

@Injectable()
export class AttendanceService {
  private readonly logger = new Logger(AttendanceService.name);

  constructor(
    @Inject(DB_TENANT) private readonly db: Db,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Records a punch-in event for the employee.
   * TODO: resolve employee from user, fetch active shift, append to attendance_punches,
   * upsert attendance_records (first_punch_in_at + status), validate geofence/IP.
   */
  async punchIn(userId: string, tenantId: string, dto: PunchDto) {
    this.logger.log(`Punch-in by user=${userId} tenant=${tenantId}`);

    await this.auditService.log({
      tenantId,
      actorUserId: userId,
      action: 'attendance.punch_in',
      resourceType: 'attendance_punch',
      metadata: { lat: dto.lat, lng: dto.lng, locationId: dto.locationId },
    });

    return {
      id: '',
      employeeId: '',
      attendanceDate: new Date().toISOString().split('T')[0],
      punchedAt: new Date().toISOString(),
      type: 'in' as const,
      isWithinGeofence: null as boolean | null,
    };
  }

  /**
   * Records a punch-out event for the employee.
   * TODO: validate open punch-in, append to attendance_punches, recompute totals,
   * close attendance_records (last_punch_out_at, total_worked_minutes, overtime).
   */
  async punchOut(userId: string, tenantId: string, dto: PunchDto) {
    this.logger.log(`Punch-out by user=${userId} tenant=${tenantId}`);

    await this.auditService.log({
      tenantId,
      actorUserId: userId,
      action: 'attendance.punch_out',
      resourceType: 'attendance_punch',
      metadata: { lat: dto.lat, lng: dto.lng },
    });

    return {
      id: '',
      employeeId: '',
      attendanceDate: new Date().toISOString().split('T')[0],
      punchedAt: new Date().toISOString(),
      type: 'out' as const,
      totalWorkedMinutes: 0,
    };
  }

  /**
   * Returns the caller's own attendance records (paginated).
   * TODO: filter on attendance_records by employee_id and date range.
   */
  async listMine(userId: string, tenantId: string, query: AttendanceListQueryDto) {
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, 100);

    return {
      data: [] as Array<{
        id: string;
        attendanceDate: string;
        attendanceStatus: string;
        totalWorkedMinutes: number;
      }>,
      pagination: { page, limit, total: 0 },
    };
  }

  /**
   * Returns today's attendance summary for the caller (current state).
   * TODO: hydrate from latest attendance_records row + active shift template.
   */
  async getMyToday(userId: string, tenantId: string) {
    return {
      employeeId: '',
      attendanceDate: new Date().toISOString().split('T')[0],
      attendanceStatus: 'absent' as const,
      firstPunchInAt: null as string | null,
      lastPunchOutAt: null as string | null,
      totalWorkedMinutes: 0,
      isOnBreak: false,
    };
  }

  /**
   * Submits a regularization request for review.
   * TODO: insert attendance_regularizations row with status=pending; emit event.
   */
  async requestRegularization(
    userId: string,
    tenantId: string,
    dto: RegularizationRequestDto,
  ) {
    await this.auditService.log({
      tenantId,
      actorUserId: userId,
      action: 'attendance.regularization.requested',
      resourceType: 'attendance_regularization',
      metadata: {
        attendanceDate: dto.attendanceDate,
        requestType: dto.requestType,
      },
    });

    return {
      id: '',
      attendanceDate: dto.attendanceDate,
      requestType: dto.requestType,
      status: 'pending' as const,
      reason: dto.reason,
    };
  }

  /**
   * Lists regularization requests pending the caller's review (manager/admin).
   * TODO: filter by approver_id or team membership.
   */
  async listPendingRegularizations(
    userId: string,
    tenantId: string,
    query: AttendanceListQueryDto,
  ) {
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, 100);

    return {
      data: [] as Array<{
        id: string;
        employeeId: string;
        attendanceDate: string;
        requestType: string;
        status: string;
      }>,
      pagination: { page, limit, total: 0 },
    };
  }

  /**
   * Approves or rejects a regularization request.
   * TODO: update status, write reviewer comment, on approve apply regularization to attendance_records.
   */
  async reviewRegularization(
    regularizationId: string,
    reviewerUserId: string,
    tenantId: string,
    dto: ReviewRegularizationDto,
  ) {
    await this.auditService.log({
      tenantId,
      actorUserId: reviewerUserId,
      action: `attendance.regularization.${dto.action}d`,
      resourceType: 'attendance_regularization',
      resourceId: regularizationId,
      metadata: { comment: dto.comment },
    });

    return {
      id: regularizationId,
      status: dto.action === 'approve' ? ('approved' as const) : ('rejected' as const),
      reviewedAt: new Date().toISOString(),
    };
  }
}
