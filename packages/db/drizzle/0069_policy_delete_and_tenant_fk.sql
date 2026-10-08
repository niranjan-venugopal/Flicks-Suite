-- 0069 — Round R R1: company policies can be deleted (soft) and an
-- acknowledgement can only ever point at a policy of the SAME company.
--
-- company_policies.deleted_at — Owner / HR "Delete policy": the row stays
-- (the acknowledgement rows are the company's proof of who agreed to which
-- version and when) but disappears from every list, the pending gate and
-- the reader; the PDF object is removed from storage by the API.
--
-- policy_acknowledgements (tenant_id, policy_id) → company_policies
-- (tenant_id, id): foreign-key checks bypass row-level security, so the
-- single-column FK from 0067 would have accepted another company's policy id
-- if application code ever passed one. The composite key makes the database
-- itself refuse it. Needs a matching unique on company_policies (tenant_id,
-- id) — redundant with the primary key, but required for a composite FK.
--
-- Idempotent and additive; mirrored in packages/db/src/schema/policies.ts.

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
