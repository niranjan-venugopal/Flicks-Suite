-- =============================================================================
-- 0014 — Invoicing v3: Row-Level Security (PRD §4.4)
-- =============================================================================
-- ENABLE + FORCE RLS + standard tenant_isolation_<t> policy on every
-- tenant-scoped invoicing/org/auditor table. Special cases:
--   • hsn_sac_codes        — GLOBAL, read-only → intentionally NO RLS.
--   • razorpay_webhook_events — written without tenant context (service role);
--                            deny-all for the tenant connection (service role
--                            bypasses RLS). Matches the 0011 lockdown pattern.
--   • memberships          — gains an additional SELECT-only self-visibility
--                            policy keyed on app.user_id for the company switcher
--                            (the FOR ALL tenant_isolation policy from 0009 still
--                            governs writes/tenant reads; permissive policies OR).
-- Idempotent: ENABLE/FORCE are no-ops if set; policies are dropped before create.
-- =============================================================================

DO $$
DECLARE
  t TEXT;
  tenant_tables TEXT[] := ARRAY[
    'invoicing_settings',
    'invoicing_setup_progress',
    'customers',
    'customer_credit_balance',
    'customer_credit_balance_entries',
    'items',
    'invoice_sequences',
    'tenant_bank_accounts',
    'tenant_currency_bank_defaults',
    'invoice_subscriptions',
    'invoices',
    'invoice_line_items',
    'invoice_payments',
    'invoice_subscription_line_items',
    'invoice_subscription_proration_events',
    'credit_notes',
    'credit_note_line_items',
    'debit_notes',
    'debit_note_line_items',
    'adjustments',
    'reminder_schedule',
    'reminder_sent',
    'gstr1_exports',
    'form_131_received',
    'membership_grants',
    'tenant_module_toggles'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_%I ON %I;', t, t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation_%I ON %I '
      'FOR ALL USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) '
      'WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid);',
      t, t
    );
  END LOOP;
END $$;

-- ─── razorpay_webhook_events — deny-all for the tenant connection ───────────────
ALTER TABLE razorpay_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE razorpay_webhook_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS service_role_only_razorpay_webhook_events ON razorpay_webhook_events;
CREATE POLICY service_role_only_razorpay_webhook_events ON razorpay_webhook_events
  FOR ALL USING (false) WITH CHECK (false);

-- ─── memberships self-visibility (company switcher) ─────────────────────────────
DROP POLICY IF EXISTS memberships_self_visibility ON memberships;
CREATE POLICY memberships_self_visibility ON memberships
  FOR SELECT USING (user_id = current_setting('app.user_id', true)::uuid);
