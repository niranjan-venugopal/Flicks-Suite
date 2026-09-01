-- Round E: project membership becomes a first-class, founder-visible thing.
--
-- 1. pm_projects.is_private — the opt-in access switch. Default false, so
--    NOTHING changes for existing projects on deploy: every project stays
--    workspace-visible exactly as today. When a project is flipped private,
--    visibility narrows to its pm_project_members rows, its lead, and the
--    full-access workspace roles (owner/admin/super_admin/fam) — managers and
--    employees must be added as members. The rule lives in ONE place
--    (PmVisibilityService), the same choke point that already scopes guests,
--    so bootstrap/delta/REST/search can't disagree. pm_project_members itself
--    needs no change: the table (0042) and its guest index (0051) already
--    carry internal members fine.
--
-- 2. pm_projects.logo_key / logo_updated_at — an uploaded project logo
--    (R2-stored WebP variants, same pipeline as the tenant logo). The raw key
--    never leaves the API: reads serve a signed URL and the emoji icon stays
--    the fallback.
--
-- 3. Two indexes the PM hot paths were missing:
--    · pm_issues (tenant_id, team_id, updated_at DESC) WHERE deleted_at IS
--      NULL — the sync bootstrap's per-team issue fetch and the REST issues
--      list both ORDER BY updated_at DESC LIMIT n; the closest existing index
--      (idx_issues_team_state) can filter but not order, so Postgres sorted
--      the team's whole live backlog on every cold bootstrap.
--    · pm_projects (tenant_id) WHERE deleted_at IS NULL — visibility scoping
--      reads the live project set on every PM request and had no index at
--      all (only idx_pm_projects_deal exists).
--
-- Idempotent and additive; mirrored in packages/db/src/schema/pm.ts.

ALTER TABLE pm_projects ADD COLUMN IF NOT EXISTS is_private boolean NOT NULL DEFAULT false;
ALTER TABLE pm_projects ADD COLUMN IF NOT EXISTS logo_key text;
ALTER TABLE pm_projects ADD COLUMN IF NOT EXISTS logo_updated_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_issues_team_updated
  ON pm_issues (tenant_id, team_id, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_pm_projects_tenant_live
  ON pm_projects (tenant_id)
  WHERE deleted_at IS NULL;
