#!/usr/bin/env bash
#
# Flicks Suite — restore drill
#
# Restores the most recent daily dump into a STAGING database to prove the
# backups are usable. A backup that has never been restored is not a backup.
#
# SAFETY: this script refuses to run unless STAGING_DATABASE_DIRECT_URL is
# set and is DIFFERENT from DATABASE_DIRECT_URL. It will never touch prod.
#
# Required env:
#   STAGING_DATABASE_DIRECT_URL   the staging Supabase/Postgres direct URL
#
# Optional env:
#   BACKUP_DIR                    where daily dumps live (default: ./backups)
#   RESTORE_FILE                  specific dump to restore (default: newest)
#
# Usage:
#   set -a; source apps/api/.env; set +a
#   export STAGING_DATABASE_DIRECT_URL="postgresql://...:5432/postgres"
#   bash scripts/restore-drill.sh
#
# Run monthly. Record the date + outcome in the team log (see RUNBOOK.md).

set -euo pipefail

if [[ -z "${STAGING_DATABASE_DIRECT_URL:-}" ]]; then
  echo "ERROR: STAGING_DATABASE_DIRECT_URL is not set." >&2
  echo "Point it at the STAGING database — never production." >&2
  exit 1
fi

if [[ -n "${DATABASE_DIRECT_URL:-}" && "${STAGING_DATABASE_DIRECT_URL}" == "${DATABASE_DIRECT_URL}" ]]; then
  echo "REFUSING TO RUN: STAGING_DATABASE_DIRECT_URL equals DATABASE_DIRECT_URL." >&2
  echo "The restore drill must target staging, not production." >&2
  exit 1
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "ERROR: psql not found. Install the postgresql-client package." >&2
  exit 1
fi

BACKUP_DIR="${BACKUP_DIR:-./backups}"
RESTORE_FILE="${RESTORE_FILE:-$(ls -1t "${BACKUP_DIR}"/flicks-*.sql.gz 2>/dev/null | head -1 || true)}"

if [[ -z "${RESTORE_FILE}" || ! -f "${RESTORE_FILE}" ]]; then
  echo "ERROR: no dump found to restore (looked in ${BACKUP_DIR})." >&2
  echo "Run scripts/backup-daily.sh first." >&2
  exit 1
fi

echo "[restore-drill] Restoring ${RESTORE_FILE}"
echo "[restore-drill] Target (staging): ${STAGING_DATABASE_DIRECT_URL%%@*}@***"
echo "[restore-drill] This DROPs and recreates objects on the staging target."
read -r -p "Type 'restore-staging' to proceed: " CONFIRM
if [[ "${CONFIRM}" != "restore-staging" ]]; then
  echo "Aborted."
  exit 1
fi

# The dump was taken with --clean --if-exists, so it drops before recreating.
gzip -dc "${RESTORE_FILE}" | psql "${STAGING_DATABASE_DIRECT_URL}" -v ON_ERROR_STOP=1 --quiet

echo "[restore-drill] Restore applied. Verifying row counts…"
psql "${STAGING_DATABASE_DIRECT_URL}" --quiet -At <<'SQL'
SELECT 'tenants   = ' || count(*) FROM tenants;
SELECT 'users     = ' || count(*) FROM users;
SELECT 'employees = ' || count(*) FROM employees;
SELECT 'memberships = ' || count(*) FROM memberships;
SQL

echo "[restore-drill] Done. Log this drill's date + outcome (RUNBOOK §4)."
