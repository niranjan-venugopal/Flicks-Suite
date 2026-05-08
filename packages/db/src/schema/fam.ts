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
  jsonb,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { tenants, users } from './platform';

// ─── Enums ────────────────────────────────────────────────────────────────────

export const subscriptionStatusEnum = pgEnum('subscription_status', [
  'trialing',
  'active',
  'past_due',
  'canceled',
  'paused',
  'unpaid',
]);

export const billingCycleEnum = pgEnum('billing_cycle', [
  'monthly',
  'quarterly',
  'annual',
]);

export const healthSignalEnum = pgEnum('health_signal', [
  'healthy',
  'at_risk',
  'churning',
  'expanding',
  'new',
]);

// ─── audit_log_platform ────────────────────────────────────────────────────────

export const auditLogPlatform = pgTable(
  'audit_log_platform',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actor_user_id: uuid('actor_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    action: text('action').notNull(),
    target_tenant_id: uuid('target_tenant_id').references(() => tenants.id, {
      onDelete: 'set null',
    }),
    target_user_id: uuid('target_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    metadata: jsonb('metadata'),
    ip_address: text('ip_address'),
    user_agent: text('user_agent'),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('audit_log_platform_actor_user_id_idx').on(t.actor_user_id),
    index('audit_log_platform_action_idx').on(t.action),
    index('audit_log_platform_target_tenant_id_idx').on(t.target_tenant_id),
    index('audit_log_platform_created_at_idx').on(t.created_at),
  ],
);

// ─── audit_log ────────────────────────────────────────────────────────────────

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    actor_user_id: uuid('actor_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    actor_employee_id: uuid('actor_employee_id'), // FK to employees — avoid circular dep
    action: text('action').notNull(),
    resource_type: text('resource_type').notNull(),
    resource_id: uuid('resource_id'),
    before_state: jsonb('before_state'),
    after_state: jsonb('after_state'),
    ip_address: text('ip_address'),
    user_agent: text('user_agent'),
    metadata: jsonb('metadata'),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('audit_log_tenant_id_idx').on(t.tenant_id),
    index('audit_log_actor_user_id_idx').on(t.actor_user_id),
    index('audit_log_action_idx').on(t.action),
    index('audit_log_resource_type_idx').on(t.resource_type),
    index('audit_log_resource_id_idx').on(t.resource_id),
    index('audit_log_created_at_idx').on(t.created_at),
  ],
);

// ─── subscriptions ────────────────────────────────────────────────────────────

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .unique()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    plan_code: text('plan_code').notNull(), // e.g. starter, growth, enterprise
    status: subscriptionStatusEnum('status').notNull().default('trialing'),
    per_user_price: real('per_user_price').notNull().default(0), // INR per user per month
    user_count: integer('user_count').notNull().default(0),
    mrr_amount: real('mrr_amount').notNull().default(0), // per_user_price * user_count
    billing_cycle: billingCycleEnum('billing_cycle').notNull().default('monthly'),
    trial_ends_at: timestamp('trial_ends_at', { withTimezone: true }),
    current_period_start: timestamp('current_period_start', {
      withTimezone: true,
    }),
    current_period_end: timestamp('current_period_end', {
      withTimezone: true,
    }),
    razorpay_subscription_id: text('razorpay_subscription_id'),
    razorpay_customer_id: text('razorpay_customer_id'),
    cancel_at_period_end: boolean('cancel_at_period_end')
      .notNull()
      .default(false),
    canceled_at: timestamp('canceled_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('subscriptions_status_idx').on(t.status),
    index('subscriptions_plan_code_idx').on(t.plan_code),
    index('subscriptions_current_period_end_idx').on(t.current_period_end),
    index('subscriptions_razorpay_subscription_id_idx').on(
      t.razorpay_subscription_id,
    ),
  ],
);

// ─── subscription_events ──────────────────────────────────────────────────────

export const subscriptionEvents = pgTable(
  'subscription_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    subscription_id: uuid('subscription_id')
      .notNull()
      .references(() => subscriptions.id, { onDelete: 'cascade' }),
    event_type: text('event_type').notNull(), // e.g. subscription.created, payment.success
    metadata: jsonb('metadata'),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('subscription_events_tenant_id_idx').on(t.tenant_id),
    index('subscription_events_subscription_id_idx').on(t.subscription_id),
    index('subscription_events_event_type_idx').on(t.event_type),
    index('subscription_events_created_at_idx').on(t.created_at),
  ],
);

// ─── tenant_health_snapshots ──────────────────────────────────────────────────

export const tenantHealthSnapshots = pgTable(
  'tenant_health_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    snapshot_date: date('snapshot_date').notNull(),
    health_score: real('health_score'), // 0-100
    active_users_7d: integer('active_users_7d').notNull().default(0),
    active_users_30d: integer('active_users_30d').notNull().default(0),
    attendance_compliance: real('attendance_compliance'), // 0-1 ratio
    feature_adoption_score: real('feature_adoption_score'), // 0-100
    support_tickets_open: integer('support_tickets_open').notNull().default(0),
    signal: healthSignalEnum('signal').notNull().default('new'),
    computed_at: timestamp('computed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('tenant_health_snapshots_tenant_date_unique').on(
      t.tenant_id,
      t.snapshot_date,
    ),
    index('tenant_health_snapshots_tenant_id_idx').on(t.tenant_id),
    index('tenant_health_snapshots_snapshot_date_idx').on(t.snapshot_date),
    index('tenant_health_snapshots_signal_idx').on(t.signal),
  ],
);

// ─── feature_flags ────────────────────────────────────────────────────────────

export const featureFlags = pgTable(
  'feature_flags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    flag_key: text('flag_key').notNull().unique(),
    description: text('description'),
    is_enabled_globally: boolean('is_enabled_globally').notNull().default(false),
    enabled_tenant_ids: uuid('enabled_tenant_ids').array().notNull().default([]),
    rollout_percentage: integer('rollout_percentage').notNull().default(0), // 0-100
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('feature_flags_flag_key_idx').on(t.flag_key)],
);

// ─── tenant_cohorts ───────────────────────────────────────────────────────────

export const tenantCohorts = pgTable(
  'tenant_cohorts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull().unique(),
    description: text('description'),
    tenant_ids: uuid('tenant_ids').array().notNull().default([]),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('tenant_cohorts_name_idx').on(t.name)],
);

// ─── Relations ────────────────────────────────────────────────────────────────

export const auditLogPlatformRelations = relations(
  auditLogPlatform,
  ({ one }) => ({
    actorUser: one(users, {
      fields: [auditLogPlatform.actor_user_id],
      references: [users.id],
    }),
    targetTenant: one(tenants, {
      fields: [auditLogPlatform.target_tenant_id],
      references: [tenants.id],
    }),
    targetUser: one(users, {
      fields: [auditLogPlatform.target_user_id],
      references: [users.id],
    }),
  }),
);

export const auditLogRelations = relations(auditLog, ({ one }) => ({
  tenant: one(tenants, {
    fields: [auditLog.tenant_id],
    references: [tenants.id],
  }),
  actorUser: one(users, {
    fields: [auditLog.actor_user_id],
    references: [users.id],
  }),
}));

export const subscriptionsRelations = relations(
  subscriptions,
  ({ one, many }) => ({
    tenant: one(tenants, {
      fields: [subscriptions.tenant_id],
      references: [tenants.id],
    }),
    events: many(subscriptionEvents),
  }),
);

export const subscriptionEventsRelations = relations(
  subscriptionEvents,
  ({ one }) => ({
    tenant: one(tenants, {
      fields: [subscriptionEvents.tenant_id],
      references: [tenants.id],
    }),
    subscription: one(subscriptions, {
      fields: [subscriptionEvents.subscription_id],
      references: [subscriptions.id],
    }),
  }),
);

export const tenantHealthSnapshotsRelations = relations(
  tenantHealthSnapshots,
  ({ one }) => ({
    tenant: one(tenants, {
      fields: [tenantHealthSnapshots.tenant_id],
      references: [tenants.id],
    }),
  }),
);

// ─── Types ────────────────────────────────────────────────────────────────────

export type AuditLogPlatform = typeof auditLogPlatform.$inferSelect;
export type NewAuditLogPlatform = typeof auditLogPlatform.$inferInsert;
export type AuditLog = typeof auditLog.$inferSelect;
export type NewAuditLog = typeof auditLog.$inferInsert;
export type Subscription = typeof subscriptions.$inferSelect;
export type NewSubscription = typeof subscriptions.$inferInsert;
export type SubscriptionEvent = typeof subscriptionEvents.$inferSelect;
export type NewSubscriptionEvent = typeof subscriptionEvents.$inferInsert;
export type TenantHealthSnapshot = typeof tenantHealthSnapshots.$inferSelect;
export type NewTenantHealthSnapshot = typeof tenantHealthSnapshots.$inferInsert;
export type FeatureFlag = typeof featureFlags.$inferSelect;
export type NewFeatureFlag = typeof featureFlags.$inferInsert;
export type TenantCohort = typeof tenantCohorts.$inferSelect;
export type NewTenantCohort = typeof tenantCohorts.$inferInsert;
