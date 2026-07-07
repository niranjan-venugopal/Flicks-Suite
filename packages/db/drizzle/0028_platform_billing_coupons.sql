-- =============================================================================
-- 0028 — platform billing core + FAM coupons (PRD v4 §8B, Sprints 21–22)
-- =============================================================================
-- The platform `subscriptions` table (fam.ts) gains the Razorpay wiring and
-- grace state; coupon_codes/coupon_redemptions land for the FAM beta-coupon
-- program; razorpay_webhook_events learns which track an event belongs to.
-- A one-time backfill gives every existing tenant a trialing subscription row
-- (the write path starts at tenant creation from this sprint on).
--
-- Additive + idempotent.
-- =============================================================================

-- ─── subscriptions: Razorpay linkage + coupon + grace ────────────────────────
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS razorpay_plan_id text;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS authorization_url text;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS applied_coupon_id uuid;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS grace_ends_at timestamptz;

-- ─── coupon_codes (FAM service-layer only — no tenant access at all) ─────────
CREATE TABLE IF NOT EXISTS coupon_codes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code             text NOT NULL UNIQUE,
  campaign         text NOT NULL DEFAULT 'general',
  months           int  NOT NULL CHECK (months BETWEEN 1 AND 12),
  max_redemptions  int  NOT NULL DEFAULT 1 CHECK (max_redemptions >= 1),
  redemption_count int  NOT NULL DEFAULT 0 CHECK (redemption_count >= 0),
  expires_at       timestamptz,
  active           boolean NOT NULL DEFAULT true,
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_coupon_codes_campaign ON coupon_codes (campaign);
-- Deny-all for the tenant connection: RLS on with no policies, no grants.
ALTER TABLE coupon_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE coupon_codes FORCE ROW LEVEL SECURITY;
REVOKE ALL ON coupon_codes FROM flicks_app;

-- ─── coupon_redemptions (tenant-visible history; writes are service-role) ────
CREATE TABLE IF NOT EXISTS coupon_redemptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coupon_id   uuid NOT NULL REFERENCES coupon_codes(id),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  redeemed_by uuid REFERENCES users(id),
  months      int  NOT NULL,
  redeemed_at timestamptz NOT NULL DEFAULT now(),
  -- One coupon EVER per tenant (§8B.3) — enforced by the database, not code.
  CONSTRAINT coupon_redemptions_tenant_once UNIQUE (tenant_id)
);
CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_coupon ON coupon_redemptions (coupon_id);
ALTER TABLE coupon_redemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE coupon_redemptions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_coupon_redemptions ON coupon_redemptions;
CREATE POLICY tenant_isolation_coupon_redemptions ON coupon_redemptions
  FOR SELECT USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT ON coupon_redemptions TO flicks_app;
REVOKE INSERT, UPDATE, DELETE ON coupon_redemptions FROM flicks_app;

-- ─── razorpay_webhook_events: platform vs tenant track ───────────────────────
ALTER TABLE razorpay_webhook_events
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'tenant'
  CHECK (source IN ('tenant', 'platform'));

-- ─── one-time backfill: a trialing subscription row for every tenant ─────────
-- New tenants get their row at creation (onboarding.service). Existing tenants
-- get at least 7 days of runway from migration time so the billing launch
-- never hard-locks a workspace that predates it; the Specflicks internal
-- tenant is exempt from billing entirely.
INSERT INTO subscriptions (tenant_id, plan_code, status, per_user_price, user_count, billing_cycle, trial_ends_at)
SELECT
  t.id,
  'beta',
  'trialing',
  499,
  GREATEST(1, (
    SELECT count(*) FROM memberships m
    WHERE m.tenant_id = t.id AND m.status = 'active'
      AND m.role NOT IN ('auditor', 'fam', 'super_admin')
  )),
  'monthly',
  GREATEST(coalesce(t.trial_ends_at, now()), now() + interval '7 days')
FROM tenants t
WHERE t.id <> '00000000-0000-0000-0000-000000000001'
  AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.tenant_id = t.id)
ON CONFLICT (tenant_id) DO NOTHING;
