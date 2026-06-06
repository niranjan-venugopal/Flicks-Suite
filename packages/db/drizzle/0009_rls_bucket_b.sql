-- 0009 — Row-Level Security for the remaining tenant-scoped tables.
--
-- 0001 enabled RLS on the 23 tenant business-data tables but left several
-- tenant-scoped tables without it. The most important is `memberships`
-- (tenant↔user roles): under the NOBYPASSRLS app role a cross-tenant read
-- of memberships was NOT isolated — a genuine gap (caught by the Gate-1
-- multi-tenant suite, test #9). The rest (subscriptions, subscription_events,
-- tenant_health_snapshots, account_deletion_requests, impersonation_sessions)
-- are accessed only via the service-role (BYPASSRLS) connection (FAM / auth),
-- so RLS here is defense-in-depth — it costs nothing at runtime but means a
-- future tenant-role query against them can never leak across tenants.
--
-- Idempotent: ENABLE/FORCE are no-ops if already set; policies are dropped
-- before (re)create since Postgres has no CREATE POLICY IF NOT EXISTS.

-- ─── memberships (tenant_id) — closes the real isolation gap ──────────────────
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_memberships ON memberships;
CREATE POLICY tenant_isolation_memberships ON memberships
  FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ─── subscriptions (tenant_id) — FAM-only, defense-in-depth ───────────────────
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_subscriptions ON subscriptions;
CREATE POLICY tenant_isolation_subscriptions ON subscriptions
  FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ─── subscription_events (tenant_id) — FAM-only, defense-in-depth ─────────────
ALTER TABLE subscription_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_subscription_events ON subscription_events;
CREATE POLICY tenant_isolation_subscription_events ON subscription_events
  FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ─── tenant_health_snapshots (tenant_id) — FAM-only, defense-in-depth ─────────
ALTER TABLE tenant_health_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_health_snapshots FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_tenant_health_snapshots ON tenant_health_snapshots;
CREATE POLICY tenant_isolation_tenant_health_snapshots ON tenant_health_snapshots
  FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ─── account_deletion_requests (tenant_id) — accessed via service role ────────
ALTER TABLE account_deletion_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_deletion_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_account_deletion_requests ON account_deletion_requests;
CREATE POLICY tenant_isolation_account_deletion_requests ON account_deletion_requests
  FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ─── impersonation_sessions (target_tenant_id) — FAM-only, defense-in-depth ───
-- The tenant column here is target_tenant_id (the tenant being impersonated).
ALTER TABLE impersonation_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE impersonation_sessions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_impersonation_sessions ON impersonation_sessions;
CREATE POLICY tenant_isolation_impersonation_sessions ON impersonation_sessions
  FOR ALL USING (target_tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (target_tenant_id = current_setting('app.tenant_id', true)::uuid);
