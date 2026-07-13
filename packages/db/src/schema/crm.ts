import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  char,
  boolean,
  integer,
  smallint,
  numeric,
  date,
  bigint,
  index,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tenants, users } from './platform';
import { items } from './invoicing';

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

// ─── Deals core (PRD v5 §4 / 0032) ────────────────────────────────────────────

export const pipelines = pgTable(
  'pipelines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    display_order: smallint('display_order').notNull().default(0),
    is_default: boolean('is_default').notNull().default(false),
    // §19.3 — when a quote generated from a deal in this pipeline is accepted,
    // auto-advance the deal to this stage (NULL = leave it where it is).
    quote_accepted_stage_id: uuid('quote_accepted_stage_id'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deleted_at: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [index('idx_pipelines_tenant').on(t.tenant_id).where(sql`${t.deleted_at} IS NULL`)],
);

export const pipelineStages = pgTable(
  'pipeline_stages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    pipeline_id: uuid('pipeline_id').notNull().references(() => pipelines.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    display_order: smallint('display_order').notNull(),
    win_probability: smallint('win_probability').notNull().default(0),
    rotting_days: smallint('rotting_days'),
    stage_type: text('stage_type').notNull().default('open'), // open | won | lost
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deleted_at: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [index('idx_stages_pipeline').on(t.tenant_id, t.pipeline_id, t.display_order)],
);

export const deals = pgTable(
  'deals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    pipeline_id: uuid('pipeline_id').notNull().references(() => pipelines.id),
    stage_id: uuid('stage_id').notNull().references(() => pipelineStages.id),
    title: text('title').notNull(),
    company_id: uuid('company_id').references(() => directoryCompanies.id),
    primary_person_id: uuid('primary_person_id').references(() => directoryPeople.id),
    owner_user_id: uuid('owner_user_id').notNull().references(() => users.id),
    value_amount: numeric('value_amount', { precision: 15, scale: 2 }).notNull().default('0'),
    currency: char('currency', { length: 3 }).notNull(),
    fx_rate_to_base: numeric('fx_rate_to_base', { precision: 15, scale: 6 }).notNull().default('1'),
    value_base_amount: numeric('value_base_amount', { precision: 15, scale: 2 }).notNull().default('0'),
    expected_close_date: date('expected_close_date'),
    status: text('status').notNull().default('open'), // open | won | lost
    won_at: timestamp('won_at', { withTimezone: true }),
    lost_at: timestamp('lost_at', { withTimezone: true }),
    lost_reason_id: uuid('lost_reason_id'),
    lost_reason_note: text('lost_reason_note'),
    source: text('source'),
    score: integer('score'),
    stage_entered_at: timestamp('stage_entered_at', { withTimezone: true }).notNull().defaultNow(),
    next_activity_at: timestamp('next_activity_at', { withTimezone: true }),
    last_activity_at: timestamp('last_activity_at', { withTimezone: true }),
    invoice_id: uuid('invoice_id'),
    quote_id: uuid('quote_id'),
    custom: jsonb('custom').notNull().default({}),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    created_by: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updated_by: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    deleted_at: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('idx_deals_owner').on(t.tenant_id, t.owner_user_id, t.status),
    index('idx_deals_close').on(t.tenant_id, t.expected_close_date).where(sql`${t.status} = 'open'`),
  ],
);

export const dealPeople = pgTable(
  'deal_people',
  {
    deal_id: uuid('deal_id').notNull().references(() => deals.id, { onDelete: 'cascade' }),
    person_id: uuid('person_id').notNull().references(() => directoryPeople.id, { onDelete: 'cascade' }),
    tenant_id: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    role: text('role'),
  },
  (t) => [primaryKey({ columns: [t.deal_id, t.person_id] })],
);

export const dealStageHistory = pgTable(
  'deal_stage_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    deal_id: uuid('deal_id').notNull().references(() => deals.id, { onDelete: 'cascade' }),
    from_stage_id: uuid('from_stage_id'),
    to_stage_id: uuid('to_stage_id').notNull(),
    changed_by: uuid('changed_by').references(() => users.id),
    changed_at: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
    seconds_in_previous_stage: bigint('seconds_in_previous_stage', { mode: 'number' }),
  },
  (t) => [index('idx_stage_history_deal').on(t.tenant_id, t.deal_id, t.changed_at)],
);

export const lostReasons = pgTable('lost_reasons', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenant_id: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  display_order: smallint('display_order').default(0),
  archived: boolean('archived').default(false),
});

export const dealProducts = pgTable(
  'deal_products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    deal_id: uuid('deal_id').notNull().references(() => deals.id, { onDelete: 'cascade' }),
    item_id: uuid('item_id').references(() => items.id),
    name: text('name').notNull(),
    quantity: numeric('quantity', { precision: 15, scale: 4 }).notNull().default('1'),
    unit_price: numeric('unit_price', { precision: 15, scale: 2 }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    discount_pct: numeric('discount_pct', { precision: 5, scale: 2 }).default('0'),
    line_total: numeric('line_total', { precision: 15, scale: 2 }).notNull(),
    display_order: smallint('display_order').default(0),
  },
  (t) => [index('idx_deal_products_deal').on(t.tenant_id, t.deal_id)],
);

// ─── FX rates (global reference; §12.1) ───────────────────────────────────────
export const fxRates = pgTable(
  'fx_rates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    base: char('base', { length: 3 }).notNull().default('USD'),
    quote: char('quote', { length: 3 }).notNull(),
    rate: numeric('rate', { precision: 18, scale: 8 }).notNull(),
    as_of: date('as_of').notNull(),
    fetched_at: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_fx_rate_day').on(t.base, t.quote, t.as_of),
    index('idx_fx_rate_latest').on(t.quote, t.as_of),
  ],
);

// ─── Tags (§19.1) ─────────────────────────────────────────────────────────────
export const tags = pgTable('tags', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenant_id: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  color: text('color'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const recordTags = pgTable(
  'record_tags',
  {
    tenant_id: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    tag_id: uuid('tag_id').notNull().references(() => tags.id, { onDelete: 'cascade' }),
    object_type: text('object_type').notNull(), // person | company | deal | lead
    object_id: uuid('object_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenant_id, t.tag_id, t.object_type, t.object_id] }),
    index('idx_record_tags_object').on(t.tenant_id, t.object_type, t.object_id),
  ],
);

// ─── Custom fields, saved views, record files (§9.1-9.2, §19.2 / 0033) ────────

export const customFieldDefs = pgTable(
  'custom_field_defs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    object_type: text('object_type').notNull(), // deal | person | company | lead
    key: text('key').notNull(),
    label: text('label').notNull(),
    field_type: text('field_type').notNull(), // text|number|date|select|multiselect|checkbox|url
    options: jsonb('options').notNull().default([]),
    is_required: boolean('is_required').notNull().default(false),
    display_order: smallint('display_order').notNull().default(0),
    archived: boolean('archived').notNull().default(false),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_custom_field_key').on(t.tenant_id, t.object_type, t.key).where(sql`${t.archived} = false`),
  ],
);

export const savedViews = pgTable(
  'saved_views',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    object_type: text('object_type').notNull(),
    name: text('name').notNull(),
    owner_user_id: uuid('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
    is_shared: boolean('is_shared').notNull().default(false),
    filters: jsonb('filters').notNull().default({}),
    sort: jsonb('sort').notNull().default({}),
    columns: jsonb('columns').notNull().default([]),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_saved_views_scope').on(t.tenant_id, t.object_type)],
);

export const recordFiles = pgTable(
  'record_files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    object_type: text('object_type').notNull(),
    object_id: uuid('object_id').notNull(),
    file_name: text('file_name').notNull(),
    mime_type: text('mime_type').notNull(),
    size_bytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    storage_key: text('storage_key').notNull(),
    uploaded_by: uuid('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deleted_at: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [index('idx_record_files_object').on(t.tenant_id, t.object_type, t.object_id).where(sql`${t.deleted_at} IS NULL`)],
);
