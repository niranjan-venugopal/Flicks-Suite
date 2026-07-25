-- 0046: GitHub App integration (PRD v6 §12, P16) — installations, repo↔team
-- mappings, issue git links, webhook delivery ledger, per-team automations.
-- Idempotent: safe to re-run.

-- ─── pm_github_installations: one App installation per tenant ────────────────
CREATE TABLE IF NOT EXISTS pm_github_installations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  installation_id BIGINT NOT NULL UNIQUE,
  account_login TEXT NOT NULL,
  -- Workspace-level branch template (P16 branch format card).
  branch_format TEXT NOT NULL DEFAULT '{user}/{team-key-lower}-{number}-{slug}',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'error')),
  failed_deliveries INTEGER NOT NULL DEFAULT 0,
  last_delivery_status INTEGER,
  last_delivery_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── pm_github_repos: repo → team mapping (installation-scoped) ──────────────
CREATE TABLE IF NOT EXISTS pm_github_repos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  installation_id BIGINT NOT NULL,
  repo_id BIGINT,
  repo_full_name TEXT NOT NULL,
  team_id UUID NOT NULL REFERENCES pm_teams(id) ON DELETE CASCADE,
  autolink BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, repo_full_name)
);
CREATE INDEX IF NOT EXISTS idx_pm_github_repos_team ON pm_github_repos(tenant_id, team_id);

-- ─── pm_issue_git_links: branch/PR/commit chips on issues ────────────────────
CREATE TABLE IF NOT EXISTS pm_issue_git_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  issue_id UUID NOT NULL REFERENCES pm_issues(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('branch', 'pr', 'commit')),
  -- ref = stable identity within the kind: branch name, PR number, short sha.
  ref TEXT NOT NULL,
  label TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'merged', 'closed')),
  url TEXT,
  repo_full_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, issue_id, kind, ref)
);
CREATE INDEX IF NOT EXISTS idx_pm_issue_git_links_issue ON pm_issue_git_links(tenant_id, issue_id);

-- ─── github_webhook_events: delivery-id idempotency ledger ───────────────────
-- Stores every inbound delivery (verified or not); processing is gated on
-- signature_verified. payload retained so failed deliveries can be re-run.
CREATE TABLE IF NOT EXISTS github_webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id TEXT NOT NULL UNIQUE,
  event TEXT NOT NULL,
  action TEXT,
  installation_id BIGINT,
  tenant_id UUID,
  signature_verified BOOLEAN NOT NULL DEFAULT false,
  processed BOOLEAN NOT NULL DEFAULT false,
  processed_at TIMESTAMPTZ,
  processing_error TEXT,
  payload JSONB,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_github_webhook_events_pending
  ON github_webhook_events (received_at)
  WHERE signature_verified AND NOT processed;

-- ─── pm_teams: per-team status automations (P16, on by default) ──────────────
ALTER TABLE pm_teams ADD COLUMN IF NOT EXISTS gh_auto_branch BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE pm_teams ADD COLUMN IF NOT EXISTS gh_auto_pr_open BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE pm_teams ADD COLUMN IF NOT EXISTS gh_auto_pr_merge BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE pm_teams ADD COLUMN IF NOT EXISTS gh_auto_pr_close BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE pm_teams ADD COLUMN IF NOT EXISTS gh_magic_words BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE pm_teams ADD COLUMN IF NOT EXISTS gh_bot_comment BOOLEAN NOT NULL DEFAULT false;

-- ─── RLS ─────────────────────────────────────────────────────────────────────
-- Tenant-scoped tables: standard FORCE-RLS + flicks_app grants.
DO $rls$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['pm_github_installations', 'pm_github_repos', 'pm_issue_git_links'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_%I ON %I', t, t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation_%I ON %I USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)',
      t, t
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO flicks_app', t);
  END LOOP;
END
$rls$;

-- Webhook ledger: service-role only (no tenant context on inbound deliveries) —
-- FORCE RLS with no policies and no app grants, like razorpay/resend ledgers.
ALTER TABLE github_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE github_webhook_events FORCE ROW LEVEL SECURITY;
