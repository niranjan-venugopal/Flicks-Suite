-- 0048 — security hardening pass (pre-beta audit)
--
-- 1. resend_webhook_events was the ONE table in the schema with no RLS at all.
--    Its only protection was "we never granted it", which any blanket
--    GRANT ... ON ALL TABLES silently undoes. Its siblings
--    (razorpay_webhook_events, github_webhook_events) are FORCE + deny-all;
--    bring this one in line so provisioning order stops mattering.
-- 2. Re-assert the service-role-only posture for the webhook ledgers.
--
-- Idempotent: safe to re-run.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'resend_webhook_events') THEN
    EXECUTE 'ALTER TABLE resend_webhook_events ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE resend_webhook_events FORCE ROW LEVEL SECURITY';
    -- Deny-all for the app role; the service role bypasses RLS entirely.
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'resend_webhook_events'
        AND policyname = 'service_role_only_resend_webhook_events'
    ) THEN
      EXECUTE 'CREATE POLICY service_role_only_resend_webhook_events ON resend_webhook_events
                 USING (false) WITH CHECK (false)';
    END IF;
  END IF;
END $$;

-- Belt-and-braces: strip any grant a blanket provisioning step handed out.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flicks_app') THEN
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'resend_webhook_events') THEN
      EXECUTE 'REVOKE ALL ON resend_webhook_events FROM flicks_app';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'github_webhook_events') THEN
      EXECUTE 'REVOKE ALL ON github_webhook_events FROM flicks_app';
    END IF;
  END IF;
END $$;
