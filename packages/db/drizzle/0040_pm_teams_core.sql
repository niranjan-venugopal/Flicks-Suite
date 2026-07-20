-- Migration 0040 — PM workspace model (PRD v6 §4; PRD-numbered 0039).
-- Teams, memberships, atomic per-team issue counters, workflow states, labels.
-- pm_issue_labels ships in 0041 with pm_issues (its FK target).
-- Additive + idempotent; FORCE RLS + tenant policy + grants on every table.

CREATE TABLE IF NOT EXISTS pm_teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key VARCHAR(6) NOT NULL,                 -- "ENG" → ENG-123; uppercase A–Z0–9
  name TEXT NOT NULL,
  icon TEXT,
  color TEXT,
  is_private BOOLEAN NOT NULL DEFAULT FALSE,
  timezone TEXT,                           -- cycle boundaries; NULL = tenant tz
  cycles_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  cycle_length_weeks SMALLINT NOT NULL DEFAULT 2 CHECK (cycle_length_weeks BETWEEN 1 AND 6),
  cooldown_days SMALLINT NOT NULL DEFAULT 0 CHECK (cooldown_days BETWEEN 0 AND 7),
  cycle_start_dow SMALLINT NOT NULL DEFAULT 1 CHECK (cycle_start_dow BETWEEN 0 AND 6),
  cycle_auto_add_started BOOLEAN NOT NULL DEFAULT TRUE,
  upcoming_cycles SMALLINT NOT NULL DEFAULT 2 CHECK (upcoming_cycles BETWEEN 1 AND 4),
  estimate_scale TEXT NOT NULL DEFAULT 'count'
    CHECK (estimate_scale IN ('count','linear','fibonacci','exponential','tshirt')),
  triage_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  default_state_id UUID,                   -- backlog-category state for new issues
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  UNIQUE (tenant_id, key)
);
CREATE INDEX IF NOT EXISTS idx_pm_teams_tenant ON pm_teams(tenant_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS pm_team_memberships (
  team_id UUID NOT NULL REFERENCES pm_teams(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_lead BOOLEAN NOT NULL DEFAULT FALSE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_pm_team_memberships_user ON pm_team_memberships(tenant_id, user_id);

CREATE TABLE IF NOT EXISTS pm_team_counters (
  team_id UUID PRIMARY KEY REFERENCES pm_teams(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL,
  last_number INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS pm_workflow_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  team_id UUID NOT NULL REFERENCES pm_teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('triage','backlog','unstarted','started','completed','canceled')),
  position REAL NOT NULL,
  is_default_for_category BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (tenant_id, team_id, name)
);
CREATE INDEX IF NOT EXISTS idx_pm_states_team ON pm_workflow_states(tenant_id, team_id);

CREATE TABLE IF NOT EXISTS pm_labels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  team_id UUID REFERENCES pm_teams(id) ON DELETE CASCADE,  -- NULL = workspace label
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pm_labels_scope
  ON pm_labels (tenant_id, coalesce(team_id, '00000000-0000-0000-0000-000000000000'::uuid), name);

-- RLS + grants (house DO-loop).
DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pm_teams','pm_team_memberships','pm_team_counters','pm_workflow_states','pm_labels'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_%I ON %I', t, t);
    EXECUTE format('CREATE POLICY tenant_isolation_%I ON %I FOR ALL USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)', t, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO flicks_app', t);
  END LOOP;
END
$rls$;

-- Module toggle seed: pm default-enabled for every tenant (CRM 0032 pattern).
INSERT INTO tenant_module_toggles (tenant_id, module, enabled)
SELECT id, 'pm', true FROM tenants
ON CONFLICT (tenant_id, module) DO NOTHING;
