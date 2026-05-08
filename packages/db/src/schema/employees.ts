import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  integer,
  jsonb,
  pgEnum,
  uniqueIndex,
  index,
  smallint,
  date,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { tenants, users } from './platform';

// ─── Enums ────────────────────────────────────────────────────────────────────

export const employmentTypeEnum = pgEnum('employment_type', [
  'full_time',
  'part_time',
  'contract',
  'intern',
  'consultant',
  'probation',
]);

export const employeeStatusEnum = pgEnum('employee_status', [
  'active',
  'inactive',
  'on_leave',
  'notice_period',
  'separated',
  'absconded',
]);

export const genderEnum = pgEnum('gender', [
  'male',
  'female',
  'other',
  'prefer_not_to_say',
]);

export const maritalStatusEnum = pgEnum('marital_status', [
  'single',
  'married',
  'divorced',
  'widowed',
  'separated',
]);

export const bloodGroupEnum = pgEnum('blood_group', [
  'A+',
  'A-',
  'B+',
  'B-',
  'AB+',
  'AB-',
  'O+',
  'O-',
]);

export const bankAccountTypeEnum = pgEnum('bank_account_type', [
  'savings',
  'current',
  'salary',
]);

export const documentTypeEnum = pgEnum('document_type', [
  'pan_card',
  'aadhaar_card',
  'passport',
  'driving_license',
  'voter_id',
  'offer_letter',
  'appointment_letter',
  'experience_letter',
  'education_certificate',
  'salary_slip',
  'bank_statement',
  'other',
]);

export const documentStatusEnum = pgEnum('document_status', [
  'pending',
  'approved',
  'rejected',
]);

export const employmentChangeTypeEnum = pgEnum('employment_change_type', [
  'hire',
  'promotion',
  'demotion',
  'transfer',
  'salary_revision',
  'role_change',
  'department_change',
  'location_change',
  'manager_change',
  'separation',
  'rehire',
  'status_change',
]);

export const consentTypeEnum = pgEnum('consent_type', [
  'data_processing',
  'marketing',
  'background_check',
  'biometric_data',
  'third_party_sharing',
]);

// ─── departments ──────────────────────────────────────────────────────────────

export const departments = pgTable(
  'departments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    code: text('code'),
    parent_id: uuid('parent_id'), // self-referential FK defined in relations
    head_employee_id: uuid('head_employee_id'), // FK to employees (set after employees table)
    description: text('description'),
    is_active: boolean('is_active').notNull().default(true),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('departments_tenant_name_unique').on(t.tenant_id, t.name),
    index('departments_tenant_id_idx').on(t.tenant_id),
    index('departments_parent_id_idx').on(t.parent_id),
    index('departments_is_active_idx').on(t.is_active),
  ],
);

// ─── designations ──────────────────────────────────────────────────────────────

export const designations = pgTable(
  'designations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    level: integer('level'), // hierarchical level, e.g. L1..L10
    department_id: uuid('department_id').references(() => departments.id, {
      onDelete: 'set null',
    }),
    is_active: boolean('is_active').notNull().default(true),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('designations_tenant_id_idx').on(t.tenant_id),
    index('designations_department_id_idx').on(t.department_id),
    index('designations_is_active_idx').on(t.is_active),
  ],
);

// ─── locations ────────────────────────────────────────────────────────────────

export const locations = pgTable(
  'locations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    address_line1: text('address_line1'),
    address_line2: text('address_line2'),
    city: text('city'),
    state_code: text('state_code'),
    postal_code: text('postal_code'),
    country_code: text('country_code').notNull().default('IN'),
    timezone: text('timezone').notNull().default('Asia/Kolkata'),
    geofence_lat: text('geofence_lat'), // stored as text for precision; cast to numeric in queries
    geofence_lng: text('geofence_lng'),
    geofence_radius_m: integer('geofence_radius_m'), // radius in metres
    ip_allowlist: text('ip_allowlist').array(), // CIDR ranges
    is_active: boolean('is_active').notNull().default(true),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('locations_tenant_id_idx').on(t.tenant_id),
    index('locations_is_active_idx').on(t.is_active),
  ],
);

// ─── employees ────────────────────────────────────────────────────────────────

export const employees = pgTable(
  'employees',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    user_id: uuid('user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    employee_code: text('employee_code').notNull(),

    // Name
    first_name: text('first_name').notNull(),
    middle_name: text('middle_name'),
    last_name: text('last_name').notNull(),
    preferred_name: text('preferred_name'),
    // full_name is a generated column computed in SQL migration; exposed here as virtual
    full_name: text('full_name').generatedAlwaysAs(
      sql`trim(coalesce(first_name,'') || ' ' || coalesce(middle_name,'') || ' ' || coalesce(last_name,''))`,
    ),

    // Contact
    work_email: text('work_email').notNull(),
    personal_email: text('personal_email'),
    work_phone: text('work_phone'),
    personal_phone: text('personal_phone'),

    // Org
    department_id: uuid('department_id').references(() => departments.id, {
      onDelete: 'set null',
    }),
    designation_id: uuid('designation_id').references(() => designations.id, {
      onDelete: 'set null',
    }),
    location_id: uuid('location_id').references(() => locations.id, {
      onDelete: 'set null',
    }),
    reporting_manager_id: uuid('reporting_manager_id'), // self-referential, set via relations

    // Employment
    employment_type: employmentTypeEnum('employment_type')
      .notNull()
      .default('full_time'),
    date_of_joining: date('date_of_joining').notNull(),
    date_of_confirmation: date('date_of_confirmation'),
    probation_end_date: date('probation_end_date'),
    date_of_exit: date('date_of_exit'),
    exit_reason: text('exit_reason'),
    notice_period_days: integer('notice_period_days').default(30),

    // Personal
    date_of_birth: date('date_of_birth'),
    gender: genderEnum('gender'),
    marital_status: maritalStatusEnum('marital_status'),
    nationality: text('nationality').default('Indian'),
    blood_group: bloodGroupEnum('blood_group'),

    // Address
    current_address: jsonb('current_address'), // { line1, line2, city, state, postal_code, country }
    permanent_address: jsonb('permanent_address'),

    // Compliance — sensitive fields stored encrypted at app layer
    pan_encrypted: text('pan_encrypted'),
    aadhaar_last4: text('aadhaar_last4'), // only last 4 digits stored
    passport_number_encrypted: text('passport_number_encrypted'),

    // Bank
    bank_account_holder: text('bank_account_holder'),
    bank_account_number_encrypted: text('bank_account_number_encrypted'),
    bank_ifsc: text('bank_ifsc'),
    bank_name: text('bank_name'),
    bank_branch: text('bank_branch'),
    bank_account_type: bankAccountTypeEnum('bank_account_type'),

    // Statutory
    pf_uan: text('pf_uan'),
    esic_number: text('esic_number'),
    pt_state: text('pt_state'), // state for Professional Tax applicability
    pf_applicable: boolean('pf_applicable').notNull().default(true),
    esi_applicable: boolean('esi_applicable').notNull().default(false),

    // Meta
    status: employeeStatusEnum('status').notNull().default('active'),
    avatar_url: text('avatar_url'),
    custom_fields: jsonb('custom_fields'), // tenant-defined extra fields
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    created_by: uuid('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [
    uniqueIndex('employees_tenant_code_unique').on(t.tenant_id, t.employee_code),
    uniqueIndex('employees_tenant_work_email_unique').on(
      t.tenant_id,
      t.work_email,
    ),
    index('employees_tenant_id_idx').on(t.tenant_id),
    index('employees_user_id_idx').on(t.user_id),
    index('employees_status_idx').on(t.status),
    index('employees_department_id_idx').on(t.department_id),
    index('employees_designation_id_idx').on(t.designation_id),
    index('employees_location_id_idx').on(t.location_id),
    index('employees_reporting_manager_id_idx').on(t.reporting_manager_id),
    index('employees_date_of_joining_idx').on(t.date_of_joining),
    index('employees_employment_type_idx').on(t.employment_type),
  ],
);

// ─── emergency_contacts ────────────────────────────────────────────────────────

export const emergencyContacts = pgTable(
  'emergency_contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    employee_id: uuid('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    relationship: text('relationship').notNull(),
    phone: text('phone').notNull(),
    email: text('email'),
    is_primary: boolean('is_primary').notNull().default(false),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('emergency_contacts_tenant_id_idx').on(t.tenant_id),
    index('emergency_contacts_employee_id_idx').on(t.employee_id),
  ],
);

// ─── employee_documents ────────────────────────────────────────────────────────

export const employeeDocuments = pgTable(
  'employee_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    employee_id: uuid('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'cascade' }),
    document_type: documentTypeEnum('document_type').notNull(),
    file_name: text('file_name').notNull(),
    file_size_bytes: integer('file_size_bytes'),
    mime_type: text('mime_type'),
    r2_key: text('r2_key').notNull(), // Cloudflare R2 object key
    uploaded_by: uuid('uploaded_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    status: documentStatusEnum('status').notNull().default('pending'),
    reviewed_by: uuid('reviewed_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    reviewed_at: timestamp('reviewed_at', { withTimezone: true }),
    rejection_reason: text('rejection_reason'),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('employee_documents_tenant_id_idx').on(t.tenant_id),
    index('employee_documents_employee_id_idx').on(t.employee_id),
    index('employee_documents_status_idx').on(t.status),
    index('employee_documents_document_type_idx').on(t.document_type),
  ],
);

// ─── employee_invitations ──────────────────────────────────────────────────────

export const employeeInvitations = pgTable(
  'employee_invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    employee_id: uuid('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    token_hash: text('token_hash').notNull().unique(),
    expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumed_at: timestamp('consumed_at', { withTimezone: true }),
    resent_count: integer('resent_count').notNull().default(0),
    invited_by: uuid('invited_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('employee_invitations_tenant_id_idx').on(t.tenant_id),
    index('employee_invitations_employee_id_idx').on(t.employee_id),
    index('employee_invitations_email_idx').on(t.email),
    index('employee_invitations_expires_at_idx').on(t.expires_at),
  ],
);

// ─── employment_history ────────────────────────────────────────────────────────

export const employmentHistory = pgTable(
  'employment_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    employee_id: uuid('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'cascade' }),
    change_type: employmentChangeTypeEnum('change_type').notNull(),
    previous_value: jsonb('previous_value'),
    new_value: jsonb('new_value'),
    effective_from: date('effective_from').notNull(),
    reason: text('reason'),
    changed_by: uuid('changed_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('employment_history_tenant_id_idx').on(t.tenant_id),
    index('employment_history_employee_id_idx').on(t.employee_id),
    index('employment_history_change_type_idx').on(t.change_type),
    index('employment_history_effective_from_idx').on(t.effective_from),
  ],
);

// ─── data_consents ────────────────────────────────────────────────────────────

export const dataConsents = pgTable(
  'data_consents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    consent_type: consentTypeEnum('consent_type').notNull(),
    purpose: text('purpose'),
    granted: boolean('granted').notNull(),
    consent_version: text('consent_version').notNull(),
    ip_address: text('ip_address'),
    user_agent: text('user_agent'),
    granted_at: timestamp('granted_at', { withTimezone: true }),
    withdrawn_at: timestamp('withdrawn_at', { withTimezone: true }),
  },
  (t) => [
    index('data_consents_tenant_id_idx').on(t.tenant_id),
    index('data_consents_user_id_idx').on(t.user_id),
    index('data_consents_consent_type_idx').on(t.consent_type),
  ],
);

// ─── Relations ────────────────────────────────────────────────────────────────

export const departmentsRelations = relations(departments, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [departments.tenant_id],
    references: [tenants.id],
  }),
  parent: one(departments, {
    fields: [departments.parent_id],
    references: [departments.id],
    relationName: 'department_hierarchy',
  }),
  children: many(departments, { relationName: 'department_hierarchy' }),
  employees: many(employees),
  designations: many(designations),
}));

export const designationsRelations = relations(designations, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [designations.tenant_id],
    references: [tenants.id],
  }),
  department: one(departments, {
    fields: [designations.department_id],
    references: [departments.id],
  }),
  employees: many(employees),
}));

export const locationsRelations = relations(locations, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [locations.tenant_id],
    references: [tenants.id],
  }),
  employees: many(employees),
}));

export const employeesRelations = relations(employees, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [employees.tenant_id],
    references: [tenants.id],
  }),
  user: one(users, {
    fields: [employees.user_id],
    references: [users.id],
  }),
  department: one(departments, {
    fields: [employees.department_id],
    references: [departments.id],
  }),
  designation: one(designations, {
    fields: [employees.designation_id],
    references: [designations.id],
  }),
  location: one(locations, {
    fields: [employees.location_id],
    references: [locations.id],
  }),
  reportingManager: one(employees, {
    fields: [employees.reporting_manager_id],
    references: [employees.id],
    relationName: 'reporting_chain',
  }),
  directReports: many(employees, { relationName: 'reporting_chain' }),
  emergencyContacts: many(emergencyContacts),
  documents: many(employeeDocuments),
  invitations: many(employeeInvitations),
  employmentHistory: many(employmentHistory),
}));

export const emergencyContactsRelations = relations(
  emergencyContacts,
  ({ one }) => ({
    tenant: one(tenants, {
      fields: [emergencyContacts.tenant_id],
      references: [tenants.id],
    }),
    employee: one(employees, {
      fields: [emergencyContacts.employee_id],
      references: [employees.id],
    }),
  }),
);

export const employeeDocumentsRelations = relations(
  employeeDocuments,
  ({ one }) => ({
    tenant: one(tenants, {
      fields: [employeeDocuments.tenant_id],
      references: [tenants.id],
    }),
    employee: one(employees, {
      fields: [employeeDocuments.employee_id],
      references: [employees.id],
    }),
    uploadedBy: one(users, {
      fields: [employeeDocuments.uploaded_by],
      references: [users.id],
    }),
    reviewedBy: one(users, {
      fields: [employeeDocuments.reviewed_by],
      references: [users.id],
    }),
  }),
);

export const employeeInvitationsRelations = relations(
  employeeInvitations,
  ({ one }) => ({
    tenant: one(tenants, {
      fields: [employeeInvitations.tenant_id],
      references: [tenants.id],
    }),
    employee: one(employees, {
      fields: [employeeInvitations.employee_id],
      references: [employees.id],
    }),
    invitedBy: one(users, {
      fields: [employeeInvitations.invited_by],
      references: [users.id],
    }),
  }),
);

export const employmentHistoryRelations = relations(
  employmentHistory,
  ({ one }) => ({
    tenant: one(tenants, {
      fields: [employmentHistory.tenant_id],
      references: [tenants.id],
    }),
    employee: one(employees, {
      fields: [employmentHistory.employee_id],
      references: [employees.id],
    }),
    changedBy: one(users, {
      fields: [employmentHistory.changed_by],
      references: [users.id],
    }),
  }),
);

export const dataConsentsRelations = relations(dataConsents, ({ one }) => ({
  tenant: one(tenants, {
    fields: [dataConsents.tenant_id],
    references: [tenants.id],
  }),
  user: one(users, {
    fields: [dataConsents.user_id],
    references: [users.id],
  }),
}));

// ─── Types ────────────────────────────────────────────────────────────────────

export type Department = typeof departments.$inferSelect;
export type NewDepartment = typeof departments.$inferInsert;
export type Designation = typeof designations.$inferSelect;
export type NewDesignation = typeof designations.$inferInsert;
export type Location = typeof locations.$inferSelect;
export type NewLocation = typeof locations.$inferInsert;
export type Employee = typeof employees.$inferSelect;
export type NewEmployee = typeof employees.$inferInsert;
export type EmergencyContact = typeof emergencyContacts.$inferSelect;
export type NewEmergencyContact = typeof emergencyContacts.$inferInsert;
export type EmployeeDocument = typeof employeeDocuments.$inferSelect;
export type NewEmployeeDocument = typeof employeeDocuments.$inferInsert;
export type EmployeeInvitation = typeof employeeInvitations.$inferSelect;
export type NewEmployeeInvitation = typeof employeeInvitations.$inferInsert;
export type EmploymentHistory = typeof employmentHistory.$inferSelect;
export type NewEmploymentHistory = typeof employmentHistory.$inferInsert;
export type DataConsent = typeof dataConsents.$inferSelect;
export type NewDataConsent = typeof dataConsents.$inferInsert;
