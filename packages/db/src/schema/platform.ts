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
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// ─── Enums ────────────────────────────────────────────────────────────────────

export const tenantStatusEnum = pgEnum('tenant_status', [
  'trialing',
  'active',
  'past_due',
  'canceled',
  'suspended',
]);

// Note: 'super_admin' remains in the enum for backwards-compat (Postgres
// cannot drop enum values without rewriting the column). New code should
// use 'fam' — the Specflicks-internal platform admin role.
export const membershipRoleEnum = pgEnum('membership_role', [
  'super_admin',
  'fam',
  'owner',
  'admin',
  'manager',
  'finance',
  'employee',
  // Invoicing v3: finance-scoped, grant-driven, multi-company, non-billable.
  // Added to the DB enum via migration (ALTER TYPE … ADD VALUE 'auditor').
  'auditor',
  // PM guest seats (round 7): project-scoped external collaborator.
  // Non-hierarchical like auditor; PM access is grant-row-driven and
  // visibility is limited to pm_project_members rows. Non-billable.
  // Added via 0051 (ALTER TYPE … ADD VALUE 'guest').
  'guest',
]);

export const membershipStatusEnum = pgEnum('membership_status', [
  'invited',
  'active',
  'deactivated',
]);

export const userStatusEnum = pgEnum('user_status', [
  'active',
  'suspended',
  'deleted',
]);

// ─── tenants ──────────────────────────────────────────────────────────────────

export const tenants = pgTable(
  'tenants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    legal_name: text('legal_name'),
    gstin: text('gstin'),
    pan: text('pan'),
    cin: text('cin'),
    industry: text('industry'),
    size_band: text('size_band'), // e.g. "1-10", "11-50", "51-200"
    country_code: text('country_code').notNull().default('IN'),
    state_code: text('state_code'),
    city: text('city'),
    address_line1: text('address_line1'),
    address_line2: text('address_line2'),
    postal_code: text('postal_code'),
    timezone: text('timezone').notNull().default('Asia/Kolkata'),
    currency: text('currency').notNull().default('INR'),
    fiscal_year_start_month: integer('fiscal_year_start_month')
      .notNull()
      .default(4), // April
    date_format: text('date_format').notNull().default('DD/MM/YYYY'),
    working_days: text('working_days')
      .array()
      .notNull()
      .default(['MON', 'TUE', 'WED', 'THU', 'FRI']),
    default_work_start: text('default_work_start').notNull().default('09:00'),
    default_work_end: text('default_work_end').notNull().default('18:00'),
    logo_url: text('logo_url'),
    // PRD v4 §4: private R2 key (tenants/<id>/logo/<uuid>_{256|64}.webp). One
    // upload feeds both the in-app circular logo and the invoice render path
    // (which swaps to a signed URL at serialization only).
    logo_key: text('logo_key'),
    logo_updated_at: timestamp('logo_updated_at', { withTimezone: true }),
    brand_color: text('brand_color'),
    status: tenantStatusEnum('status').notNull().default('trialing'),
    trial_ends_at: timestamp('trial_ends_at', { withTimezone: true }),
    verified_at: timestamp('verified_at', { withTimezone: true }),
    verified_by_user_id: uuid('verified_by_user_id'),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    deleted_at: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('tenants_slug_unique').on(t.slug),
    index('tenants_status_idx').on(t.status),
    index('tenants_deleted_at_idx').on(t.deleted_at),
  ],
);

// ─── users ────────────────────────────────────────────────────────────────────

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // citext for case-insensitive email matching — stored as text, cast in DB
    email: text('email').notNull(),
    email_verified_at: timestamp('email_verified_at', { withTimezone: true }),
    full_name: text('full_name').notNull(),
    avatar_url: text('avatar_url'),
    // PRD v4 §4 media pipeline: private R2 key (users/<id>/avatar/<uuid>_{256|64}.webp).
    // Serialization prefers a signed URL from this key, falls back to avatar_url.
    avatar_key: text('avatar_key'),
    avatar_updated_at: timestamp('avatar_updated_at', { withTimezone: true }),
    phone: text('phone'),
    phone_verified_at: timestamp('phone_verified_at', { withTimezone: true }),
    locale: text('locale').notNull().default('en-IN'),
    timezone: text('timezone').notNull().default('Asia/Kolkata'),
    // §19.4 — appended to CRM composed email.
    email_signature_html: text('email_signature_html'),
    // PM Inbox (0045): email cadence for inbox-style notifications —
    // 'urgent' (5-min unread mention/assignment emails only) | 'hourly' | 'daily'.
    notification_email_digest: text('notification_email_digest').notNull().default('daily'),
    is_platform_admin: boolean('is_platform_admin').notNull().default(false),
    // FAM (platform-admin) second factor. Base32 TOTP secret, set at enrolment.
    // FAM logins are gated on this being non-null (PRD §11.6).
    totp_secret: text('totp_secret'),
    totp_enrolled_at: timestamp('totp_enrolled_at', { withTimezone: true }),
    // TOTP brute-force lockout + single-use backup codes (Sprint 13 §E).
    totp_failed_attempts: integer('totp_failed_attempts').notNull().default(0),
    totp_locked_until: timestamp('totp_locked_until', { withTimezone: true }),
    totp_backup_codes: jsonb('totp_backup_codes').$type<Array<{ h: string; u: string | null }>>(),
    status: userStatusEnum('status').notNull().default('active'),
    last_login_at: timestamp('last_login_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('users_email_unique').on(t.email),
    index('users_status_idx').on(t.status),
  ],
);

// ─── memberships ──────────────────────────────────────────────────────────────

export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    employee_id: uuid('employee_id'), // FK set on employees table to avoid circular dep
    role: membershipRoleEnum('role').notNull().default('employee'),
    status: membershipStatusEnum('status').notNull().default('invited'),
    // Invoicing v3 auditor support: external CA vs internal reviewer, and an
    // optional time-boxed engagement window (P1).
    is_external: boolean('is_external').notNull().default(false),
    access_expires_at: timestamp('access_expires_at', { withTimezone: true }),
    invited_by: uuid('invited_by').references(() => users.id),
    invited_at: timestamp('invited_at', { withTimezone: true }).defaultNow(),
    accepted_at: timestamp('accepted_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('memberships_tenant_user_unique').on(t.tenant_id, t.user_id),
    index('memberships_tenant_id_idx').on(t.tenant_id),
    index('memberships_user_id_idx').on(t.user_id),
    index('memberships_role_idx').on(t.role),
    index('memberships_status_idx').on(t.status),
  ],
);

// ─── account_deletion_requests ─────────────────────────────────────────────────
// DPDP right-to-erasure. A request opens a 7-day cool-off (scheduled_for),
// during which the principal can cancel. The actual erasure honours the
// employer's statutory retention obligations (8-yr employee records), so a
// "completed" request soft-deletes the personal login, not the employment
// ledger — processed by an admin/cron step (deferred past MVP).

export const accountDeletionRequests = pgTable(
  'account_deletion_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    reason: text('reason'),
    status: text('status').notNull().default('pending'), // pending | cancelled | completed
    requested_at: timestamp('requested_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    scheduled_for: timestamp('scheduled_for', { withTimezone: true }).notNull(),
    processed_at: timestamp('processed_at', { withTimezone: true }),
    ip_address: text('ip_address'),
    user_agent: text('user_agent'),
  },
  (t) => [
    index('account_deletion_requests_user_idx').on(t.user_id, t.status),
    index('account_deletion_requests_tenant_idx').on(t.tenant_id),
  ],
);

// ─── consent_records (PRD v4 §3.2 — append-only consent ledger) ─────────────────
// One row per consent decision; withdrawal = a new row with granted=false.
// Current state = latest row per (user_id, consent_type). Self-visibility RLS
// (user reads/writes own rows); FAM/audit read via service role. No UPDATE or
// DELETE policies — the ledger is append-only under the app role.

export const consentRecords = pgTable(
  'consent_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Nullable: signup consents predate tenant creation.
    tenant_id: uuid('tenant_id').references(() => tenants.id, {
      onDelete: 'set null',
    }),
    consent_type: text('consent_type').notNull(), // terms_privacy | analytics | marketing_email
    granted: boolean('granted').notNull(),
    policy_version: text('policy_version').notNull(), // 'tos-2026-07-01' | 'privacy-2026-07-01' | 'consent-v1'
    source: text('source').notNull(), // signup | banner | settings | unsubscribe | import
    region_code: text('region_code'), // ISO 3166-1 alpha-2
    ip_hash: text('ip_hash'), // SHA-256(ip + server salt); never the raw IP
    user_agent: text('user_agent'),
    occurred_at: timestamp('occurred_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('idx_consents_user_type').on(t.user_id, t.consent_type, t.occurred_at),
  ],
);

// ─── member_status (PRD v4 §5 — presence & status) ──────────────────────────────
// Manual status only (auto states resolve at read time). Per (tenant, user) —
// auditors hold independent statuses per client company. Tenant-read /
// write-own RLS.

export const memberStatus = pgTable(
  'member_status',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    manual_status: text('manual_status'), // available|busy|dnd|brb|away|offline
    status_message: text('status_message'), // ≤80 chars (app-enforced)
    expires_at: timestamp('expires_at', { withTimezone: true }),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('member_status_tenant_user_unique').on(t.tenant_id, t.user_id),
    index('idx_member_status_tenant').on(t.tenant_id),
  ],
);

// ─── membership_grants (Invoicing v3 — per-membership module scopes) ────────────
// Drives the Auditor sidebar + grant guards. One row per (membership, module).

export const membershipGrants = pgTable(
  'membership_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }), // == membership's tenant
    membership_id: uuid('membership_id')
      .notNull()
      .references(() => memberships.id, { onDelete: 'cascade' }),
    // invoicing | reports | org_financial | payroll(reserved) | expenses(reserved)
    module: text('module').notNull(),
    access_level: text('access_level').notNull().default('view'), // none | view | edit
    capabilities: jsonb('capabilities').notNull().default({}), // {"send":true,"record_payment":true,...}
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('membership_grants_membership_module_unique').on(
      t.membership_id,
      t.module,
    ),
    index('idx_membership_grants_membership').on(t.membership_id),
    index('membership_grants_tenant_idx').on(t.tenant_id),
  ],
);

// ─── tenant_module_toggles (Invoicing v3 — FAM per-module enablement) ───────────

export const tenantModuleToggles = pgTable(
  'tenant_module_toggles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    module: text('module').notNull(), // invoicing | payroll | expenses
    enabled: boolean('enabled').notNull().default(false),
    updated_by: uuid('updated_by').references(() => users.id),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (t) => [
    uniqueIndex('tenant_module_toggles_unique').on(t.tenant_id, t.module),
    index('tenant_module_toggles_tenant_idx').on(t.tenant_id),
  ],
);

// ─── Relations ────────────────────────────────────────────────────────────────

export const tenantsRelations = relations(tenants, ({ many }) => ({
  memberships: many(memberships),
}));

export const usersRelations = relations(users, ({ many }) => ({
  memberships: many(memberships),
}));

export const membershipsRelations = relations(memberships, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [memberships.tenant_id],
    references: [tenants.id],
  }),
  user: one(users, {
    fields: [memberships.user_id],
    references: [users.id],
  }),
  invitedBy: one(users, {
    fields: [memberships.invited_by],
    references: [users.id],
  }),
  grants: many(membershipGrants),
}));

export const membershipGrantsRelations = relations(
  membershipGrants,
  ({ one }) => ({
    tenant: one(tenants, {
      fields: [membershipGrants.tenant_id],
      references: [tenants.id],
    }),
    membership: one(memberships, {
      fields: [membershipGrants.membership_id],
      references: [memberships.id],
    }),
  }),
);

export const tenantModuleTogglesRelations = relations(
  tenantModuleToggles,
  ({ one }) => ({
    tenant: one(tenants, {
      fields: [tenantModuleToggles.tenant_id],
      references: [tenants.id],
    }),
  }),
);

// ─── Types ────────────────────────────────────────────────────────────────────

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Membership = typeof memberships.$inferSelect;
export type NewMembership = typeof memberships.$inferInsert;
export type MembershipGrant = typeof membershipGrants.$inferSelect;
export type NewMembershipGrant = typeof membershipGrants.$inferInsert;
export type TenantModuleToggle = typeof tenantModuleToggles.$inferSelect;
export type NewTenantModuleToggle = typeof tenantModuleToggles.$inferInsert;
export type ConsentRecord = typeof consentRecords.$inferSelect;
export type NewConsentRecord = typeof consentRecords.$inferInsert;
