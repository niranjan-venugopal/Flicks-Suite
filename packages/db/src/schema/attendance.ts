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
  smallint,
  date,
  real,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { tenants, users } from './platform.js';
import { employees, locations } from './employees.js';

// ─── Enums ────────────────────────────────────────────────────────────────────

export const attendanceStatusEnum = pgEnum('attendance_status', [
  'present',
  'absent',
  'half_day',
  'late',
  'on_leave',
  'holiday',
  'weekend',
  'work_from_home',
  'on_duty',
  'comp_off',
]);

export const attendanceSourceEnum = pgEnum('attendance_source', [
  'web',
  'mobile',
  'biometric',
  'manual',
  'system',
]);

export const punchTypeEnum = pgEnum('punch_type', [
  'in',
  'out',
  'break_start',
  'break_end',
]);

export const regularizationStatusEnum = pgEnum('regularization_status', [
  'pending',
  'approved',
  'rejected',
  'cancelled',
]);

export const regularizationRequestTypeEnum = pgEnum(
  'regularization_request_type',
  ['missing_punch', 'wrong_time', 'wfh_request', 'on_duty', 'manual_override'],
);

// ─── shift_templates ──────────────────────────────────────────────────────────

export const shiftTemplates = pgTable(
  'shift_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    start_time: text('start_time').notNull(), // HH:MM (24h)
    end_time: text('end_time').notNull(), // HH:MM (24h)
    is_overnight: boolean('is_overnight').notNull().default(false),
    break_minutes: integer('break_minutes').notNull().default(60),
    break_paid: boolean('break_paid').notNull().default(false),
    working_days: smallint('working_days').array().notNull(), // 0=Sun..6=Sat
    timezone: text('timezone').notNull().default('Asia/Kolkata'),
    grace_period_minutes: integer('grace_period_minutes').notNull().default(15),
    half_day_threshold_minutes: integer('half_day_threshold_minutes')
      .notNull()
      .default(240),
    full_day_threshold_minutes: integer('full_day_threshold_minutes')
      .notNull()
      .default(480),
    is_default: boolean('is_default').notNull().default(false),
    is_active: boolean('is_active').notNull().default(true),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('shift_templates_tenant_id_idx').on(t.tenant_id),
    index('shift_templates_is_active_idx').on(t.is_active),
  ],
);

// ─── employee_shifts ──────────────────────────────────────────────────────────

export const employeeShifts = pgTable(
  'employee_shifts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    employee_id: uuid('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'cascade' }),
    shift_template_id: uuid('shift_template_id')
      .notNull()
      .references(() => shiftTemplates.id, { onDelete: 'restrict' }),
    effective_from: date('effective_from').notNull(),
    effective_to: date('effective_to'),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    created_by: uuid('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [
    index('employee_shifts_tenant_id_idx').on(t.tenant_id),
    index('employee_shifts_employee_id_idx').on(t.employee_id),
    index('employee_shifts_effective_from_idx').on(t.effective_from),
  ],
);

// ─── attendance_records ────────────────────────────────────────────────────────

export const attendanceRecords = pgTable(
  'attendance_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    employee_id: uuid('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'cascade' }),
    attendance_date: date('attendance_date').notNull(),
    shift_template_id: uuid('shift_template_id').references(
      () => shiftTemplates.id,
      { onDelete: 'set null' },
    ),
    first_punch_in_at: timestamp('first_punch_in_at', { withTimezone: true }),
    last_punch_out_at: timestamp('last_punch_out_at', { withTimezone: true }),
    total_break_minutes: integer('total_break_minutes').notNull().default(0),
    total_worked_minutes: integer('total_worked_minutes').notNull().default(0),
    is_late: boolean('is_late').notNull().default(false),
    late_by_minutes: integer('late_by_minutes').notNull().default(0),
    is_early_departure: boolean('is_early_departure').notNull().default(false),
    early_by_minutes: integer('early_by_minutes').notNull().default(0),
    is_overtime: boolean('is_overtime').notNull().default(false),
    overtime_minutes: integer('overtime_minutes').notNull().default(0),
    attendance_status: attendanceStatusEnum('attendance_status')
      .notNull()
      .default('absent'),
    source: attendanceSourceEnum('source').notNull().default('system'),
    notes: text('notes'),
    is_regularized: boolean('is_regularized').notNull().default(false),
    regularization_request_id: uuid('regularization_request_id'), // FK set after table creation
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('attendance_records_tenant_employee_date_unique').on(
      t.tenant_id,
      t.employee_id,
      t.attendance_date,
    ),
    index('attendance_records_tenant_id_idx').on(t.tenant_id),
    index('attendance_records_employee_id_idx').on(t.employee_id),
    index('attendance_records_attendance_date_idx').on(t.attendance_date),
    index('attendance_records_status_idx').on(t.attendance_status),
  ],
);

// ─── attendance_punches ────────────────────────────────────────────────────────

export const attendancePunches = pgTable(
  'attendance_punches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    attendance_record_id: uuid('attendance_record_id')
      .notNull()
      .references(() => attendanceRecords.id, { onDelete: 'cascade' }),
    employee_id: uuid('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'cascade' }),
    punch_type: punchTypeEnum('punch_type').notNull(),
    punched_at: timestamp('punched_at', { withTimezone: true }).notNull(),
    source: attendanceSourceEnum('source').notNull().default('web'),
    ip_address: text('ip_address'),
    user_agent: text('user_agent'),
    geo_lat: real('geo_lat'),
    geo_lng: real('geo_lng'),
    geo_accuracy_m: real('geo_accuracy_m'),
    location_id: uuid('location_id').references(() => locations.id, {
      onDelete: 'set null',
    }),
    is_within_geofence: boolean('is_within_geofence'),
    is_within_ip_allowlist: boolean('is_within_ip_allowlist'),
    notes: text('notes'),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('attendance_punches_tenant_id_idx').on(t.tenant_id),
    index('attendance_punches_attendance_record_id_idx').on(
      t.attendance_record_id,
    ),
    index('attendance_punches_employee_id_idx').on(t.employee_id),
    index('attendance_punches_punched_at_idx').on(t.punched_at),
  ],
);

// ─── attendance_regularizations ───────────────────────────────────────────────

export const attendanceRegularizations = pgTable(
  'attendance_regularizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    employee_id: uuid('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'cascade' }),
    attendance_date: date('attendance_date').notNull(),
    request_type: regularizationRequestTypeEnum('request_type').notNull(),
    proposed_in_time: timestamp('proposed_in_time', { withTimezone: true }),
    proposed_out_time: timestamp('proposed_out_time', { withTimezone: true }),
    reason: text('reason').notNull(),
    status: regularizationStatusEnum('status').notNull().default('pending'),
    approver_id: uuid('approver_id').references(() => employees.id, {
      onDelete: 'set null',
    }),
    approver_comment: text('approver_comment'),
    reviewed_at: timestamp('reviewed_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('attendance_regularizations_tenant_id_idx').on(t.tenant_id),
    index('attendance_regularizations_employee_id_idx').on(t.employee_id),
    index('attendance_regularizations_attendance_date_idx').on(
      t.attendance_date,
    ),
    index('attendance_regularizations_status_idx').on(t.status),
  ],
);

// ─── Relations ────────────────────────────────────────────────────────────────

export const shiftTemplatesRelations = relations(
  shiftTemplates,
  ({ one, many }) => ({
    tenant: one(tenants, {
      fields: [shiftTemplates.tenant_id],
      references: [tenants.id],
    }),
    employeeShifts: many(employeeShifts),
    attendanceRecords: many(attendanceRecords),
  }),
);

export const employeeShiftsRelations = relations(
  employeeShifts,
  ({ one }) => ({
    tenant: one(tenants, {
      fields: [employeeShifts.tenant_id],
      references: [tenants.id],
    }),
    employee: one(employees, {
      fields: [employeeShifts.employee_id],
      references: [employees.id],
    }),
    shiftTemplate: one(shiftTemplates, {
      fields: [employeeShifts.shift_template_id],
      references: [shiftTemplates.id],
    }),
  }),
);

export const attendanceRecordsRelations = relations(
  attendanceRecords,
  ({ one, many }) => ({
    tenant: one(tenants, {
      fields: [attendanceRecords.tenant_id],
      references: [tenants.id],
    }),
    employee: one(employees, {
      fields: [attendanceRecords.employee_id],
      references: [employees.id],
    }),
    shiftTemplate: one(shiftTemplates, {
      fields: [attendanceRecords.shift_template_id],
      references: [shiftTemplates.id],
    }),
    punches: many(attendancePunches),
    regularization: one(attendanceRegularizations, {
      fields: [attendanceRecords.regularization_request_id],
      references: [attendanceRegularizations.id],
    }),
  }),
);

export const attendancePunchesRelations = relations(
  attendancePunches,
  ({ one }) => ({
    tenant: one(tenants, {
      fields: [attendancePunches.tenant_id],
      references: [tenants.id],
    }),
    attendanceRecord: one(attendanceRecords, {
      fields: [attendancePunches.attendance_record_id],
      references: [attendanceRecords.id],
    }),
    employee: one(employees, {
      fields: [attendancePunches.employee_id],
      references: [employees.id],
    }),
    location: one(locations, {
      fields: [attendancePunches.location_id],
      references: [locations.id],
    }),
  }),
);

export const attendanceRegularizationsRelations = relations(
  attendanceRegularizations,
  ({ one }) => ({
    tenant: one(tenants, {
      fields: [attendanceRegularizations.tenant_id],
      references: [tenants.id],
    }),
    employee: one(employees, {
      fields: [attendanceRegularizations.employee_id],
      references: [employees.id],
    }),
    approver: one(employees, {
      fields: [attendanceRegularizations.approver_id],
      references: [employees.id],
    }),
  }),
);

// ─── Types ────────────────────────────────────────────────────────────────────

export type ShiftTemplate = typeof shiftTemplates.$inferSelect;
export type NewShiftTemplate = typeof shiftTemplates.$inferInsert;
export type EmployeeShift = typeof employeeShifts.$inferSelect;
export type NewEmployeeShift = typeof employeeShifts.$inferInsert;
export type AttendanceRecord = typeof attendanceRecords.$inferSelect;
export type NewAttendanceRecord = typeof attendanceRecords.$inferInsert;
export type AttendancePunch = typeof attendancePunches.$inferSelect;
export type NewAttendancePunch = typeof attendancePunches.$inferInsert;
export type AttendanceRegularization =
  typeof attendanceRegularizations.$inferSelect;
export type NewAttendanceRegularization =
  typeof attendanceRegularizations.$inferInsert;
