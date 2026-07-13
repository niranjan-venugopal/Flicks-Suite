-- Migration 0033 — CRM views, custom fields, files (PRD v5 §9.1-9.2, §19.2)
--                  + deal→quote support (§4.4 / §19.3)
--
-- Sprint 27. Idempotent + additive (IF NOT EXISTS) per house convention. Built
-- in chunks; this file grows as the sprint lands each feature. Every new table
-- gets FORCE RLS + a tenant-isolation policy + flicks_app grants + joins the
-- isolation suite in the same sprint.

-- ─── Deal → quote (§4.4 / §19.3) ──────────────────────────────────────────────
-- A deal may generate a quote (an invoices row, document_type='QUOTE') and,
-- separately, an invoice. When the customer accepts the quote on the hosted
-- page, the deal can auto-advance to a pipeline-configured stage.

-- Per-pipeline "on quote accepted, move the deal to this stage" (§19.3). NULL =
-- leave the deal where it is.
ALTER TABLE pipelines ADD COLUMN IF NOT EXISTS quote_accepted_stage_id uuid;

-- Deal → quote back-link (mirrors deals.invoice_id).
ALTER TABLE deals ADD COLUMN IF NOT EXISTS quote_id uuid;

-- Quote acceptance audit timestamp (the ACCEPTED status lives in invoices.status).
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS quote_accepted_at timestamptz;

-- ─── Custom fields (§9.1) ─────────────────────────────────────────────────────
-- Definitions live here; VALUES live in the object's existing `custom` jsonb
-- (deals.custom, directory_companies.custom, directory_people.custom) — no
-- per-value table needed.
CREATE TABLE IF NOT EXISTS custom_field_defs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  object_type  text NOT NULL CHECK (object_type IN ('deal','person','company','lead')),
  key          text NOT NULL,
  label        text NOT NULL,
  field_type   text NOT NULL CHECK (field_type IN ('text','number','date','select','multiselect','checkbox','url')),
  options      jsonb NOT NULL DEFAULT '[]',
  is_required  boolean NOT NULL DEFAULT false,
  display_order smallint NOT NULL DEFAULT 0,
  archived     boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_custom_field_key
  ON custom_field_defs (tenant_id, object_type, key) WHERE archived = false;

-- ─── Saved views (§9.2) ───────────────────────────────────────────────────────
-- A named filter/sort/column set on a list or board. Private to the owner unless
-- is_shared; RLS keeps it tenant-scoped, the service enforces owner-vs-shared.
CREATE TABLE IF NOT EXISTS saved_views (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  object_type   text NOT NULL CHECK (object_type IN ('deal','person','company','lead')),
  name          text NOT NULL,
  owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  is_shared     boolean NOT NULL DEFAULT false,
  filters       jsonb NOT NULL DEFAULT '{}',
  sort          jsonb NOT NULL DEFAULT '{}',
  columns       jsonb NOT NULL DEFAULT '[]',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_saved_views_scope ON saved_views (tenant_id, object_type);

-- ─── Record files / attachments (§19.2) ───────────────────────────────────────
-- Table lands now (joins the isolation suite); the generalized magic-byte upload
-- service is built in Phase C alongside email attachments (shared surface).
CREATE TABLE IF NOT EXISTS record_files (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  object_type  text NOT NULL CHECK (object_type IN ('deal','person','company','lead')),
  object_id    uuid NOT NULL,
  file_name    text NOT NULL,
  mime_type    text NOT NULL,
  size_bytes   bigint NOT NULL,
  storage_key  text NOT NULL,
  uploaded_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);
CREATE INDEX IF NOT EXISTS idx_record_files_object
  ON record_files (tenant_id, object_type, object_id) WHERE deleted_at IS NULL;

-- ─── RLS for the new tables (FORCE + tenant isolation + app grants) ───────────
DO $v5views$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['custom_field_defs','saved_views','record_files'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_%I ON %I', t, t);
    EXECUTE format('CREATE POLICY tenant_isolation_%I ON %I FOR ALL USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)', t, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO flicks_app', t);
  END LOOP;
END
$v5views$;
