-- =============================================================================
-- 0016 — Invoicing v3: tenant-specific HSN/SAC additions
-- =============================================================================
-- The global hsn_sac_codes master stays shared/read-only (no RLS). Tenants may
-- add their own codes here; tenant-scoped + RLS. Search unions the two.
-- =============================================================================

CREATE TABLE IF NOT EXISTS tenant_hsn_sac_codes (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  code              TEXT NOT NULL,
  type              TEXT NOT NULL,                 -- HSN | SAC
  description       TEXT NOT NULL,
  default_gst_rate  NUMERIC(5,2),
  category          TEXT,
  created_by        UUID REFERENCES users (id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS tenant_hsn_sac_codes_unique ON tenant_hsn_sac_codes (tenant_id, code);
CREATE INDEX IF NOT EXISTS tenant_hsn_sac_codes_tenant_idx ON tenant_hsn_sac_codes (tenant_id);

ALTER TABLE tenant_hsn_sac_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_hsn_sac_codes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_tenant_hsn_sac_codes ON tenant_hsn_sac_codes;
CREATE POLICY tenant_isolation_tenant_hsn_sac_codes ON tenant_hsn_sac_codes
  FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
