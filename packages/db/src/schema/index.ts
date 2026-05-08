// ─── Platform ─────────────────────────────────────────────────────────────────
export * from './platform.js';

// ─── Auth ─────────────────────────────────────────────────────────────────────
export * from './auth.js';

// ─── Employees ────────────────────────────────────────────────────────────────
export * from './employees.js';

// ─── Attendance ───────────────────────────────────────────────────────────────
export * from './attendance.js';

// ─── Leave ────────────────────────────────────────────────────────────────────
export * from './leave.js';

// ─── Timesheet ────────────────────────────────────────────────────────────────
export * from './timesheet.js';

// ─── FAM (Fleet Administration & Monitoring) ──────────────────────────────────
export * from './fam.js';

// ─── Combined schema object (for Drizzle client) ─────────────────────────────
import * as platformSchema from './platform.js';
import * as authSchema from './auth.js';
import * as employeesSchema from './employees.js';
import * as attendanceSchema from './attendance.js';
import * as leaveSchema from './leave.js';
import * as timesheetSchema from './timesheet.js';
import * as famSchema from './fam.js';

export const schema = {
  ...platformSchema,
  ...authSchema,
  ...employeesSchema,
  ...attendanceSchema,
  ...leaveSchema,
  ...timesheetSchema,
  ...famSchema,
} as const;

export type Schema = typeof schema;
