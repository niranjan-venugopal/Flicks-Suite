-- =============================================================================
-- 0022 — consent_records (PRD v4 §3.2 — append-only consent ledger)
-- =============================================================================
-- One row per consent decision (terms_privacy / analytics / marketing_email);
-- withdrawal = a new row with granted=false. Current state = the latest row per
-- (user_id, consent_type). Signup consents predate tenant creation, so
-- tenant_id is nullable.
--
-- RLS: SELF-VISIBILITY — a signed-in user can read and append ONLY their own
-- rows (user_id = app.user_id). There are deliberately NO UPDATE/DELETE
-- policies: the ledger is append-only under the app role. FAM/audit reads run
-- on the service-role connection.
--
-- Additive + idempotent.
-- =============================================================================

CREATE TABLE IF NOT EXISTS consent_records (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id      uuid REFERENCES tenants(id) ON DELETE SET NULL,
  consent_type   text NOT NULL CHECK (consent_type IN ('terms_privacy','analytics','marketing_email')),
  granted        boolean NOT NULL,
  policy_version text NOT NULL,
  source         text NOT NULL CHECK (source IN ('signup','banner','settings','unsubscribe','import')),
  region_code    text,
  ip_hash        text,          -- SHA-256(ip + server salt); never the raw IP
  user_agent     text,
  occurred_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_consents_user_type
  ON consent_records (user_id, consent_type, occurred_at DESC);

ALTER TABLE consent_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent_records FORCE ROW LEVEL SECURITY;

-- Self-visibility read + append; NULLIF guards the unset-setting cast.
DROP POLICY IF EXISTS consent_self_select ON consent_records;
CREATE POLICY consent_self_select ON consent_records FOR SELECT
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

DROP POLICY IF EXISTS consent_self_insert ON consent_records;
CREATE POLICY consent_self_insert ON consent_records FOR INSERT
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

-- Append-only: no UPDATE/DELETE policies AND the grants are explicitly revoked
-- (the app role carries blanket table grants from the base setup, so the
-- narrow GRANT alone would not stop a 0-row-matching UPDATE from succeeding).
GRANT SELECT, INSERT ON consent_records TO flicks_app;
REVOKE UPDATE, DELETE ON consent_records FROM flicks_app;
