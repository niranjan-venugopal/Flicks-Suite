// ─── Timesheet Types ──────────────────────────────────────────────────────────

export type TimesheetStatus =
  | 'draft'
  | 'submitted'
  | 'approved'
  | 'rejected'
  | 'rework';

export type TimesheetCategory =
  | 'development'
  | 'design'
  | 'meeting'
  | 'research'
  | 'testing'
  | 'documentation'
  | 'support'
  | 'training'
  | 'administrative'
  | 'other';

export interface TimesheetEntry {
  id: string;
  timesheetPeriodId: string;
  employeeId: string;
  tenantId: string;
  entryDate: string; // YYYY-MM-DD
  hours: number; // 0-24
  category: TimesheetCategory;
  isBillable: boolean;
  description: string | null;
  projectId: string | null;
  projectName: string | null;
  taskId: string | null;
  taskName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TimesheetPeriod {
  id: string;
  tenantId: string;
  employeeId: string;
  employeeName: string;
  employeeCode: string;
  periodStart: string; // YYYY-MM-DD
  periodEnd: string; // YYYY-MM-DD
  status: TimesheetStatus;
  totalHours: number;
  billableHours: number;
  nonBillableHours: number;
  approverId: string | null;
  approverName: string | null;
  approvedAt: string | null;
  approverComment: string | null;
  submittedAt: string | null;
  entries: TimesheetEntry[];
  createdAt: string;
  updatedAt: string;
}
