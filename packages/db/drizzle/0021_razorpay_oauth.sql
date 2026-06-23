-- =============================================================================
-- 0021 — Razorpay live payments via OAuth Connect (Sprint 15, PRD §6.6/§9.3)
-- =============================================================================
-- Closes the live half of the Razorpay integration (Sprint 4 shipped the safe
-- stub). Sellers connect their Razorpay account via OAuth (Partner model); we
-- store the resulting tokens encrypted at the app layer, create orders on the
-- sub-merchant account with a Bearer access token, and record captured payments
-- via the existing webhook → recordPayment path.
--
-- Additive + idempotent (ADD COLUMN / CREATE TABLE IF NOT EXISTS).
-- =============================================================================

-- ─── invoicing_settings: OAuth token storage ────────────────────────────────
-- Tokens are AES-256-GCM-encrypted by InvoicingCryptoService before they reach
-- these columns and are never returned by the settings API (masked to a
-- razorpay_connected boolean).
ALTER TABLE invoicing_settings
  ADD COLUMN IF NOT EXISTS razorpay_access_token     text,
  ADD COLUMN IF NOT EXISTS razorpay_refresh_token    text,
  ADD COLUMN IF NOT EXISTS razorpay_public_token     text,
  ADD COLUMN IF NOT EXISTS razorpay_token_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS razorpay_connected_at     timestamptz,
  ADD COLUMN IF NOT EXISTS razorpay_oauth_state      text;

-- ─── razorpay_orders: order → invoice/tenant mapping ────────────────────────
-- The webhook matches a captured payment by entity.order_id (order notes are
-- not echoed onto the payment entity). Tenant-scoped + RLS; the webhook reads
-- it on the service-role connection, the public order endpoint writes it via
-- service role too (no tenant JWT on the hosted page).
CREATE TABLE IF NOT EXISTS razorpay_orders (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_id   uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  order_id     text NOT NULL UNIQUE,
  amount_paise integer NOT NULL,
  currency     text NOT NULL DEFAULT 'INR',
  status       text NOT NULL DEFAULT 'created',
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS razorpay_orders_tenant_invoice_idx
  ON razorpay_orders (tenant_id, invoice_id);

ALTER TABLE razorpay_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE razorpay_orders FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_razorpay_orders ON razorpay_orders;
CREATE POLICY tenant_isolation_razorpay_orders ON razorpay_orders
  FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON razorpay_orders TO flicks_app;
