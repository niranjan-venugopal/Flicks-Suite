-- =============================================================================
-- 0013 — Invoicing v3: Auditor role + per-membership grants + module toggles
-- =============================================================================
-- PRD §3 (Auditor RBAC), §4.3 (membership_grants, tenant_module_toggles,
-- memberships ALTER). RLS for the two new tenant-scoped tables is applied in
-- 0014. Idempotent.
--
-- NOTE: ALTER TYPE … ADD VALUE cannot run inside an explicit transaction and
-- the new value cannot be used in the same statement batch — so this file does
-- NOT insert any 'auditor' rows; it only registers the enum value.
-- =============================================================================

-- ─── membership_role gains 'auditor' ────────────────────────────────────────────
ALTER TYPE membership_role ADD VALUE IF NOT EXISTS 'auditor';

-- ─── memberships: external flag + optional time-boxed access window (P1) ────────
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS is_external BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS access_expires_at TIMESTAMPTZ;

-- ─── membership_grants — per-membership module scopes (drives Auditor sidebar) ──
CREATE TABLE IF NOT EXISTS membership_grants (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  membership_id  UUID NOT NULL REFERENCES memberships (id) ON DELETE CASCADE,
  module         TEXT NOT NULL,                 -- invoicing | reports | org_financial | payroll | expenses
  access_level   TEXT NOT NULL DEFAULT 'view',  -- none | view | edit
  capabilities   JSONB NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS membership_grants_membership_module_unique
  ON membership_grants (membership_id, module);
CREATE INDEX IF NOT EXISTS idx_membership_grants_membership ON membership_grants (membership_id);
CREATE INDEX IF NOT EXISTS membership_grants_tenant_idx ON membership_grants (tenant_id);

-- ─── tenant_module_toggles — FAM per-module enablement ──────────────────────────
CREATE TABLE IF NOT EXISTS tenant_module_toggles (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  module      TEXT NOT NULL,                    -- invoicing | payroll | expenses
  enabled     BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by  UUID REFERENCES users (id),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS tenant_module_toggles_unique ON tenant_module_toggles (tenant_id, module);
CREATE INDEX IF NOT EXISTS tenant_module_toggles_tenant_idx ON tenant_module_toggles (tenant_id);
