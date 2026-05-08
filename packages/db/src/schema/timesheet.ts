import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  integer,
  pgEnum,
  uniqueIndex,
  index,
  date,
  real,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { tenants, users } from './platform';
import { employees } from './employees';

// ─── Enums ────────────────────────────────────────────────────────────────────

export const timesheetStatusEnum = pgEnum('timesheet_status', [
  'draft',
  'submitted',
  'approved',
  'rejected',
  'locked',
]);

export const timesheetEntryCategoryEnum = pgEnum('timesheet_entry_category', [
  'development',
  'design',
  'testing',
  'management',
  'meetings',
  'research',
  'documentation',
  'support',
  'training',
  'admin',
  'other',
]);

// ─── timesheet_periods ────────────────────────────────────────────────────────

export const timesheetPeriods = pgTable(
  'timesheet_periods',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    employee_id: uuid('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'cascade' }),
    period_start: date('period_start').notNull(),
    period_end: date('period_end').notNull(),
    total_hours: real('total_hours').notNull().default(0),
    total_billable_hours: real('total_billable_hours').notNull().default(0),
    total_non_billable_hours: real('total_non_billable_hours')
      .notNull()
      .default(0),
    status: timesheetStatusEnum('status').notNull().default('draft'),
    submitted_at: timestamp('submitted_at', { withTimezone: true }),
    approver_id: uuid('approver_id').references(() => employees.id, {
      onDelete: 'set null',
    }),
    approved_at: timestamp('approved_at', { withTimezone: true }),
    rejected_at: timestamp('rejected_at', { withTimezone: true }),
    rejection_comment: text('rejection_comment'),
    locked_at: timestamp('locked_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('timesheet_periods_tenant_employee_period_start_unique').on(
      t.tenant_id,
      t.employee_id,
      t.period_start,
    ),
    index('timesheet_periods_tenant_id_idx').on(t.tenant_id),
    index('timesheet_periods_employee_id_idx').on(t.employee_id),
    index('timesheet_periods_status_idx').on(t.status),
    index('timesheet_periods_period_start_idx').on(t.period_start),
    index('timesheet_periods_approver_id_idx').on(t.approver_id),
  ],
);

// ─── timesheet_entries ────────────────────────────────────────────────────────

export const timesheetEntries = pgTable(
  'timesheet_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    timesheet_period_id: uuid('timesheet_period_id')
      .notNull()
      .references(() => timesheetPeriods.id, { onDelete: 'cascade' }),
    employee_id: uuid('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'cascade' }),
    entry_date: date('entry_date').notNull(),
    hours: real('hours').notNull(),
    project_id: uuid('project_id'), // FK to future projects table
    task_id: uuid('task_id'), // FK to future tasks table
    category: timesheetEntryCategoryEnum('category').notNull().default('other'),
    is_billable: boolean('is_billable').notNull().default(false),
    hourly_rate_snapshot: real('hourly_rate_snapshot'), // rate at time of entry
    description: text('description'),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('timesheet_entries_tenant_id_idx').on(t.tenant_id),
    index('timesheet_entries_timesheet_period_id_idx').on(
      t.timesheet_period_id,
    ),
    index('timesheet_entries_employee_id_idx').on(t.employee_id),
    index('timesheet_entries_entry_date_idx').on(t.entry_date),
    index('timesheet_entries_project_id_idx').on(t.project_id),
    index('timesheet_entries_is_billable_idx').on(t.is_billable),
  ],
);

// ─── timesheet_rework_requests ────────────────────────────────────────────────

export const timesheetReworkRequests = pgTable(
  'timesheet_rework_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    timesheet_period_id: uuid('timesheet_period_id')
      .notNull()
      .references(() => timesheetPeriods.id, { onDelete: 'cascade' }),
    requested_by: uuid('requested_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    affected_entry_ids: uuid('affected_entry_ids').array().notNull().default([]),
    comment: text('comment').notNull(),
    resolved_at: timestamp('resolved_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('timesheet_rework_requests_tenant_id_idx').on(t.tenant_id),
    index('timesheet_rework_requests_timesheet_period_id_idx').on(
      t.timesheet_period_id,
    ),
    index('timesheet_rework_requests_requested_by_idx').on(t.requested_by),
  ],
);

// ─── Relations ────────────────────────────────────────────────────────────────

export const timesheetPeriodsRelations = relations(
  timesheetPeriods,
  ({ one, many }) => ({
    tenant: one(tenants, {
      fields: [timesheetPeriods.tenant_id],
      references: [tenants.id],
    }),
    employee: one(employees, {
      fields: [timesheetPeriods.employee_id],
      references: [employees.id],
    }),
    approver: one(employees, {
      fields: [timesheetPeriods.approver_id],
      references: [employees.id],
    }),
    entries: many(timesheetEntries),
    reworkRequests: many(timesheetReworkRequests),
  }),
);

export const timesheetEntriesRelations = relations(
  timesheetEntries,
  ({ one }) => ({
    tenant: one(tenants, {
      fields: [timesheetEntries.tenant_id],
      references: [tenants.id],
    }),
    timesheetPeriod: one(timesheetPeriods, {
      fields: [timesheetEntries.timesheet_period_id],
      references: [timesheetPeriods.id],
    }),
    employee: one(employees, {
      fields: [timesheetEntries.employee_id],
      references: [employees.id],
    }),
  }),
);

export const timesheetReworkRequestsRelations = relations(
  timesheetReworkRequests,
  ({ one }) => ({
    tenant: one(tenants, {
      fields: [timesheetReworkRequests.tenant_id],
      references: [tenants.id],
    }),
    timesheetPeriod: one(timesheetPeriods, {
      fields: [timesheetReworkRequests.timesheet_period_id],
      references: [timesheetPeriods.id],
    }),
    requestedBy: one(users, {
      fields: [timesheetReworkRequests.requested_by],
      references: [users.id],
    }),
  }),
);

// ─── Types ────────────────────────────────────────────────────────────────────

export type TimesheetPeriod = typeof timesheetPeriods.$inferSelect;
export type NewTimesheetPeriod = typeof timesheetPeriods.$inferInsert;
export type TimesheetEntry = typeof timesheetEntries.$inferSelect;
export type NewTimesheetEntry = typeof timesheetEntries.$inferInsert;
export type TimesheetReworkRequest = typeof timesheetReworkRequests.$inferSelect;
export type NewTimesheetReworkRequest =
  typeof timesheetReworkRequests.$inferInsert;
