-- apply-0069.sql — Round R R1 (2026-10-07): policy delete + company-bound acknowledgements (0069).
-- Run once in the Supabase SQL editor (service role). Idempotent: safe to re-run.
-- Run it BEFORE pushing the API (the policies module reads company_policies.deleted_at).
-- Identical to packages/db/drizzle/0069_policy_delete_and_tenant_fk.sql.

BEGIN;

ALTER TABLE company_policies ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_company_policies_tenant_live
  ON company_policies (tenant_id) WHERE deleted_at IS NULL;

DO $fk$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'company_policies_tenant_id_id_key'
  ) THEN
    ALTER TABLE company_policies
      ADD CONSTRAINT company_policies_tenant_id_id_key UNIQUE (tenant_id, id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'policy_acknowledgements_tenant_policy_fkey'
  ) THEN
    ALTER TABLE policy_acknowledgements
      ADD CONSTRAINT policy_acknowledgements_tenant_policy_fkey
      FOREIGN KEY (tenant_id, policy_id)
      REFERENCES company_policies (tenant_id, id) ON DELETE CASCADE;
  END IF;
END
$fk$;

COMMIT;

-- Final check — every row must say OK.
SELECT check_name, CASE WHEN ok THEN 'OK' ELSE 'MISSING' END AS result
FROM (VALUES
  ('company_policies.deleted_at column',
   EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_name = 'company_policies' AND column_name = 'deleted_at')),
  ('idx_company_policies_tenant_live index',
   EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_company_policies_tenant_live')),
  ('company_policies (tenant_id, id) unique',
   EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_policies_tenant_id_id_key')),
  ('policy_acknowledgements company-bound FK',
   EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'policy_acknowledgements_tenant_policy_fkey'))
) AS checks(check_name, ok);
