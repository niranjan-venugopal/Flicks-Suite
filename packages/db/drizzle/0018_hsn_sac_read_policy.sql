-- =============================================================================
-- 0018 — hsn_sac_codes: RLS on + global read policy (dashboard-drift-proof)
-- =============================================================================
-- The HSN/SAC master is a GLOBAL reference table (same rows for every tenant).
-- It originally shipped without RLS, but Supabase's dashboard/security advisor
-- tends to flag and enable RLS on it — and RLS with NO policy silently breaks
-- HSN search for the app role (zero rows). Observed live: a fresh sync against
-- Supabase reported 69/69 tables RLS-enabled, meaning the dashboard had already
-- turned it on.
--
-- Fix: own the posture in the migration. Enable RLS deliberately and add a
-- permissive SELECT-for-all policy:
--   • reads work for every role, with or without dashboard drift;
--   • writes by the app role are denied (no INSERT/UPDATE/DELETE policy) —
--     tenant-specific codes belong in tenant_hsn_sac_codes;
--   • seeds/admin writes still work (the postgres owner is not FORCEd).
-- Idempotent.
-- =============================================================================

ALTER TABLE hsn_sac_codes ENABLE ROW LEVEL SECURITY;
-- Deliberately NOT FORCE: the owning role (postgres) keeps seeding/managing the
-- master; only non-owner roles (flicks_app) are subject to the policies below.

DROP POLICY IF EXISTS hsn_sac_codes_global_read ON hsn_sac_codes;
CREATE POLICY hsn_sac_codes_global_read ON hsn_sac_codes
  FOR SELECT USING (true);
