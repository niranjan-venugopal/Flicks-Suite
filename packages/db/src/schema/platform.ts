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
    phone: text('phone'),
    phone_verified_at: timestamp('phone_verified_at', { withTimezone: true }),
    locale: text('locale').notNull().default('en-IN'),
    timezone: text('timezone').notNull().default('Asia/Kolkata'),
    is_platform_admin: boolean('is_platform_admin').notNull().default(false),
    // FAM (platform-admin) second factor. Base32 TOTP secret, set at enrolment.
    // FAM logins are gated on this being non-null (PRD §11.6).
    totp_secret: text('totp_secret'),
    totp_enrolled_at: timestamp('totp_enrolled_at', { withTimezone: true }),
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

// ─── Relations ────────────────────────────────────────────────────────────────

export const tenantsRelations = relations(tenants, ({ many }) => ({
  memberships: many(memberships),
}));

export const usersRelations = relations(users, ({ many }) => ({
  memberships: many(memberships),
}));

export const membershipsRelations = relations(memberships, ({ one }) => ({
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
}));

// ─── Types ────────────────────────────────────────────────────────────────────

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Membership = typeof memberships.$inferSelect;
export type NewMembership = typeof memberships.$inferInsert;
