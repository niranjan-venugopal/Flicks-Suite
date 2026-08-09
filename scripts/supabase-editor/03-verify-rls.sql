-- =============================================================================
-- STEP 3 of the dashboard-only deploy — THE RLS GATE.
-- Paste into: Supabase Dashboard -> SQL Editor -> New query -> Run.
--
-- SQL-editor equivalent of scripts/diagnose-rls.sh. Every row of the result
-- must show PASS. Do NOT continue the deployment until they all PASS.
-- =============================================================================

-- Everything runs AS the app role: the leak probe must see the database the
-- way the application does (RLS enforced), and the posture checks only read
-- system catalogs, which any role may query.
SET ROLE flicks_app;

CREATE TEMP TABLE _rls_gate (ord int, item text, value text, verdict text);

-- Probe with a deliberately wrong tenant context: every tenant-scoped table
-- must return zero rows.
SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-0000000000ff', false);

DO $sweep$
DECLARE
  t record;
  n bigint;
  leaked text[] := '{}';
  checked int := 0;
BEGIN
  FOR t IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
      JOIN information_schema.columns col
        ON col.table_schema = 'public' AND col.table_name = c.relname AND col.column_name = 'tenant_id'
     WHERE ns.nspname = 'public' AND c.relkind = 'r'
     ORDER BY c.relname
  LOOP
    BEGIN
      EXECUTE format('SELECT count(*) FROM %I', t.relname) INTO n;
      checked := checked + 1;
      IF n > 0 THEN leaked := leaked || t.relname; END IF;
    EXCEPTION WHEN insufficient_privilege THEN
      NULL; -- revoked-by-design tables (outbox, api_keys, webhook ledgers)
    END;
  END LOOP;
  INSERT INTO _rls_gate VALUES
    (1, 'tenant tables probed as flicks_app', checked::text,
        CASE WHEN checked >= 100 THEN 'PASS' ELSE 'FAIL — expected 100+' END),
    (2, 'rows leaked with bogus tenant context', coalesce(array_length(leaked,1),0)::text,
        CASE WHEN coalesce(array_length(leaked,1),0) = 0 THEN 'PASS' ELSE 'FAIL — ' || array_to_string(leaked, ', ') END);
END
$sweep$;

INSERT INTO _rls_gate
SELECT 3, 'tenant tables missing RLS/FORCE', COALESCE(string_agg(c.relname, ', '), '(none)'),
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END
  FROM pg_class c
  JOIN pg_namespace ns ON ns.oid = c.relnamespace
  JOIN information_schema.columns col
    ON col.table_schema='public' AND col.table_name=c.relname AND col.column_name='tenant_id'
  WHERE ns.nspname='public' AND c.relkind='r' AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity);

INSERT INTO _rls_gate
SELECT 4, 'flicks_app role posture',
       COALESCE((SELECT 'exists, bypassrls=' || rolbypassrls FROM pg_roles WHERE rolname='flicks_app'), 'MISSING'),
       CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname='flicks_app' AND NOT rolbypassrls AND NOT rolsuper)
            THEN 'PASS' ELSE 'FAIL — re-run step 2' END;

INSERT INTO _rls_gate
SELECT 5, 'RLS policies installed', count(*)::text,
       CASE WHEN count(*) > 100 THEN 'PASS' ELSE 'FAIL — migrations incomplete' END
  FROM pg_policies WHERE schemaname='public';

RESET ROLE;

SELECT item, value, verdict FROM _rls_gate ORDER BY ord;
