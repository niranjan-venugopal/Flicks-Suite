#!/usr/bin/env bash
#
# Flicks Suite — daily database backup
#
# Takes a compressed logical dump of the production database using the
# direct connection (port 5432, not the pooler — pg_dump needs a session).
# Off-provider copy in addition to Supabase's own automated backups.
#
# Required env:
#   DATABASE_DIRECT_URL   postgresql://postgres.<ref>:<pwd>@...:5432/postgres
#                         (password MUST be URL-encoded — '@' → '%40' etc.)
#
# Optional env:
#   BACKUP_DIR            where dumps land (default: ./backups)
#   BACKUP_RETENTION_DAYS prune local dumps older than this (default: 14)
#
# Usage:
#   set -a; source apps/api/.env; set +a
#   bash scripts/backup-daily.sh
#
# Cron (02:30 IST daily):
#   30 2 * * *  cd /srv/flicks && set -a; . apps/api/.env; set +a; \
#               bash scripts/backup-daily.sh >> /var/log/flicks-backup.log 2>&1

set -euo pipefail

if [[ -z "${DATABASE_DIRECT_URL:-}" ]]; then
  echo "ERROR: DATABASE_DIRECT_URL is not set." >&2
  echo "Export it (or source apps/api/.env) before running this script." >&2
  exit 1
fi

if ! command -v pg_dump >/dev/null 2>&1; then
  echo "ERROR: pg_dump not found. Install the postgresql-client package." >&2
  exit 1
fi

BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUTFILE="${BACKUP_DIR}/flicks-${TIMESTAMP}.sql.gz"

mkdir -p "${BACKUP_DIR}"

echo "[backup-daily] Dumping database → ${OUTFILE}"

# --no-owner / --no-privileges keep the dump portable across roles (the
# staging restore target uses a different owner than prod). --clean adds
# DROP statements so a restore is idempotent.
pg_dump "${DATABASE_DIRECT_URL}" \
  --no-owner \
  --no-privileges \
  --clean \
  --if-exists \
  --format=plain \
  | gzip -9 > "${OUTFILE}"

SIZE="$(du -h "${OUTFILE}" | cut -f1)"
echo "[backup-daily] Done — ${SIZE}"

# Sanity check: a healthy dump is more than a few KB and ends cleanly.
if [[ "$(gzip -dc "${OUTFILE}" | tail -c 200 | grep -c 'PostgreSQL database dump complete')" -lt 1 ]]; then
  echo "WARNING: dump may be truncated — 'dump complete' marker not found." >&2
fi

echo "[backup-daily] Pruning local dumps older than ${RETENTION_DAYS} days"
find "${BACKUP_DIR}" -name 'flicks-*.sql.gz' -type f -mtime "+${RETENTION_DAYS}" -print -delete || true

echo "[backup-daily] Latest backups:"
ls -1t "${BACKUP_DIR}"/flicks-*.sql.gz 2>/dev/null | head -5
