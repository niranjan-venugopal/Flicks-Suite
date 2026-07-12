import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  char,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tenants, users } from './platform';

// ─── Directory kernel (PRD v5 §3 / 0031) ──────────────────────────────────────
// Shared people/companies. CRM presents these as Contacts/Companies; Invoicing
// links to them from `customers`. Tenant-isolated, soft-deleted.

export const directoryCompanies = pgTable(
  'directory_companies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    domain: text('domain'), // citext in DB, normalized (no www)
    website: text('website'),
    industry: text('industry'),
    size_band: text('size_band'),
    phone: text('phone'),
    address_line1: text('address_line1'),
    address_line2: text('address_line2'),
    city: text('city'),
    state: text('state'),
    postal_code: text('postal_code'),
    country_code: char('country_code', { length: 2 }),
    owner_user_id: uuid('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
    source: text('source'), // manual|import|form|api|invoicing_backfill
    last_activity_at: timestamp('last_activity_at', { withTimezone: true }),
    custom: jsonb('custom').notNull().default({}),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    created_by: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updated_by: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    deleted_at: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('uq_dir_company_domain')
      .on(t.tenant_id, t.domain)
      .where(sql`${t.domain} IS NOT NULL AND ${t.deleted_at} IS NULL`),
    index('idx_dir_company_tenant').on(t.tenant_id).where(sql`${t.deleted_at} IS NULL`),
  ],
);

export const directoryPeople = pgTable(
  'directory_people',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    first_name: text('first_name'),
    last_name: text('last_name'),
    // display_name is GENERATED ALWAYS in the DB — read-only here.
    display_name: text('display_name'),
    email: text('email'), // citext in DB
    secondary_emails: text('secondary_emails').array(),
    phone: text('phone'), // E.164
    secondary_phones: text('secondary_phones').array(),
    title: text('title'),
    company_id: uuid('company_id').references(() => directoryCompanies.id, { onDelete: 'set null' }),
    owner_user_id: uuid('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
    source: text('source'),
    last_activity_at: timestamp('last_activity_at', { withTimezone: true }),
    custom: jsonb('custom').notNull().default({}),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    created_by: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updated_by: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    deleted_at: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('idx_dir_people_email')
      .on(t.tenant_id, t.email)
      .where(sql`${t.email} IS NOT NULL AND ${t.deleted_at} IS NULL`),
    index('idx_dir_people_company').on(t.tenant_id, t.company_id),
  ],
);
