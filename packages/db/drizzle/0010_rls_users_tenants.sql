-- 0010 — Row-Level Security for users and tenants.
--
-- These are identity/platform tables (no tenant_id of their own), but the
-- tenant connection legitimately reads them: employee list/detail/org-chart
-- join `users` for member display names, and the invite flow reads `tenants`
-- for the company name. So instead of a blanket deny, we scope them:
--
--   users   — visible to a tenant connection only for users who are MEMBERS
--             of the current tenant (app.tenant_id). Cross-tenant user rows
--             are invisible. Identity provisioning that must see/create users
--             globally (auth, and the employee-invite email lookup) runs on
--             the service-role connection, which bypasses RLS.
--   tenants — a tenant connection sees only its own row (id = app.tenant_id).
--
-- The service role (FAM / auth / onboarding) is a superuser and bypasses RLS,
-- so platform-wide reads/writes are unaffected.
--
-- Idempotent: ENABLE/FORCE are no-ops if set; policies dropped before create.

-- ─── users — members of the current tenant only ───────────────────────────────
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_members_users ON users;
CREATE POLICY tenant_members_users ON users
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.user_id = users.id
        AND m.tenant_id = current_setting('app.tenant_id', true)::uuid
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.user_id = users.id
        AND m.tenant_id = current_setting('app.tenant_id', true)::uuid
    )
  );

-- ─── tenants — own row only ───────────────────────────────────────────────────
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_self_tenants ON tenants;
CREATE POLICY tenant_self_tenants ON tenants
  FOR ALL USING (id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (id = current_setting('app.tenant_id', true)::uuid);
