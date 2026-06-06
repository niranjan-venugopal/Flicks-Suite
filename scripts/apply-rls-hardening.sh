#!/usr/bin/env bash
#
# Flicks Suite — apply RLS hardening (migrations 0009–0011) to an existing DB.
#
# This applies, idempotently and in order:
#   0009_rls_bucket_b.sql        RLS on memberships + subscriptions,
#                                subscription_events, tenant_health_snapshots,
#                                account_deletion_requests, impersonation_sessions
#   0010_rls_users_tenants.sql   scoped RLS on users (member-of-tenant) + tenants
#   0011_rls_identity_lockdown.sql deny-all RLS on the identity/platform tables
#                                (auth_otps, refresh_tokens, trusted_devices,
#                                auth_events, notification_preferences,
#                                notifications, feature_flags, tenant_cohorts,
#                                audit_log_platform) — re-locks auth_otps correctly.
#
# After this, ALL tables are RLS-protected (40/40).
#
# ┌───────────────────────────────────────────────────────────────────────────┐
# │ ⚠  DEPLOY THE MATCHING API CODE FIRST (or in the same release).            │
# │    These policies require the app code that routes auth/onboarding to the  │
# │    service-role connection and wraps employees/timesheet reads in          │
# │    withTenant(). Applying them while the OLD code is running WILL break     │
# │    login and the employees/timesheet modules. That is why this script      │
# │    requires an explicit --yes (or CONFIRM=1).                              │
# └───────────────────────────────────────────────────────────────────────────┘
#
# Connection: uses DATABASE_DIRECT_URL — the PRIVILEGED (postgres / owner)
# connection, NOT DATABASE_URL. Enabling RLS and creating policies needs owner
# rights; the NOBYPASSRLS app role cannot do it. (Same var the other setup
# scripts use.)
#
# Usage:
#   set -a; source apps/api/.env; set +a
#   bash scripts/apply-rls-hardening.sh --yes
#   # or: CONFIRM=1 DATABASE_DIRECT_URL='postgresql://postgres:...:5432/postgres' \
#   #        bash scripts/apply-rls-hardening.sh
#
# Optional env:
#   APP_ROLE   name of the NOBYPASSRLS app role (default: flicks_app) — used only
#              to re-assert table/sequence grants and to run the leak spot-check.

set -euo pipefail

# ─── Confirmation gate (because of the code-coupling above) ──────────────────
CONFIRMED="${CONFIRM:-0}"
for arg in "$@"; do
  case "$arg" in
    --yes|-y) CONFIRMED=1 ;;
  esac
done
if [[ "$CONFIRMED" != "1" ]]; then
  cat >&2 <<'WARN'
Refusing to run without confirmation.

These migrations REQUIRE the matching API code to be deployed first/with them.
Applying them against a database whose API is still running the OLD code will
break login and the employees/timesheet modules.

If the new API code (branch fix/rls-tenant-context) is deployed, re-run with:
    bash scripts/apply-rls-hardening.sh --yes
WARN
  exit 2
fi

if [[ -z "${DATABASE_DIRECT_URL:-}" ]]; then
  echo "ERROR: DATABASE_DIRECT_URL is not set (privileged/owner connection)." >&2
  echo "Export it or 'source apps/api/.env' before running." >&2
  exit 1
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "ERROR: psql not found. Install libpq (e.g. brew install libpq)." >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DRIZZLE_DIR="${REPO_ROOT}/packages/db/drizzle"
APP_ROLE="${APP_ROLE:-flicks_app}"
PSQL_ARGS=(-v ON_ERROR_STOP=1 --quiet --no-psqlrc)
# Quieten the harmless "policy ... does not exist, skipping" NOTICEs that the
# idempotent DROP POLICY IF EXISTS lines emit on a first apply.
export PGOPTIONS='-c client_min_messages=warning'

MIGRATIONS=(
  "0009_rls_bucket_b.sql"
  "0010_rls_users_tenants.sql"
  "0011_rls_identity_lockdown.sql"
)

echo "─── Step 1: probe connectivity ───"
SERVER_VERSION=$(psql "$DATABASE_DIRECT_URL" "${PSQL_ARGS[@]}" -tAc "show server_version;" | tr -d '[:space:]')
echo "  ✓ connected (Postgres ${SERVER_VERSION})"

echo "─── Step 2: apply RLS migrations (idempotent, in order) ───"
for m in "${MIGRATIONS[@]}"; do
  f="${DRIZZLE_DIR}/${m}"
  [[ -f "$f" ]] || { echo "ERROR: migration not found: $f" >&2; exit 1; }
  psql "$DATABASE_DIRECT_URL" "${PSQL_ARGS[@]}" -f "$f" >/dev/null
  echo "  ✓ applied ${m}"
done

echo "─── Step 3: re-assert grants for app role '${APP_ROLE}' ───"
# RLS does not change grants, but re-asserting is a cheap no-op that guarantees
# the app role can reach every table it is allowed to (subject to RLS).
if psql "$DATABASE_DIRECT_URL" "${PSQL_ARGS[@]}" -tAc \
     "SELECT 1 FROM pg_roles WHERE rolname='${APP_ROLE}'" | grep -q 1; then
  psql "$DATABASE_DIRECT_URL" "${PSQL_ARGS[@]}" >/dev/null <<SQL
GRANT USAGE ON SCHEMA public TO "${APP_ROLE}";
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public TO "${APP_ROLE}";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${APP_ROLE}";
SQL
  echo "  ✓ grants re-asserted for '${APP_ROLE}'"
else
  echo "  ⚠ role '${APP_ROLE}' not found — skipping grants. (Create it via"
  echo "    setup-supabase.sh / setup-db.sh and point DATABASE_URL at it.)"
fi

echo "─── Step 4: verify posture ───"
psql "$DATABASE_DIRECT_URL" "${PSQL_ARGS[@]}" -tAc \
  "SELECT '  RLS coverage: ' || count(*) FILTER (WHERE relrowsecurity) || '/' || count(*) || ' tables'
   FROM pg_class WHERE relkind='r' AND relnamespace='public'::regnamespace;"

NOT_RLS=$(psql "$DATABASE_DIRECT_URL" "${PSQL_ARGS[@]}" -tAc \
  "SELECT string_agg(relname, ', ')
   FROM pg_class WHERE relkind='r' AND relnamespace='public'::regnamespace AND NOT relrowsecurity;")
if [[ -z "$NOT_RLS" ]]; then
  echo "  ✓ every table has RLS enabled"
else
  echo "  ⚠ tables still WITHOUT RLS: ${NOT_RLS}"
fi

# Leak spot-check: as the app role, a bogus tenant context must see 0 rows of
# tenant data and be denied the identity tables. Mirrors scripts/diagnose-rls.sh.
if psql "$DATABASE_DIRECT_URL" "${PSQL_ARGS[@]}" -tAc \
     "SELECT 1 FROM pg_roles WHERE rolname='${APP_ROLE}' AND NOT rolbypassrls AND NOT rolsuper" | grep -q 1; then
  psql "$DATABASE_DIRECT_URL" "${PSQL_ARGS[@]}" -tAc "
    SET ROLE \"${APP_ROLE}\";
    SELECT set_config('app.tenant_id','00000000-0000-0000-0000-000000000000', false);
    SELECT '  leak check (bogus ctx): employees=' || (SELECT count(*) FROM employees)
        || '  memberships=' || (SELECT count(*) FROM memberships)
        || '  auth_otps='   || (SELECT count(*) FROM auth_otps)
        || '   (all must be 0)';
    RESET ROLE;" 2>/dev/null | grep 'leak check' || echo "  (leak check skipped)"
else
  echo "  ⚠ '${APP_ROLE}' is superuser/bypassrls or missing — leak check skipped."
  echo "    DATABASE_URL must point at a NOBYPASSRLS role for RLS to isolate."
fi

echo
echo "✅ RLS hardening applied. Run scripts/diagnose-rls.sh for the full posture report."
