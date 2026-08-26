-- 0053 — Soft delete for leads and web forms (Round 9, founder item 3)
--
-- Every other CRM entity (contacts, companies, deals, activities) soft-deletes
-- via a `deleted_at` column; leads and web_forms had no delete path at all —
-- leads only had status='discarded', forms only an active toggle, and the
-- unique form-name index burned a name forever. This brings both in line so
-- an Owner can actually remove junk records.
--
-- Idempotent + additive, per house rules.

ALTER TABLE leads ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE web_forms ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- Recreate the form-name uniqueness as a PARTIAL unique index so deleting a
-- form frees its name for reuse (mirrors uq_dir_company_domain's pattern).
DO $r9$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE indexname = 'uq_web_form_name'
       AND indexdef NOT LIKE '%deleted_at IS NULL%'
  ) THEN
    DROP INDEX uq_web_form_name;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uq_web_form_name') THEN
    CREATE UNIQUE INDEX uq_web_form_name
      ON web_forms (tenant_id, lower(name))
      WHERE deleted_at IS NULL;
  END IF;
END
$r9$;

-- Partial indexes so the hot list queries skip deleted rows the same way the
-- rest of CRM does.
CREATE INDEX IF NOT EXISTS idx_leads_tenant_status_live
  ON leads (tenant_id, status)
  WHERE deleted_at IS NULL;
