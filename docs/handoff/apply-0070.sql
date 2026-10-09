-- apply-0070.sql — Round R R2 (2026-10-09): FAM support console (0070).
-- Run once in the Supabase SQL editor (service role). Idempotent: safe to re-run.
-- Run it BEFORE pushing the API (the API reads tenants.status_before_suspend
-- and refresh_tokens.mfa from its first request).
-- Identical to packages/db/drizzle/0070_fam_support_console.sql.
--
-- The first statement adds an enum value and must run OUTSIDE the transaction
-- below (Postgres refuses to use a new enum label inside the transaction that
-- added it). Supabase runs this whole paste as one script — that is fine.

ALTER TYPE auth_event_type ADD VALUE IF NOT EXISTS 'tenant_selected';

BEGIN;

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS status_before_suspend tenant_status;

ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS mfa boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS fam_tenant_notes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  author_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  body           text NOT NULL,
  pinned         boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);

CREATE INDEX IF NOT EXISTS idx_fam_tenant_notes_tenant_created
  ON fam_tenant_notes (tenant_id, created_at DESC);

ALTER TABLE fam_tenant_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE fam_tenant_notes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS service_role_only_fam_tenant_notes ON fam_tenant_notes;
CREATE POLICY service_role_only_fam_tenant_notes ON fam_tenant_notes
  FOR ALL USING (false) WITH CHECK (false);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flicks_app') THEN
    EXECUTE 'REVOKE ALL ON fam_tenant_notes FROM flicks_app';
  END IF;
END $$;

ALTER TABLE coupon_redemptions DROP CONSTRAINT IF EXISTS coupon_redemptions_tenant_once;
CREATE UNIQUE INDEX IF NOT EXISTS coupon_redemptions_tenant_coupon_unique
  ON coupon_redemptions (tenant_id, coupon_id);

COMMIT;

-- Verification — every row must say OK.
SELECT check_name,
       CASE WHEN ok THEN 'OK' ELSE 'MISSING' END AS result
FROM (VALUES
  ('auth_event_type has tenant_selected',
     EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
             WHERE t.typname = 'auth_event_type' AND e.enumlabel = 'tenant_selected')),
  ('tenants.status_before_suspend',
     EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'tenants' AND column_name = 'status_before_suspend')),
  ('refresh_tokens.mfa',
     EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'refresh_tokens' AND column_name = 'mfa')),
  ('fam_tenant_notes table',
     EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'fam_tenant_notes')),
  ('fam_tenant_notes deny-all policy',
     EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'fam_tenant_notes'
             AND policyname = 'service_role_only_fam_tenant_notes')),
  ('coupon_redemptions (tenant, coupon) unique',
     EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'coupon_redemptions_tenant_coupon_unique'))
) AS checks(check_name, ok);
