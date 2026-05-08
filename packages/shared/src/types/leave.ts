// ─── Leave Types ──────────────────────────────────────────────────────────────

export type LeaveStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'cancelled'
  | 'recalled'
  | 'auto_approved';

export type HalfDaySession = 'first_half' | 'second_half';

export type HolidayType = 'national' | 'regional' | 'optional' | 'restricted';

export type AccrualMethod = 'monthly' | 'quarterly' | 'annual' | 'on_joining';

export type LeaveCarryForwardType = 'none' | 'limited' | 'unlimited';

export type LeaveApplicableGender = 'all' | 'male' | 'female';

export interface LeaveType {
  id: string;
  tenantId: string;
  name: string;
  code: string;
  description: string | null;
  isPaid: boolean;
  isCarryForward: boolean;
  carryForwardType: LeaveCarryForwardType;
  maxCarryForward: number | null;
  accrualMethod: AccrualMethod;
  accrualDays: number;
  maxBalance: number | null;
  minDaysPerRequest: number;
  maxDaysPerRequest: number | null;
  requiresApproval: boolean;
  requiresDocument: boolean;
  documentRequiredAfterDays: number | null;
  noticeDaysRequired: number;
  isHalfDayAllowed: boolean;
  applicableGender: LeaveApplicableGender;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface LeaveBalance {
  leaveTypeId: string;
  leaveTypeName: string;
  leaveTypeCode: string;
  isPaid: boolean;
  year: number;
  openingBalance: number;
  accrued: number;
  taken: number;
  pending: number;
  available: number;
  carryForward: number;
  expiredBalance: number;
  lapsedAt: string | null;
}

export interface LeaveRequest {
  id: string;
  tenantId: string;
  employeeId: string;
  employeeName: string;
  employeeCode: string;
  leaveTypeId: string;
  leaveTypeName: string;
  leaveTypeCode: string;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  totalDays: number;
  isHalfDay: boolean;
  halfDaySession: HalfDaySession | null;
  reason: string;
  status: LeaveStatus;
  coverEmployeeId: string | null;
  coverEmployeeName: string | null;
  approverId: string | null;
  approverName: string | null;
  approvedAt: string | null;
  approverComment: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  documentUrls: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CalendarEvent {
  date: string; // YYYY-MM-DD
  type: 'holiday' | 'leave' | 'attendance';
  title: string;
  holidayType?: HolidayType;
  leaveStatus?: LeaveStatus;
  attendanceStatus?: string;
  isHalfDay?: boolean;
  halfDaySession?: HalfDaySession;
}
