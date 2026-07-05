-- =============================================================================
-- 0024 — member_status (PRD v4 §5 — presence & status, Teams-style)
-- =============================================================================
-- One row per (tenant, user): the MANUAL status only. Auto states (in office /
-- out of office / available / away / offline) are resolved at read time from
-- attendance, leave, and the presence gateway's live activity — never stored.
-- Manual status is per company (auditors hold independent statuses per client).
--
-- RLS: everyone in the tenant can READ (org-wide visibility); a user can WRITE
-- only their own row (tenant + user_id = app.user_id).
--
-- Additive + idempotent.
-- =============================================================================

CREATE TABLE IF NOT EXISTS member_status (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  manual_status  text CHECK (manual_status IN ('available','busy','dnd','brb','away','offline')),
  status_message varchar(80),
  expires_at     timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_member_status_tenant ON member_status (tenant_id);

ALTER TABLE member_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_status FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS member_status_tenant_read ON member_status;
CREATE POLICY member_status_tenant_read ON member_status FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

DROP POLICY IF EXISTS member_status_write_own ON member_status;
CREATE POLICY member_status_write_own ON member_status FOR ALL
  USING (
    tenant_id = current_setting('app.tenant_id', true)::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = current_setting('app.tenant_id', true)::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON member_status TO flicks_app;
