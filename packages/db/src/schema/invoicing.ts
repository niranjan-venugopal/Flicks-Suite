/**
 * Invoicing module schema (PRD v3 §4.2 / §4.3).
 *
 * Follows the foundation conventions: UUID PK, tenant_id FK (cascade), tz
 * timestamps, created_by/updated_by, soft-delete where applicable, and
 * tenant-leading indexes. RLS is applied in the SQL migrations (§4.4), not here.
 *
 * Monetary columns use NUMERIC(15,2); rates NUMERIC(5,2); FX NUMERIC(15,6).
 * Status/type columns are TEXT with app-level validation (matching the PRD),
 * not pgEnums, since the value sets are large and evolve.
 */
import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  integer,
  smallint,
  numeric,
  jsonb,
  uniqueIndex,
  index,
  date,
  char,
  varchar,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { tenants, users } from './platform';

// ─── hsn_sac_codes (GLOBAL, no tenant_id, no RLS) ───────────────────────────────

export const hsnSacCodes = pgTable(
  'hsn_sac_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull().unique(),
    type: text('type').notNull(), // HSN | SAC
    description: text('description').notNull(),
    default_gst_rate: numeric('default_gst_rate', { precision: 5, scale: 2 }),
    category: text('category'),
    popularity: integer('popularity').notNull().default(0),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('hsn_sac_codes_type_idx').on(t.type),
    index('hsn_sac_codes_popularity_idx').on(t.popularity),
  ],
);

// ─── tenant_hsn_sac_codes (tenant-specific additions to the global master) ──────

export const tenantHsnSacCodes = pgTable(
  'tenant_hsn_sac_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    type: text('type').notNull(), // HSN | SAC
    description: text('description').notNull(),
    default_gst_rate: numeric('default_gst_rate', { precision: 5, scale: 2 }),
    category: text('category'),
    created_by: uuid('created_by').references(() => users.id),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('tenant_hsn_sac_codes_unique').on(t.tenant_id, t.code),
    index('tenant_hsn_sac_codes_tenant_idx').on(t.tenant_id),
  ],
);

// ─── invoicing_settings (one row per tenant) ────────────────────────────────────

export const invoicingSettings = pgTable(
  'invoicing_settings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .unique()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    default_currency: text('default_currency').notNull().default('INR'),
    default_payment_terms_days: integer('default_payment_terms_days')
      .notNull()
      .default(30),
    default_gst_rate: numeric('default_gst_rate', { precision: 5, scale: 2 })
      .notNull()
      .default('18'),
    default_invoice_notes: text('default_invoice_notes'),
    default_terms_and_conditions: text('default_terms_and_conditions'),
    invoice_template: text('invoice_template').notNull().default('classic'),
    brand_color_override: text('brand_color_override'),
    show_gstin_on_pdf: boolean('show_gstin_on_pdf').default(true),
    show_tds_section_on_pdf: boolean('show_tds_section_on_pdf').default(true),
    show_upi_qr_on_pdf: boolean('show_upi_qr_on_pdf').default(true),
    show_powered_by_footer: boolean('show_powered_by_footer').default(true),
    email_sender_name: text('email_sender_name'),
    email_reply_to: text('email_reply_to'),
    email_signature: text('email_signature'),
    cc_owner_on_customer_emails: boolean('cc_owner_on_customer_emails').default(
      true,
    ),
    additional_cc_emails: text('additional_cc_emails').array(),
    upi_id: text('upi_id'),
    upi_display_name: text('upi_display_name'),
    razorpay_account_id: text('razorpay_account_id'), // acc_… of the connected sub-merchant (OAuth)
    razorpay_key_id: text('razorpay_key_id'),
    razorpay_webhook_secret: text('razorpay_webhook_secret'), // encrypted at app layer
    // Razorpay OAuth (Sprint 15). Tokens are AES-256-GCM-encrypted at the app
    // layer (InvoicingCryptoService); never returned by the settings API.
    razorpay_access_token: text('razorpay_access_token'), // encrypted; Bearer for sub-merchant API calls (90-day)
    razorpay_refresh_token: text('razorpay_refresh_token'), // encrypted; renews the access token (180-day)
    razorpay_public_token: text('razorpay_public_token'), // client-side Checkout key
    razorpay_token_expires_at: timestamp('razorpay_token_expires_at', {
      withTimezone: true,
    }),
    razorpay_connected_at: timestamp('razorpay_connected_at', {
      withTimezone: true,
    }),
    razorpay_oauth_state: text('razorpay_oauth_state'), // transient CSRF/tenant binding for the OAuth callback
    allow_partial_payments: boolean('allow_partial_payments').default(true),
    fx_rate_source: text('fx_rate_source').default('openexchangerates'),
    fx_rate_last_refresh: timestamp('fx_rate_last_refresh', {
      withTimezone: true,
    }),
    filing_frequency: text('filing_frequency').default('monthly'), // monthly | quarterly
    declared_aato: numeric('declared_aato', { precision: 15, scale: 2 }),
    composition_scheme: boolean('composition_scheme').default(false),
    default_tds_section: text('default_tds_section').default('393'),
    default_tds_payment_code: text('default_tds_payment_code'),
    default_tds_rate: numeric('default_tds_rate', { precision: 5, scale: 2 }),
    auto_suggest_tds: boolean('auto_suggest_tds').default(false),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('invoicing_settings_tenant_id_idx').on(t.tenant_id)],
);

// ─── invoicing_setup_progress (wizard tracker, one row per tenant) ──────────────

export const invoicingSetupProgress = pgTable(
  'invoicing_setup_progress',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .unique()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    wizard_started_at: timestamp('wizard_started_at', { withTimezone: true }),
    wizard_completed_at: timestamp('wizard_completed_at', {
      withTimezone: true,
    }),
    current_step: text('current_step'),
    business_details_confirmed: boolean('business_details_confirmed').default(
      false,
    ),
    upi_configured: boolean('upi_configured').default(false),
    razorpay_connected: boolean('razorpay_connected').default(false),
    template_chosen: boolean('template_chosen').default(false),
    numbering_configured: boolean('numbering_configured').default(false),
    payment_terms_set: boolean('payment_terms_set').default(false),
    currencies_enabled: boolean('currencies_enabled').default(false),
    default_gst_set: boolean('default_gst_set').default(false),
    default_notes_set: boolean('default_notes_set').default(false),
    email_signature_set: boolean('email_signature_set').default(false),
    reminder_schedule_set: boolean('reminder_schedule_set').default(false),
    first_invoice_sent_at: timestamp('first_invoice_sent_at', {
      withTimezone: true,
    }),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('invoicing_setup_progress_tenant_id_idx').on(t.tenant_id)],
);

// ─── customers ──────────────────────────────────────────────────────────────────

export const customers = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    customer_code: text('customer_code').notNull(),
    display_name: text('display_name').notNull(),
    legal_name: text('legal_name'),
    customer_type: text('customer_type').notNull().default('business'), // business | individual
    primary_contact_name: text('primary_contact_name'),
    email: text('email'),
    secondary_emails: text('secondary_emails').array(),
    phone: text('phone'),
    country_code: text('country_code').notNull().default('IN'),
    state_code: text('state_code'),
    billing_address_line1: text('billing_address_line1'),
    billing_address_line2: text('billing_address_line2'),
    billing_city: text('billing_city'),
    billing_state: text('billing_state'),
    billing_postal_code: text('billing_postal_code'),
    billing_country: text('billing_country'),
    shipping_same_as_billing: boolean('shipping_same_as_billing').default(true),
    shipping_address_line1: text('shipping_address_line1'),
    shipping_address_line2: text('shipping_address_line2'),
    shipping_city: text('shipping_city'),
    shipping_state: text('shipping_state'),
    shipping_postal_code: text('shipping_postal_code'),
    shipping_country: text('shipping_country'),
    is_gst_registered: boolean('is_gst_registered').default(false),
    gstin: text('gstin'),
    pan: text('pan'),
    intl_tax_id: text('intl_tax_id'),
    default_currency: text('default_currency').notNull().default('INR'),
    default_payment_terms_days: integer('default_payment_terms_days'),
    default_language: text('default_language').default('en'),
    default_notes: text('default_notes'),
    internal_notes: text('internal_notes'),
    status: text('status').notNull().default('active'), // active | archived
    // Sub-merchant Razorpay customer handle for auto-debit mandates (0027).
    razorpay_customer_id: text('razorpay_customer_id'),
    // CRM directory kernel linkage (0031) — one canonical person/org per tenant.
    directory_company_id: uuid('directory_company_id'),
    directory_person_id: uuid('directory_person_id'),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    created_by: uuid('created_by').references(() => users.id),
    updated_by: uuid('updated_by').references(() => users.id),
    deleted_at: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('customers_tenant_code_unique').on(t.tenant_id, t.customer_code),
    index('idx_customers_tenant_status').on(t.tenant_id, t.status),
    index('idx_customers_email').on(t.tenant_id, t.email),
    index('idx_customers_gstin').on(t.tenant_id, t.gstin),
  ],
);

// ─── customer_credit_balance (+ entries) ────────────────────────────────────────

export const customerCreditBalance = pgTable(
  'customer_credit_balance',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    customer_id: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    balance_amount: numeric('balance_amount', { precision: 15, scale: 2 })
      .notNull()
      .default('0'),
    currency: text('currency').notNull().default('INR'),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('customer_credit_balance_unique').on(
      t.tenant_id,
      t.customer_id,
      t.currency,
    ),
    index('customer_credit_balance_tenant_idx').on(t.tenant_id),
  ],
);

export const customerCreditBalanceEntries = pgTable(
  'customer_credit_balance_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    customer_id: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    entry_date: date('entry_date').notNull(),
    // credit_note | overpayment | adjustment | applied_to_invoice | refund
    entry_type: text('entry_type').notNull(),
    amount: numeric('amount', { precision: 15, scale: 2 }).notNull(), // + credit / − use
    currency: text('currency').notNull().default('INR'),
    reference_type: text('reference_type'),
    reference_id: uuid('reference_id'),
    description: text('description'),
    created_by: uuid('created_by').references(() => users.id),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('customer_credit_entries_tenant_customer_date_idx').on(
      t.tenant_id,
      t.customer_id,
      t.entry_date,
    ),
  ],
);

// ─── items ──────────────────────────────────────────────────────────────────────

export const items = pgTable(
  'items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    item_code: text('item_code').notNull(),
    name: text('name').notNull(),
    category: text('category'),
    description: text('description'),
    default_rate: numeric('default_rate', { precision: 15, scale: 2 }).notNull(),
    currency: text('currency').notNull().default('INR'),
    unit: text('unit').notNull().default('units'),
    hsn_sac_code: text('hsn_sac_code'),
    default_gst_rate: numeric('default_gst_rate', {
      precision: 5,
      scale: 2,
    }).default('18'),
    cess_rate: numeric('cess_rate', { precision: 5, scale: 2 }).default('0'),
    country_override: text('country_override'),
    intl_tax_code: text('intl_tax_code'),
    intl_tax_rate: numeric('intl_tax_rate', { precision: 5, scale: 2 }),
    tax_exempt: boolean('tax_exempt').default(false),
    status: text('status').notNull().default('active'),
    usage_count: integer('usage_count').default(0),
    last_used_at: timestamp('last_used_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    created_by: uuid('created_by').references(() => users.id),
    updated_by: uuid('updated_by').references(() => users.id),
    deleted_at: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('items_tenant_code_unique').on(t.tenant_id, t.item_code),
    index('idx_items_tenant_status').on(t.tenant_id, t.status),
  ],
);

// ─── invoice_sequences (one row per tenant, doc type, FY, branch) ───────────────

export const invoiceSequences = pgTable(
  'invoice_sequences',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    document_type: text('document_type').notNull(), // INVOICE | QUOTE | CREDIT_NOTE | DEBIT_NOTE
    fy_label: text('fy_label').notNull(), // '26-27'
    fy_start_date: date('fy_start_date').notNull(),
    fy_end_date: date('fy_end_date').notNull(),
    prefix: text('prefix').notNull().default('INV'),
    separator: text('separator').notNull().default('/'),
    fy_format: text('fy_format').notNull().default('26-27'),
    zero_padding: integer('zero_padding').notNull().default(4),
    starting_number: integer('starting_number').notNull().default(1),
    current_number: integer('current_number').notNull().default(0),
    branch_code: varchar('branch_code', { length: 10 }).notNull().default(''),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('invoice_sequences_unique').on(
      t.tenant_id,
      t.document_type,
      t.fy_label,
      t.branch_code,
    ),
    index('invoice_sequences_tenant_idx').on(t.tenant_id),
  ],
);

// ─── tenant_bank_accounts (+ currency defaults) — shared Org → Financial (§8) ───

export const tenantBankAccounts = pgTable(
  'tenant_bank_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    beneficiary_name: text('beneficiary_name').notNull(),
    account_number: text('account_number').notNull(),
    account_type: text('account_type').notNull().default('Current'), // Current | Savings | EEFC
    bank_name: text('bank_name').notNull(),
    branch: text('branch'),
    ifsc: varchar('ifsc', { length: 11 }),
    swift_bic: varchar('swift_bic', { length: 11 }),
    bank_address: text('bank_address'),
    iban: varchar('iban', { length: 34 }),
    is_default: boolean('is_default').notNull().default(false),
    is_active: boolean('is_active').notNull().default(true),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    created_by: uuid('created_by').references(() => users.id),
    updated_by: uuid('updated_by').references(() => users.id),
    deleted_at: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [index('idx_tenant_bank_accounts_tenant').on(t.tenant_id)],
);

export const tenantCurrencyBankDefaults = pgTable(
  'tenant_currency_bank_defaults',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    currency: char('currency', { length: 3 }).notNull(),
    bank_account_id: uuid('bank_account_id')
      .notNull()
      .references(() => tenantBankAccounts.id, { onDelete: 'cascade' }),
  },
  (t) => [
    uniqueIndex('tenant_currency_bank_defaults_unique').on(
      t.tenant_id,
      t.currency,
    ),
  ],
);

// ─── invoiceSubscriptions (+ line items, + proration events) ───────────────────────────

export const invoiceSubscriptions = pgTable(
  'invoice_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    customer_id: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    name: text('name').notNull(),
    // PENDING_MANDATE|TRIALING|ACTIVE|PAST_DUE|PAUSED|CANCELLED|EXPIRED
    status: text('status').notNull().default('PENDING_MANDATE'),
    pricing_model: text('pricing_model').notNull(), // flat_rate | per_seat
    currency: text('currency').notNull(), // LOCKED at creation
    flat_amount: numeric('flat_amount', { precision: 15, scale: 2 }),
    seat_rate: numeric('seat_rate', { precision: 15, scale: 2 }),
    seat_count: integer('seat_count'),
    billing_period: text('billing_period').notNull(), // monthly|quarterly|annually|custom
    custom_period_days: integer('custom_period_days'),
    anchor_day: integer('anchor_day'),
    start_date: date('start_date').notNull(),
    end_condition: text('end_condition').notNull().default('until_cancelled'),
    end_after_cycles: integer('end_after_cycles'),
    end_date: date('end_date'),
    trial_days: integer('trial_days').default(0),
    trial_ends_at: date('trial_ends_at'),
    next_billing_date: date('next_billing_date'),
    next_billing_amount: numeric('next_billing_amount', {
      precision: 15,
      scale: 2,
    }),
    razorpay_subscription_id: text('razorpay_subscription_id').unique(),
    razorpay_plan_id: text('razorpay_plan_id'),
    // Auto-debit (PRD v4 §8A / 0027): how cycles are collected + the mandate
    // lifecycle. manual = send invoices (default); auto_debit = e-mandate.
    collection_mode: text('collection_mode').notNull().default('manual'),
    // none | pending_authorization | authenticated | active | paused | halted
    // | revoked | failed  (CHECK-constrained in 0029)
    mandate_status: text('mandate_status').notNull().default('none'),
    mandate_short_url: text('mandate_short_url'), // Razorpay-hosted auth page
    mandate_token: text('mandate_token'), // public /sub/<token> page
    mandate_token_expires_at: timestamp('mandate_token_expires_at', {
      withTimezone: true,
    }),
    mandate_authorized_at: timestamp('mandate_authorized_at', {
      withTimezone: true,
    }),
    mandate_revoked_at: timestamp('mandate_revoked_at', { withTimezone: true }),
    payment_method: text('payment_method'), // upi_autopay | card
    total_cycles_billed: integer('total_cycles_billed').default(0),
    total_amount_billed: numeric('total_amount_billed', {
      precision: 15,
      scale: 2,
    }).default('0'),
    failed_charge_count: integer('failed_charge_count').default(0),
    last_failure_at: timestamp('last_failure_at', { withTimezone: true }),
    paused_at: timestamp('paused_at', { withTimezone: true }),
    cancelled_at: timestamp('cancelled_at', { withTimezone: true }),
    cancellation_reason: text('cancellation_reason'),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    created_by: uuid('created_by').references(() => users.id),
  },
  (t) => [
    index('invoice_subscriptions_tenant_idx').on(t.tenant_id),
    index('idx_invoice_subscriptions_next_billing').on(t.next_billing_date),
    // Partial unique on the public-page token (0027) — matches the migration.
    uniqueIndex('idx_invoice_subscriptions_mandate_token')
      .on(t.mandate_token)
      .where(sql`${t.mandate_token} IS NOT NULL`),
  ],
);

// ─── subscription_charge_attempts (PRD v4 §8A / 0027 — D14b timeline) ─────────
// One row per auto-debit charge outcome; tenant-isolated, append-only under
// the app role (webhook writes via service role).

export const subscriptionChargeAttempts = pgTable(
  'subscription_charge_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    subscription_id: uuid('subscription_id')
      .notNull()
      .references(() => invoiceSubscriptions.id, { onDelete: 'cascade' }),
    invoice_id: uuid('invoice_id').references(() => invoices.id, {
      onDelete: 'set null',
    }),
    razorpay_payment_id: text('razorpay_payment_id'),
    status: text('status').notNull(), // created | captured | failed (0029)
    attempt_no: smallint('attempt_no'),
    amount: numeric('amount', { precision: 15, scale: 2 }).notNull(),
    currency: text('currency').notNull(),
    failure_reason: text('failure_reason'),
    failure_code: text('failure_code'),
    attempted_at: timestamp('attempted_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('idx_charge_attempts_subscription').on(t.subscription_id, t.attempted_at),
    index('idx_charge_attempts_tenant').on(t.tenant_id, t.attempted_at),
  ],
);

export type SubscriptionChargeAttempt = typeof subscriptionChargeAttempts.$inferSelect;

// ─── invoices (main table; also stores quotes via document_type/status) ─────────

export const invoices = pgTable(
  'invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    customer_id: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    invoice_number: text('invoice_number').notNull(),
    quote_number: text('quote_number'),
    document_type: text('document_type').notNull().default('INVOICE'), // INVOICE | QUOTE
    status: text('status').notNull().default('DRAFT'),
    invoice_date: date('invoice_date').notNull(),
    due_date: date('due_date').notNull(),
    valid_until: date('valid_until'),
    reference: text('reference'),
    fy_label: text('fy_label').notNull(),
    currency: text('currency').notNull(),
    fx_rate_to_inr: numeric('fx_rate_to_inr', { precision: 15, scale: 6 }),
    subtotal: numeric('subtotal', { precision: 15, scale: 2 })
      .notNull()
      .default('0'),
    discount_type: text('discount_type'),
    discount_value: numeric('discount_value', {
      precision: 15,
      scale: 2,
    }).default('0'),
    discount_amount: numeric('discount_amount', {
      precision: 15,
      scale: 2,
    }).default('0'),
    taxable_amount: numeric('taxable_amount', { precision: 15, scale: 2 })
      .notNull()
      .default('0'),
    cgst_amount: numeric('cgst_amount', { precision: 15, scale: 2 }).default(
      '0',
    ),
    sgst_amount: numeric('sgst_amount', { precision: 15, scale: 2 }).default(
      '0',
    ),
    igst_amount: numeric('igst_amount', { precision: 15, scale: 2 }).default(
      '0',
    ),
    cess_amount: numeric('cess_amount', { precision: 15, scale: 2 }).default(
      '0',
    ),
    total_amount: numeric('total_amount', { precision: 15, scale: 2 })
      .notNull()
      .default('0'),
    tds_section: text('tds_section'),
    tds_payment_code: text('tds_payment_code'),
    tds_rate: numeric('tds_rate', { precision: 5, scale: 2 }),
    tds_amount: numeric('tds_amount', { precision: 15, scale: 2 }).default('0'),
    net_receivable: numeric('net_receivable', { precision: 15, scale: 2 }),
    amount_paid: numeric('amount_paid', { precision: 15, scale: 2 }).default(
      '0',
    ),
    amount_outstanding: numeric('amount_outstanding', {
      precision: 15,
      scale: 2,
    }),
    credit_applied: numeric('credit_applied', {
      precision: 15,
      scale: 2,
    }).default('0'),
    place_of_supply: text('place_of_supply'),
    // INTRA_STATE|INTER_STATE|EXPORT|B2C_LARGE|B2C_SMALL
    tax_treatment: text('tax_treatment'),
    reverse_charge: boolean('reverse_charge').default(false),
    notes: text('notes'),
    terms_and_conditions: text('terms_and_conditions'),
    subscription_id: uuid('subscription_id').references(() => invoiceSubscriptions.id),
    bank_account_id: uuid('bank_account_id').references(
      () => tenantBankAccounts.id,
    ),
    pdf_storage_key: text('pdf_storage_key'),
    customer_email_at_send: text('customer_email_at_send'),
    email_sent_at: timestamp('email_sent_at', { withTimezone: true }),
    email_delivered_at: timestamp('email_delivered_at', { withTimezone: true }),
    first_viewed_at: timestamp('first_viewed_at', { withTimezone: true }),
    last_viewed_at: timestamp('last_viewed_at', { withTimezone: true }),
    view_count: integer('view_count').default(0),
    paid_at: timestamp('paid_at', { withTimezone: true }),
    cancelled_at: timestamp('cancelled_at', { withTimezone: true }),
    cancellation_reason: text('cancellation_reason'),
    voided_at: timestamp('voided_at', { withTimezone: true }),
    refunded_at: timestamp('refunded_at', { withTimezone: true }),
    write_off_at: timestamp('write_off_at', { withTimezone: true }),
    write_off_reason: text('write_off_reason'),
    public_view_token: text('public_view_token').unique(),
    public_view_token_expires_at: timestamp('public_view_token_expires_at', {
      withTimezone: true,
    }),
    invoice_template: text('invoice_template'),
    // CRM back-link (0032) — the deal this invoice was generated from (§4.4).
    deal_id: uuid('deal_id'),
    // Quote acceptance timestamp (0033) — set when a QUOTE is accepted on the
    // hosted page; the ACCEPTED state itself lives in `status`.
    quote_accepted_at: timestamp('quote_accepted_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    created_by: uuid('created_by').references(() => users.id),
    updated_by: uuid('updated_by').references(() => users.id),
  },
  (t) => [
    uniqueIndex('invoices_tenant_number_unique').on(
      t.tenant_id,
      t.invoice_number,
    ),
    index('idx_invoices_tenant_status').on(t.tenant_id, t.status),
    index('idx_invoices_tenant_customer').on(t.tenant_id, t.customer_id),
    index('idx_invoices_due_date').on(t.tenant_id, t.due_date),
    index('idx_invoices_public_token').on(t.public_view_token),
  ],
);

export const invoiceLineItems = pgTable(
  'invoice_line_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    invoice_id: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    line_number: integer('line_number').notNull(),
    item_id: uuid('item_id').references(() => items.id),
    item_name: text('item_name').notNull(),
    description: text('description'),
    hsn_sac_code: text('hsn_sac_code'),
    quantity: numeric('quantity', { precision: 15, scale: 4 }).notNull(),
    unit: text('unit'),
    rate: numeric('rate', { precision: 15, scale: 2 }).notNull(),
    gst_rate: numeric('gst_rate', { precision: 5, scale: 2 }).default('0'),
    cess_rate: numeric('cess_rate', { precision: 5, scale: 2 }).default('0'),
    line_amount: numeric('line_amount', { precision: 15, scale: 2 }).default(
      '0',
    ),
    discount_amount: numeric('discount_amount', {
      precision: 15,
      scale: 2,
    }).default('0'),
    taxable_amount: numeric('taxable_amount', {
      precision: 15,
      scale: 2,
    }).default('0'),
    cgst_amount: numeric('cgst_amount', { precision: 15, scale: 2 }).default(
      '0',
    ),
    sgst_amount: numeric('sgst_amount', { precision: 15, scale: 2 }).default(
      '0',
    ),
    igst_amount: numeric('igst_amount', { precision: 15, scale: 2 }).default(
      '0',
    ),
    cess_amount: numeric('cess_amount', { precision: 15, scale: 2 }).default(
      '0',
    ),
    line_total: numeric('line_total', { precision: 15, scale: 2 }).default('0'),
  },
  (t) => [
    uniqueIndex('invoice_line_items_unique').on(t.invoice_id, t.line_number),
    index('invoice_line_items_tenant_idx').on(t.tenant_id),
    index('invoice_line_items_invoice_idx').on(t.invoice_id),
  ],
);

export const invoicePayments = pgTable(
  'invoice_payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    invoice_id: uuid('invoice_id').references(() => invoices.id, {
      onDelete: 'cascade',
    }),
    customer_id: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    payment_number: text('payment_number').notNull(),
    payment_date: date('payment_date').notNull(),
    amount: numeric('amount', { precision: 15, scale: 2 }).notNull(),
    currency: text('currency').notNull().default('INR'),
    // CASH|BANK_TRANSFER|CHEQUE|UPI_DIRECT|RAZORPAY_*|OTHER
    payment_method: text('payment_method').notNull(),
    reference_number: text('reference_number'),
    razorpay_payment_id: text('razorpay_payment_id'),
    razorpay_order_id: text('razorpay_order_id'),
    notes: text('notes'),
    source: text('source').notNull().default('manual'), // automatic_webhook|manual|subscription_charge
    receipt_sent: boolean('receipt_sent').default(false),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    created_by: uuid('created_by').references(() => users.id),
  },
  (t) => [
    uniqueIndex('invoice_payments_number_unique').on(
      t.tenant_id,
      t.payment_number,
    ),
    index('invoice_payments_tenant_idx').on(t.tenant_id),
    index('invoice_payments_invoice_idx').on(t.invoice_id),
  ],
);

// ─── subscription line items + proration (after invoices for FK ordering) ───────

export const invoiceSubscriptionLineItems = pgTable(
  'invoice_subscription_line_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    subscription_id: uuid('subscription_id')
      .notNull()
      .references(() => invoiceSubscriptions.id, { onDelete: 'cascade' }),
    item_id: uuid('item_id').references(() => items.id),
    item_name: text('item_name').notNull(),
    description: text('description'),
    hsn_sac_code: text('hsn_sac_code'),
    quantity: numeric('quantity', { precision: 15, scale: 4 })
      .notNull()
      .default('1'),
    unit: text('unit'),
    rate: numeric('rate', { precision: 15, scale: 2 }).notNull(),
    gst_rate: numeric('gst_rate', { precision: 5, scale: 2 }).default('0'),
    cess_rate: numeric('cess_rate', { precision: 5, scale: 2 }).default('0'),
    effective_from: date('effective_from'),
    effective_until: date('effective_until'),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('invoice_subscription_line_items_tenant_idx').on(t.tenant_id),
    index('invoice_subscription_line_items_sub_idx').on(t.subscription_id),
  ],
);

export const invoiceSubscriptionProrationEvents = pgTable(
  'invoice_subscription_proration_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    subscription_id: uuid('subscription_id')
      .notNull()
      .references(() => invoiceSubscriptions.id, { onDelete: 'cascade' }),
    event_date: date('event_date').notNull(),
    event_type: text('event_type').notNull(), // add_seats|remove_seats|rate_change|other
    amount: numeric('amount', { precision: 15, scale: 2 }).notNull(), // +charge / −credit
    applied_to_invoice_id: uuid('applied_to_invoice_id').references(
      () => invoices.id,
    ),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('invoice_subscription_proration_tenant_idx').on(t.tenant_id),
    index('invoice_subscription_proration_sub_idx').on(t.subscription_id),
  ],
);

// ─── credit_notes (+ lines) ─────────────────────────────────────────────────────

export const creditNotes = pgTable(
  'credit_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    invoice_id: uuid('invoice_id').references(() => invoices.id),
    customer_id: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    credit_note_number: text('credit_note_number').notNull(),
    fy_label: text('fy_label').notNull(),
    credit_note_date: date('credit_note_date').notNull(),
    // sales_return|price_revision|post_supply_discount|service_deficiency|invoice_cancellation|other
    reason: text('reason').notNull(),
    reason_description: text('reason_description'),
    status: text('status').notNull().default('DRAFT'), // DRAFT|ISSUED|CANCELLED
    currency: text('currency').notNull().default('INR'),
    subtotal: numeric('subtotal', { precision: 15, scale: 2 }).default('0'),
    taxable_amount: numeric('taxable_amount', {
      precision: 15,
      scale: 2,
    }).default('0'),
    cgst_amount: numeric('cgst_amount', { precision: 15, scale: 2 }).default(
      '0',
    ),
    sgst_amount: numeric('sgst_amount', { precision: 15, scale: 2 }).default(
      '0',
    ),
    igst_amount: numeric('igst_amount', { precision: 15, scale: 2 }).default(
      '0',
    ),
    cess_amount: numeric('cess_amount', { precision: 15, scale: 2 }).default(
      '0',
    ),
    total_amount: numeric('total_amount', { precision: 15, scale: 2 }).default(
      '0',
    ),
    applied_to_balance: numeric('applied_to_balance', {
      precision: 15,
      scale: 2,
    }).default('0'),
    refunded_amount: numeric('refunded_amount', {
      precision: 15,
      scale: 2,
    }).default('0'),
    refund_reference: text('refund_reference'),
    refund_date: date('refund_date'),
    pdf_storage_key: text('pdf_storage_key'),
    notes: text('notes'),
    issued_at: timestamp('issued_at', { withTimezone: true }),
    cancelled_at: timestamp('cancelled_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    created_by: uuid('created_by').references(() => users.id),
  },
  (t) => [
    uniqueIndex('credit_notes_number_unique').on(
      t.tenant_id,
      t.credit_note_number,
    ),
    index('credit_notes_tenant_idx').on(t.tenant_id),
    index('credit_notes_customer_idx').on(t.customer_id),
  ],
);

export const creditNoteLineItems = pgTable(
  'credit_note_line_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    credit_note_id: uuid('credit_note_id')
      .notNull()
      .references(() => creditNotes.id, { onDelete: 'cascade' }),
    line_number: integer('line_number').notNull(),
    item_id: uuid('item_id').references(() => items.id),
    item_name: text('item_name').notNull(),
    description: text('description'),
    hsn_sac_code: text('hsn_sac_code'),
    quantity: numeric('quantity', { precision: 15, scale: 4 }).notNull(),
    unit: text('unit'),
    rate: numeric('rate', { precision: 15, scale: 2 }).notNull(),
    gst_rate: numeric('gst_rate', { precision: 5, scale: 2 }).default('0'),
    cess_rate: numeric('cess_rate', { precision: 5, scale: 2 }).default('0'),
    line_amount: numeric('line_amount', { precision: 15, scale: 2 }).default(
      '0',
    ),
    discount_amount: numeric('discount_amount', {
      precision: 15,
      scale: 2,
    }).default('0'),
    taxable_amount: numeric('taxable_amount', {
      precision: 15,
      scale: 2,
    }).default('0'),
    cgst_amount: numeric('cgst_amount', { precision: 15, scale: 2 }).default(
      '0',
    ),
    sgst_amount: numeric('sgst_amount', { precision: 15, scale: 2 }).default(
      '0',
    ),
    igst_amount: numeric('igst_amount', { precision: 15, scale: 2 }).default(
      '0',
    ),
    cess_amount: numeric('cess_amount', { precision: 15, scale: 2 }).default(
      '0',
    ),
    line_total: numeric('line_total', { precision: 15, scale: 2 }).default('0'),
  },
  (t) => [
    uniqueIndex('credit_note_line_items_unique').on(
      t.credit_note_id,
      t.line_number,
    ),
    index('credit_note_line_items_tenant_idx').on(t.tenant_id),
  ],
);

// ─── debit_notes (+ lines) ──────────────────────────────────────────────────────

export const debitNotes = pgTable(
  'debit_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    invoice_id: uuid('invoice_id').references(() => invoices.id),
    customer_id: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    debit_note_number: text('debit_note_number').notNull(),
    fy_label: text('fy_label').notNull(),
    debit_note_date: date('debit_note_date').notNull(),
    // additional_charges|price_revision_upward|under_billing_correction|reverse_charge_adjustment|other
    reason: text('reason').notNull(),
    reason_description: text('reason_description'),
    status: text('status').notNull().default('DRAFT'), // DRAFT|ISSUED|CANCELLED
    currency: text('currency').notNull().default('INR'),
    subtotal: numeric('subtotal', { precision: 15, scale: 2 }).default('0'),
    taxable_amount: numeric('taxable_amount', {
      precision: 15,
      scale: 2,
    }).default('0'),
    cgst_amount: numeric('cgst_amount', { precision: 15, scale: 2 }).default(
      '0',
    ),
    sgst_amount: numeric('sgst_amount', { precision: 15, scale: 2 }).default(
      '0',
    ),
    igst_amount: numeric('igst_amount', { precision: 15, scale: 2 }).default(
      '0',
    ),
    cess_amount: numeric('cess_amount', { precision: 15, scale: 2 }).default(
      '0',
    ),
    total_amount: numeric('total_amount', { precision: 15, scale: 2 }).default(
      '0',
    ),
    pdf_storage_key: text('pdf_storage_key'),
    notes: text('notes'),
    issued_at: timestamp('issued_at', { withTimezone: true }),
    cancelled_at: timestamp('cancelled_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    created_by: uuid('created_by').references(() => users.id),
  },
  (t) => [
    uniqueIndex('debit_notes_number_unique').on(
      t.tenant_id,
      t.debit_note_number,
    ),
    index('debit_notes_tenant_idx').on(t.tenant_id),
    index('debit_notes_customer_idx').on(t.customer_id),
  ],
);

export const debitNoteLineItems = pgTable(
  'debit_note_line_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    debit_note_id: uuid('debit_note_id')
      .notNull()
      .references(() => debitNotes.id, { onDelete: 'cascade' }),
    line_number: integer('line_number').notNull(),
    item_id: uuid('item_id').references(() => items.id),
    item_name: text('item_name').notNull(),
    description: text('description'),
    hsn_sac_code: text('hsn_sac_code'),
    quantity: numeric('quantity', { precision: 15, scale: 4 }).notNull(),
    unit: text('unit'),
    rate: numeric('rate', { precision: 15, scale: 2 }).notNull(),
    gst_rate: numeric('gst_rate', { precision: 5, scale: 2 }).default('0'),
    cess_rate: numeric('cess_rate', { precision: 5, scale: 2 }).default('0'),
    line_amount: numeric('line_amount', { precision: 15, scale: 2 }).default(
      '0',
    ),
    discount_amount: numeric('discount_amount', {
      precision: 15,
      scale: 2,
    }).default('0'),
    taxable_amount: numeric('taxable_amount', {
      precision: 15,
      scale: 2,
    }).default('0'),
    cgst_amount: numeric('cgst_amount', { precision: 15, scale: 2 }).default(
      '0',
    ),
    sgst_amount: numeric('sgst_amount', { precision: 15, scale: 2 }).default(
      '0',
    ),
    igst_amount: numeric('igst_amount', { precision: 15, scale: 2 }).default(
      '0',
    ),
    cess_amount: numeric('cess_amount', { precision: 15, scale: 2 }).default(
      '0',
    ),
    line_total: numeric('line_total', { precision: 15, scale: 2 }).default('0'),
  },
  (t) => [
    uniqueIndex('debit_note_line_items_unique').on(
      t.debit_note_id,
      t.line_number,
    ),
    index('debit_note_line_items_tenant_idx').on(t.tenant_id),
  ],
);

// ─── adjustments ────────────────────────────────────────────────────────────────

export const adjustments = pgTable(
  'adjustments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    customer_id: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    adjustment_date: date('adjustment_date').notNull(),
    amount: numeric('amount', { precision: 15, scale: 2 }).notNull(), // +owe / −owed
    currency: text('currency').notNull().default('INR'),
    type: text('type').notNull(), // opening_balance|write_off|round_off|bank_charge|other
    reason: text('reason'),
    affects_credit_balance: boolean('affects_credit_balance').default(false),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    created_by: uuid('created_by').references(() => users.id),
  },
  (t) => [
    index('adjustments_tenant_idx').on(t.tenant_id),
    index('adjustments_customer_idx').on(t.customer_id),
  ],
);

// ─── reminder_schedule + reminder_sent ──────────────────────────────────────────

export const reminderSchedule = pgTable(
  'reminder_schedule',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    reminder_number: integer('reminder_number').notNull(),
    offset_days: integer('offset_days').notNull(), // − before / 0 on / + after due
    active: boolean('active').notNull().default(true),
    email_subject_template: text('email_subject_template'),
    email_body_template: text('email_body_template'),
    scope: text('scope').notNull().default('tenant'), // tenant|customer|invoice
    customer_id: uuid('customer_id').references(() => customers.id, {
      onDelete: 'cascade',
    }),
    invoice_id: uuid('invoice_id').references(() => invoices.id, {
      onDelete: 'cascade',
    }),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('reminder_schedule_tenant_idx').on(t.tenant_id),
    index('reminder_schedule_scope_idx').on(t.tenant_id, t.scope),
  ],
);

export const reminderSent = pgTable(
  'reminder_sent',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    invoice_id: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    reminder_number: integer('reminder_number').notNull(),
    offset_days: integer('offset_days').notNull(),
    sent_at: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
    delivered_at: timestamp('delivered_at', { withTimezone: true }),
    bounced: boolean('bounced').default(false),
  },
  (t) => [
    uniqueIndex('reminder_sent_unique').on(t.invoice_id, t.reminder_number),
    index('reminder_sent_tenant_idx').on(t.tenant_id),
  ],
);

// ─── razorpay_webhook_events (tenant_id nullable; service-role access) ──────────

export const razorpayWebhookEvents = pgTable(
  'razorpay_webhook_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id').references(() => tenants.id, {
      onDelete: 'cascade',
    }),
    event_id: text('event_id').notNull().unique(),
    event_type: text('event_type').notNull(),
    // Which webhook endpoint received it: tenant-track (invoicing) or the
    // platform-billing endpoint (PRD v4 §8B / 0028).
    source: text('source').notNull().default('tenant'), // tenant | platform
    payload: jsonb('payload'),
    signature: text('signature'),
    signature_verified: boolean('signature_verified').default(false),
    processed: boolean('processed').default(false),
    processed_at: timestamp('processed_at', { withTimezone: true }),
    processing_error: text('processing_error'),
    retry_count: integer('retry_count').default(0),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('razorpay_webhook_events_type_idx').on(t.event_type)],
);

// ─── razorpay_orders (Sprint 15) ────────────────────────────────────────────────
// Maps a Razorpay order (created when a customer clicks "Pay with Razorpay" on
// the hosted page) back to its invoice + tenant. The webhook matches by
// entity.order_id — order notes are NOT echoed onto the payment entity, so this
// mapping (not notes) is the reliable link, and it also supports repeated
// partial-payment orders against one invoice.

export const razorpayOrders = pgTable(
  'razorpay_orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    invoice_id: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    order_id: text('order_id').notNull().unique(), // Razorpay order_… id
    amount_paise: integer('amount_paise').notNull(),
    currency: text('currency').notNull().default('INR'),
    status: text('status').notNull().default('created'), // created | paid | failed
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('razorpay_orders_tenant_invoice_idx').on(t.tenant_id, t.invoice_id)],
);

// ─── gstr1_exports ──────────────────────────────────────────────────────────────

export const gstr1Exports = pgTable(
  'gstr1_exports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    fy_label: text('fy_label').notNull(),
    period_month: integer('period_month'),
    period_year: integer('period_year'),
    format: text('format').notNull().default('json'), // json|csv
    storage_key: text('storage_key'),
    file_hash: text('file_hash'),
    invoice_count: integer('invoice_count').default(0),
    total_taxable_value: numeric('total_taxable_value', {
      precision: 15,
      scale: 2,
    }).default('0'),
    total_tax: numeric('total_tax', { precision: 15, scale: 2 }).default('0'),
    b2b_count: integer('b2b_count').default(0),
    b2cl_count: integer('b2cl_count').default(0),
    b2cs_count: integer('b2cs_count').default(0),
    export_count: integer('export_count').default(0),
    cdnr_count: integer('cdnr_count').default(0),
    generated_by: uuid('generated_by').references(() => users.id),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('gstr1_exports_tenant_idx').on(t.tenant_id, t.fy_label)],
);

// ─── form_131_received (TDS Form 131 tracking) ──────────────────────────────────

export const form131Received = pgTable(
  'form_131_received',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    customer_id: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    fy_label: text('fy_label').notNull(),
    quarter: integer('quarter').notNull(), // 1–4
    total_tds_amount: numeric('total_tds_amount', {
      precision: 15,
      scale: 2,
    }).default('0'),
    form_131_received: boolean('form_131_received').default(false),
    form_131_received_date: date('form_131_received_date'),
    form_131_storage_key: text('form_131_storage_key'),
    expected_invoices: uuid('expected_invoices').array(),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('form_131_received_unique').on(
      t.tenant_id,
      t.customer_id,
      t.fy_label,
      t.quarter,
    ),
    index('form_131_received_tenant_idx').on(t.tenant_id),
  ],
);

// ─── Relations (key entities) ───────────────────────────────────────────────────

export const customersRelations = relations(customers, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [customers.tenant_id],
    references: [tenants.id],
  }),
  invoices: many(invoices),
}));

export const invoicesRelations = relations(invoices, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [invoices.tenant_id],
    references: [tenants.id],
  }),
  customer: one(customers, {
    fields: [invoices.customer_id],
    references: [customers.id],
  }),
  subscription: one(invoiceSubscriptions, {
    fields: [invoices.subscription_id],
    references: [invoiceSubscriptions.id],
  }),
  bankAccount: one(tenantBankAccounts, {
    fields: [invoices.bank_account_id],
    references: [tenantBankAccounts.id],
  }),
  lineItems: many(invoiceLineItems),
  payments: many(invoicePayments),
}));

export const invoiceLineItemsRelations = relations(
  invoiceLineItems,
  ({ one }) => ({
    invoice: one(invoices, {
      fields: [invoiceLineItems.invoice_id],
      references: [invoices.id],
    }),
  }),
);

export const invoicePaymentsRelations = relations(
  invoicePayments,
  ({ one }) => ({
    invoice: one(invoices, {
      fields: [invoicePayments.invoice_id],
      references: [invoices.id],
    }),
    customer: one(customers, {
      fields: [invoicePayments.customer_id],
      references: [customers.id],
    }),
  }),
);

export const invoiceSubscriptionsRelations = relations(
  invoiceSubscriptions,
  ({ one, many }) => ({
    tenant: one(tenants, {
      fields: [invoiceSubscriptions.tenant_id],
      references: [tenants.id],
    }),
    customer: one(customers, {
      fields: [invoiceSubscriptions.customer_id],
      references: [customers.id],
    }),
    lineItems: many(invoiceSubscriptionLineItems),
  }),
);

// ─── invoicing_debug_consents (FAM consented-debug, §10.5) ──────────────────────

export const invoicingDebugConsents = pgTable(
  'invoicing_debug_consents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    granted_by: uuid('granted_by').references(() => users.id),
    scope: text('scope').array().notNull().default([]),
    note: text('note'),
    expires_at: timestamp('expires_at', { withTimezone: true }),
    revoked_at: timestamp('revoked_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_invoicing_debug_consents_tenant').on(t.tenant_id)],
);

// ─── Types ──────────────────────────────────────────────────────────────────────

export type InvoicingDebugConsent = typeof invoicingDebugConsents.$inferSelect;
export type NewInvoicingDebugConsent = typeof invoicingDebugConsents.$inferInsert;
export type HsnSacCode = typeof hsnSacCodes.$inferSelect;
export type NewHsnSacCode = typeof hsnSacCodes.$inferInsert;
export type TenantHsnSacCode = typeof tenantHsnSacCodes.$inferSelect;
export type NewTenantHsnSacCode = typeof tenantHsnSacCodes.$inferInsert;
export type InvoicingSettings = typeof invoicingSettings.$inferSelect;
export type NewInvoicingSettings = typeof invoicingSettings.$inferInsert;
export type InvoicingSetupProgress =
  typeof invoicingSetupProgress.$inferSelect;
export type NewInvoicingSetupProgress =
  typeof invoicingSetupProgress.$inferInsert;
export type Customer = typeof customers.$inferSelect;
export type NewCustomer = typeof customers.$inferInsert;
export type CustomerCreditBalance = typeof customerCreditBalance.$inferSelect;
export type NewCustomerCreditBalance =
  typeof customerCreditBalance.$inferInsert;
export type CustomerCreditBalanceEntry =
  typeof customerCreditBalanceEntries.$inferSelect;
export type NewCustomerCreditBalanceEntry =
  typeof customerCreditBalanceEntries.$inferInsert;
export type Item = typeof items.$inferSelect;
export type NewItem = typeof items.$inferInsert;
export type InvoiceSequence = typeof invoiceSequences.$inferSelect;
export type NewInvoiceSequence = typeof invoiceSequences.$inferInsert;
export type TenantBankAccount = typeof tenantBankAccounts.$inferSelect;
export type NewTenantBankAccount = typeof tenantBankAccounts.$inferInsert;
export type TenantCurrencyBankDefault =
  typeof tenantCurrencyBankDefaults.$inferSelect;
export type NewTenantCurrencyBankDefault =
  typeof tenantCurrencyBankDefaults.$inferInsert;
export type InvoiceSubscription = typeof invoiceSubscriptions.$inferSelect;
export type NewInvoiceSubscription = typeof invoiceSubscriptions.$inferInsert;
export type InvoiceSubscriptionLineItem = typeof invoiceSubscriptionLineItems.$inferSelect;
export type NewInvoiceSubscriptionLineItem =
  typeof invoiceSubscriptionLineItems.$inferInsert;
export type InvoiceSubscriptionProrationEvent =
  typeof invoiceSubscriptionProrationEvents.$inferSelect;
export type NewInvoiceSubscriptionProrationEvent =
  typeof invoiceSubscriptionProrationEvents.$inferInsert;
export type Invoice = typeof invoices.$inferSelect;
export type NewInvoice = typeof invoices.$inferInsert;
export type InvoiceLineItem = typeof invoiceLineItems.$inferSelect;
export type NewInvoiceLineItem = typeof invoiceLineItems.$inferInsert;
export type InvoicePayment = typeof invoicePayments.$inferSelect;
export type NewInvoicePayment = typeof invoicePayments.$inferInsert;
export type CreditNote = typeof creditNotes.$inferSelect;
export type NewCreditNote = typeof creditNotes.$inferInsert;
export type CreditNoteLineItem = typeof creditNoteLineItems.$inferSelect;
export type NewCreditNoteLineItem = typeof creditNoteLineItems.$inferInsert;
export type DebitNote = typeof debitNotes.$inferSelect;
export type NewDebitNote = typeof debitNotes.$inferInsert;
export type DebitNoteLineItem = typeof debitNoteLineItems.$inferSelect;
export type NewDebitNoteLineItem = typeof debitNoteLineItems.$inferInsert;
export type Adjustment = typeof adjustments.$inferSelect;
export type NewAdjustment = typeof adjustments.$inferInsert;
export type ReminderSchedule = typeof reminderSchedule.$inferSelect;
export type NewReminderSchedule = typeof reminderSchedule.$inferInsert;
export type ReminderSent = typeof reminderSent.$inferSelect;
export type NewReminderSent = typeof reminderSent.$inferInsert;
export type RazorpayWebhookEvent = typeof razorpayWebhookEvents.$inferSelect;
export type NewRazorpayWebhookEvent =
  typeof razorpayWebhookEvents.$inferInsert;
export type Gstr1Export = typeof gstr1Exports.$inferSelect;
export type NewGstr1Export = typeof gstr1Exports.$inferInsert;
export type Form131Received = typeof form131Received.$inferSelect;
export type NewForm131Received = typeof form131Received.$inferInsert;
