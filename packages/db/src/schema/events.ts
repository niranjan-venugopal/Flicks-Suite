import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  integer,
  smallint,
  bigint,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tenants, users } from './platform';

// ─── domain_events — transactional outbox (PRD v5 §2.2 / 0030) ────────────────
// State changes insert here in the SAME transaction (app role has INSERT-only,
// tenant-scoped). The worker-side dispatcher drains undispatched rows to the
// BullMQ 'domain-events' queue and stamps dispatched_at (service role).
// Payloads: ids/enums/amounts only — never PII or message bodies.

export const domainEvents = pgTable(
  'domain_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id').references(() => tenants.id, {
      onDelete: 'cascade',
    }), // NULL = platform event
    event_name: text('event_name').notNull(),
    actor_user_id: uuid('actor_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    payload: jsonb('payload').notNull().default({}),
    occurred_at: timestamp('occurred_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    dispatched_at: timestamp('dispatched_at', { withTimezone: true }),
    dispatch_attempts: smallint('dispatch_attempts').notNull().default(0),
    // FSE (PRD v6 §3.2 / 0039): globally monotonic delta cursor. Assigned at
    // INSERT via the domain_events_sync_seq sequence (declared as the default
    // so inserts may omit it); per-tenant delta queries filter
    // (tenant_id, sync_seq). Number mode is safe well past any realistic
    // event volume (< 2^53).
    sync_seq: bigint('sync_seq', { mode: 'number' })
      .notNull()
      .default(sql`nextval('domain_events_sync_seq')`),
  },
  (t) => [
    index('idx_de_tenant_name_time').on(t.tenant_id, t.event_name, t.occurred_at),
    uniqueIndex('uq_de_sync_seq').on(t.sync_seq),
    index('idx_de_tenant_seq').on(t.tenant_id, t.sync_seq),
  ],
);

// ─── api_keys — public API (PRD v5 §11 / 0030) ────────────────────────────────
// Service-layer only: the app role can't read hashes. Key format:
// 'flk_live_' + 32 random bytes base64url; SHA-256 hex stored; prefix shown.

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    key_hash: text('key_hash').notNull().unique(),
    key_prefix: text('key_prefix').notNull(),
    scopes: text('scopes').array().notNull().default([]),
    last_used_at: timestamp('last_used_at', { withTimezone: true }),
    revoked_at: timestamp('revoked_at', { withTimezone: true }),
    created_by: uuid('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('idx_api_keys_tenant').on(t.tenant_id, t.created_at)],
);

// ─── webhook_endpoints / webhook_deliveries (PRD v5 §11 / 0030) ───────────────

export const webhookEndpoints = pgTable(
  'webhook_endpoints',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    secret_encrypted: text('secret_encrypted').notNull(),
    events: text('events').array().notNull().default([]),
    active: boolean('active').notNull().default(true),
    consecutive_failures: integer('consecutive_failures').notNull().default(0),
    disabled_at: timestamp('disabled_at', { withTimezone: true }),
    disabled_reason: text('disabled_reason'),
    created_by: uuid('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    deleted_at: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [index('idx_webhook_endpoints_tenant').on(t.tenant_id)],
);

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    endpoint_id: uuid('endpoint_id')
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: 'cascade' }),
    event_id: uuid('event_id'),
    event_name: text('event_name').notNull(),
    status: text('status').notNull().default('pending'), // pending | success | failed | exhausted
    attempts: smallint('attempts').notNull().default(0),
    last_status_code: integer('last_status_code'),
    last_error: text('last_error'),
    delivered_at: timestamp('delivered_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('idx_webhook_deliveries_endpoint').on(t.endpoint_id, t.created_at),
    index('idx_webhook_deliveries_tenant').on(t.tenant_id, t.created_at),
  ],
);
