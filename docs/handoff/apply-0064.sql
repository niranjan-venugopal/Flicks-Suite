-- apply-0064.sql — Round M (2026-09-17): project priority + insights defaults, milestone descriptions, update snapshots (0064).
-- Run once in the Supabase SQL editor (service role). Idempotent: safe to re-run.
-- Identical to packages/db/drizzle/0064_pm_project_priority_updates.sql.

-- 0064 — Round M: project priority, insights defaults, milestone descriptions,
-- update snapshots.
--
-- 1. pm_projects.priority — the issue scale (0 none · 1 urgent · 2 high ·
--    3 medium · 4 low), default 0 so every existing project reads "No
--    priority". Guarded CHECK mirrors pm_issues.priority (0041).
-- 2. pm_projects.insights_default — the project's saved Insights panel
--    config ({measure, slice, segment}); NULL = the shared default
--    (PM_INSIGHTS_DEFAULT in packages/shared/src/pm).
-- 3. pm_project_milestones.description_md — optional markdown body.
-- 4. pm_project_updates.snapshot — the project state captured when the update
--    was posted (progress, props, milestones) so the feed can show what
--    changed since the previous update. NULL for rows posted before this
--    migration; the UI degrades to today's plain feed for those.
--
-- No new tables: all four tables already have ENABLE + FORCE RLS, their
-- tenant_isolation_* policies and the flicks_app grants (0042), so nothing
-- here touches RLS. pm_issues already carries idx_issues_project
-- (tenant_id, project_id) from 0041 — no new index needed for the per-project
-- issue reads. Idempotent and additive; mirrored in packages/db/src/schema/pm.ts.

-- 1. Columns.
ALTER TABLE pm_projects ADD COLUMN IF NOT EXISTS priority smallint NOT NULL DEFAULT 0;
ALTER TABLE pm_projects ADD COLUMN IF NOT EXISTS insights_default jsonb;
ALTER TABLE pm_project_milestones ADD COLUMN IF NOT EXISTS description_md text;
ALTER TABLE pm_project_updates ADD COLUMN IF NOT EXISTS snapshot jsonb;

-- 2. Guarded CHECK constraint (0062 pattern).
DO $chk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pm_projects_priority_check') THEN
    ALTER TABLE pm_projects ADD CONSTRAINT pm_projects_priority_check CHECK (priority BETWEEN 0 AND 4);
  END IF;
END
$chk$;
