-- Migration 0044 — PM templates + views plumbing (PRD v6 §9.4/§14; PRD-numbered
-- 0043). Ships in Sprint 34 (numerically after the projects/cycles migrations
-- that land in Sprints 36–37 — all four are independent and idempotent, so
-- apply order across a fresh sync stays correct).

-- Issue templates (per team; §14). Recurring schedule column reserved (v1.5).
CREATE TABLE IF NOT EXISTS pm_issue_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  team_id UUID NOT NULL REFERENCES pm_teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  title_pattern TEXT,
  description_md TEXT,
  default_priority SMALLINT CHECK (default_priority BETWEEN 0 AND 4),
  default_estimate NUMERIC(6,2),
  default_state_id UUID,
  default_label_ids UUID[] NOT NULL DEFAULT '{}',
  is_team_default BOOLEAN NOT NULL DEFAULT FALSE,
  schedule TEXT,                       -- reserved: recurring issues (v1.5)
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, team_id, name)
);

-- Project templates + starter issue sets (§14; instantiated Sprint 40).
CREATE TABLE IF NOT EXISTS pm_project_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description_md TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, name)
);
CREATE TABLE IF NOT EXISTS pm_project_template_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  template_id UUID NOT NULL REFERENCES pm_project_templates(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description_md TEXT,
  default_priority SMALLINT CHECK (default_priority BETWEEN 0 AND 4),
  relative_due_days INTEGER,           -- due = project start + N days
  position SMALLINT NOT NULL DEFAULT 0
);

-- Saved views open to PM objects (§9.4) — CHECK re-created additively.
DO $sv$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'saved_views') THEN
    ALTER TABLE saved_views DROP CONSTRAINT IF EXISTS saved_views_object_type_check;
    ALTER TABLE saved_views ADD CONSTRAINT saved_views_object_type_check
      CHECK (object_type IN ('deal','person','company','lead','pm_issue','pm_project'));
  END IF;
END
$sv$;

-- Favorites pinned to the sidebar (§9.4).
CREATE TABLE IF NOT EXISTS pm_view_favorites (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  view_id UUID NOT NULL REFERENCES saved_views(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, view_id)
);
CREATE INDEX IF NOT EXISTS idx_pm_view_favorites_user ON pm_view_favorites(tenant_id, user_id);

-- Import batches learn the PM object types early (§14 importers, Sprint 40).
DO $ib$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'import_batches') THEN
    ALTER TABLE import_batches DROP CONSTRAINT IF EXISTS import_batches_object_type_check;
    ALTER TABLE import_batches ADD CONSTRAINT import_batches_object_type_check
      CHECK (object_type IN ('people','companies','leads','pm_issues','pm_projects'));
  END IF;
END
$ib$;

-- RLS + grants (house DO-loop).
DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pm_issue_templates','pm_project_templates','pm_project_template_items','pm_view_favorites'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_%I ON %I', t, t);
    EXECUTE format('CREATE POLICY tenant_isolation_%I ON %I FOR ALL USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)', t, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO flicks_app', t);
  END LOOP;
END
$rls$;
