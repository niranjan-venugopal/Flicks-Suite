-- 0056 — deleting a project takes its issues with it (founder round 20).
--
-- Until now `softDelete` on a project stamped only pm_projects.deleted_at. The
-- project's issues kept their own deleted_at NULL, so they stayed live in the
-- issues list, My Issues, Triage, search and the sync bootstrap — pointing at a
-- project that no longer exists. The founder's call: "Delete them with it …
-- issues don't survive without a project."
--
-- The cascade therefore stamps every live issue in the project. Restore has to
-- undo exactly that set and nothing more: an issue the user had already deleted
-- by hand BEFORE the project went must stay deleted afterwards. This column is
-- the marker that separates the two — set when the cascade takes an issue,
-- cleared when the project's restore gives it back.
--
-- Deliberately NO foreign key: the 30-day purge hard-deletes pm_projects, and a
-- REFERENCES … ON DELETE SET NULL would quietly erase the marker mid-purge
-- while the issues it names are still being resolved. The value is a historical
-- record of "which delete took me", not a live relationship.
ALTER TABLE pm_issues ADD COLUMN IF NOT EXISTS deleted_with_project_id uuid;

-- The restore path's only lookup: "which issues did THIS project's delete take?"
-- Partial, because the column is NULL for every issue that was not cascaded.
CREATE INDEX IF NOT EXISTS idx_pm_issues_deleted_with_project
  ON pm_issues (tenant_id, deleted_with_project_id)
  WHERE deleted_with_project_id IS NOT NULL;
