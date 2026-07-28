-- Re-assert the per-table lockdowns the migrations establish.
--
-- Every provisioning path ends with a blanket
--   GRANT ... ON ALL TABLES IN SCHEMA public TO flicks_app
-- which silently undoes the append-only ledgers and service-role-only tables
-- the migrations carefully locked down. RLS absorbs most of it, but the
-- grant-only controls (ledger immutability, read-only reference data) are NOT
-- RLS-backed — they are exactly what the isolation suite asserts.
--
-- Run this AFTER the grant, on every path. Idempotent.
-- Kept in ONE file so the three setup scripts can never drift apart again.

DO $$
DECLARE
  r text := 'flicks_app';
  has_table boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
    RAISE NOTICE 'role % absent — nothing to re-lock', r;
    RETURN;
  END IF;

  -- (table, revoke clause) pairs — mirrors the migration that locked each one.
  FOR has_table IN SELECT true LOOP EXIT; END LOOP; -- no-op to keep the block tidy

  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='consent_records') THEN
    EXECUTE format('REVOKE UPDATE, DELETE ON consent_records FROM %I', r);              -- 0022 append-only
  END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='feedback_submissions') THEN
    EXECUTE format('REVOKE UPDATE, DELETE ON feedback_submissions FROM %I', r);         -- 0026
  END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='nps_responses') THEN
    EXECUTE format('REVOKE DELETE ON nps_responses FROM %I', r);                        -- 0026
  END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='subscription_charge_attempts') THEN
    EXECUTE format('REVOKE UPDATE, DELETE ON subscription_charge_attempts FROM %I', r); -- 0027 ledger
  END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='coupon_codes') THEN
    EXECUTE format('REVOKE ALL ON coupon_codes FROM %I', r);                            -- 0028 service-role only
  END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='coupon_redemptions') THEN
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON coupon_redemptions FROM %I', r);   -- 0028 read-only
  END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='domain_events') THEN
    EXECUTE format('REVOKE SELECT, UPDATE, DELETE ON domain_events FROM %I', r);        -- 0030 outbox: INSERT-only
  END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='api_keys') THEN
    EXECUTE format('REVOKE ALL ON api_keys FROM %I', r);                                -- 0030 service-role only
  END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='webhook_endpoints') THEN
    EXECUTE format('REVOKE ALL ON webhook_endpoints FROM %I', r);                       -- 0030 service-role only
  END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='webhook_deliveries') THEN
    EXECUTE format('REVOKE ALL ON webhook_deliveries FROM %I', r);                      -- 0030 service-role only
  END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='fx_rates') THEN
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON fx_rates FROM %I', r);             -- 0032 read-only reference
  END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='resend_webhook_events') THEN
    EXECUTE format('REVOKE ALL ON resend_webhook_events FROM %I', r);                   -- 0035 service-role only
  END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='github_webhook_events') THEN
    EXECUTE format('REVOKE ALL ON github_webhook_events FROM %I', r);                   -- 0046 service-role only
  END IF;
END $$;
