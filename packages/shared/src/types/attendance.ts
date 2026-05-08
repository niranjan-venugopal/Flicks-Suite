// ─── Attendance Types ─────────────────────────────────────────────────────────

export type AttendanceStatus =
  | 'present'
  | 'absent'
  | 'half_day'
  | 'holiday'
  | 'weekend'
  | 'leave'
  | 'on_duty'
  | 'comp_off';

export type PunchType = 'in' | 'out' | 'break_start' | 'break_end';

export type AttendanceSource =
  | 'web'
  | 'mobile'
  | 'biometric'
  | 'manual'
  | 'import'
  | 'regularization';

export type RegularizationType =
  | 'missing_punch'
  | 'wrong_punch'
  | 'forgot_punch_in'
  | 'forgot_punch_out'
  | 'full_day_correction'
  | 'on_duty';

export type RegularizationStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export interface PunchEvent {
  id: string;
  type: PunchType;
  timestamp: string; // ISO datetime
  source: AttendanceSource;
  lat: number | null;
  lng: number | null;
  accuracy: number | null;
  locationId: string | null;
  locationName: string | null;
  deviceInfo: string | null;
}

export interface TodayAttendance {
  date: string; // YYYY-MM-DD
  status: AttendanceStatus;
  firstPunchIn: string | null; // ISO datetime
  lastPunchOut: string | null; // ISO datetime
  totalWorkMinutes: number;
  totalBreakMinutes: number;
  effectiveWorkMinutes: number;
  isLate: boolean;
  lateByMinutes: number;
  isEarlyExit: boolean;
  earlyExitByMinutes: number;
  isOvertime: boolean;
  overtimeMinutes: number;
  currentlyPunchedIn: boolean;
  currentSessionStartedAt: string | null;
  punches: PunchEvent[];
}

export interface WeekSummary {
  weekStart: string; // YYYY-MM-DD (Monday)
  weekEnd: string; // YYYY-MM-DD (Sunday)
  totalWorkMinutes: number;
  totalExpectedMinutes: number;
  presentDays: number;
  absentDays: number;
  halfDays: number;
  leaveDays: number;
  holidays: number;
  overtime: number;
  days: Array<{
    date: string;
    status: AttendanceStatus;
    workMinutes: number;
  }>;
}

export interface MonthSummary {
  month: number; // 1-12
  year: number;
  totalWorkingDays: number;
  presentDays: number;
  absentDays: number;
  halfDays: number;
  leaveDays: number;
  holidays: number;
  weekends: number;
  totalWorkMinutes: number;
  totalExpectedMinutes: number;
  overtimeMinutes: number;
  lateArrivals: number;
  earlyExits: number;
  attendancePercentage: number;
}
