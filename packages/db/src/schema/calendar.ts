import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  pgEnum,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { tenants, users } from './platform';
import { employees } from './employees';

// ─── Enums (0001) ─────────────────────────────────────────────────────────────

export const calendarEventTypeEnum = pgEnum('calendar_event_type', [
  'leave',
  'holiday',
  'attendance',
  'birthday',
  'anniversary',
  'company_event',
]);

export const calendarVisibilityEnum = pgEnum('calendar_visibility', [
  'private',
  'team',
  'company',
]);

/** Round J — meeting providers a user-authored event can carry. */
export const MEETING_PROVIDERS = ['none', 'teams', 'google_meet', 'other'] as const;
export type MeetingProvider = (typeof MEETING_PROVIDERS)[number];

/** Round J — attendee RSVP states. */
export const ATTENDEE_RESPONSES = ['pending', 'accepted', 'declined', 'tentative'] as const;
export type AttendeeResponse = (typeof ATTENDEE_RESPONSES)[number];

// ─── calendar_events ──────────────────────────────────────────────────────────
//
// 0001 created this as a projection cache that nothing ever wrote. Round J
// (migration 0061) turned it into the first-class record for user-authored
// events and meetings: `kind` carries event | meeting (the 0001 enum column is
// kept and set to 'company_event' for these rows), `organizer_user_id` owns
// the row, `meeting_provider` / `meeting_url` are the door for auto-generated
// Teams / Google Meet links once accounts are connected, `cancelled_at` is the
// soft cancel. Mirrors 0061 exactly, indexes included, so drizzle-kit never
// proposes dropping them.

export const calendarEvents = pgTable(
  'calendar_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    event_type: calendarEventTypeEnum('event_type').notNull(),
    source_id: uuid('source_id'), // id of the originating record (leave_request, holiday, etc.)
    employee_id: uuid('employee_id').references(() => employees.id, {
      onDelete: 'cascade',
    }),
    title: text('title').notNull(),
    description: text('description'),
    start_at: timestamp('start_at', { withTimezone: true }).notNull(),
    end_at: timestamp('end_at', { withTimezone: true }).notNull(),
    is_all_day: boolean('is_all_day').notNull().default(false),
    visibility: calendarVisibilityEnum('visibility')
      .notNull()
      .default('company'),
    color: text('color'),
    // Round J (0061)
    kind: text('kind').notNull().default('event'), // event | meeting
    organizer_user_id: uuid('organizer_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    location: text('location'),
    timezone: text('timezone').notNull().default('Asia/Kolkata'),
    meeting_provider: text('meeting_provider').notNull().default('none'), // none | teams | google_meet | other
    meeting_url: text('meeting_url'),
    created_by: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updated_by: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    cancelled_at: timestamp('cancelled_at', { withTimezone: true }),
  },
  (t) => [
    index('calendar_events_tenant_id_idx').on(t.tenant_id),
    index('calendar_events_employee_id_idx').on(t.employee_id),
    index('calendar_events_event_type_idx').on(t.event_type),
    index('calendar_events_start_at_idx').on(t.start_at),
    index('calendar_events_end_at_idx').on(t.end_at),
    // 0061 — the week/day/month range scan and the organizer list.
    index('idx_calendar_events_tenant_range')
      .on(t.tenant_id, t.start_at, t.end_at)
      .where(sql`${t.cancelled_at} IS NULL`),
    index('idx_calendar_events_organizer')
      .on(t.tenant_id, t.organizer_user_id, t.start_at)
      .where(sql`${t.cancelled_at} IS NULL`),
  ],
);

// ─── calendar_event_attendees (0061) ──────────────────────────────────────────

export const calendarEventAttendees = pgTable(
  'calendar_event_attendees',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    event_id: uuid('event_id')
      .notNull()
      .references(() => calendarEvents.id, { onDelete: 'cascade' }),
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    is_optional: boolean('is_optional').notNull().default(false),
    response: text('response').notNull().default('pending'), // pending | accepted | declined | tentative
    responded_at: timestamp('responded_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('calendar_event_attendees_event_id_user_id_key').on(t.event_id, t.user_id),
    index('idx_calendar_attendees_user').on(t.tenant_id, t.user_id),
    index('idx_calendar_attendees_event').on(t.tenant_id, t.event_id),
  ],
);

// ─── Relations ────────────────────────────────────────────────────────────────

export const calendarEventsRelations = relations(calendarEvents, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [calendarEvents.tenant_id],
    references: [tenants.id],
  }),
  employee: one(employees, {
    fields: [calendarEvents.employee_id],
    references: [employees.id],
  }),
  organizer: one(users, {
    fields: [calendarEvents.organizer_user_id],
    references: [users.id],
  }),
  attendees: many(calendarEventAttendees),
}));

export const calendarEventAttendeesRelations = relations(calendarEventAttendees, ({ one }) => ({
  tenant: one(tenants, {
    fields: [calendarEventAttendees.tenant_id],
    references: [tenants.id],
  }),
  event: one(calendarEvents, {
    fields: [calendarEventAttendees.event_id],
    references: [calendarEvents.id],
  }),
  user: one(users, {
    fields: [calendarEventAttendees.user_id],
    references: [users.id],
  }),
}));

// ─── Types ────────────────────────────────────────────────────────────────────

export type CalendarEvent = typeof calendarEvents.$inferSelect;
export type NewCalendarEvent = typeof calendarEvents.$inferInsert;
export type CalendarEventAttendee = typeof calendarEventAttendees.$inferSelect;
export type NewCalendarEventAttendee = typeof calendarEventAttendees.$inferInsert;
