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
    import_batch_id: uuid('import_batch_id'),
    merged_into_id: uuid('merged_into_id'),
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
    import_batch_id: uuid('import_batch_id'),
    merged_into_id: uuid('merged_into_id'),
    email: text('email'), // citext in DB
    secondary_emails: text('secondary_emails').array(),
    phone: text('phone'), // E.164
    secondary_phones: text('secondary_phones').array(),
    title: text('title'),
    // §19.5 do-not-contact: hard block on compose/sequences; auto-set on
    // bounce/complaint; badge on the person.
    email_do_not_contact: boolean('email_do_not_contact').notNull().default(false),
    email_do_not_contact_reason: text('email_do_not_contact_reason'),
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
    // 360° detail pages: deals for a contact / company (deals.service.listForRef).
    index('idx_deals_person').on(t.tenant_id, t.primary_person_id).where(sql`${t.deleted_at} IS NULL`),
    index('idx_deals_company').on(t.tenant_id, t.company_id).where(sql`${t.deleted_at} IS NULL`),
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

// ─── Activities (PRD v5 §6 / 0034) ────────────────────────────────────────────

export const activities = pgTable(
  'activities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    type: text('type').notNull(), // task | call | meeting | note
    subject: text('subject').notNull(),
    body: text('body'),
    deal_id: uuid('deal_id').references(() => deals.id, { onDelete: 'cascade' }),
    person_id: uuid('person_id').references(() => directoryPeople.id, { onDelete: 'set null' }),
    company_id: uuid('company_id').references(() => directoryCompanies.id, { onDelete: 'set null' }),
    assignee_user_id: uuid('assignee_user_id').notNull().references(() => users.id),
    due_at: timestamp('due_at', { withTimezone: true }),
    completed_at: timestamp('completed_at', { withTimezone: true }),
    completed_by: uuid('completed_by').references(() => users.id),
    outcome: text('outcome'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    created_by: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    deleted_at: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('idx_activities_assignee_due').on(t.tenant_id, t.assignee_user_id, t.due_at).where(sql`${t.completed_at} IS NULL AND ${t.deleted_at} IS NULL`),
    index('idx_activities_deal').on(t.tenant_id, t.deal_id, t.due_at).where(sql`${t.deleted_at} IS NULL`),
    // 360° detail pages: activity timeline for a contact / company (activities.service.listForRef).
    index('idx_activities_person').on(t.tenant_id, t.person_id).where(sql`${t.deleted_at} IS NULL`),
    index('idx_activities_company').on(t.tenant_id, t.company_id).where(sql`${t.deleted_at} IS NULL`),
  ],
);

export const activityMentions = pgTable(
  'activity_mentions',
  {
    tenant_id: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    activity_id: uuid('activity_id').notNull().references(() => activities.id, { onDelete: 'cascade' }),
    mentioned_user_id: uuid('mentioned_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.activity_id, t.mentioned_user_id] })],
);

// ─── Email Phase A (PRD v5 §7.1 / 0035) ───────────────────────────────────────

export const emailTemplates = pgTable(
  'email_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    subject: text('subject').notNull(),
    body_html: text('body_html').notNull(),
    created_by: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    archived: boolean('archived').notNull().default(false),
  },
);

export const emailMessages = pgTable(
  'email_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    direction: text('direction').notNull(), // out | in
    status: text('status').notNull().default('sent'),
    provider_id: text('provider_id'),
    from_email: text('from_email'),
    to_email: text('to_email').notNull(),
    subject: text('subject').notNull(),
    body_html: text('body_html'),
    person_id: uuid('person_id').references(() => directoryPeople.id, { onDelete: 'set null' }),
    deal_id: uuid('deal_id').references(() => deals.id, { onDelete: 'set null' }),
    sender_user_id: uuid('sender_user_id').references(() => users.id, { onDelete: 'set null' }),
    open_token: text('open_token').unique(),
    open_count: integer('open_count').notNull().default(0),
    click_count: integer('click_count').notNull().default(0),
    tracking: boolean('tracking').notNull().default(false),
    sequence_enrollment_id: uuid('sequence_enrollment_id'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_email_messages_deal').on(t.tenant_id, t.deal_id, t.created_at),
    index('idx_email_messages_person').on(t.tenant_id, t.person_id, t.created_at),
    index('idx_email_messages_provider').on(t.provider_id),
    // Per-user send throttle (sequences) + activity leaderboard (reports) both
    // scan by sender over a time window.
    index('idx_email_messages_sender').on(t.sender_user_id, t.created_at),
  ],
);

export const emailLinks = pgTable(
  'email_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    message_id: uuid('message_id').notNull().references(() => emailMessages.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    url: text('url').notNull(),
    click_count: integer('click_count').notNull().default(0),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_email_links_message').on(t.tenant_id, t.message_id)],
);

export const emailEvents = pgTable(
  'email_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    message_id: uuid('message_id').notNull().references(() => emailMessages.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    meta: jsonb('meta').notNull().default({}),
    occurred_at: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_email_events_message').on(t.tenant_id, t.message_id, t.occurred_at)],
);

export const sequences = pgTable('sequences', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenant_id: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  is_active: boolean('is_active').notNull().default(true),
  send_window_start: text('send_window_start').notNull().default('09:00'),
  send_window_end: text('send_window_end').notNull().default('18:00'),
  timezone: text('timezone').notNull().default('Asia/Kolkata'),
  created_by: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sequenceSteps = pgTable(
  'sequence_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    sequence_id: uuid('sequence_id').notNull().references(() => sequences.id, { onDelete: 'cascade' }),
    step_order: smallint('step_order').notNull(),
    wait_days: smallint('wait_days').notNull().default(0),
    subject: text('subject').notNull(),
    body_html: text('body_html').notNull(),
  },
  (t) => [index('idx_sequence_steps').on(t.tenant_id, t.sequence_id, t.step_order)],
);

export const sequenceEnrollments = pgTable(
  'sequence_enrollments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    sequence_id: uuid('sequence_id').notNull().references(() => sequences.id, { onDelete: 'cascade' }),
    person_id: uuid('person_id').notNull().references(() => directoryPeople.id, { onDelete: 'cascade' }),
    deal_id: uuid('deal_id').references(() => deals.id, { onDelete: 'set null' }),
    enrolled_by: uuid('enrolled_by').references(() => users.id, { onDelete: 'set null' }),
    current_step: smallint('current_step').notNull().default(0),
    next_send_at: timestamp('next_send_at', { withTimezone: true }),
    status: text('status').notNull().default('active'),
    exit_reason: text('exit_reason'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_sequence_enrollments_due').on(t.tenant_id, t.next_send_at).where(sql`${t.status} = 'active'`)],
);

export const tenantInboundAddresses = pgTable('tenant_inbound_addresses', {
  tenant_id: uuid('tenant_id').primaryKey().references(() => tenants.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const connectedEmailAccounts = pgTable(
  'connected_email_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    user_id: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    email: text('email').notNull(),
    access_token_enc: text('access_token_enc'),
    refresh_token_enc: text('refresh_token_enc'),
    status: text('status').notNull().default('pending'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('uq_connected_account').on(t.tenant_id, t.user_id, t.provider)],
);

export const resendWebhookEvents = pgTable('resend_webhook_events', {
  id: text('id').primaryKey(),
  received_at: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
});

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

// ─── Automation & capture: leads, web forms, workflows (§5/§8 / 0036) ─────────

export const leads = pgTable(
  'leads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    first_name: text('first_name').notNull(),
    last_name: text('last_name'),
    company_name: text('company_name'),
    email: text('email'),
    phone: text('phone'),
    note: text('note'),
    source: text('source').notNull().default('manual'), // manual|api|import|email_in|form:<tag>
    score: integer('score').notNull().default(0),
    status: text('status').notNull().default('new'), // new|working|converted|discarded
    owner_user_id: uuid('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
    form_id: uuid('form_id'),
    utm: jsonb('utm').notNull().default({}),
    extra: jsonb('extra').notNull().default({}),
    import_batch_id: uuid('import_batch_id'),
    converted_person_id: uuid('converted_person_id').references(() => directoryPeople.id, { onDelete: 'set null' }),
    converted_company_id: uuid('converted_company_id').references(() => directoryCompanies.id, { onDelete: 'set null' }),
    converted_deal_id: uuid('converted_deal_id').references(() => deals.id, { onDelete: 'set null' }),
    deleted_at: timestamp('deleted_at', { withTimezone: true }), // 0053 — soft delete
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_leads_inbox').on(t.tenant_id, t.status, t.created_at.desc()),
    index('idx_leads_tenant_status_live')
      .on(t.tenant_id, t.status)
      .where(sql`${t.deleted_at} IS NULL`),
  ],
);

export const webForms = pgTable(
  'web_forms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    token: text('token').notNull().unique(),
    title: text('title').notNull().default('Talk to sales'),
    intro: text('intro'),
    fields: jsonb('fields').notNull().default([]), // [{key,label,type,required}]
    source_tag: text('source_tag').notNull().default('form'),
    assignment: text('assignment').notNull().default('round_robin'), // none|round_robin
    success_message: text('success_message').notNull().default("Thanks — we'll be in touch"),
    redirect_url: text('redirect_url'),
    active: boolean('active').notNull().default(true),
    created_by: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    deleted_at: timestamp('deleted_at', { withTimezone: true }), // 0053 — soft delete
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Partial (0053): a deleted form frees its name for reuse.
    uniqueIndex('uq_web_form_name')
      .on(t.tenant_id, sql`lower(${t.name})`)
      .where(sql`${t.deleted_at} IS NULL`),
  ],
);

export const formSubmissions = pgTable(
  'form_submissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    form_id: uuid('form_id').notNull().references(() => webForms.id, { onDelete: 'cascade' }),
    lead_id: uuid('lead_id').references(() => leads.id, { onDelete: 'set null' }),
    payload: jsonb('payload').notNull().default({}),
    utm: jsonb('utm').notNull().default({}),
    ip_hash: text('ip_hash'), // sha256(ip) — throttle key, never the raw IP
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_form_submissions').on(t.tenant_id, t.form_id, t.created_at.desc())],
);

export const workflows = pgTable(
  'workflows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    trigger: text('trigger').notNull(), // domain event name (crm.*)
    conditions: jsonb('conditions').notNull().default([]), // [{field,op,value}] AND-combined
    actions: jsonb('actions').notNull().default([]), // [{type,...config}] in order
    active: boolean('active').notNull().default(true),
    runs_count: integer('runs_count').notNull().default(0),
    last_run_at: timestamp('last_run_at', { withTimezone: true }),
    created_by: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_workflows_trigger').on(t.tenant_id, t.trigger).where(sql`${t.active} = true`)],
);

export const workflowRuns = pgTable(
  'workflow_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    workflow_id: uuid('workflow_id').notNull().references(() => workflows.id, { onDelete: 'cascade' }),
    event_id: text('event_id').notNull(), // domain_events.id that fired it
    subject_type: text('subject_type'), // deal|lead|activity|email
    subject_id: uuid('subject_id'),
    status: text('status').notNull().default('ok'), // ok|error|skipped
    steps: jsonb('steps').notNull().default([]), // [{label,status,error?}]
    depth: smallint('depth').notNull().default(0), // workflow-caused chain depth (loop guard)
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_workflow_run').on(t.workflow_id, t.event_id),
    index('idx_workflow_runs').on(t.tenant_id, t.created_at.desc()),
  ],
);

// ─── Reports/goals, import, sample data (§10, §19.6, C14/C22 / 0037) ─────────

export const salesGoals = pgTable(
  'sales_goals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    user_id: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }), // NULL = whole team
    period: text('period').notNull(), // 'YYYY-MM'
    target_base: numeric('target_base', { precision: 14, scale: 2 }).notNull(),
    created_by: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
);

export const importBatches = pgTable(
  'import_batches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    object_type: text('object_type').notNull(), // people|companies|leads
    file_name: text('file_name'),
    rows_read: integer('rows_read').notNull().default(0),
    rows_created: integer('rows_created').notNull().default(0),
    rows_updated: integer('rows_updated').notNull().default(0),
    rows_skipped: integer('rows_skipped').notNull().default(0),
    errors: jsonb('errors').notNull().default([]), // [{row, error}] first 200
    status: text('status').notNull().default('done'), // done|undone
    created_by: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    undone_at: timestamp('undone_at', { withTimezone: true }),
  },
  (t) => [index('idx_import_batches').on(t.tenant_id, t.created_at.desc())],
);

export const samplePacks = pgTable('sample_packs', {
  tenant_id: uuid('tenant_id').primaryKey().references(() => tenants.id, { onDelete: 'cascade' }),
  record_ids: jsonb('record_ids').notNull().default({}), // {table: [ids]}
  created_by: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
