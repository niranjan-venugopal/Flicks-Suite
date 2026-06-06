-- 0011 — Lock down the identity / platform tables with deny-all RLS.
--
-- These tables have no tenant dimension a tenant connection could be scoped
-- to, and they are touched ONLY by the service-role (BYPASSRLS) connection
-- (auth.service, notifications.service, fam.service, audit.service's platform
-- log). So we enable RLS with a policy that denies everyone: the service role
-- bypasses RLS and keeps working, while the NOBYPASSRLS app role can never
-- read or write them — even by accident.
--
-- This also re-enables RLS on auth_otps the RIGHT way. It had been enabled
-- out-of-band (Supabase dashboard) with NO policy, which default-denied the
-- app role's OTP insert and 500'd login; the documented hotfix was to disable
-- it. This migration restores it as an explicit, intentional deny-all.
--
-- Idempotent: ENABLE/FORCE are no-ops if set; policies dropped before create.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'auth_otps',
    'refresh_tokens',
    'trusted_devices',
    'auth_events',
    'notification_preferences',
    'notifications',
    'feature_flags',
    'tenant_cohorts',
    'audit_log_platform'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS service_role_only_%I ON %I', t, t);
    EXECUTE format(
      'CREATE POLICY service_role_only_%I ON %I FOR ALL USING (false) WITH CHECK (false)',
      t, t
    );
  END LOOP;
END $$;
