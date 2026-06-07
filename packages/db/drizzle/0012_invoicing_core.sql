-- =============================================================================
-- 0012 — Invoicing module: core data model (PRD v3 §4.2 / §4.3)
-- =============================================================================
-- Creates all invoicing business tables + the shared company bank-account
-- tables. RLS is applied separately in 0014; the auditor role/platform tables
-- in 0013; seeds in 0015. No RLS here so the table-creation step is reviewable
-- on its own. Idempotent via IF NOT EXISTS.
--
-- Conventions: UUID PK (gen_random_uuid), tenant_id FK cascade, TIMESTAMPTZ,
-- NUMERIC(15,2) money / NUMERIC(5,2) rates / NUMERIC(15,6) fx /
-- NUMERIC(15,4) quantity. Status/type columns are TEXT (app-validated).
-- =============================================================================

-- ─── hsn_sac_codes (GLOBAL — no tenant_id, no RLS) ──────────────────────────────
CREATE TABLE IF NOT EXISTS hsn_sac_codes (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code              TEXT NOT NULL UNIQUE,
  type              TEXT NOT NULL,                 -- HSN | SAC
  description       TEXT NOT NULL,
  default_gst_rate  NUMERIC(5,2),
  category          TEXT,
  popularity        INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS hsn_sac_codes_type_idx ON hsn_sac_codes (type);
CREATE INDEX IF NOT EXISTS hsn_sac_codes_popularity_idx ON hsn_sac_codes (popularity);

-- ─── invoicing_settings (one row per tenant) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoicing_settings (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                     UUID NOT NULL UNIQUE REFERENCES tenants (id) ON DELETE CASCADE,
  default_currency              TEXT NOT NULL DEFAULT 'INR',
  default_payment_terms_days    INTEGER NOT NULL DEFAULT 30,
  default_gst_rate              NUMERIC(5,2) NOT NULL DEFAULT 18,
  default_invoice_notes         TEXT,
  default_terms_and_conditions  TEXT,
  invoice_template              TEXT NOT NULL DEFAULT 'classic',
  brand_color_override          TEXT,
  show_gstin_on_pdf             BOOLEAN DEFAULT TRUE,
  show_tds_section_on_pdf       BOOLEAN DEFAULT TRUE,
  show_upi_qr_on_pdf            BOOLEAN DEFAULT TRUE,
  show_powered_by_footer        BOOLEAN DEFAULT TRUE,
  email_sender_name             TEXT,
  email_reply_to                TEXT,
  email_signature               TEXT,
  cc_owner_on_customer_emails   BOOLEAN DEFAULT TRUE,
  additional_cc_emails          TEXT[],
  upi_id                        TEXT,
  upi_display_name              TEXT,
  razorpay_account_id           TEXT,
  razorpay_key_id               TEXT,
  razorpay_webhook_secret       TEXT,
  allow_partial_payments        BOOLEAN DEFAULT TRUE,
  fx_rate_source                TEXT DEFAULT 'openexchangerates',
  fx_rate_last_refresh          TIMESTAMPTZ,
  filing_frequency              TEXT DEFAULT 'monthly',
  declared_aato                 NUMERIC(15,2),
  composition_scheme            BOOLEAN DEFAULT FALSE,
  default_tds_section           TEXT DEFAULT '393',
  default_tds_payment_code      TEXT,
  default_tds_rate              NUMERIC(5,2),
  auto_suggest_tds              BOOLEAN DEFAULT FALSE,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS invoicing_settings_tenant_id_idx ON invoicing_settings (tenant_id);

-- ─── invoicing_setup_progress (wizard tracker) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS invoicing_setup_progress (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   UUID NOT NULL UNIQUE REFERENCES tenants (id) ON DELETE CASCADE,
  wizard_started_at           TIMESTAMPTZ,
  wizard_completed_at         TIMESTAMPTZ,
  current_step                TEXT,
  business_details_confirmed  BOOLEAN DEFAULT FALSE,
  upi_configured              BOOLEAN DEFAULT FALSE,
  razorpay_connected          BOOLEAN DEFAULT FALSE,
  template_chosen             BOOLEAN DEFAULT FALSE,
  numbering_configured        BOOLEAN DEFAULT FALSE,
  payment_terms_set           BOOLEAN DEFAULT FALSE,
  currencies_enabled          BOOLEAN DEFAULT FALSE,
  default_gst_set             BOOLEAN DEFAULT FALSE,
  default_notes_set           BOOLEAN DEFAULT FALSE,
  email_signature_set         BOOLEAN DEFAULT FALSE,
  reminder_schedule_set       BOOLEAN DEFAULT FALSE,
  first_invoice_sent_at       TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS invoicing_setup_progress_tenant_id_idx ON invoicing_setup_progress (tenant_id);

-- ─── customers ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS customers (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  customer_code               TEXT NOT NULL,
  display_name                TEXT NOT NULL,
  legal_name                  TEXT,
  customer_type               TEXT NOT NULL DEFAULT 'business',
  primary_contact_name        TEXT,
  email                       TEXT,
  secondary_emails            TEXT[],
  phone                       TEXT,
  country_code                TEXT NOT NULL DEFAULT 'IN',
  state_code                  TEXT,
  billing_address_line1       TEXT,
  billing_address_line2       TEXT,
  billing_city                TEXT,
  billing_state               TEXT,
  billing_postal_code         TEXT,
  billing_country             TEXT,
  shipping_same_as_billing    BOOLEAN DEFAULT TRUE,
  shipping_address_line1      TEXT,
  shipping_address_line2      TEXT,
  shipping_city               TEXT,
  shipping_state              TEXT,
  shipping_postal_code        TEXT,
  shipping_country            TEXT,
  is_gst_registered           BOOLEAN DEFAULT FALSE,
  gstin                       TEXT,
  pan                         TEXT,
  intl_tax_id                 TEXT,
  default_currency            TEXT NOT NULL DEFAULT 'INR',
  default_payment_terms_days  INTEGER,
  default_language            TEXT DEFAULT 'en',
  default_notes               TEXT,
  internal_notes              TEXT,
  status                      TEXT NOT NULL DEFAULT 'active',
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by                  UUID REFERENCES users (id),
  updated_by                  UUID REFERENCES users (id),
  deleted_at                  TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS customers_tenant_code_unique ON customers (tenant_id, customer_code);
CREATE INDEX IF NOT EXISTS idx_customers_tenant_status ON customers (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_customers_email ON customers (tenant_id, email) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_customers_gstin ON customers (tenant_id, gstin) WHERE gstin IS NOT NULL;

-- ─── customer_credit_balance (+ entries) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS customer_credit_balance (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  customer_id     UUID NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  balance_amount  NUMERIC(15,2) NOT NULL DEFAULT 0,
  currency        TEXT NOT NULL DEFAULT 'INR',
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS customer_credit_balance_unique ON customer_credit_balance (tenant_id, customer_id, currency);
CREATE INDEX IF NOT EXISTS customer_credit_balance_tenant_idx ON customer_credit_balance (tenant_id);

CREATE TABLE IF NOT EXISTS customer_credit_balance_entries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  customer_id     UUID NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  entry_date      DATE NOT NULL,
  entry_type      TEXT NOT NULL,
  amount          NUMERIC(15,2) NOT NULL,
  currency        TEXT NOT NULL DEFAULT 'INR',
  reference_type  TEXT,
  reference_id    UUID,
  description     TEXT,
  created_by      UUID REFERENCES users (id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS customer_credit_entries_tenant_customer_date_idx
  ON customer_credit_balance_entries (tenant_id, customer_id, entry_date);

-- ─── items ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  item_code         TEXT NOT NULL,
  name              TEXT NOT NULL,
  category          TEXT,
  description       TEXT,
  default_rate      NUMERIC(15,2) NOT NULL,
  currency          TEXT NOT NULL DEFAULT 'INR',
  unit              TEXT NOT NULL DEFAULT 'units',
  hsn_sac_code      TEXT,
  default_gst_rate  NUMERIC(5,2) DEFAULT 18,
  cess_rate         NUMERIC(5,2) DEFAULT 0,
  country_override  TEXT,
  intl_tax_code     TEXT,
  intl_tax_rate     NUMERIC(5,2),
  tax_exempt        BOOLEAN DEFAULT FALSE,
  status            TEXT NOT NULL DEFAULT 'active',
  usage_count       INTEGER DEFAULT 0,
  last_used_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by        UUID REFERENCES users (id),
  updated_by        UUID REFERENCES users (id),
  deleted_at        TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS items_tenant_code_unique ON items (tenant_id, item_code);
CREATE INDEX IF NOT EXISTS idx_items_tenant_status ON items (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_items_name ON items USING gin (to_tsvector('english', name));

-- ─── invoice_sequences ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoice_sequences (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  document_type    TEXT NOT NULL,
  fy_label         TEXT NOT NULL,
  fy_start_date    DATE NOT NULL,
  fy_end_date      DATE NOT NULL,
  prefix           TEXT NOT NULL DEFAULT 'INV',
  separator        TEXT NOT NULL DEFAULT '/',
  fy_format        TEXT NOT NULL DEFAULT '26-27',
  zero_padding     INTEGER NOT NULL DEFAULT 4,
  starting_number  INTEGER NOT NULL DEFAULT 1,
  current_number   INTEGER NOT NULL DEFAULT 0,
  branch_code      VARCHAR(10) NOT NULL DEFAULT '',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS invoice_sequences_unique
  ON invoice_sequences (tenant_id, document_type, fy_label, branch_code);
CREATE INDEX IF NOT EXISTS invoice_sequences_tenant_idx ON invoice_sequences (tenant_id);

-- ─── tenant_bank_accounts (+ currency defaults) — shared Org → Financial (§8) ───
CREATE TABLE IF NOT EXISTS tenant_bank_accounts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  beneficiary_name  TEXT NOT NULL,
  account_number    TEXT NOT NULL,
  account_type      TEXT NOT NULL DEFAULT 'Current',
  bank_name         TEXT NOT NULL,
  branch            TEXT,
  ifsc              VARCHAR(11) CHECK (ifsc IS NULL OR ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  swift_bic         VARCHAR(11) CHECK (swift_bic IS NULL OR swift_bic ~ '^[A-Z0-9]{8}([A-Z0-9]{3})?$'),
  bank_address      TEXT,
  iban              VARCHAR(34),
  is_default        BOOLEAN NOT NULL DEFAULT FALSE,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by        UUID REFERENCES users (id),
  updated_by        UUID REFERENCES users (id),
  deleted_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_tenant_bank_accounts_tenant ON tenant_bank_accounts (tenant_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_bank_default ON tenant_bank_accounts (tenant_id) WHERE is_default AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS tenant_currency_bank_defaults (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  currency         CHAR(3) NOT NULL,
  bank_account_id  UUID NOT NULL REFERENCES tenant_bank_accounts (id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS tenant_currency_bank_defaults_unique ON tenant_currency_bank_defaults (tenant_id, currency);

-- ─── invoice_subscriptions (recurring; distinct from FAM SaaS `subscriptions`) ──
CREATE TABLE IF NOT EXISTS invoice_subscriptions (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  customer_id               UUID NOT NULL REFERENCES customers (id),
  name                      TEXT NOT NULL,
  status                    TEXT NOT NULL DEFAULT 'PENDING_MANDATE',
  pricing_model             TEXT NOT NULL,
  currency                  TEXT NOT NULL,
  flat_amount               NUMERIC(15,2),
  seat_rate                 NUMERIC(15,2),
  seat_count                INTEGER,
  billing_period            TEXT NOT NULL,
  custom_period_days        INTEGER,
  anchor_day                INTEGER,
  start_date                DATE NOT NULL,
  end_condition             TEXT NOT NULL DEFAULT 'until_cancelled',
  end_after_cycles          INTEGER,
  end_date                  DATE,
  trial_days                INTEGER DEFAULT 0,
  trial_ends_at             DATE,
  next_billing_date         DATE,
  next_billing_amount       NUMERIC(15,2),
  razorpay_subscription_id  TEXT UNIQUE,
  razorpay_plan_id          TEXT,
  mandate_authorized_at     TIMESTAMPTZ,
  mandate_revoked_at        TIMESTAMPTZ,
  payment_method            TEXT,
  total_cycles_billed       INTEGER DEFAULT 0,
  total_amount_billed       NUMERIC(15,2) DEFAULT 0,
  failed_charge_count       INTEGER DEFAULT 0,
  last_failure_at           TIMESTAMPTZ,
  paused_at                 TIMESTAMPTZ,
  cancelled_at              TIMESTAMPTZ,
  cancellation_reason       TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by                UUID REFERENCES users (id)
);
CREATE INDEX IF NOT EXISTS invoice_subscriptions_tenant_idx ON invoice_subscriptions (tenant_id);
CREATE INDEX IF NOT EXISTS idx_invoice_subscriptions_next_billing ON invoice_subscriptions (next_billing_date)
  WHERE status IN ('ACTIVE','TRIALING');

-- ─── invoices ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoices (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                     UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  customer_id                   UUID NOT NULL REFERENCES customers (id),
  invoice_number                TEXT NOT NULL,
  quote_number                  TEXT,
  document_type                 TEXT NOT NULL DEFAULT 'INVOICE',
  status                        TEXT NOT NULL DEFAULT 'DRAFT',
  invoice_date                  DATE NOT NULL,
  due_date                      DATE NOT NULL,
  valid_until                   DATE,
  reference                     TEXT,
  fy_label                      TEXT NOT NULL,
  currency                      TEXT NOT NULL,
  fx_rate_to_inr                NUMERIC(15,6),
  subtotal                      NUMERIC(15,2) NOT NULL DEFAULT 0,
  discount_type                 TEXT,
  discount_value                NUMERIC(15,2) DEFAULT 0,
  discount_amount               NUMERIC(15,2) DEFAULT 0,
  taxable_amount                NUMERIC(15,2) NOT NULL DEFAULT 0,
  cgst_amount                   NUMERIC(15,2) DEFAULT 0,
  sgst_amount                   NUMERIC(15,2) DEFAULT 0,
  igst_amount                   NUMERIC(15,2) DEFAULT 0,
  cess_amount                   NUMERIC(15,2) DEFAULT 0,
  total_amount                  NUMERIC(15,2) NOT NULL DEFAULT 0,
  tds_section                   TEXT,
  tds_payment_code              TEXT,
  tds_rate                      NUMERIC(5,2),
  tds_amount                    NUMERIC(15,2) DEFAULT 0,
  net_receivable                NUMERIC(15,2),
  amount_paid                   NUMERIC(15,2) DEFAULT 0,
  amount_outstanding            NUMERIC(15,2),
  credit_applied                NUMERIC(15,2) DEFAULT 0,
  place_of_supply               TEXT,
  tax_treatment                 TEXT,
  reverse_charge                BOOLEAN DEFAULT FALSE,
  notes                         TEXT,
  terms_and_conditions          TEXT,
  subscription_id               UUID REFERENCES invoice_subscriptions (id),
  bank_account_id               UUID REFERENCES tenant_bank_accounts (id),
  pdf_storage_key               TEXT,
  customer_email_at_send        TEXT,
  email_sent_at                 TIMESTAMPTZ,
  email_delivered_at            TIMESTAMPTZ,
  first_viewed_at               TIMESTAMPTZ,
  last_viewed_at                TIMESTAMPTZ,
  view_count                    INTEGER DEFAULT 0,
  paid_at                       TIMESTAMPTZ,
  cancelled_at                  TIMESTAMPTZ,
  cancellation_reason           TEXT,
  voided_at                     TIMESTAMPTZ,
  refunded_at                   TIMESTAMPTZ,
  write_off_at                  TIMESTAMPTZ,
  write_off_reason              TEXT,
  public_view_token             TEXT UNIQUE,
  public_view_token_expires_at  TIMESTAMPTZ,
  invoice_template              TEXT,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by                    UUID REFERENCES users (id),
  updated_by                    UUID REFERENCES users (id)
);
CREATE UNIQUE INDEX IF NOT EXISTS invoices_tenant_number_unique ON invoices (tenant_id, invoice_number);
CREATE INDEX IF NOT EXISTS idx_invoices_tenant_status ON invoices (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_invoices_tenant_customer ON invoices (tenant_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_invoices_due_date ON invoices (tenant_id, due_date)
  WHERE status IN ('SENT','VIEWED','PARTIALLY_PAID','OVERDUE');
CREATE INDEX IF NOT EXISTS idx_invoices_public_token ON invoices (public_view_token);

-- ─── invoice_line_items ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoice_line_items (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  invoice_id       UUID NOT NULL REFERENCES invoices (id) ON DELETE CASCADE,
  line_number      INTEGER NOT NULL,
  item_id          UUID REFERENCES items (id),
  item_name        TEXT NOT NULL,
  description      TEXT,
  hsn_sac_code     TEXT,
  quantity         NUMERIC(15,4) NOT NULL,
  unit             TEXT,
  rate             NUMERIC(15,2) NOT NULL,
  gst_rate         NUMERIC(5,2) DEFAULT 0,
  cess_rate        NUMERIC(5,2) DEFAULT 0,
  line_amount      NUMERIC(15,2) DEFAULT 0,
  discount_amount  NUMERIC(15,2) DEFAULT 0,
  taxable_amount   NUMERIC(15,2) DEFAULT 0,
  cgst_amount      NUMERIC(15,2) DEFAULT 0,
  sgst_amount      NUMERIC(15,2) DEFAULT 0,
  igst_amount      NUMERIC(15,2) DEFAULT 0,
  cess_amount      NUMERIC(15,2) DEFAULT 0,
  line_total       NUMERIC(15,2) DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS invoice_line_items_unique ON invoice_line_items (invoice_id, line_number);
CREATE INDEX IF NOT EXISTS invoice_line_items_tenant_idx ON invoice_line_items (tenant_id);
CREATE INDEX IF NOT EXISTS invoice_line_items_invoice_idx ON invoice_line_items (invoice_id);

-- ─── invoice_payments ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoice_payments (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  invoice_id           UUID REFERENCES invoices (id) ON DELETE CASCADE,
  customer_id          UUID NOT NULL REFERENCES customers (id),
  payment_number       TEXT NOT NULL,
  payment_date         DATE NOT NULL,
  amount               NUMERIC(15,2) NOT NULL,
  currency             TEXT NOT NULL DEFAULT 'INR',
  payment_method       TEXT NOT NULL,
  reference_number     TEXT,
  razorpay_payment_id  TEXT,
  razorpay_order_id    TEXT,
  notes                TEXT,
  source               TEXT NOT NULL DEFAULT 'manual',
  receipt_sent         BOOLEAN DEFAULT FALSE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by           UUID REFERENCES users (id)
);
CREATE UNIQUE INDEX IF NOT EXISTS invoice_payments_number_unique ON invoice_payments (tenant_id, payment_number);
CREATE INDEX IF NOT EXISTS invoice_payments_tenant_idx ON invoice_payments (tenant_id);
CREATE INDEX IF NOT EXISTS invoice_payments_invoice_idx ON invoice_payments (invoice_id);

-- ─── invoice_subscription_line_items + proration ────────────────────────────────
CREATE TABLE IF NOT EXISTS invoice_subscription_line_items (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  subscription_id  UUID NOT NULL REFERENCES invoice_subscriptions (id) ON DELETE CASCADE,
  item_id          UUID REFERENCES items (id),
  item_name        TEXT NOT NULL,
  description      TEXT,
  hsn_sac_code     TEXT,
  quantity         NUMERIC(15,4) NOT NULL DEFAULT 1,
  unit             TEXT,
  rate             NUMERIC(15,2) NOT NULL,
  gst_rate         NUMERIC(5,2) DEFAULT 0,
  cess_rate        NUMERIC(5,2) DEFAULT 0,
  effective_from   DATE,
  effective_until  DATE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS invoice_subscription_line_items_tenant_idx ON invoice_subscription_line_items (tenant_id);
CREATE INDEX IF NOT EXISTS invoice_subscription_line_items_sub_idx ON invoice_subscription_line_items (subscription_id);

CREATE TABLE IF NOT EXISTS invoice_subscription_proration_events (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  subscription_id        UUID NOT NULL REFERENCES invoice_subscriptions (id) ON DELETE CASCADE,
  event_date             DATE NOT NULL,
  event_type             TEXT NOT NULL,
  amount                 NUMERIC(15,2) NOT NULL,
  applied_to_invoice_id  UUID REFERENCES invoices (id),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS invoice_subscription_proration_tenant_idx ON invoice_subscription_proration_events (tenant_id);
CREATE INDEX IF NOT EXISTS invoice_subscription_proration_sub_idx ON invoice_subscription_proration_events (subscription_id);

-- ─── credit_notes (+ lines) ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS credit_notes (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  invoice_id          UUID REFERENCES invoices (id),
  customer_id         UUID NOT NULL REFERENCES customers (id),
  credit_note_number  TEXT NOT NULL,
  fy_label            TEXT NOT NULL,
  credit_note_date    DATE NOT NULL,
  reason              TEXT NOT NULL,
  reason_description  TEXT,
  status              TEXT NOT NULL DEFAULT 'DRAFT',
  currency            TEXT NOT NULL DEFAULT 'INR',
  subtotal            NUMERIC(15,2) DEFAULT 0,
  taxable_amount      NUMERIC(15,2) DEFAULT 0,
  cgst_amount         NUMERIC(15,2) DEFAULT 0,
  sgst_amount         NUMERIC(15,2) DEFAULT 0,
  igst_amount         NUMERIC(15,2) DEFAULT 0,
  cess_amount         NUMERIC(15,2) DEFAULT 0,
  total_amount        NUMERIC(15,2) DEFAULT 0,
  applied_to_balance  NUMERIC(15,2) DEFAULT 0,
  refunded_amount     NUMERIC(15,2) DEFAULT 0,
  refund_reference    TEXT,
  refund_date         DATE,
  pdf_storage_key     TEXT,
  notes               TEXT,
  issued_at           TIMESTAMPTZ,
  cancelled_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by          UUID REFERENCES users (id)
);
CREATE UNIQUE INDEX IF NOT EXISTS credit_notes_number_unique ON credit_notes (tenant_id, credit_note_number);
CREATE INDEX IF NOT EXISTS credit_notes_tenant_idx ON credit_notes (tenant_id);
CREATE INDEX IF NOT EXISTS credit_notes_customer_idx ON credit_notes (customer_id);

CREATE TABLE IF NOT EXISTS credit_note_line_items (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  credit_note_id   UUID NOT NULL REFERENCES credit_notes (id) ON DELETE CASCADE,
  line_number      INTEGER NOT NULL,
  item_id          UUID REFERENCES items (id),
  item_name        TEXT NOT NULL,
  description      TEXT,
  hsn_sac_code     TEXT,
  quantity         NUMERIC(15,4) NOT NULL,
  unit             TEXT,
  rate             NUMERIC(15,2) NOT NULL,
  gst_rate         NUMERIC(5,2) DEFAULT 0,
  cess_rate        NUMERIC(5,2) DEFAULT 0,
  line_amount      NUMERIC(15,2) DEFAULT 0,
  discount_amount  NUMERIC(15,2) DEFAULT 0,
  taxable_amount   NUMERIC(15,2) DEFAULT 0,
  cgst_amount      NUMERIC(15,2) DEFAULT 0,
  sgst_amount      NUMERIC(15,2) DEFAULT 0,
  igst_amount      NUMERIC(15,2) DEFAULT 0,
  cess_amount      NUMERIC(15,2) DEFAULT 0,
  line_total       NUMERIC(15,2) DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS credit_note_line_items_unique ON credit_note_line_items (credit_note_id, line_number);
CREATE INDEX IF NOT EXISTS credit_note_line_items_tenant_idx ON credit_note_line_items (tenant_id);

-- ─── debit_notes (+ lines) ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS debit_notes (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  invoice_id          UUID REFERENCES invoices (id),
  customer_id         UUID NOT NULL REFERENCES customers (id),
  debit_note_number   TEXT NOT NULL,
  fy_label            TEXT NOT NULL,
  debit_note_date     DATE NOT NULL,
  reason              TEXT NOT NULL,
  reason_description  TEXT,
  status              TEXT NOT NULL DEFAULT 'DRAFT',
  currency            TEXT NOT NULL DEFAULT 'INR',
  subtotal            NUMERIC(15,2) DEFAULT 0,
  taxable_amount      NUMERIC(15,2) DEFAULT 0,
  cgst_amount         NUMERIC(15,2) DEFAULT 0,
  sgst_amount         NUMERIC(15,2) DEFAULT 0,
  igst_amount         NUMERIC(15,2) DEFAULT 0,
  cess_amount         NUMERIC(15,2) DEFAULT 0,
  total_amount        NUMERIC(15,2) DEFAULT 0,
  pdf_storage_key     TEXT,
  notes               TEXT,
  issued_at           TIMESTAMPTZ,
  cancelled_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by          UUID REFERENCES users (id)
);
CREATE UNIQUE INDEX IF NOT EXISTS debit_notes_number_unique ON debit_notes (tenant_id, debit_note_number);
CREATE INDEX IF NOT EXISTS debit_notes_tenant_idx ON debit_notes (tenant_id);
CREATE INDEX IF NOT EXISTS debit_notes_customer_idx ON debit_notes (customer_id);

CREATE TABLE IF NOT EXISTS debit_note_line_items (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  debit_note_id    UUID NOT NULL REFERENCES debit_notes (id) ON DELETE CASCADE,
  line_number      INTEGER NOT NULL,
  item_id          UUID REFERENCES items (id),
  item_name        TEXT NOT NULL,
  description      TEXT,
  hsn_sac_code     TEXT,
  quantity         NUMERIC(15,4) NOT NULL,
  unit             TEXT,
  rate             NUMERIC(15,2) NOT NULL,
  gst_rate         NUMERIC(5,2) DEFAULT 0,
  cess_rate        NUMERIC(5,2) DEFAULT 0,
  line_amount      NUMERIC(15,2) DEFAULT 0,
  discount_amount  NUMERIC(15,2) DEFAULT 0,
  taxable_amount   NUMERIC(15,2) DEFAULT 0,
  cgst_amount      NUMERIC(15,2) DEFAULT 0,
  sgst_amount      NUMERIC(15,2) DEFAULT 0,
  igst_amount      NUMERIC(15,2) DEFAULT 0,
  cess_amount      NUMERIC(15,2) DEFAULT 0,
  line_total       NUMERIC(15,2) DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS debit_note_line_items_unique ON debit_note_line_items (debit_note_id, line_number);
CREATE INDEX IF NOT EXISTS debit_note_line_items_tenant_idx ON debit_note_line_items (tenant_id);

-- ─── adjustments ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS adjustments (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  customer_id             UUID NOT NULL REFERENCES customers (id),
  adjustment_date         DATE NOT NULL,
  amount                  NUMERIC(15,2) NOT NULL,
  currency                TEXT NOT NULL DEFAULT 'INR',
  type                    TEXT NOT NULL,
  reason                  TEXT,
  affects_credit_balance  BOOLEAN DEFAULT FALSE,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by              UUID REFERENCES users (id)
);
CREATE INDEX IF NOT EXISTS adjustments_tenant_idx ON adjustments (tenant_id);
CREATE INDEX IF NOT EXISTS adjustments_customer_idx ON adjustments (customer_id);

-- ─── reminder_schedule + reminder_sent ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reminder_schedule (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  reminder_number         INTEGER NOT NULL,
  offset_days             INTEGER NOT NULL,
  active                  BOOLEAN NOT NULL DEFAULT TRUE,
  email_subject_template  TEXT,
  email_body_template     TEXT,
  scope                   TEXT NOT NULL DEFAULT 'tenant',
  customer_id             UUID REFERENCES customers (id) ON DELETE CASCADE,
  invoice_id              UUID REFERENCES invoices (id) ON DELETE CASCADE,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS reminder_schedule_tenant_idx ON reminder_schedule (tenant_id);
CREATE INDEX IF NOT EXISTS reminder_schedule_scope_idx ON reminder_schedule (tenant_id, scope);

CREATE TABLE IF NOT EXISTS reminder_sent (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  invoice_id       UUID NOT NULL REFERENCES invoices (id) ON DELETE CASCADE,
  reminder_number  INTEGER NOT NULL,
  offset_days      INTEGER NOT NULL,
  sent_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at     TIMESTAMPTZ,
  bounced          BOOLEAN DEFAULT FALSE
);
CREATE UNIQUE INDEX IF NOT EXISTS reminder_sent_unique ON reminder_sent (invoice_id, reminder_number);
CREATE INDEX IF NOT EXISTS reminder_sent_tenant_idx ON reminder_sent (tenant_id);

-- ─── razorpay_webhook_events (tenant_id nullable; service-role access) ──────────
CREATE TABLE IF NOT EXISTS razorpay_webhook_events (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID REFERENCES tenants (id) ON DELETE CASCADE,
  event_id            TEXT NOT NULL UNIQUE,
  event_type          TEXT NOT NULL,
  payload             JSONB,
  signature           TEXT,
  signature_verified  BOOLEAN DEFAULT FALSE,
  processed           BOOLEAN DEFAULT FALSE,
  processed_at        TIMESTAMPTZ,
  processing_error    TEXT,
  retry_count         INTEGER DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS razorpay_webhook_events_type_idx ON razorpay_webhook_events (event_type);

-- ─── gstr1_exports ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gstr1_exports (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  fy_label             TEXT NOT NULL,
  period_month         INTEGER,
  period_year          INTEGER,
  format               TEXT NOT NULL DEFAULT 'json',
  storage_key          TEXT,
  file_hash            TEXT,
  invoice_count        INTEGER DEFAULT 0,
  total_taxable_value  NUMERIC(15,2) DEFAULT 0,
  total_tax            NUMERIC(15,2) DEFAULT 0,
  b2b_count            INTEGER DEFAULT 0,
  b2cl_count           INTEGER DEFAULT 0,
  b2cs_count           INTEGER DEFAULT 0,
  export_count         INTEGER DEFAULT 0,
  cdnr_count           INTEGER DEFAULT 0,
  generated_by         UUID REFERENCES users (id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS gstr1_exports_tenant_idx ON gstr1_exports (tenant_id, fy_label);

-- ─── form_131_received (TDS Form 131 tracking) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS form_131_received (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  customer_id             UUID NOT NULL REFERENCES customers (id),
  fy_label                TEXT NOT NULL,
  quarter                 INTEGER NOT NULL,
  total_tds_amount        NUMERIC(15,2) DEFAULT 0,
  form_131_received       BOOLEAN DEFAULT FALSE,
  form_131_received_date  DATE,
  form_131_storage_key    TEXT,
  expected_invoices       UUID[],
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS form_131_received_unique ON form_131_received (tenant_id, customer_id, fy_label, quarter);
CREATE INDEX IF NOT EXISTS form_131_received_tenant_idx ON form_131_received (tenant_id);
