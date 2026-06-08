#!/usr/bin/env bash
#
# Flicks Suite — ONE-COMMAND Supabase sync.
#
#   pnpm sync:supabase
#
# Applies every migration (V1 + Invoicing 0012–0017) to your Supabase database,
# (re)asserts the flicks_app role's table grants, and verifies the RLS posture.
#
# It is IDEMPOTENT and NON-DESTRUCTIVE:
#   • existing tables/data are never dropped (all DDL is IF NOT EXISTS / additive);
#   • re-running only fills in what's missing (e.g. the new invoicing tables);
#   • if flicks_app already exists (it does, from V1) no password is needed —
#     the script just re-grants so the app can read/write the new tables.
#
# ── What it needs ────────────────────────────────────────────────────────────
# A privileged Supabase connection string (the `postgres` user, Session pooler,
# port 5432). Provide it ONE of these ways:
#   1. DATABASE_DIRECT_URL in apps/api/.env   (recommended — set it once)
#   2. export DATABASE_DIRECT_URL=... before running
#   3. falls back to DATABASE_SERVICE_ROLE_URL if that's the postgres URL
#
# Optional: APP_ROLE_PASSWORD=... to (re)create the flicks_app role from scratch
# (only needed the very first time on a brand-new project).
#
# ── After it runs ────────────────────────────────────────────────────────────
#   pnpm test        # 68/68 — verifies against your Supabase DB
#   pnpm dev         # boot the app (needs a local Redis: docker run -d -p 6379:6379 redis)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_ROOT/apps/api/.env"

# Read a single key from apps/api/.env WITHOUT `source` (tolerates spaces/quotes
# like EMAIL_FROM_NAME="Flicks Suite", which would break a naive source).
envval() {
  [[ -f "$ENV_FILE" ]] || return 0
  grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- \
    | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
}

: "${DATABASE_DIRECT_URL:=$(envval DATABASE_DIRECT_URL)}"
: "${DATABASE_DIRECT_URL:=$(envval DATABASE_SERVICE_ROLE_URL)}"

if [[ -z "${DATABASE_DIRECT_URL:-}" ]]; then
  cat >&2 <<MSG
ERROR: no privileged Supabase connection found.

Set DATABASE_DIRECT_URL in apps/api/.env to your Supabase 'postgres' connection
(Dashboard → Project Settings → Database → Connection string → Session pooler,
port 5432). The password must be URL-encoded ('@' -> %40). Example:

  DATABASE_DIRECT_URL=postgresql://postgres.<ref>:<pwd>@aws-0-<region>.pooler.supabase.com:5432/postgres

Then re-run:  pnpm sync:supabase
MSG
  exit 1
fi

export DATABASE_DIRECT_URL
[[ -n "${APP_ROLE_PASSWORD:-}" ]] && export APP_ROLE_PASSWORD

HOST="$(printf '%s' "$DATABASE_DIRECT_URL" | sed -E 's#.*@([^:/?]+).*#\1#')"
echo "▶ Syncing Flicks Suite schema to Supabase (host: ${HOST})"
echo "  idempotent + non-destructive — existing V1 data is left untouched."
echo

# Delegate to the canonical setup (applies 0001–0017, role + grants, verifies).
exec bash "$REPO_ROOT/scripts/setup-database.sh"
