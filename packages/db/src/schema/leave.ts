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
import { relations, sql } from 'drizzle-orm';
import { tenants, users } from './platform';
import { locations } from './employees';
import { employees } from './employees';

// ─── Enums ────────────────────────────────────────────────────────────────────

export const leaveAccrualMethodEnum = pgEnum('leave_accrual_method', [
  'none',
  'monthly',
  'quarterly',
  'annually',
  'per_working_day',
]);

export const leaveProrateBasisEnum = pgEnum('leave_prorate_basis', [
  'none',
  'days_remaining_in_year',
  'months_remaining_in_year',
  'calendar_days',
]);

export const leaveEncashmentBasisEnum = pgEnum('leave_encashment_basis', [
  'none',
  'basic_salary',
  'gross_salary',
  'ctc',
]);

export const leaveRequestStatusEnum = pgEnum('leave_request_status', [
  'draft',
  'pending',
  'approved',
  'rejected',
  'cancelled',
  'revoked',
]);

export const halfDaySessionEnum = pgEnum('half_day_session', [
  'first_half',
  'second_half',
]);

export const holidayTypeEnum = pgEnum('holiday_type', [
  'national',
  'regional',
  'optional',
  'restricted',
  'company',
]);

export const calendarEventTypeEnum = pgEnum('calendar_event_type', [
  'leave',
  'holiday',
  'attendance',
  'birthday',
  'anniversary',
  'company_event',
]);

export const calendarVisibilityEnum = pgEnum('calendar_visibility', [
  'private',
  'team',
  'company',
]);

// ─── leave_types ──────────────────────────────────────────────────────────────

export const leaveTypes = pgTable(
  'leave_types',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    code: text('code').notNull(), // e.g. CL, SL, EL
    description: text('description'),
    default_quota_days: real('default_quota_days').notNull().default(0),
    prorate_for_new_joiners: boolean('prorate_for_new_joiners')
      .notNull()
      .default(true),
    prorate_basis: leaveProrateBasisEnum('prorate_basis')
      .notNull()
      .default('months_remaining_in_year'),
    accrual_method: leaveAccrualMethodEnum('accrual_method')
      .notNull()
      .default('none'),
    accrual_day_of_month: integer('accrual_day_of_month').default(1), // day of month for monthly accrual
    carry_forward_allowed: boolean('carry_forward_allowed')
      .notNull()
      .default(false),
    max_carry_forward_days: real('max_carry_forward_days').default(0),
    encashable: boolean('encashable').notNull().default(false),
    encashment_basis: leaveEncashmentBasisEnum('encashment_basis')
      .notNull()
      .default('none'),
    min_notice_days: integer('min_notice_days').notNull().default(0),
    max_consecutive_days: integer('max_consecutive_days'),
    allow_half_day: boolean('allow_half_day').notNull().default(true),
    allow_quarter_day: boolean('allow_quarter_day').notNull().default(false),
    requires_attachment: boolean('requires_attachment').notNull().default(false),
    attachment_after_days: integer('attachment_after_days').default(3),
    auto_approve_below_days: real('auto_approve_below_days').default(0),
    count_weekend_in_between: boolean('count_weekend_in_between')
      .notNull()
      .default(false),
    applicable_employment_types: text('applicable_employment_types').array(), // null = all
    applicable_genders: text('applicable_genders').array(), // null = all; for ML, PL etc.
    min_tenure_days: integer('min_tenure_days').notNull().default(0),
    is_active: boolean('is_active').notNull().default(true),
    is_paid: boolean('is_paid').notNull().default(true),
    is_lop: boolean('is_lop').notNull().default(false), // Loss of Pay
    display_order: integer('display_order').notNull().default(0),
    color: text('color').default('#6366f1'), // hex color for calendar display
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('leave_types_tenant_code_unique').on(t.tenant_id, t.code),
    index('leave_types_tenant_id_idx').on(t.tenant_id),
    index('leave_types_is_active_idx').on(t.is_active),
    index('leave_types_display_order_idx').on(t.display_order),
  ],
);

// ─── leave_balances ────────────────────────────────────────────────────────────

export const leaveBalances = pgTable(
  'leave_balances',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    employee_id: uuid('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'cascade' }),
    leave_type_id: uuid('leave_type_id')
      .notNull()
      .references(() => leaveTypes.id, { onDelete: 'cascade' }),
    leave_year: integer('leave_year').notNull(), // e.g. 2026
    opening_balance: real('opening_balance').notNull().default(0),
    accrued: real('accrued').notNull().default(0),
    used: real('used').notNull().default(0),
    pending: real('pending').notNull().default(0), // in-flight pending approvals
    carry_forward_in: real('carry_forward_in').notNull().default(0),
    carry_forward_out: real('carry_forward_out').notNull().default(0),
    encashed: real('encashed').notNull().default(0),
    // available is a generated column: opening + accrued + carry_forward_in - used - pending - encashed - carry_forward_out
    available: real('available').generatedAlwaysAs(
      sql`opening_balance + accrued + carry_forward_in - used - pending - encashed - carry_forward_out`,
    ),
    last_accrued_at: timestamp('last_accrued_at', { withTimezone: true }),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('leave_balances_tenant_employee_type_year_unique').on(
      t.tenant_id,
      t.employee_id,
      t.leave_type_id,
      t.leave_year,
    ),
    index('leave_balances_tenant_id_idx').on(t.tenant_id),
    index('leave_balances_employee_id_idx').on(t.employee_id),
    index('leave_balances_leave_type_id_idx').on(t.leave_type_id),
    index('leave_balances_leave_year_idx').on(t.leave_year),
  ],
);

// ─── leave_requests ────────────────────────────────────────────────────────────

export const leaveRequests = pgTable(
  'leave_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    employee_id: uuid('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'cascade' }),
    leave_type_id: uuid('leave_type_id')
      .notNull()
      .references(() => leaveTypes.id, { onDelete: 'restrict' }),
    start_date: date('start_date').notNull(),
    end_date: date('end_date').notNull(),
    is_half_day: boolean('is_half_day').notNull().default(false),
    half_day_session: halfDaySessionEnum('half_day_session'),
    total_days: real('total_days').notNull(),
    reason: text('reason'),
    attachment_url: text('attachment_url'),
    cover_employee_id: uuid('cover_employee_id').references(() => employees.id, {
      onDelete: 'set null',
    }),
    status: leaveRequestStatusEnum('status').notNull().default('pending'),
    approver_id: uuid('approver_id').references(() => employees.id, {
      onDelete: 'set null',
    }),
    approver_comment: text('approver_comment'),
    approved_at: timestamp('approved_at', { withTimezone: true }),
    rejected_at: timestamp('rejected_at', { withTimezone: true }),
    cancelled_at: timestamp('cancelled_at', { withTimezone: true }),
    applied_at: timestamp('applied_at', { withTimezone: true }).defaultNow(),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('leave_requests_tenant_id_idx').on(t.tenant_id),
    index('leave_requests_employee_id_idx').on(t.employee_id),
    index('leave_requests_leave_type_id_idx').on(t.leave_type_id),
    index('leave_requests_status_idx').on(t.status),
    index('leave_requests_start_date_idx').on(t.start_date),
    index('leave_requests_end_date_idx').on(t.end_date),
    index('leave_requests_approver_id_idx').on(t.approver_id),
  ],
);

// ─── holidays ─────────────────────────────────────────────────────────────────

export const holidays = pgTable(
  'holidays',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    location_id: uuid('location_id').references(() => locations.id, {
      onDelete: 'set null',
    }),
    holiday_date: date('holiday_date').notNull(),
    name: text('name').notNull(),
    type: holidayTypeEnum('type').notNull().default('national'),
    description: text('description'),
    is_recurring: boolean('is_recurring').notNull().default(false), // yearly
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('holidays_tenant_id_idx').on(t.tenant_id),
    index('holidays_holiday_date_idx').on(t.holiday_date),
    index('holidays_type_idx').on(t.type),
  ],
);

// ─── calendar_events ──────────────────────────────────────────────────────────

export const calendarEvents = pgTable(
  'calendar_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    event_type: calendarEventTypeEnum('event_type').notNull(),
    source_id: uuid('source_id'), // id of the originating record (leave_request, holiday, etc.)
    employee_id: uuid('employee_id').references(() => employees.id, {
      onDelete: 'cascade',
    }),
    title: text('title').notNull(),
    description: text('description'),
    start_at: timestamp('start_at', { withTimezone: true }).notNull(),
    end_at: timestamp('end_at', { withTimezone: true }).notNull(),
    is_all_day: boolean('is_all_day').notNull().default(false),
    visibility: calendarVisibilityEnum('visibility')
      .notNull()
      .default('company'),
    color: text('color'),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('calendar_events_tenant_id_idx').on(t.tenant_id),
    index('calendar_events_employee_id_idx').on(t.employee_id),
    index('calendar_events_event_type_idx').on(t.event_type),
    index('calendar_events_start_at_idx').on(t.start_at),
    index('calendar_events_end_at_idx').on(t.end_at),
  ],
);

// ─── Relations ────────────────────────────────────────────────────────────────

export const leaveTypesRelations = relations(leaveTypes, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [leaveTypes.tenant_id],
    references: [tenants.id],
  }),
  balances: many(leaveBalances),
  requests: many(leaveRequests),
}));

export const leaveBalancesRelations = relations(leaveBalances, ({ one }) => ({
  tenant: one(tenants, {
    fields: [leaveBalances.tenant_id],
    references: [tenants.id],
  }),
  employee: one(employees, {
    fields: [leaveBalances.employee_id],
    references: [employees.id],
  }),
  leaveType: one(leaveTypes, {
    fields: [leaveBalances.leave_type_id],
    references: [leaveTypes.id],
  }),
}));

export const leaveRequestsRelations = relations(leaveRequests, ({ one }) => ({
  tenant: one(tenants, {
    fields: [leaveRequests.tenant_id],
    references: [tenants.id],
  }),
  employee: one(employees, {
    fields: [leaveRequests.employee_id],
    references: [employees.id],
  }),
  leaveType: one(leaveTypes, {
    fields: [leaveRequests.leave_type_id],
    references: [leaveTypes.id],
  }),
  approver: one(employees, {
    fields: [leaveRequests.approver_id],
    references: [employees.id],
  }),
  coverEmployee: one(employees, {
    fields: [leaveRequests.cover_employee_id],
    references: [employees.id],
  }),
}));

export const holidaysRelations = relations(holidays, ({ one }) => ({
  tenant: one(tenants, {
    fields: [holidays.tenant_id],
    references: [tenants.id],
  }),
}));

export const calendarEventsRelations = relations(calendarEvents, ({ one }) => ({
  tenant: one(tenants, {
    fields: [calendarEvents.tenant_id],
    references: [tenants.id],
  }),
  employee: one(employees, {
    fields: [calendarEvents.employee_id],
    references: [employees.id],
  }),
}));

// ─── Types ────────────────────────────────────────────────────────────────────

export type LeaveType = typeof leaveTypes.$inferSelect;
export type NewLeaveType = typeof leaveTypes.$inferInsert;
export type LeaveBalance = typeof leaveBalances.$inferSelect;
export type NewLeaveBalance = typeof leaveBalances.$inferInsert;
export type LeaveRequest = typeof leaveRequests.$inferSelect;
export type NewLeaveRequest = typeof leaveRequests.$inferInsert;
export type Holiday = typeof holidays.$inferSelect;
export type NewHoliday = typeof holidays.$inferInsert;
export type CalendarEvent = typeof calendarEvents.$inferSelect;
export type NewCalendarEvent = typeof calendarEvents.$inferInsert;
