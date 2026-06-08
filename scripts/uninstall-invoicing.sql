-- =============================================================================
-- Uninstall Invoicing v3 — clean rollback (V1-safe)
-- =============================================================================
-- Removes ONLY the objects added by migrations 0012–0017, returning the
-- database to its pre-invoicing (V1 HRMS) state. Use this if you want to back
-- the module out of your single Supabase database without disturbing HRMS.
--
-- Run as the privileged role (Supabase `postgres`):
--   psql "$DATABASE_DIRECT_URL" -v ON_ERROR_STOP=1 -f scripts/uninstall-invoicing.sql
--
-- Everything is IF EXISTS / CASCADE, so it is safe to run more than once.
-- It does NOT touch any V1 table or its data.
--
-- NOTE: the one change it cannot fully reverse is the `'auditor'` value added to
-- the membership_role enum — Postgres does not support removing an enum value.
-- It is harmless (no rows use it after the tables below are dropped).
-- =============================================================================

BEGIN;

-- ─── Invoicing tables (children + parents; CASCADE clears FKs/policies) ─────────
DROP TABLE IF EXISTS invoice_subscription_proration_events CASCADE;
DROP TABLE IF EXISTS invoice_subscription_line_items     CASCADE;
DROP TABLE IF EXISTS invoice_payments                    CASCADE;
DROP TABLE IF EXISTS invoice_line_items                  CASCADE;
DROP TABLE IF EXISTS credit_note_line_items              CASCADE;
DROP TABLE IF EXISTS debit_note_line_items               CASCADE;
DROP TABLE IF EXISTS reminder_sent                       CASCADE;
DROP TABLE IF EXISTS reminder_schedule                   CASCADE;
DROP TABLE IF EXISTS gstr1_exports                       CASCADE;
DROP TABLE IF EXISTS form_131_received                   CASCADE;
DROP TABLE IF EXISTS adjustments                         CASCADE;
DROP TABLE IF EXISTS credit_notes                        CASCADE;
DROP TABLE IF EXISTS debit_notes                         CASCADE;
DROP TABLE IF EXISTS invoices                            CASCADE;
DROP TABLE IF EXISTS invoice_subscriptions               CASCADE;
DROP TABLE IF EXISTS tenant_currency_bank_defaults       CASCADE;
DROP TABLE IF EXISTS tenant_bank_accounts                CASCADE;
DROP TABLE IF EXISTS invoice_sequences                   CASCADE;
DROP TABLE IF EXISTS items                               CASCADE;
DROP TABLE IF EXISTS customer_credit_balance_entries     CASCADE;
DROP TABLE IF EXISTS customer_credit_balance             CASCADE;
DROP TABLE IF EXISTS customers                           CASCADE;
DROP TABLE IF EXISTS invoicing_setup_progress            CASCADE;
DROP TABLE IF EXISTS invoicing_settings                  CASCADE;
DROP TABLE IF EXISTS tenant_hsn_sac_codes                CASCADE;
DROP TABLE IF EXISTS hsn_sac_codes                       CASCADE;
DROP TABLE IF EXISTS membership_grants                   CASCADE;
DROP TABLE IF EXISTS tenant_module_toggles               CASCADE;
DROP TABLE IF EXISTS razorpay_webhook_events             CASCADE;

-- ─── Revert the additive changes to the V1 `memberships` table ──────────────────
DROP POLICY IF EXISTS memberships_self_visibility ON memberships;
ALTER TABLE memberships DROP COLUMN IF EXISTS is_external;
ALTER TABLE memberships DROP COLUMN IF EXISTS access_expires_at;

COMMIT;
