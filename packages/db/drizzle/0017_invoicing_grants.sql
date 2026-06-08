-- =============================================================================
-- 0017 — Invoicing v3: grant the new tables to the app role (flicks_app)
-- =============================================================================
-- Why this exists: the invoicing tables (0012–0016) are owned by the migration
-- role (Supabase `postgres`). The API connects as the NOBYPASSRLS `flicks_app`
-- role, which needs table-level privileges IN ADDITION to the RLS policies.
-- scripts/setup-supabase.sh / setup-database.sh re-GRANT after every run, so if
-- you apply migrations with those scripts you're already covered. This migration
-- makes the grant self-contained so applying the SQL any other way (e.g. pasting
-- into the Supabase SQL editor) still leaves the app able to read/write — without
-- it you'd get "permission denied for table …" even though RLS is correct.
--
-- Safe on any database:
--   • guarded by role existence (no-op if flicks_app isn't present);
--   • grants are additive + idempotent (re-running changes nothing);
--   • does NOT touch existing V1 data — only privileges.
-- RLS still confines flicks_app to its tenant rows (it is NOBYPASSRLS).
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flicks_app') THEN
    -- Cover every current public table (new invoicing tables + existing V1).
    GRANT USAGE ON SCHEMA public TO flicks_app;
    GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER
      ON ALL TABLES IN SCHEMA public TO flicks_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO flicks_app;
    -- Cover any tables created later in this schema by the migration role.
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER ON TABLES TO flicks_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT USAGE, SELECT ON SEQUENCES TO flicks_app;
  END IF;
END $$;
