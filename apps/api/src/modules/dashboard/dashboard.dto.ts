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

export interface AdminOverviewDto {
  generatedAt: string;

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
  attendanceToday: {
    present: number;
    late: number;
    onLeave: number;
    yetToClockIn: number;
    holiday: number;
  };

  // Pending Actions (top items to approve inline)
  pending: {
    leaveCount: number;
    regularizationCount: number;
    // Onboarding reviews are admin+-only: the service returns an empty list
    // for lower roles, and the caller's own row is never included.
    onboardingCount: number;
    onboarding: Array<{
      employeeId: string;
      userId: string | null;
      employeeName: string;
      employeeCode: string | null;
      designationTitle: string | null;
      submittedAt: string | null;
    }>;
    leaves: Array<{
      id: string;
      employeeId: string;
      employeeName: string;
      employeeCode: string | null;
      leaveTypeName: string | null;
      leaveTypeCode: string | null;
      startDate: string;
      endDate: string;
      totalDays: number;
      reason: string | null;
      appliedAt: string;
    }>;
    regularizations: Array<{
      id: string;
      employeeId: string;
      employeeName: string;
      employeeCode: string | null;
      attendanceDate: string;
      requestType: string;
      reason: string;
      requestedAt: string;
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
  metadata: Record<string, unknown> | null;
  createdAt: string;
}
