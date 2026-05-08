#!/usr/bin/env bash
#
# Flicks Suite — local Postgres setup
#
# Idempotent: safe to re-run. Performs:
#   1. Creates the flicks_suite database (if missing)
#   2. Installs required extensions (uuid-ossp, citext, pg_trgm, pgcrypto)
#   3. Applies the schema migration (0001_initial.sql)
#   4. Creates the flicks_app role (NOSUPERUSER, NOBYPASSRLS) used by the API
#   5. Grants table/sequence permissions to flicks_app
#   6. Inserts the default seed tenant (so pnpm db:seed succeeds)
#
# Connects as the Postgres superuser. Override via env vars if needed:
#   PGSUPERUSER       (default: postgres)
#   PGSUPERPASSWORD   (default: postgres)
#   PGHOST            (default: 127.0.0.1)
#   PGPORT            (default: 5432)
#   APP_DB_NAME       (default: flicks_suite)
#   APP_ROLE          (default: flicks_app)
#   APP_ROLE_PASSWORD (default: flicks_app)
#
# Usage:
#   ./scripts/setup-db.sh

set -euo pipefail

PGSUPERUSER="${PGSUPERUSER:-postgres}"
PGSUPERPASSWORD="${PGSUPERPASSWORD:-postgres}"
PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-5432}"
APP_DB_NAME="${APP_DB_NAME:-flicks_suite}"
APP_ROLE="${APP_ROLE:-flicks_app}"
APP_ROLE_PASSWORD="${APP_ROLE_PASSWORD:-flicks_app}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCHEMA_SQL="${REPO_ROOT}/packages/db/drizzle/0001_initial.sql"

if [[ ! -f "$SCHEMA_SQL" ]]; then
  echo "ERROR: Schema file not found at $SCHEMA_SQL" >&2
  exit 1
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "ERROR: psql not found. Install Postgres client tools." >&2
  exit 1
fi

export PGPASSWORD="$PGSUPERPASSWORD"

run_super() {
  psql -h "$PGHOST" -p "$PGPORT" -U "$PGSUPERUSER" -v ON_ERROR_STOP=1 "$@"
}

echo "─── Step 1: ensure database '${APP_DB_NAME}' exists ───"
DB_EXISTS=$(run_super -d postgres -tA -c \
  "SELECT 1 FROM pg_database WHERE datname='${APP_DB_NAME}'" || echo "")
if [[ "$DB_EXISTS" != "1" ]]; then
  run_super -d postgres -c "CREATE DATABASE \"${APP_DB_NAME}\";"
  echo "  ✓ created"
else
  echo "  ✓ already exists"
fi

echo "─── Step 2: install extensions ───"
run_super -d "$APP_DB_NAME" <<SQL
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
SQL
echo "  ✓ extensions ready"

echo "─── Step 3: apply schema (0001_initial.sql) ───"
# Detect whether tables already exist; if so, skip — 0001 is not idempotent
# on its own (CREATE TABLE without IF NOT EXISTS).
TABLES_EXIST=$(run_super -d "$APP_DB_NAME" -tA -c \
  "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='employees' LIMIT 1" || echo "")
if [[ "$TABLES_EXIST" == "1" ]]; then
  echo "  ✓ schema already applied (employees table exists), skipping"
else
  run_super -d "$APP_DB_NAME" -f "$SCHEMA_SQL" >/dev/null
  echo "  ✓ schema applied"
fi

echo "─── Step 4: create app role '${APP_ROLE}' (NOBYPASSRLS) ───"
ROLE_EXISTS=$(run_super -d postgres -tA -c \
  "SELECT 1 FROM pg_roles WHERE rolname='${APP_ROLE}'" || echo "")
if [[ "$ROLE_EXISTS" != "1" ]]; then
  run_super -d postgres -c "CREATE ROLE \"${APP_ROLE}\" WITH LOGIN PASSWORD '${APP_ROLE_PASSWORD}' NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;"
  echo "  ✓ role created"
else
  echo "  ✓ role already exists"
fi

echo "─── Step 5: grant permissions ───"
run_super -d "$APP_DB_NAME" <<SQL >/dev/null
GRANT USAGE ON SCHEMA public TO "${APP_ROLE}";
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public TO "${APP_ROLE}";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${APP_ROLE}";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER ON TABLES TO "${APP_ROLE}";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO "${APP_ROLE}";
SQL
echo "  ✓ granted CRUD + sequence access"

echo "─── Step 6: insert seed tenant (so pnpm db:seed has a target) ───"
run_super -d "$APP_DB_NAME" <<SQL >/dev/null
INSERT INTO tenants (id, name, slug, status)
VALUES ('00000000-0000-0000-0000-000000000001', 'Seed Tenant', 'seed-tenant', 'trialing')
ON CONFLICT (id) DO NOTHING;
SQL
echo "  ✓ seed tenant ready"

echo
echo "✅ Database setup complete."
echo
echo "Connection strings to put in apps/api/.env:"
echo "  DATABASE_URL=postgres://${APP_ROLE}:${APP_ROLE_PASSWORD}@${PGHOST}:${PGPORT}/${APP_DB_NAME}"
echo "  DATABASE_SERVICE_ROLE_URL=postgres://${PGSUPERUSER}:${PGSUPERPASSWORD}@${PGHOST}:${PGPORT}/${APP_DB_NAME}"
echo
echo "Next: run 'pnpm db:seed' to load 11 leave types and 25+ holidays."
