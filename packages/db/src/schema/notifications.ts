import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { tenants, users } from './platform';

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id').references(() => tenants.id, {
      onDelete: 'cascade',
    }),
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    message: text('message').notNull(),
    link_url: text('link_url'),
    read_at: timestamp('read_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('notifications_user_read_idx').on(t.user_id, t.read_at),
    index('notifications_user_created_idx').on(t.user_id, t.created_at),
    index('notifications_tenant_id_idx').on(t.tenant_id),
  ],
);

export const notificationsRelations = relations(notifications, ({ one }) => ({
  tenant: one(tenants, {
    fields: [notifications.tenant_id],
    references: [tenants.id],
  }),
  user: one(users, {
    fields: [notifications.user_id],
    references: [users.id],
  }),
}));

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;

// ─── notification_preferences (PRD §9.3) ──────────────────────────────────────
// Per-user, per-event, per-channel toggle. Absence of a row means "default on"
// (resolved in NotificationsService). WhatsApp/SMS channels are Phase 2.

export const notificationPreferences = pgTable(
  'notification_preferences',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    event_type: text('event_type').notNull(),
    channel: text('channel').notNull(), // 'in_app' | 'email'
    enabled: boolean('enabled').notNull().default(true),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('notification_preferences_user_event_channel_unique').on(
      t.user_id,
      t.event_type,
      t.channel,
    ),
    index('notification_preferences_user_idx').on(t.user_id),
  ],
);

export const notificationPreferencesRelations = relations(
  notificationPreferences,
  ({ one }) => ({
    user: one(users, {
      fields: [notificationPreferences.user_id],
      references: [users.id],
    }),
  }),
);

export type NotificationPreference =
  typeof notificationPreferences.$inferSelect;
export type NewNotificationPreference =
  typeof notificationPreferences.$inferInsert;
