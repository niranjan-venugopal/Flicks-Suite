import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';
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
