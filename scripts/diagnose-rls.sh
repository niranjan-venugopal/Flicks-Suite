#!/usr/bin/env bash
#
# Flicks Suite — RLS posture diagnostic
#
# Prints exactly why the multi-tenant isolation tests pass or fail:
#   • which role the app connection (DATABASE_URL) actually uses
#   • whether that role bypasses RLS (rolbypassrls / rolsuper / inherited)
#   • whether a deliberately-wrong tenant context still leaks rows
#   • whether the RLS policies + FORCE are present on the database
#
# Usage:
#   set -a; source apps/api/.env; set +a
#   bash scripts/diagnose-rls.sh
#
# Read it like this:
#   connected_as = postgres            -> DATABASE_URL still points at the
#                                         bypass role; repoint it at flicks_app.
#   rolbypassrls = t                   -> this role skips RLS entirely.
#   leak_with_bogus_context > 0        -> this connection is NOT subject to RLS.
#   public_policies = 0 / force = f    -> the RLS migration didn't land here.

set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "ERROR: DATABASE_URL not set. Run: set -a; source apps/api/.env; set +a" >&2
  exit 1
fi

ADMIN_URL="${DATABASE_SERVICE_ROLE_URL:-$DATABASE_URL}"
PA=(-v ON_ERROR_STOP=1 -tAX --no-psqlrc)

echo "════════ APP connection (DATABASE_URL — this is what the API/tests use) ════════"
psql "$DATABASE_URL" "${PA[@]}" -c "
SELECT 'connected_as       = ' || current_user;
SELECT 'rolsuper           = ' || rolsuper || '   rolbypassrls = ' || rolbypassrls
  FROM pg_roles WHERE rolname = current_user;
SELECT 'member_of          = ' || COALESCE(string_agg(r.rolname, ', '), '(none)')
  FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid
  WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = current_user);
"
# With a deliberately-bogus tenant context, an RLS-subject connection must see
# ZERO rows in EVERY tenant-scoped table — not just employees. This sweeps them
# all and reports the ones that leak, so a single table losing its policy can't
# hide behind a green employees check.
LEAK_REPORT="$(psql "$DATABASE_URL" "${PA[@]}" <<'SQL' || true
SELECT set_config('app.tenant_id','00000000-0000-0000-0000-0000000000ff', false);
DO $$
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
  RAISE NOTICE 'tenant_tables_probed     = %', checked;
  RAISE NOTICE 'leak_with_bogus_context  = %  (must be 0)', coalesce(array_length(leaked,1),0);
  IF array_length(leaked,1) > 0 THEN
    RAISE NOTICE 'LEAKING TABLES           = %', array_to_string(leaked, ', ');
  END IF;
END $$;
SQL
)"
echo "$LEAK_REPORT" | grep -E "tenant_tables_probed|leak_with_bogus_context|LEAKING TABLES" || true

echo
echo "════════ Policy / RLS posture (via service-role URL) ════════"
psql "$ADMIN_URL" "${PA[@]}" -c "
SELECT 'public_policies      = ' || count(*) FROM pg_policies WHERE schemaname='public';
SELECT 'tenant_tables        = ' || count(*) FROM information_schema.columns
  WHERE table_schema='public' AND column_name='tenant_id';
SELECT 'tenant_tables_no_rls = ' || COALESCE(string_agg(c.relname, ', '), '(none — good)')
  FROM pg_class c
  JOIN pg_namespace ns ON ns.oid = c.relnamespace
  JOIN information_schema.columns col
    ON col.table_schema='public' AND col.table_name=c.relname AND col.column_name='tenant_id'
  WHERE ns.nspname='public' AND c.relkind='r' AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity);
SELECT 'flicks_app role      = ' || COALESCE(
  (SELECT 'exists, rolbypassrls=' || rolbypassrls FROM pg_roles WHERE rolname='flicks_app'),
  'DOES NOT EXIST — run setup-supabase.sh with APP_ROLE_PASSWORD');
"
echo
echo "Diagnosis hints:"
echo "  • connected_as=postgres OR rolbypassrls=t  -> repoint DATABASE_URL at flicks_app."
echo "  • leak_with_bogus_context > 0              -> those tables are NOT RLS-protected."
echo "  • tenant_tables_no_rls lists anything      -> that table is missing ENABLE/FORCE RLS."
