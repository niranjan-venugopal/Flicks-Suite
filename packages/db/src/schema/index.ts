// ─── Platform ─────────────────────────────────────────────────────────────────
export * from './platform';

// ─── Auth ─────────────────────────────────────────────────────────────────────
export * from './auth';

// ─── Employees ────────────────────────────────────────────────────────────────
export * from './employees';

// ─── Attendance ───────────────────────────────────────────────────────────────
export * from './attendance';

// ─── Leave ────────────────────────────────────────────────────────────────────
export * from './leave';

// ─── Timesheet ────────────────────────────────────────────────────────────────
export * from './timesheet';

// ─── FAM (Fleet Administration & Monitoring) ──────────────────────────────────
export * from './fam';

// ─── Notifications ────────────────────────────────────────────────────────────
export * from './notifications';

// ─── Invoicing (v3) ───────────────────────────────────────────────────────────
export * from './invoicing';

// ─── Platform evolution: domain events, API keys, webhooks (v5 §2/§11) ───────
export * from './events';

// ─── Combined schema object (for Drizzle client) ─────────────────────────────
import * as platformSchema from './platform';
import * as authSchema from './auth';
import * as employeesSchema from './employees';
import * as attendanceSchema from './attendance';
import * as leaveSchema from './leave';
import * as timesheetSchema from './timesheet';
import * as famSchema from './fam';
import * as notificationsSchema from './notifications';
import * as invoicingSchema from './invoicing';
import * as eventsSchema from './events';

export const schema = {
  ...platformSchema,
  ...authSchema,
  ...employeesSchema,
  ...attendanceSchema,
  ...leaveSchema,
  ...timesheetSchema,
  ...famSchema,
  ...notificationsSchema,
  ...invoicingSchema,
  ...eventsSchema,
} as const;

export type Schema = typeof schema;
