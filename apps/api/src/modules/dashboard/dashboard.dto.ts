import { ApiProperty } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ActivityQueryDto {
  @ApiProperty({ required: false, default: 20 })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  /** Cursor: pull items with id < `before` (newest first ordering). */
  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  before?: string;
}

/**
 * Round L — where a pending item sits in the routing chain (0 = reporting
 * manager · 1 = manager's manager · 2 = Owner + HR Admins) and why it moved.
 */
export interface ApprovalEscalationDto {
  level: 0 | 1 | 2;
  reason: 'sla' | 'reviewer_on_leave' | 'no_manager' | 'no_skip_manager' | null;
  /** ISO instant it reached this level (the level-1 clock anchor). */
  at: string | null;
  /** The level-1 manager it was escalated to, when known. */
  toName: string | null;
}

export interface AdminOverviewDto {
  generatedAt: string;
  /**
   * Round I — `team` means every number below is narrowed to the caller's
   * direct reports (managers); `org` is workspace-wide (owner/admin/finance).
   */
  scope: 'org' | 'team';

  // Stats grid (4 headline tiles)
  stats: {
    totalEmployees: number;
    presentToday: number;
    onLeaveToday: number;
    pendingApprovals: number;
  };

  // Today's Snapshot
  headcount: {
    active: number;
    notice: number;
    onLeave: number;
    inactive: number;
  };
  /**
   * Round L — derived from the day resolver (core/common/workday.ts) on the
   * tenant's "today". `present` INCLUDES late arrivals (`late` is the
   * subset); `yetToClockIn` = expected ∧ no record ∧ no pending leave.
   */
  attendanceToday: {
    present: number;
    late: number;
    onLeave: number;
    yetToClockIn: number;
    holiday: number;
    /** Employees on their shift's non-working day (new in Round L). */
    weekend: number;
    /** Expected, no record, a pending leave request covers today. */
    pendingLeave: number;
    /** Everyone whose day is a working day (half-day leave included). */
    expectedToday: number;
  };

  // Pending Actions (top items to approve inline). Round L: the leave /
  // regularization / timesheet buckets are ROUTED — direct reports, items
  // escalated to the caller, and (owner/HR admin) items at level 2 or with
  // no manager at all — never the whole workspace from minute zero.
  pending: {
    leaveCount: number;
    regularizationCount: number;
    /** Round L — submitted timesheets routed to the caller. */
    timesheetCount: number;
    // Approvals are approver-only (manager+): the service returns empty
    // lists and zero counts for lower roles. In every bucket the caller's own
    // request is excluded — nobody approves themselves.
    onboardingCount: number;
    onboarding: Array<{
      employeeId: string;
      userId: string | null;
      employeeName: string;
      employeeCode: string | null;
      designationTitle: string | null;
      avatarUrl: string | null;
      submittedAt: string | null;
    }>;
    leaves: Array<{
      id: string;
      employeeId: string;
      /** Requester's user id — drives the Inbox presence dot. */
      userId: string | null;
      employeeName: string;
      employeeCode: string | null;
      leaveTypeName: string | null;
      leaveTypeCode: string | null;
      startDate: string;
      endDate: string;
      totalDays: number;
      reason: string | null;
      appliedAt: string;
      avatarUrl: string | null;
      /** Round L — null while still with the reporting manager (level 0). */
      escalation: ApprovalEscalationDto | null;
    }>;
    regularizations: Array<{
      id: string;
      employeeId: string;
      userId: string | null;
      employeeName: string;
      employeeCode: string | null;
      attendanceDate: string;
      requestType: string;
      /** Round K — ISO instants so the Inbox detail can show the proposed in/out. */
      proposedInTime: string | null;
      proposedOutTime: string | null;
      reason: string;
      requestedAt: string;
      avatarUrl: string | null;
      escalation: ApprovalEscalationDto | null;
    }>;
    /** Round L — the Inbox → Approvals timesheet kind (Approve / Reject / Rework). */
    timesheets: Array<{
      id: string;
      employeeId: string;
      userId: string | null;
      employeeName: string;
      employeeCode: string | null;
      periodStart: string;
      periodEnd: string;
      totalHours: number;
      totalBillableHours: number;
      submittedAt: string | null;
      avatarUrl: string | null;
      escalation: ApprovalEscalationDto | null;
    }>;
  };

  // 30-day trends — headline numbers only (no sparklines in v1)
  trends: {
    attendanceCompliancePct: number | null; // null = not enough data
    leaveDaysConsumed: number;
    headcountDelta: { joiners: number; exits: number; net: number };
    avgWorkingHours: number | null;
  };
}

export interface ActivityItemDto {
  id: string;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  actorUserId: string | null;
  actorName: string | null;
  /** Round N — signed 64 px photo of the actor (legacy URL / null fallback). */
  avatarUrl: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}
