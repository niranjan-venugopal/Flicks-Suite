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
# With a deliberately-bogus tenant context, an RLS-subject connection must see 0
# employees. Any number > 0 means this connection bypasses RLS.
psql "$DATABASE_URL" "${PA[@]}" -c "
SELECT set_config('app.tenant_id','00000000-0000-0000-0000-0000000000ff', false);
SELECT 'leak_with_bogus_context = ' || count(*) || '  (must be 0)' FROM employees;
" | grep leak_with_bogus_context || true

echo
echo "════════ Policy / RLS posture (via service-role URL) ════════"
psql "$ADMIN_URL" "${PA[@]}" -c "
SELECT 'public_policies    = ' || count(*) || '   (expect ~24)' FROM pg_policies WHERE schemaname='public';
SELECT 'employees rls/force= ' || relrowsecurity || ' / ' || relforcerowsecurity || '   (expect t / t)'
  FROM pg_class WHERE relname='employees';
SELECT 'flicks_app role    = ' || COALESCE(
  (SELECT 'exists, rolbypassrls=' || rolbypassrls FROM pg_roles WHERE rolname='flicks_app'),
  'DOES NOT EXIST — run setup-supabase.sh with APP_ROLE_PASSWORD');
"
echo
echo "Diagnosis hints:"
echo "  • connected_as=postgres OR rolbypassrls=t  -> repoint DATABASE_URL at flicks_app."
echo "  • leak_with_bogus_context > 0              -> app connection is bypassing RLS."
echo "  • public_policies=0 / force=f              -> re-run setup-supabase.sh (policies missing)."
