#!/usr/bin/env bash
#
# Flicks Suite — Supabase remote setup
#
# Applies schema + seed tenant to a remote Supabase Postgres using
# the connection string in DATABASE_DIRECT_URL (session mode, port 5432).
#
# Idempotent: re-runs are safe. Skips schema apply if `tenants` table exists.
#
# Required env:
#   DATABASE_DIRECT_URL   postgresql://postgres.<ref>:<pwd>@aws-1-...:5432/postgres
#                         (password MUST be URL-encoded — '@' → '%40' etc.)
#   APP_ROLE_PASSWORD     password for the NOBYPASSRLS app role created below.
#                         If unset, the role step is skipped (RLS will NOT isolate
#                         tenants until DATABASE_URL uses a non-bypass role).
#
# After running, set in apps/api/.env:
#   DATABASE_URL              -> connects as the app role (NOBYPASSRLS) — RLS applies
#   DATABASE_SERVICE_ROLE_URL -> connects as postgres (BYPASSRLS)  — admin/FAM only
# Pointing DATABASE_URL at the postgres role disables tenant isolation entirely.
#
# Usage:
#   set -a; source apps/api/.env; set +a
#   APP_ROLE_PASSWORD='<strong-pwd>' bash scripts/setup-supabase.sh

set -euo pipefail

if [[ -z "${DATABASE_DIRECT_URL:-}" ]]; then
  echo "ERROR: DATABASE_DIRECT_URL is not set." >&2
  echo "Export it (or source apps/api/.env) before running this script." >&2
  exit 1
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "ERROR: psql not found. Install with: brew install libpq && brew link --force libpq" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCHEMA_SQL="${REPO_ROOT}/packages/db/drizzle/0001_initial.sql"

if [[ ! -f "$SCHEMA_SQL" ]]; then
  echo "ERROR: Schema file not found at $SCHEMA_SQL" >&2
  exit 1
fi

PSQL_ARGS=(-v ON_ERROR_STOP=1 --quiet --no-psqlrc)

# Dedicated app role that the API connects as. It MUST be NOBYPASSRLS so the
# tenant-isolation policies actually apply. The privileged Supabase `postgres`
# role bypasses RLS, so it is used ONLY for the service-role connection and for
# this setup script — never for DATABASE_URL.
APP_ROLE="${APP_ROLE:-flicks_app}"

echo "─── Step 1: probe connectivity ───"
SERVER_VERSION=$(psql "$DATABASE_DIRECT_URL" "${PSQL_ARGS[@]}" -tAc "show server_version;" | tr -d '[:space:]')
echo "  ✓ connected (Postgres ${SERVER_VERSION})"

echo "─── Step 2: install extensions ───"
psql "$DATABASE_DIRECT_URL" "${PSQL_ARGS[@]}" <<SQL
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
SQL
echo "  ✓ extensions ready"

echo "─── Step 3: apply schema (0001_initial.sql) ───"
TABLES_EXIST=$(psql "$DATABASE_DIRECT_URL" "${PSQL_ARGS[@]}" -tAc \
  "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='tenants' LIMIT 1;")
if [[ "${TABLES_EXIST}" == "1" ]]; then
  echo "  ✓ schema already applied (tenants table exists), skipping"
else
  psql "$DATABASE_DIRECT_URL" "${PSQL_ARGS[@]}" -f "$SCHEMA_SQL" >/dev/null
  echo "  ✓ schema applied"
fi

echo "─── Step 3b: apply incremental migrations (>=0002) ───"
# Each migration file uses IF NOT EXISTS guards so re-applying is a no-op.
# Loop in lexical order so 0002 lands before 0003 etc.
for MIG in "${REPO_ROOT}/packages/db/drizzle/"[0-9]*.sql; do
  base=$(basename "$MIG")
  # Skip 0001 — handled by Step 3.
  if [[ "$base" == "0001_initial.sql" ]]; then continue; fi
  psql "$DATABASE_DIRECT_URL" "${PSQL_ARGS[@]}" -f "$MIG" >/dev/null
  echo "  ✓ applied $base"
done

echo "─── Step 3c: app role '${APP_ROLE}' (NOBYPASSRLS) + grants ───"
# RLS only isolates tenants when the API connects as a role that is SUBJECT to
# row-level security. Supabase's `postgres` role BYPASSES RLS, so if DATABASE_URL
# uses it, every tenant can read every other tenant's data (the multi-tenant
# isolation tests fail wholesale). This creates the dedicated NOBYPASSRLS role
# the API should use, mirroring scripts/setup-db.sh for local Postgres.
if [[ -z "${APP_ROLE_PASSWORD:-}" ]]; then
  echo "  ⚠ APP_ROLE_PASSWORD not set — SKIPPING role creation."
  echo "    Until DATABASE_URL points at a NOBYPASSRLS role, RLS does NOT isolate"
  echo "    tenants. Re-run with: APP_ROLE_PASSWORD='<strong-pwd>' bash scripts/setup-supabase.sh"
else
  psql "$DATABASE_DIRECT_URL" "${PSQL_ARGS[@]}" <<SQL >/dev/null
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
  echo "  ✓ role '${APP_ROLE}' ready (NOBYPASSRLS) — point DATABASE_URL at it"
fi

echo "─── Step 4: insert seed tenant ───"
psql "$DATABASE_DIRECT_URL" "${PSQL_ARGS[@]}" <<SQL >/dev/null
INSERT INTO tenants (id, name, slug, status)
VALUES ('00000000-0000-0000-0000-000000000001', 'Seed Tenant', 'seed-tenant', 'trialing')
ON CONFLICT (id) DO NOTHING;
SQL
echo "  ✓ seed tenant ready"

echo
echo "✅ Supabase setup complete."
echo
echo "Next:"
echo "  pnpm db:seed         # 11 leave types + 25+ holidays"
echo "  pnpm setup:demo      # demo tenant + alice@demo.co + manager@demo.co"
echo "  pnpm dev             # boot API on :4000 and web on :3000"
