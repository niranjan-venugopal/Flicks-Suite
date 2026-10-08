import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  index,
  unique,
  foreignKey,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { tenants, users } from './platform';
import { employees } from './employees';

// ─── Company policies (Round P R3, migration 0067) ───────────────────────────
//
// HR/Owner (or any seat holding the 'policies' module grant) writes a policy
// as rich text (body_md) OR uploads a PDF (file_* columns, private R2 key
// tenants/<tenant>/policies/<policy>/<uuid>.pdf), publishes it and asks the
// applicable members to agree. `version` only moves when a PUBLISHED policy
// is re-published with "ask everyone to agree again"; `applies_to_roles`
// NULL = every standard role. `last_reminded_at` throttles the HR reminder
// to one per hour per policy. Mirrors 0067 exactly, indexes included.

export const POLICY_KINDS = ['rich_text', 'pdf'] as const;
export type PolicyKind = (typeof POLICY_KINDS)[number];

export const POLICY_STATUSES = ['draft', 'published', 'archived'] as const;
export type PolicyStatus = (typeof POLICY_STATUSES)[number];

/** Roles a policy can target; NULL on the row means all of these. */
export const POLICY_TARGET_ROLES = ['owner', 'admin', 'manager', 'finance', 'employee'] as const;
export type PolicyTargetRole = (typeof POLICY_TARGET_ROLES)[number];

export const companyPolicies = pgTable(
  'company_policies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    category: text('category'),
    kind: text('kind').notNull().default('rich_text'), // rich_text | pdf
    body_md: text('body_md'),
    file_key: text('file_key'),
    file_name: text('file_name'),
    file_size_bytes: integer('file_size_bytes'),
    file_sha256: text('file_sha256'),
    version: integer('version').notNull().default(1),
    status: text('status').notNull().default('draft'), // draft | published | archived
    requires_acknowledgement: boolean('requires_acknowledgement').notNull().default(true),
    applies_to_roles: text('applies_to_roles').array(), // NULL = every standard role
    published_at: timestamp('published_at', { withTimezone: true }),
    published_by: uuid('published_by').references(() => users.id, { onDelete: 'set null' }),
    archived_at: timestamp('archived_at', { withTimezone: true }),
    last_reminded_at: timestamp('last_reminded_at', { withTimezone: true }),
    // 0069 (Round R): Owner / HR deleted it — hidden everywhere, PDF removed;
    // the acknowledgement rows stay as the company's proof.
    deleted_at: timestamp('deleted_at', { withTimezone: true }),
    created_by: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updated_by: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_company_policies_tenant_status').on(t.tenant_id, t.status),
    index('idx_company_policies_tenant_live').on(t.tenant_id).where(sql`${t.deleted_at} IS NULL`),
    // Target of the composite FK below (0069).
    unique('company_policies_tenant_id_id_key').on(t.tenant_id, t.id),
  ],
);

export const policyAcknowledgements = pgTable(
  'policy_acknowledgements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    policy_id: uuid('policy_id')
      .notNull()
      .references(() => companyPolicies.id, { onDelete: 'cascade' }),
    policy_version: integer('policy_version').notNull(),
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    employee_id: uuid('employee_id').references(() => employees.id, { onDelete: 'set null' }),
    acknowledged_at: timestamp('acknowledged_at', { withTimezone: true }).notNull().defaultNow(),
    ip_hash: text('ip_hash'),
    user_agent: text('user_agent'),
  },
  (t) => [
    unique('policy_acknowledgements_tenant_policy_version_user_key').on(
      t.tenant_id,
      t.policy_id,
      t.policy_version,
      t.user_id,
    ),
    index('idx_policy_acknowledgements_user').on(t.tenant_id, t.user_id),
    // 0069 (Round R): FK checks bypass RLS — tie the acknowledgement to a
    // policy of the SAME company at the database level.
    foreignKey({
      name: 'policy_acknowledgements_tenant_policy_fkey',
      columns: [t.tenant_id, t.policy_id],
      foreignColumns: [companyPolicies.tenant_id, companyPolicies.id],
    }).onDelete('cascade'),
  ],
);

// ─── Relations ────────────────────────────────────────────────────────────────

export const companyPoliciesRelations = relations(companyPolicies, ({ one, many }) => ({
  tenant: one(tenants, { fields: [companyPolicies.tenant_id], references: [tenants.id] }),
  publisher: one(users, { fields: [companyPolicies.published_by], references: [users.id] }),
  acknowledgements: many(policyAcknowledgements),
}));

export const policyAcknowledgementsRelations = relations(policyAcknowledgements, ({ one }) => ({
  tenant: one(tenants, { fields: [policyAcknowledgements.tenant_id], references: [tenants.id] }),
  policy: one(companyPolicies, {
    fields: [policyAcknowledgements.policy_id],
    references: [companyPolicies.id],
  }),
  user: one(users, { fields: [policyAcknowledgements.user_id], references: [users.id] }),
  employee: one(employees, {
    fields: [policyAcknowledgements.employee_id],
    references: [employees.id],
  }),
}));

// ─── Types ────────────────────────────────────────────────────────────────────

export type CompanyPolicy = typeof companyPolicies.$inferSelect;
export type NewCompanyPolicy = typeof companyPolicies.$inferInsert;
export type PolicyAcknowledgement = typeof policyAcknowledgements.$inferSelect;
export type NewPolicyAcknowledgement = typeof policyAcknowledgements.$inferInsert;
