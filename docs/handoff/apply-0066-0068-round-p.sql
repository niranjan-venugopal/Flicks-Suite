-- apply-0066-0068-round-p.sql — Round P R2 + R3 + R4 in ONE file (2026-10-06).
--
-- What it does, in order:
--   0066  Invoice numbering: adds invoice_sequences.series_mode
--         (Financial-year vs Continuous series).
--   0067  Company policies: creates company_policies + policy_acknowledgements.
--   0068  Asset register: creates assets + asset_assignments.
--
-- How to run: Supabase → SQL editor → paste this whole file → Run.
--   * Run it BEFORE pushing the API to `production`.
--   * One transaction: either everything is applied or nothing is (any error
--     rolls the whole file back and leaves the database as it was).
--   * Safe to run again: every statement is idempotent (IF NOT EXISTS / guarded).
--   * Expect a few "already exists, skipping" notices on a re-run — harmless.
--   * The last statement prints a check table; every row should say OK.
--
-- Identical, statement for statement, to docs/handoff/apply-0066.sql,
-- apply-0067.sql and apply-0068.sql (and packages/db/drizzle/0066–0068).

BEGIN;

-- ════════════════════════════════════════════════════════════════════════
-- 0066
-- ════════════════════════════════════════════════════════════════════════
-- apply-0066.sql — Round P R2 (2026-10-05): invoice numbering series mode — invoice_sequences.series_mode (0066).
-- Run once in the Supabase SQL editor (service role). Idempotent: safe to re-run.
-- Run it BEFORE pushing the API (numbering.service selects the whole invoice_sequences row and writes series_mode).
-- Identical to packages/db/drizzle/0066_invoice_sequences_series_mode.sql.

-- 0066 — Round P R2: invoice numbering series mode (invoice_sequences.series_mode).
--
-- invoice_sequences.series_mode — per document type, how the number series
-- behaves across financial years:
--   'fiscal_year' (default, today's behaviour) — PREFIX{sep}FY{sep}NNNN, the
--     counter restarts at starting_number on the first day of each FY;
--   'continuous' — PREFIX{sep?}NNNNN, never resets (e.g. LB2400001).
-- The current-FY row keeps holding the config (prefix, separator, zero_padding,
-- starting_number, series_mode) and FY rollover copies it forward, so the mode
-- survives April 1 with no special case. The continuous counter lives in ONE
-- sentinel row per (tenant, document_type, branch): fy_label = 'ALL',
-- fy_start_date = the day the mode was first enabled, fy_end_date =
-- '9999-12-31', series_mode = 'continuous' — the existing unique index
-- (tenant_id, document_type, fy_label, branch_code) already guarantees a
-- single such row. invoices.fy_label still records the invoice's own FY, so
-- GSTR-1 period grouping is unchanged in either mode.
--
-- Guarded CHECK (0062/0064/0065 pattern). The table already has FORCE RLS,
-- the tenant_isolation policy and the flicks_app grants from 0012/0014 —
-- table-level grants cover the new column, so no policy or grant changes.
-- Idempotent and additive; mirrored in packages/db/src/schema/invoicing.ts.
--
-- Release ordering: numbering.service selects the whole invoice_sequences row
-- and writes series_mode on every save, so an API built with the mirror fails
-- on the Numbering tab (and on invoice creation) until this has run — apply in
-- Supabase BEFORE pushing the API.

-- 1. Column (existing rows backfill to today's behaviour).
ALTER TABLE invoice_sequences
  ADD COLUMN IF NOT EXISTS series_mode text NOT NULL DEFAULT 'fiscal_year';

-- 2. Guarded CHECK constraint.
DO $chk$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'invoice_sequences_series_mode_check'
  ) THEN
    ALTER TABLE invoice_sequences
      ADD CONSTRAINT invoice_sequences_series_mode_check
      CHECK (series_mode IN ('fiscal_year', 'continuous'));
  END IF;
END
$chk$;

-- ════════════════════════════════════════════════════════════════════════
-- 0067
-- ════════════════════════════════════════════════════════════════════════
-- apply-0067.sql — Round P R3 (2026-10-05): company policies + acknowledgements (0067).
-- Run once in the Supabase SQL editor (service role). Idempotent: safe to re-run.
-- Run it BEFORE pushing the API (the policies module selects whole rows from both new tables).
-- Identical to packages/db/drizzle/0067_company_policies.sql.

-- 0067 — Round P R3: company policies + acknowledgements (new module `policies`).
--
-- company_policies — one row per policy. HR/Owner (or anyone holding the
-- 'policies' module grant) writes it as rich text (body_md, cleaned server-side)
-- OR uploads a PDF (file_* columns; the object lives in private R2 under
-- tenants/<tenant>/policies/<policy>/<uuid>.pdf). `version` starts at 1 and
-- only moves when a PUBLISHED policy is re-published with "ask everyone to
-- agree again" — editing the body of a published policy keeps the version.
-- `applies_to_roles` NULL = every standard role (owner/admin/manager/finance/
-- employee); guest/auditor/fam seats are never asked. `last_reminded_at` is
-- the 1-per-hour throttle marker for POST /policies/:id/remind (an
-- updated_at-style column rather than an audit-log probe, so the throttle
-- holds even where the audit trail is pruned or stubbed).
--
-- policy_acknowledgements — one row per (policy, version, user); the UNIQUE
-- makes the acknowledge call idempotent (INSERT … ON CONFLICT DO NOTHING).
-- employee_id is the caller's employee record when the seat has one (NULL for
-- owner seats without a record); ip_hash = sha256(ip + server salt), never the
-- raw IP, mirroring the consent ledger.
--
-- Both tables: ENABLE + FORCE RLS, tenant_isolation_* policy on
-- current_setting('app.tenant_id') and grants to flicks_app (0037/0061 loop).
-- Idempotent and additive; mirrored in packages/db/src/schema/policies.ts.
--
-- Release ordering: the API module selects whole rows from both tables, so
-- apply this in Supabase BEFORE pushing the API.

-- 1. company_policies
CREATE TABLE IF NOT EXISTS company_policies (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title                     text NOT NULL,
  category                  text,
  kind                      text NOT NULL DEFAULT 'rich_text'
                              CONSTRAINT company_policies_kind_chk CHECK (kind IN ('rich_text', 'pdf')),
  body_md                   text,
  file_key                  text,
  file_name                 text,
  file_size_bytes           integer,
  file_sha256               text,
  version                   integer NOT NULL DEFAULT 1,
  status                    text NOT NULL DEFAULT 'draft'
                              CONSTRAINT company_policies_status_chk CHECK (status IN ('draft', 'published', 'archived')),
  requires_acknowledgement  boolean NOT NULL DEFAULT true,
  applies_to_roles          text[],
  published_at              timestamptz,
  published_by              uuid REFERENCES users(id) ON DELETE SET NULL,
  archived_at               timestamptz,
  last_reminded_at          timestamptz,
  created_by                uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by                uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

-- Re-runs against a table created by an earlier draft of this file.
ALTER TABLE company_policies ADD COLUMN IF NOT EXISTS last_reminded_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_company_policies_tenant_status
  ON company_policies (tenant_id, status);

-- 2. policy_acknowledgements
CREATE TABLE IF NOT EXISTS policy_acknowledgements (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  policy_id        uuid NOT NULL REFERENCES company_policies(id) ON DELETE CASCADE,
  policy_version   integer NOT NULL,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  employee_id      uuid REFERENCES employees(id) ON DELETE SET NULL,
  acknowledged_at  timestamptz NOT NULL DEFAULT now(),
  ip_hash          text,
  user_agent       text,
  CONSTRAINT policy_acknowledgements_tenant_policy_version_user_key
    UNIQUE (tenant_id, policy_id, policy_version, user_id)
);

CREATE INDEX IF NOT EXISTS idx_policy_acknowledgements_user
  ON policy_acknowledgements (tenant_id, user_id);

-- 3. RLS + grants (0037/0061 loop).
DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['company_policies', 'policy_acknowledgements'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_%I ON %I', t, t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation_%I ON %I FOR ALL USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)',
      t, t
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO flicks_app', t);
  END LOOP;
END
$rls$;

-- ════════════════════════════════════════════════════════════════════════
-- 0068
-- ════════════════════════════════════════════════════════════════════════
-- apply-0068.sql — Round P R4 (2026-10-05): company asset register (0068).
-- Run once in the Supabase SQL editor (service role). Idempotent: safe to re-run.
-- Run it BEFORE pushing the API (the assets module selects whole rows from both new tables).
-- Identical to packages/db/drizzle/0068_assets.sql.

-- 0068 — Round P R4: company asset register (new module `assets`).
--
-- assets — one row per piece of company equipment (laptop, phone, SIM, ID
-- card, …). HR/Owner registers it with a tag (unique per tenant among live
-- rows; the server suggests the next AST-NNNN), a photo (private R2 key
-- tenants/<tenant>/assets/<asset>/photo_<uuid>_256.webp — the 64 px variant
-- derives from it, same as avatars), serial/brand/model, purchase info,
-- `condition` and a lifecycle `status`. `assigned` is never set by hand: it
-- follows the open assignment row. Soft-deleted rows keep `deleted_at` so an
-- old tag can be reused and history stays readable.
--
-- asset_assignments — who holds it. At most ONE open row per asset (partial
-- unique on asset_id WHERE returned_at IS NULL). The employee acknowledges
-- receipt from "My assets" (acknowledged_at); HR records the return with the
-- condition it came back in. Returned rows are the asset's history and the
-- employee's "ever held" record — the employees module counts them in the
-- removal footprint so a person with any equipment history is archived,
-- never hard-deleted.
--
-- Both tables: ENABLE + FORCE RLS, tenant_isolation_* policy on
-- current_setting('app.tenant_id') and grants to flicks_app (0037/0061 loop).
-- Idempotent and additive; mirrored in packages/db/src/schema/assets.ts.
--
-- Release ordering: the API module selects whole rows from both tables, so
-- apply this in Supabase BEFORE pushing the API.

-- 1. assets
CREATE TABLE IF NOT EXISTS assets (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  asset_tag          text NOT NULL,
  name               text NOT NULL,
  category           text NOT NULL DEFAULT 'other'
                       CONSTRAINT assets_category_chk CHECK (category IN (
                         'laptop', 'desktop', 'monitor', 'phone', 'sim', 'tablet', 'id_card',
                         'access_card', 'keys', 'peripheral', 'furniture', 'vehicle', 'other')),
  brand              text,
  model              text,
  serial_number      text,
  photo_key          text,
  photo_updated_at   timestamptz,
  purchase_date      date,
  purchase_value     numeric(15, 2),
  currency           text NOT NULL DEFAULT 'INR',
  condition          text NOT NULL DEFAULT 'good'
                       CONSTRAINT assets_condition_chk CHECK (condition IN ('new', 'good', 'fair', 'poor', 'damaged')),
  status             text NOT NULL DEFAULT 'in_stock'
                       CONSTRAINT assets_status_chk CHECK (status IN ('in_stock', 'assigned', 'under_repair', 'retired', 'lost')),
  notes              text,
  created_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz
);

-- A tag is unique among LIVE rows, so a retired-and-deleted laptop's tag can
-- be reused on its replacement.
CREATE UNIQUE INDEX IF NOT EXISTS assets_tenant_tag_unique
  ON assets (tenant_id, asset_tag) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_assets_tenant_status
  ON assets (tenant_id, status);

-- 2. asset_assignments
CREATE TABLE IF NOT EXISTS asset_assignments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  asset_id          uuid NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  employee_id       uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  assigned_at       timestamptz NOT NULL DEFAULT now(),
  assigned_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  issue_condition   text
                      CONSTRAINT asset_assignments_issue_condition_chk
                      CHECK (issue_condition IS NULL OR issue_condition IN ('new', 'good', 'fair', 'poor', 'damaged')),
  notes             text,
  acknowledged_at   timestamptz,
  returned_at       timestamptz,
  returned_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  return_condition  text
                      CONSTRAINT asset_assignments_return_condition_chk
                      CHECK (return_condition IS NULL OR return_condition IN ('new', 'good', 'fair', 'poor', 'damaged')),
  return_notes      text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- One holder at a time.
CREATE UNIQUE INDEX IF NOT EXISTS asset_assignments_open_unique
  ON asset_assignments (asset_id) WHERE returned_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_asset_assignments_tenant_employee
  ON asset_assignments (tenant_id, employee_id);
CREATE INDEX IF NOT EXISTS idx_asset_assignments_tenant_asset
  ON asset_assignments (tenant_id, asset_id);

-- 3. RLS + grants (0037/0061 loop).
DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['assets', 'asset_assignments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_%I ON %I', t, t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation_%I ON %I FOR ALL USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)',
      t, t
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO flicks_app', t);
  END LOOP;
END
$rls$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════════
-- Check: every row should say OK.
-- ════════════════════════════════════════════════════════════════════════════
SELECT check_name, CASE WHEN ok THEN 'OK' ELSE 'MISSING' END AS result
FROM (
  VALUES
    ('0066 invoice_sequences.series_mode column',
       EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = 'invoice_sequences' AND column_name = 'series_mode')),
    ('0066 series_mode check constraint',
       EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoice_sequences_series_mode_check')),
    ('0067 company_policies table, RLS forced',
       EXISTS (SELECT 1 FROM pg_class WHERE relname = 'company_policies' AND relrowsecurity AND relforcerowsecurity)),
    ('0067 policy_acknowledgements table, RLS forced',
       EXISTS (SELECT 1 FROM pg_class WHERE relname = 'policy_acknowledgements' AND relrowsecurity AND relforcerowsecurity)),
    ('0067 tenant isolation policies',
       (SELECT count(*) FROM pg_policy WHERE polname IN ('tenant_isolation_company_policies', 'tenant_isolation_policy_acknowledgements')) = 2),
    ('0068 assets table, RLS forced',
       EXISTS (SELECT 1 FROM pg_class WHERE relname = 'assets' AND relrowsecurity AND relforcerowsecurity)),
    ('0068 asset_assignments table, RLS forced',
       EXISTS (SELECT 1 FROM pg_class WHERE relname = 'asset_assignments' AND relrowsecurity AND relforcerowsecurity)),
    ('0068 tenant isolation policies',
       (SELECT count(*) FROM pg_policy WHERE polname IN ('tenant_isolation_assets', 'tenant_isolation_asset_assignments')) = 2),
    ('0068 one open assignment per asset (unique index)',
       EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'asset_assignments_open_unique')),
    ('app role can use the four new tables',
       has_table_privilege('flicks_app', 'company_policies', 'SELECT,INSERT,UPDATE,DELETE')
       AND has_table_privilege('flicks_app', 'policy_acknowledgements', 'SELECT,INSERT,UPDATE,DELETE')
       AND has_table_privilege('flicks_app', 'assets', 'SELECT,INSERT,UPDATE,DELETE')
       AND has_table_privilege('flicks_app', 'asset_assignments', 'SELECT,INSERT,UPDATE,DELETE'))
) AS checks(check_name, ok);
