-- 0052 — Per-role module access defaults (Round 8, item 4)
--
-- Owners asked to hand out (and take away) whole modules — CRM, Invoicing,
-- Projects — per role and per person, from Settings. Two pieces were missing:
--
--   1. a place to say "Employees get no CRM in THIS workspace" once, rather
--      than per member. That is this table.
--   2. the ability for an explicit membership_grants row to NARROW what a role
--      gets by default (revocation). That is a code change in
--      ModuleAccessService/ModuleGrantGuard — the resolution order is
--      member grant row → tenant role default (here) → built-in role default.
--
-- Roles that hold full module access by role (owner, admin, fam, super_admin,
-- and finance for invoicing) short-circuit BEFORE this table is consulted, so
-- rows for them are meaningless and the API rejects them: an owner must never
-- be able to lock every owner out of a module.
--
-- Capabilities (invoicing send / record_payment / manage_customers) stay
-- per-member on membership_grants — they are deliberately NOT settable here.
--
-- Idempotent + additive, per house rules.

CREATE TABLE IF NOT EXISTS tenant_role_module_defaults (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- membership_role value: manager | employee | finance | auditor | guest
  role         text NOT NULL,
  -- GrantModule value: crm | invoicing | pm | reports | org_financial | ...
  module       text NOT NULL,
  -- none | view | edit
  access_level text NOT NULL DEFAULT 'edit',
  updated_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS tenant_role_module_defaults_unique
  ON tenant_role_module_defaults (tenant_id, role, module);
CREATE INDEX IF NOT EXISTS tenant_role_module_defaults_tenant_idx
  ON tenant_role_module_defaults (tenant_id);

DO $rmd$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenant_role_module_defaults'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_%I ON %I', t, t);
    EXECUTE format('CREATE POLICY tenant_isolation_%I ON %I FOR ALL USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)', t, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO flicks_app', t);
  END LOOP;
END
$rmd$;
