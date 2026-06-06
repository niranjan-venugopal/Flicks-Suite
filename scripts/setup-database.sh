#!/usr/bin/env bash
#
# Flicks Suite — one-command database setup + RLS hardening.
#
# Combines scripts/setup-supabase.sh (schema + all migrations + app role +
# grants + seed tenant) with scripts/apply-rls-hardening.sh (RLS verification),
# so a single command brings a database to the correct, fully-RLS-protected
# state (40/40 tables) and reports its posture.
#
# ─── Two modes ──────────────────────────────────────────────────────────────
#
#   (default)         FULL setup + RLS hardening (migrations 0001–0011).
#                     Use this WITH the matching API code deployed
#                     (branch fix/rls-tenant-context). Login works because auth
#                     runs on the service-role connection.
#
#   --unblock-login   Setup WITHOUT the coupled RLS migrations (skips
#                     0009–0011) AND disables auth_otps RLS — the Step 0
#                     one-liner. Use this to unblock login on the CURRENT/OLD
#                     code, before the new code is deployed. Re-run in the
#                     default mode once the new code is live to get to 40/40.
#
# Why the split: migrations 0009–0011 require the new code (auth/onboarding on
# the service role; employees/timesheet wrapped in withTenant). Applying them
# while the OLD code runs breaks login + employees/timesheet — so the
# login-unblock mode deliberately does NOT apply them.
#
# ─── Connection ─────────────────────────────────────────────────────────────
# Uses a PRIVILEGED connection (owner/superuser) — enabling RLS, creating
# policies, and creating the app role all need it. Resolved in this order:
#   1. DATABASE_DIRECT_URL           (Supabase session-mode / remote)
#   2. DATABASE_SERVICE_ROLE_URL     (the service-role connection)
#   3. local PG* vars                (PGHOST/PGPORT/PGSUPERUSER/APP_DB_NAME)
# apps/api/.env is auto-sourced if present and nothing is exported.
#
# ─── Optional env ───────────────────────────────────────────────────────────
#   APP_ROLE            NOBYPASSRLS app role name           (default: flicks_app)
#   APP_ROLE_PASSWORD   if set, (re)creates the app role + grants
#
# ─── Usage ──────────────────────────────────────────────────────────────────
#   set -a; source apps/api/.env; set +a
#   bash scripts/setup-database.sh                 # full setup + harden (new code)
#   bash scripts/setup-database.sh --unblock-login # unblock login on old code
#   APP_ROLE_PASSWORD='<pwd>' bash scripts/setup-database.sh

set -euo pipefail

MODE="harden"
for arg in "$@"; do
  case "$arg" in
    --unblock-login) MODE="unblock" ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $arg (use --unblock-login or --help)" >&2; exit 1 ;;
  esac
done

if ! command -v psql >/dev/null 2>&1; then
  echo "ERROR: psql not found. Install libpq (e.g. brew install libpq)." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DRIZZLE_DIR="${REPO_ROOT}/packages/db/drizzle"
APP_ROLE="${APP_ROLE:-flicks_app}"
PSQL_ARGS=(-v ON_ERROR_STOP=1 --quiet --no-psqlrc)
export PGOPTIONS='-c client_min_messages=warning'

# Auto-source apps/api/.env (same convenience as setup-demo.sh).
ENV_FILE="$REPO_ROOT/apps/api/.env"
if [[ -z "${DATABASE_DIRECT_URL:-}" && -z "${DATABASE_SERVICE_ROLE_URL:-}" && -f "$ENV_FILE" ]]; then
  echo "  ↳ sourcing $ENV_FILE"
  set -a; # shellcheck disable=SC1090
  source "$ENV_FILE"; set +a
fi

# Resolve the privileged connection target into an array usable by psql.
if [[ -n "${DATABASE_DIRECT_URL:-}" ]]; then
  CONN=("$DATABASE_DIRECT_URL")
elif [[ -n "${DATABASE_SERVICE_ROLE_URL:-}" ]]; then
  CONN=("$DATABASE_SERVICE_ROLE_URL")
else
  export PGPASSWORD="${PGSUPERPASSWORD:-postgres}"
  CONN=(-h "${PGHOST:-127.0.0.1}" -p "${PGPORT:-5432}" -U "${PGSUPERUSER:-postgres}" -d "${APP_DB_NAME:-flicks_suite}")
fi

psql_run() { psql "${CONN[@]}" "${PSQL_ARGS[@]}" "$@"; }

echo "═══ Flicks DB setup (mode: ${MODE}) ═══"

echo "─── Step 1: probe connectivity ───"
SERVER_VERSION=$(psql_run -tAc "show server_version;" | tr -d '[:space:]')
echo "  ✓ connected (Postgres ${SERVER_VERSION})"

echo "─── Step 2: extensions ───"
psql_run >/dev/null <<'SQL'
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
SQL
echo "  ✓ extensions ready"

echo "─── Step 3: base schema (0001_initial.sql) ───"
TABLES_EXIST=$(psql_run -tAc \
  "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='tenants' LIMIT 1;")
if [[ "${TABLES_EXIST}" == "1" ]]; then
  echo "  ✓ schema already present, skipping"
else
  psql_run -f "${DRIZZLE_DIR}/0001_initial.sql" >/dev/null
  echo "  ✓ schema applied"
fi

echo "─── Step 4: migrations ───"
# In unblock mode we deliberately skip the RLS migrations that require the new
# code (0009–0011). In harden mode we apply everything.
SKIP_RLS_RE='0009_|0010_|0011_'
for MIG in "${DRIZZLE_DIR}/"[0-9]*.sql; do
  base=$(basename "$MIG")
  [[ "$base" == "0001_initial.sql" ]] && continue
  if [[ "$MODE" == "unblock" && "$base" =~ $SKIP_RLS_RE ]]; then
    echo "  ⏭ skipped $base (RLS migration — needs new code)"
    continue
  fi
  psql_run -f "$MIG" >/dev/null
  echo "  ✓ applied $base"
done

echo "─── Step 5: app role '${APP_ROLE}' (NOBYPASSRLS) + grants ───"
if [[ -n "${APP_ROLE_PASSWORD:-}" ]]; then
  psql_run >/dev/null <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
    CREATE ROLE "${APP_ROLE}" WITH LOGIN PASSWORD '${APP_ROLE_PASSWORD}'
      NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;
  ELSE
    ALTER ROLE "${APP_ROLE}" WITH LOGIN PASSWORD '${APP_ROLE_PASSWORD}' NOBYPASSRLS;
  END IF;
END
\$\$;
GRANT USAGE ON SCHEMA public TO "${APP_ROLE}";
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public TO "${APP_ROLE}";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${APP_ROLE}";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER ON TABLES TO "${APP_ROLE}";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO "${APP_ROLE}";
SQL
  echo "  ✓ role '${APP_ROLE}' ready + grants (point DATABASE_URL at it)"
elif psql_run -tAc "SELECT 1 FROM pg_roles WHERE rolname='${APP_ROLE}'" | grep -q 1; then
  psql_run >/dev/null <<SQL
GRANT USAGE ON SCHEMA public TO "${APP_ROLE}";
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public TO "${APP_ROLE}";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${APP_ROLE}";
SQL
  echo "  ✓ grants re-asserted for existing role '${APP_ROLE}'"
else
  echo "  ⚠ APP_ROLE_PASSWORD not set and role '${APP_ROLE}' missing — skipping."
  echo "    RLS only isolates tenants when DATABASE_URL uses a NOBYPASSRLS role."
fi

echo "─── Step 6: seed tenant ───"
psql_run >/dev/null <<SQL
INSERT INTO tenants (id, name, slug, status)
VALUES ('00000000-0000-0000-0000-000000000001', 'Seed Tenant', 'seed-tenant', 'trialing')
ON CONFLICT (id) DO NOTHING;
SQL
echo "  ✓ seed tenant ready"

if [[ "$MODE" == "unblock" ]]; then
  echo "─── Step 7: unblock login (disable auth_otps RLS — Step 0) ───"
  psql_run >/dev/null <<'SQL'
ALTER TABLE auth_otps DISABLE ROW LEVEL SECURITY;
SQL
  echo "  ✓ auth_otps RLS disabled — login works on the current/old code"
fi

echo "─── Step 8: verify posture ───"
psql_run -tAc \
  "SELECT '  RLS coverage: ' || count(*) FILTER (WHERE relrowsecurity) || '/' || count(*) || ' tables'
   FROM pg_class WHERE relkind='r' AND relnamespace='public'::regnamespace;"
NOT_RLS=$(psql_run -tAc \
  "SELECT string_agg(relname, ', ')
   FROM pg_class WHERE relkind='r' AND relnamespace='public'::regnamespace AND NOT relrowsecurity;")
if [[ -z "$NOT_RLS" ]]; then
  echo "  ✓ every table has RLS enabled"
else
  echo "  • tables without RLS: ${NOT_RLS}"
fi
if psql_run -tAc "SELECT 1 FROM pg_roles WHERE rolname='${APP_ROLE}' AND NOT rolbypassrls AND NOT rolsuper" | grep -q 1; then
  psql_run -tAc "
    SET ROLE \"${APP_ROLE}\";
    SELECT set_config('app.tenant_id','00000000-0000-0000-0000-000000000000', false);
    SELECT '  leak check (bogus ctx): employees=' || (SELECT count(*) FROM employees)
        || '  memberships=' || (SELECT count(*) FROM memberships)
        || '   (must be 0)';
    RESET ROLE;" 2>/dev/null | grep 'leak check' || true
fi

echo
if [[ "$MODE" == "unblock" ]]; then
  echo "✅ Login-unblock setup complete (old code safe)."
  echo "   auth_otps RLS is OFF. RLS migrations 0009–0011 were NOT applied."
  echo "   After deploying the new API code, run WITHOUT --unblock-login to reach 40/40:"
  echo "     bash scripts/setup-database.sh"
else
  echo "✅ Full setup + RLS hardening complete (target: 40/40 tables)."
  echo "   ⚠ Requires the matching API code (branch fix/rls-tenant-context) deployed."
  echo "   If you are still on the OLD code and need login NOW, run:"
  echo "     bash scripts/setup-database.sh --unblock-login"
fi
echo "   Optional demo data:  pnpm setup:demo"
