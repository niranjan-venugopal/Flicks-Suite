-- Migration 0043 — PM cycles, Autopilot, snapshots + triage snooze
-- (PRD v6 §7/§8; PRD-numbered 0042). Idempotent like every PM migration —
-- 0044 shipped first on existing databases; fresh syncs apply in file order.

-- §7.1 Cycles: per-team numbered periods; config lives on pm_teams (0040).
CREATE TABLE IF NOT EXISTS pm_cycles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  team_id UUID NOT NULL REFERENCES pm_teams(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  cooldown_ends_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'upcoming' CHECK (status IN ('upcoming','active','completed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (team_id, number)
);
CREATE INDEX IF NOT EXISTS idx_pm_cycles_team ON pm_cycles(tenant_id, team_id, starts_at);

-- §7.3 Daily snapshots — the stats substrate (velocity/creep/burn).
CREATE TABLE IF NOT EXISTS pm_cycle_snapshots (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  cycle_id UUID NOT NULL REFERENCES pm_cycles(id) ON DELETE CASCADE,
  snapshot_date DATE NOT NULL,
  scope_points NUMERIC(10,2) NOT NULL DEFAULT 0,
  started_points NUMERIC(10,2) NOT NULL DEFAULT 0,
  completed_points NUMERIC(10,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (cycle_id, snapshot_date)
);

-- 0041 reserved pm_issues.cycle_id without an FK target — add now.
DO $fk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pm_issues_cycle_id_fkey') THEN
    ALTER TABLE pm_issues ADD CONSTRAINT pm_issues_cycle_id_fkey
      FOREIGN KEY (cycle_id) REFERENCES pm_cycles(id) ON DELETE SET NULL NOT VALID;
    ALTER TABLE pm_issues VALIDATE CONSTRAINT pm_issues_cycle_id_fkey;
  END IF;
END
$fk$;

-- §8 Triage snooze (Z · 1d/3d/1w): hides the issue from the conveyor until due.
ALTER TABLE pm_issues ADD COLUMN IF NOT EXISTS snoozed_until TIMESTAMPTZ;

-- Appendix B sample pack ledger — every seeded id, so removal never touches
-- anything the team created themselves (same doctrine as CRM sample_packs).
CREATE TABLE IF NOT EXISTS pm_sample_packs (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  record_ids JSONB NOT NULL DEFAULT '{}',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS + grants (house DO-loop).
DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pm_cycles','pm_cycle_snapshots','pm_sample_packs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_%I ON %I', t, t);
    EXECUTE format('CREATE POLICY tenant_isolation_%I ON %I FOR ALL USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)', t, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO flicks_app', t);
  END LOOP;
END
$rls$;
