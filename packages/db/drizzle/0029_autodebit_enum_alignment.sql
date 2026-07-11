-- =============================================================================
-- 0029 — auto-debit enum alignment (PRD v4 §8.3 conformance)
-- =============================================================================
-- 0027 shipped invoice_subscriptions.mandate_status / collection_mode and the
-- subscription_charge_attempts ledger WITHOUT the CHECK constraints the PRD
-- specifies, and with a couple of value names that drifted from §8.3/§8.4:
--   • mandate_status used 'authorized'          → PRD says 'authenticated'
--   • charge status used 'succeeded'/'pending'  → PRD says 'captured'/'created'
--   • the ledger lacked attempt_no + failure_code
-- This migration reconciles the stored values to the PRD set, adds the missing
-- columns, and pins both enums with CHECK constraints. Writers are updated in
-- lockstep (subscription-mandates.service.ts).
--
-- Additive + idempotent (drop-then-add constraints, IF NOT EXISTS columns,
-- value UPDATEs that no-op once migrated). Safe to re-run.
-- =============================================================================

-- ─── invoice_subscriptions.mandate_status: migrate legacy value, then constrain ─
UPDATE invoice_subscriptions SET mandate_status = 'authenticated' WHERE mandate_status = 'authorized';
ALTER TABLE invoice_subscriptions DROP CONSTRAINT IF EXISTS invoice_subscriptions_mandate_status_check;
ALTER TABLE invoice_subscriptions ADD  CONSTRAINT invoice_subscriptions_mandate_status_check
  CHECK (mandate_status IN ('none','pending_authorization','authenticated','active','paused','halted','revoked','failed'));

-- ─── invoice_subscriptions.collection_mode: constrain ────────────────────────
ALTER TABLE invoice_subscriptions DROP CONSTRAINT IF EXISTS invoice_subscriptions_collection_mode_check;
ALTER TABLE invoice_subscriptions ADD  CONSTRAINT invoice_subscriptions_collection_mode_check
  CHECK (collection_mode IN ('manual','auto_debit'));

-- ─── subscription_charge_attempts: new columns + status reconciliation ───────
ALTER TABLE subscription_charge_attempts ADD COLUMN IF NOT EXISTS attempt_no   smallint;
ALTER TABLE subscription_charge_attempts ADD COLUMN IF NOT EXISTS failure_code text;
UPDATE subscription_charge_attempts SET status = 'captured' WHERE status = 'succeeded';
UPDATE subscription_charge_attempts SET status = 'created'  WHERE status = 'pending';
-- Postgres names the inline column CHECK from 0027 '<table>_<column>_check'.
ALTER TABLE subscription_charge_attempts DROP CONSTRAINT IF EXISTS subscription_charge_attempts_status_check;
ALTER TABLE subscription_charge_attempts ADD  CONSTRAINT subscription_charge_attempts_status_check
  CHECK (status IN ('created','captured','failed'));
