-- 0070_fam_support_console.sql — Round R R2 (2026-10-09): the FAM support console.
--
-- Additive + idempotent. Apply BEFORE the API deploys: platform.ts declares
-- tenants.status_before_suspend and auth.ts declares refresh_tokens.mfa, so
-- every bare select on those tables references the new columns from the
-- first request.
--
--  1. auth_event_type gains 'tenant_selected' — auth.service has written it on
--     every company switch since Sprint 8; Postgres rejected the label and the
--     row was silently dropped. ADD VALUE must stay a top-level statement and
--     nothing in this file may USE the label (PG forbids it in the same tx).
--  2. tenants.status_before_suspend — what Reactivate restores (trialing stays
--     trialing; today it came back 'active').
--  3. refresh_tokens.mfa — the session finished the FAM second factor; carried
--     through rotation so FAM routes can insist on it.
--  4. fam_tenant_notes — Specflicks support notes about a company. FAM-only:
--     FORCE RLS + deny-all policy + REVOKE from the app role (0011/0048
--     pattern); the tenant never sees them.
--  5. coupon_redemptions: one coupon per tenant → one redemption per
--     (tenant, coupon). Self-service redemption keeps its "one coupon ever"
--     rule in code; the FAM "give free months" grant may happen more than once.

ALTER TYPE auth_event_type ADD VALUE IF NOT EXISTS 'tenant_selected';

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS status_before_suspend tenant_status;

ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS mfa boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS fam_tenant_notes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  author_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  body           text NOT NULL,
  pinned         boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);

CREATE INDEX IF NOT EXISTS idx_fam_tenant_notes_tenant_created
  ON fam_tenant_notes (tenant_id, created_at DESC);

ALTER TABLE fam_tenant_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE fam_tenant_notes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS service_role_only_fam_tenant_notes ON fam_tenant_notes;
CREATE POLICY service_role_only_fam_tenant_notes ON fam_tenant_notes
  FOR ALL USING (false) WITH CHECK (false);

-- Belt-and-braces: the default privileges (0017) and every provisioning
-- script's blanket GRANT hand the app role table rights on new tables.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flicks_app') THEN
    EXECUTE 'REVOKE ALL ON fam_tenant_notes FROM flicks_app';
  END IF;
END $$;

-- One redemption per (tenant, coupon) instead of one coupon ever per tenant.
ALTER TABLE coupon_redemptions DROP CONSTRAINT IF EXISTS coupon_redemptions_tenant_once;
CREATE UNIQUE INDEX IF NOT EXISTS coupon_redemptions_tenant_coupon_unique
  ON coupon_redemptions (tenant_id, coupon_id);
