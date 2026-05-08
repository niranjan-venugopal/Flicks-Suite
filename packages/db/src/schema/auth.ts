import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  char,
  jsonb,
  index,
  pgEnum,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './platform.js';

// ─── Enums ────────────────────────────────────────────────────────────────────

export const authEventTypeEnum = pgEnum('auth_event_type', [
  'otp_requested',
  'otp_verified',
  'otp_failed',
  'magic_link_requested',
  'magic_link_consumed',
  'login_success',
  'login_failed',
  'logout',
  'token_refreshed',
  'token_revoked',
  'device_trusted',
  'device_revoked',
  'password_changed',
  'account_locked',
  'account_unlocked',
]);

// ─── auth_otps ────────────────────────────────────────────────────────────────

export const authOtps = pgTable(
  'auth_otps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    user_id: uuid('user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    otp_hash: char('otp_hash', { length: 64 }),
    magic_link_token: char('magic_link_token', { length: 64 }),
    attempt_count: integer('attempt_count').notNull().default(0),
    ip_address: text('ip_address'),
    user_agent: text('user_agent'),
    expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumed_at: timestamp('consumed_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('auth_otps_email_idx').on(t.email),
    index('auth_otps_magic_link_token_idx').on(t.magic_link_token),
    index('auth_otps_expires_at_idx').on(t.expires_at),
    index('auth_otps_user_id_idx').on(t.user_id),
  ],
);

// ─── refresh_tokens ───────────────────────────────────────────────────────────

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tenant_id: uuid('tenant_id'), // nullable — platform-level tokens won't have one
    token_hash: char('token_hash', { length: 64 }).notNull().unique(),
    device_id: text('device_id'),
    ip_address: text('ip_address'),
    user_agent: text('user_agent'),
    expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
    revoked_at: timestamp('revoked_at', { withTimezone: true }),
    rotated_to: uuid('rotated_to'), // points to the replacement token id
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    last_used_at: timestamp('last_used_at', { withTimezone: true }),
  },
  (t) => [
    index('refresh_tokens_user_id_idx').on(t.user_id),
    index('refresh_tokens_token_hash_idx').on(t.token_hash),
    index('refresh_tokens_tenant_id_idx').on(t.tenant_id),
    index('refresh_tokens_expires_at_idx').on(t.expires_at),
  ],
);

// ─── trusted_devices ──────────────────────────────────────────────────────────

export const trustedDevices = pgTable(
  'trusted_devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    device_id: text('device_id').notNull(),
    device_name: text('device_name'),
    ip_address: text('ip_address'),
    user_agent: text('user_agent'),
    last_used_at: timestamp('last_used_at', { withTimezone: true }),
    expires_at: timestamp('expires_at', { withTimezone: true }),
    revoked_at: timestamp('revoked_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    {
      name: 'trusted_devices_user_device_unique',
      columns: [t.user_id, t.device_id],
      unique: true,
    },
    index('trusted_devices_user_id_idx').on(t.user_id),
    index('trusted_devices_device_id_idx').on(t.device_id),
  ],
);

// ─── auth_events ──────────────────────────────────────────────────────────────

export const authEvents = pgTable(
  'auth_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email'),
    user_id: uuid('user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    event_type: authEventTypeEnum('event_type').notNull(),
    ip_address: text('ip_address'),
    user_agent: text('user_agent'),
    device_id: text('device_id'),
    metadata: jsonb('metadata'),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('auth_events_user_id_idx').on(t.user_id),
    index('auth_events_email_idx').on(t.email),
    index('auth_events_event_type_idx').on(t.event_type),
    index('auth_events_created_at_idx').on(t.created_at),
  ],
);

// ─── Relations ────────────────────────────────────────────────────────────────

export const authOtpsRelations = relations(authOtps, ({ one }) => ({
  user: one(users, {
    fields: [authOtps.user_id],
    references: [users.id],
  }),
}));

export const refreshTokensRelations = relations(refreshTokens, ({ one }) => ({
  user: one(users, {
    fields: [refreshTokens.user_id],
    references: [users.id],
  }),
}));

export const trustedDevicesRelations = relations(
  trustedDevices,
  ({ one }) => ({
    user: one(users, {
      fields: [trustedDevices.user_id],
      references: [users.id],
    }),
  }),
);

export const authEventsRelations = relations(authEvents, ({ one }) => ({
  user: one(users, {
    fields: [authEvents.user_id],
    references: [users.id],
  }),
}));

// ─── Types ────────────────────────────────────────────────────────────────────

export type AuthOtp = typeof authOtps.$inferSelect;
export type NewAuthOtp = typeof authOtps.$inferInsert;
export type RefreshToken = typeof refreshTokens.$inferSelect;
export type NewRefreshToken = typeof refreshTokens.$inferInsert;
export type TrustedDevice = typeof trustedDevices.$inferSelect;
export type NewTrustedDevice = typeof trustedDevices.$inferInsert;
export type AuthEvent = typeof authEvents.$inferSelect;
export type NewAuthEvent = typeof authEvents.$inferInsert;
