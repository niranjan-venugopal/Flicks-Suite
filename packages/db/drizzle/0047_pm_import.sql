-- 0047: PM importers (PRD v6 §14) — batch stamping + external-id dedupe.
-- Idempotent: safe to re-run. The import_batches CHECK already knows
-- 'pm_issues'/'pm_projects' (0044).

-- Batch stamp → 24h undo retracts exactly the imported rows (0037 pattern).
ALTER TABLE pm_issues ADD COLUMN IF NOT EXISTS import_batch_id UUID;
ALTER TABLE pm_projects ADD COLUMN IF NOT EXISTS import_batch_id UUID;
CREATE INDEX IF NOT EXISTS idx_pm_issues_import_batch
  ON pm_issues (import_batch_id) WHERE import_batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pm_projects_import_batch
  ON pm_projects (import_batch_id) WHERE import_batch_id IS NOT NULL;

-- external_ref = '<source>:<external id>' (e.g. 'linear:ENG-142',
-- 'jira:PROJ-9') — re-running an import is idempotent per tenant.
ALTER TABLE pm_issues ADD COLUMN IF NOT EXISTS external_ref TEXT;
ALTER TABLE pm_projects ADD COLUMN IF NOT EXISTS external_ref TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_pm_issues_external_ref
  ON pm_issues (tenant_id, external_ref) WHERE external_ref IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_pm_projects_external_ref
  ON pm_projects (tenant_id, external_ref) WHERE external_ref IS NOT NULL;
