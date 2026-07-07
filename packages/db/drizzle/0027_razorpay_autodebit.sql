-- =============================================================================
-- 0027 — tenant-track auto-debit (PRD v4 §8A, Sprint 23)
-- =============================================================================
-- Razorpay e-mandates on the SELLER's own (OAuth-connected) account for
-- recurring invoices: the customer authorizes once on a hosted page, then
-- cycles charge automatically. invoice_subscriptions already carried the
-- razorpay ids + mandate timestamps from v3; this adds the collection mode,
-- mandate lifecycle state, the public-page token, and the per-charge attempt
-- ledger. (Numbered 0027 by the PRD plan; applied after 0028 — both are
-- additive and order-independent, and sync-supabase applies every file.)
--
-- Additive + idempotent.
-- =============================================================================

-- ─── customers: sub-merchant customer handle ─────────────────────────────────
ALTER TABLE customers ADD COLUMN IF NOT EXISTS razorpay_customer_id text;

-- ─── invoice_subscriptions: collection mode + mandate lifecycle ──────────────
-- collection_mode: manual (send invoices, D14a default) | auto_debit
ALTER TABLE invoice_subscriptions ADD COLUMN IF NOT EXISTS collection_mode text NOT NULL DEFAULT 'manual';
-- mandate_status: none | pending_authorization | authorized | active | revoked
ALTER TABLE invoice_subscriptions ADD COLUMN IF NOT EXISTS mandate_status text NOT NULL DEFAULT 'none';
-- Razorpay-hosted authorization page for this subscription's mandate.
ALTER TABLE invoice_subscriptions ADD COLUMN IF NOT EXISTS mandate_short_url text;
-- Public /sub/<token> page token (public-invoice pattern; NULL until minted).
ALTER TABLE invoice_subscriptions ADD COLUMN IF NOT EXISTS mandate_token text;
ALTER TABLE invoice_subscriptions ADD COLUMN IF NOT EXISTS mandate_token_expires_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_subscriptions_mandate_token
  ON invoice_subscriptions (mandate_token) WHERE mandate_token IS NOT NULL;

-- ─── subscription_charge_attempts: per-cycle charge ledger (D14b timeline) ───
CREATE TABLE IF NOT EXISTS subscription_charge_attempts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subscription_id uuid NOT NULL REFERENCES invoice_subscriptions(id) ON DELETE CASCADE,
  invoice_id      uuid REFERENCES invoices(id) ON DELETE SET NULL,
  razorpay_payment_id text,
  status          text NOT NULL CHECK (status IN ('succeeded','failed','pending')),
  amount          numeric(15,2) NOT NULL,
  currency        text NOT NULL,
  failure_reason  text,
  attempted_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_charge_attempts_subscription
  ON subscription_charge_attempts (subscription_id, attempted_at DESC);
CREATE INDEX IF NOT EXISTS idx_charge_attempts_tenant
  ON subscription_charge_attempts (tenant_id, attempted_at DESC);

-- House tenant-isolation RLS (matches every other invoicing table).
ALTER TABLE subscription_charge_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_charge_attempts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_subscription_charge_attempts ON subscription_charge_attempts;
CREATE POLICY tenant_isolation_subscription_charge_attempts ON subscription_charge_attempts
  FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT ON subscription_charge_attempts TO flicks_app;
REVOKE UPDATE, DELETE ON subscription_charge_attempts FROM flicks_app;
