-- Migration 0037 — CRM Reports/Goals + Import/Merge + Sample data (PRD v5
-- §10, §19.6/§19.7, C14–C17, C22 — Sprint 31, beta gate).
-- Idempotent + additive per house convention; tenant tables get FORCE RLS +
-- isolation policy + flicks_app grants.

-- §19.6 goals: monthly won-revenue targets, per user or team (user_id NULL).
CREATE TABLE IF NOT EXISTS sales_goals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid REFERENCES users(id) ON DELETE CASCADE,  -- NULL = whole team
  period      text NOT NULL,                                -- 'YYYY-MM'
  target_base numeric(14,2) NOT NULL,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (period ~ '^[0-9]{4}-[0-9]{2}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_goal
  ON sales_goals (tenant_id, period, coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- C14 import: one row per run; created record ids are stamped with the batch
-- so the 24h undo window can retract exactly what the batch created.
CREATE TABLE IF NOT EXISTS import_batches (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  object_type   text NOT NULL CHECK (object_type IN ('people','companies','leads')),
  file_name     text,
  rows_read     integer NOT NULL DEFAULT 0,
  rows_created  integer NOT NULL DEFAULT 0,
  rows_updated  integer NOT NULL DEFAULT 0,
  rows_skipped  integer NOT NULL DEFAULT 0,
  errors        jsonb NOT NULL DEFAULT '[]',   -- [{row, error}] first 200
  status        text NOT NULL DEFAULT 'done' CHECK (status IN ('done','undone')),
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  undone_at     timestamptz
);
CREATE INDEX IF NOT EXISTS idx_import_batches ON import_batches (tenant_id, created_at DESC);

ALTER TABLE directory_people    ADD COLUMN IF NOT EXISTS import_batch_id uuid;
ALTER TABLE directory_companies ADD COLUMN IF NOT EXISTS import_batch_id uuid;
ALTER TABLE leads               ADD COLUMN IF NOT EXISTS import_batch_id uuid;

-- C15 merge tombstones: the loser row is soft-deleted and points at the
-- survivor so stale links/ids can be redirected.
ALTER TABLE directory_people    ADD COLUMN IF NOT EXISTS merged_into_id uuid REFERENCES directory_people(id) ON DELETE SET NULL;
ALTER TABLE directory_companies ADD COLUMN IF NOT EXISTS merged_into_id uuid REFERENCES directory_companies(id) ON DELETE SET NULL;

-- C22 sample data: remember exactly what the demo pack created so the toggle
-- can remove it cleanly.
CREATE TABLE IF NOT EXISTS sample_packs (
  tenant_id  uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  record_ids jsonb NOT NULL DEFAULT '{}',      -- {table: [ids]}
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $rpt$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sales_goals','import_batches','sample_packs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_%I ON %I', t, t);
    EXECUTE format('CREATE POLICY tenant_isolation_%I ON %I FOR ALL USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)', t, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO flicks_app', t);
  END LOOP;
END
$rpt$;
