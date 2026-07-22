-- Migration 0042 — PM projects, milestones, health updates, initiatives
-- (PRD v6 §6, §9.3, §15.2; PRD-numbered 0041). Repo numbering is +1 because
-- 0038 was taken by crm_360_indexes. 0044 (templates/views) already shipped in
-- Sprint 34 — every PM migration is idempotent so numeric apply order on a
-- fresh sync stays correct.

-- §6.1 Projects — one lead, a target date, honest health updates.
CREATE TABLE IF NOT EXISTS pm_projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  summary TEXT,                               -- one-line
  description_md TEXT,                        -- markdown doc (lazy-loaded)
  icon TEXT,                                  -- emoji
  color TEXT,
  status TEXT NOT NULL DEFAULT 'planned'
    CHECK (status IN ('backlog','planned','in_progress','paused','completed','canceled')),
  health TEXT NOT NULL DEFAULT 'on_track'
    CHECK (health IN ('on_track','at_risk','off_track')),  -- denormalized latest (updates are the log)
  lead_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  start_date DATE,
  target_date DATE,
  deal_id UUID,                               -- CRM back-link (§15.2); no FK — module boundary
  completed_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_pm_projects_tenant ON pm_projects(tenant_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_pm_projects_deal ON pm_projects(tenant_id, deal_id) WHERE deal_id IS NOT NULL;

-- §6.1 Projects span teams (M2M).
CREATE TABLE IF NOT EXISTS pm_project_teams (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES pm_projects(id) ON DELETE CASCADE,
  team_id UUID NOT NULL REFERENCES pm_teams(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, team_id)
);
CREATE INDEX IF NOT EXISTS idx_pm_project_teams_team ON pm_project_teams(tenant_id, team_id);

-- §6.1 Optional roster for pinning/notifications.
CREATE TABLE IF NOT EXISTS pm_project_members (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES pm_projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, user_id)
);

-- §6.2 Milestones — issues attach via pm_issues.milestone_id.
CREATE TABLE IF NOT EXISTS pm_project_milestones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES pm_projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  target_date DATE,
  position SMALLINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pm_milestones_project ON pm_project_milestones(tenant_id, project_id);

-- §6.3 Health updates — the log; latest denormalizes onto pm_projects.health.
CREATE TABLE IF NOT EXISTS pm_project_updates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES pm_projects(id) ON DELETE CASCADE,
  health TEXT NOT NULL CHECK (health IN ('on_track','at_risk','off_track')),
  body_md TEXT NOT NULL,
  author_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pm_updates_project ON pm_project_updates(tenant_id, project_id, created_at DESC);

-- §6.4 Initiatives (light, v1).
CREATE TABLE IF NOT EXISTS pm_initiatives (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','paused')),
  owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  target_quarter TEXT,                        -- 'Q3 2026'
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS pm_initiative_projects (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  initiative_id UUID NOT NULL REFERENCES pm_initiatives(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES pm_projects(id) ON DELETE CASCADE,
  position SMALLINT NOT NULL DEFAULT 0,
  PRIMARY KEY (initiative_id, project_id)
);

-- 0041 reserved pm_issues.project_id/milestone_id without FK targets — add now
-- (idempotent via constraint-name checks; NOT VALID + VALIDATE avoids locks).
DO $fk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pm_issues_project_id_fkey') THEN
    ALTER TABLE pm_issues ADD CONSTRAINT pm_issues_project_id_fkey
      FOREIGN KEY (project_id) REFERENCES pm_projects(id) ON DELETE SET NULL NOT VALID;
    ALTER TABLE pm_issues VALIDATE CONSTRAINT pm_issues_project_id_fkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pm_issues_milestone_id_fkey') THEN
    ALTER TABLE pm_issues ADD CONSTRAINT pm_issues_milestone_id_fkey
      FOREIGN KEY (milestone_id) REFERENCES pm_project_milestones(id) ON DELETE SET NULL NOT VALID;
    ALTER TABLE pm_issues VALIDATE CONSTRAINT pm_issues_milestone_id_fkey;
  END IF;
END
$fk$;

-- record_files already accepts 'project' (0041's CHECK) — nothing to extend.

-- RLS + grants (house DO-loop).
DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pm_projects','pm_project_teams','pm_project_members','pm_project_milestones','pm_project_updates','pm_initiatives','pm_initiative_projects'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_%I ON %I', t, t);
    EXECUTE format('CREATE POLICY tenant_isolation_%I ON %I FOR ALL USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)', t, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO flicks_app', t);
  END LOOP;
END
$rls$;
