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
