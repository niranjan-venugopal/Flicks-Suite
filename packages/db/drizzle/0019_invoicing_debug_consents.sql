-- =============================================================================
-- 0019 — invoicing_debug_consents (FAM consented-debug, PRD §10.5)
-- =============================================================================
-- The hard FAM privacy line is "never read invoice content without explicit,
-- time-boxed, audited tenant consent." This table records that consent: an
-- Owner grants FAM a time-boxed, revocable window to view their workspace's
-- invoice count/status distribution + webhook/email/audit logs (metadata only,
-- never amounts/customers/descriptions). FAM access is gated on an active row
-- here and every access is written to the platform audit log.
--
-- Tenant-scoped + RLS (the Owner manages their own consent); FAM reads it on
-- the service-role connection. Additive + idempotent.
-- =============================================================================

CREATE TABLE IF NOT EXISTS invoicing_debug_consents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  granted_by  uuid REFERENCES users(id),
  scope       text[] NOT NULL DEFAULT '{}',
  note        text,
  expires_at  timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_invoicing_debug_consents_tenant
  ON invoicing_debug_consents (tenant_id);

ALTER TABLE invoicing_debug_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoicing_debug_consents FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_invoicing_debug_consents ON invoicing_debug_consents;
CREATE POLICY tenant_isolation_invoicing_debug_consents ON invoicing_debug_consents
  FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON invoicing_debug_consents TO flicks_app;
