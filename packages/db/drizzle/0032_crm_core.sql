-- =============================================================================
-- 0032 — CRM core: pipelines, deals, products, tags, FX (PRD v5 §4, §12.1, §19.1)
-- =============================================================================
-- Additive + idempotent. Seeds a default "Sales" pipeline + stages + lost
-- reasons (Appendix B) for every existing tenant that lacks one; onboarding
-- seeds the same for new tenants.
-- =============================================================================

-- ─── fx_rates: real multi-currency (§12.1) ───────────────────────────────────
-- USD-based daily rates from openexchangerates; cross-rates computed in app.
CREATE TABLE IF NOT EXISTS fx_rates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  base        char(3) NOT NULL DEFAULT 'USD',
  quote       char(3) NOT NULL,               -- ISO-4217
  rate        numeric(18,8) NOT NULL,          -- 1 base = <rate> quote
  as_of       date NOT NULL,
  fetched_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_fx_rate_day ON fx_rates (base, quote, as_of);
CREATE INDEX IF NOT EXISTS idx_fx_rate_latest ON fx_rates (quote, as_of DESC);
-- Global reference data (no tenant_id): readable by the app role, writable
-- only by the service-role refresh job.
ALTER TABLE fx_rates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fx_rates_read ON fx_rates;
CREATE POLICY fx_rates_read ON fx_rates FOR SELECT USING (true);
GRANT SELECT ON fx_rates TO flicks_app;
REVOKE INSERT, UPDATE, DELETE ON fx_rates FROM flicks_app;

-- ─── pipelines & stages ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pipelines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          text NOT NULL,
  display_order smallint NOT NULL DEFAULT 0,
  is_default    boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);
CREATE INDEX IF NOT EXISTS idx_pipelines_tenant ON pipelines (tenant_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS pipeline_stages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  pipeline_id     uuid NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  name            text NOT NULL,
  display_order   smallint NOT NULL,
  win_probability smallint NOT NULL DEFAULT 0 CHECK (win_probability BETWEEN 0 AND 100),
  rotting_days    smallint,
  stage_type      text NOT NULL DEFAULT 'open' CHECK (stage_type IN ('open','won','lost')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
CREATE INDEX IF NOT EXISTS idx_stages_pipeline ON pipeline_stages (tenant_id, pipeline_id, display_order);

-- ─── deals ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS deals (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  pipeline_id        uuid NOT NULL REFERENCES pipelines(id),
  stage_id           uuid NOT NULL REFERENCES pipeline_stages(id),
  title              text NOT NULL,
  company_id         uuid REFERENCES directory_companies(id),
  primary_person_id  uuid REFERENCES directory_people(id),
  owner_user_id      uuid NOT NULL REFERENCES users(id),
  value_amount       numeric(15,2) NOT NULL DEFAULT 0,
  currency           char(3) NOT NULL,
  fx_rate_to_base    numeric(15,6) NOT NULL DEFAULT 1,
  value_base_amount  numeric(15,2) NOT NULL DEFAULT 0,
  expected_close_date date,
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open','won','lost')),
  won_at             timestamptz, lost_at timestamptz,
  lost_reason_id     uuid, lost_reason_note text,
  source             text,
  score              int,
  stage_entered_at   timestamptz NOT NULL DEFAULT now(),
  next_activity_at   timestamptz,
  last_activity_at   timestamptz,
  invoice_id         uuid,
  custom             jsonb NOT NULL DEFAULT '{}',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  deleted_at         timestamptz
);
CREATE INDEX IF NOT EXISTS idx_deals_board ON deals (tenant_id, pipeline_id, stage_id)
  WHERE deleted_at IS NULL AND status = 'open';
CREATE INDEX IF NOT EXISTS idx_deals_owner ON deals (tenant_id, owner_user_id, status);
CREATE INDEX IF NOT EXISTS idx_deals_close ON deals (tenant_id, expected_close_date) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_deals_custom ON deals USING gin (custom);

CREATE TABLE IF NOT EXISTS deal_people (
  deal_id   uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  person_id uuid NOT NULL REFERENCES directory_people(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  role      text,
  PRIMARY KEY (deal_id, person_id)
);

CREATE TABLE IF NOT EXISTS deal_stage_history (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  deal_id       uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  from_stage_id uuid, to_stage_id uuid NOT NULL,
  changed_by    uuid REFERENCES users(id),
  changed_at    timestamptz NOT NULL DEFAULT now(),
  seconds_in_previous_stage bigint
);
CREATE INDEX IF NOT EXISTS idx_stage_history_deal ON deal_stage_history (tenant_id, deal_id, changed_at);

CREATE TABLE IF NOT EXISTS lost_reasons (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  label         text NOT NULL,
  display_order smallint DEFAULT 0,
  archived      boolean DEFAULT false
);

CREATE TABLE IF NOT EXISTS deal_products (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  deal_id       uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  item_id       uuid REFERENCES items(id),
  name          text NOT NULL,
  quantity      numeric(15,4) NOT NULL DEFAULT 1,
  unit_price    numeric(15,2) NOT NULL,
  currency      char(3) NOT NULL,
  discount_pct  numeric(5,2) DEFAULT 0,
  line_total    numeric(15,2) NOT NULL,
  display_order smallint DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_deal_products_deal ON deal_products (tenant_id, deal_id);

-- Invoicing back-link (non-breaking).
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS deal_id uuid REFERENCES deals(id);

-- ─── tags / record_tags (§19.1) ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tags (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  label      text NOT NULL,
  color      text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tag_label ON tags (tenant_id, lower(label));

CREATE TABLE IF NOT EXISTS record_tags (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tag_id      uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  object_type text NOT NULL CHECK (object_type IN ('person','company','deal','lead')),
  object_id   uuid NOT NULL,
  PRIMARY KEY (tenant_id, tag_id, object_type, object_id)
);
CREATE INDEX IF NOT EXISTS idx_record_tags_object ON record_tags (tenant_id, object_type, object_id);

-- ─── RLS (tenant isolation on every CRM table) ───────────────────────────────
DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'pipelines','pipeline_stages','deals','deal_people','deal_stage_history',
    'lost_reasons','deal_products','tags','record_tags'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_%I ON %I', t, t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation_%I ON %I FOR ALL '
      'USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) '
      'WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)', t, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO flicks_app', t);
  END LOOP;
END
$rls$;

-- ─── seed default pipeline/stages/lost reasons per tenant (Appendix B) ────────
DO $seed$
DECLARE tn RECORD; v_pipeline uuid;
BEGIN
  FOR tn IN SELECT id FROM tenants LOOP
    -- Skip tenants that already have a pipeline (idempotent).
    IF EXISTS (SELECT 1 FROM pipelines WHERE tenant_id = tn.id AND deleted_at IS NULL) THEN
      CONTINUE;
    END IF;
    INSERT INTO pipelines (tenant_id, name, is_default, display_order)
    VALUES (tn.id, 'Sales', true, 0) RETURNING id INTO v_pipeline;
    INSERT INTO pipeline_stages (tenant_id, pipeline_id, name, display_order, win_probability, rotting_days, stage_type) VALUES
      (tn.id, v_pipeline, 'Qualified',       0, 10,  NULL, 'open'),
      (tn.id, v_pipeline, 'Contact Made',    1, 25,  NULL, 'open'),
      (tn.id, v_pipeline, 'Demo Scheduled',  2, 40,  7,    'open'),
      (tn.id, v_pipeline, 'Proposal Sent',   3, 60,  10,   'open'),
      (tn.id, v_pipeline, 'Negotiation',     4, 80,  10,   'open'),
      (tn.id, v_pipeline, 'Won',             5, 100, NULL, 'won'),
      (tn.id, v_pipeline, 'Lost',            6, 0,   NULL, 'lost');
    INSERT INTO lost_reasons (tenant_id, label, display_order) VALUES
      (tn.id, 'Price', 0), (tn.id, 'Competitor', 1), (tn.id, 'No budget', 2),
      (tn.id, 'No response', 3), (tn.id, 'Bad timing', 4), (tn.id, 'Not a fit', 5);
  END LOOP;
END
$seed$;

-- CRM module toggle default-enabled marker (guard already defaults on; this
-- makes the state explicit and visible in the FAM console).
INSERT INTO tenant_module_toggles (tenant_id, module, enabled)
SELECT id, 'crm', true FROM tenants
ON CONFLICT (tenant_id, module) DO NOTHING;

-- ─── Deal→invoice idempotency guards (review finding M5) ──────────────────────
-- Defense-in-depth so a repeated deal→invoice call (double-click, retry, race)
-- can never fan out duplicates: at most ONE billing customer per directory link,
-- and at most ONE invoice per deal. The service also short-circuits on the
-- deal↔invoice back-link; these make the invariant true at the storage layer.
CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_directory_company
  ON customers (tenant_id, directory_company_id)
  WHERE directory_company_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_directory_person
  ON customers (tenant_id, directory_person_id)
  WHERE directory_person_id IS NOT NULL AND deleted_at IS NULL;
-- One invoice AND one quote per deal (document_type keyed) — a deal legitimately
-- produces a quote and, separately, an invoice, but never two of the same kind.
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_deal_doc
  ON invoices (tenant_id, deal_id, document_type)
  WHERE deal_id IS NOT NULL;
