#!/usr/bin/env bash
#
# Flicks Suite — weekly off-site snapshot to Cloudflare R2
#
# Pushes the most recent daily dump (or makes a fresh one) to an R2 bucket
# via the S3-compatible API. This is the geographically-separate copy that
# survives a Supabase-account-level loss.
#
# Required env:
#   R2_ACCOUNT_ID          Cloudflare account id (for the S3 endpoint)
#   R2_ACCESS_KEY_ID       R2 API token access key
#   R2_SECRET_ACCESS_KEY   R2 API token secret
#   R2_BACKUP_BUCKET       target bucket (default: flicks-suite-backups)
#                          — kept separate from R2_BUCKET_NAME (file uploads)
#   DATABASE_DIRECT_URL    only needed if no daily dump exists yet
#
# Optional env:
#   BACKUP_DIR             where daily dumps live (default: ./backups)
#   R2_BACKUP_PREFIX       key prefix in the bucket (default: db/weekly)
#   R2_RETENTION_WEEKS     prune remote snapshots older than this (default: 12)
#
# Usage:
#   set -a; source apps/api/.env; set +a
#   bash scripts/backup-weekly-r2.sh
#
# Cron (03:30 IST Sundays):
#   30 3 * * 0  cd /srv/flicks && set -a; . apps/api/.env; set +a; \
#               bash scripts/backup-weekly-r2.sh >> /var/log/flicks-backup.log 2>&1

set -euo pipefail

for v in R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY; do
  if [[ -z "${!v:-}" ]]; then
    echo "ERROR: ${v} is not set." >&2
    exit 1
  fi
done

if ! command -v aws >/dev/null 2>&1; then
  echo "ERROR: aws CLI not found. Install awscli (v2) for the S3-compatible R2 API." >&2
  exit 1
fi

BACKUP_DIR="${BACKUP_DIR:-./backups}"
BUCKET="${R2_BACKUP_BUCKET:-flicks-suite-backups}"
PREFIX="${R2_BACKUP_PREFIX:-db/weekly}"
RETENTION_WEEKS="${R2_RETENTION_WEEKS:-12}"
ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"

# Reuse the newest daily dump if present; otherwise make one now.
LATEST="$(ls -1t "${BACKUP_DIR}"/flicks-*.sql.gz 2>/dev/null | head -1 || true)"
if [[ -z "${LATEST}" ]]; then
  echo "[backup-weekly-r2] No daily dump found — running backup-daily.sh first"
  bash "$(dirname "$0")/backup-daily.sh"
  LATEST="$(ls -1t "${BACKUP_DIR}"/flicks-*.sql.gz | head -1)"
fi

KEY="${PREFIX}/$(basename "${LATEST}")"
echo "[backup-weekly-r2] Uploading ${LATEST} → s3://${BUCKET}/${KEY}"

# R2 uses the S3 API; pass the R2 token as the AWS credentials for this call
# only (do not export globally — keep it scoped).
AWS_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID}" \
AWS_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY}" \
AWS_DEFAULT_REGION="auto" \
  aws s3 cp "${LATEST}" "s3://${BUCKET}/${KEY}" \
    --endpoint-url "${ENDPOINT}" \
    --only-show-errors

echo "[backup-weekly-r2] Uploaded."

# Prune old remote snapshots. R2/S3 has no TTL, so do it explicitly.
CUTOFF_EPOCH="$(date -u -d "${RETENTION_WEEKS} weeks ago" +%s 2>/dev/null || echo 0)"
if [[ "${CUTOFF_EPOCH}" -gt 0 ]]; then
  echo "[backup-weekly-r2] Pruning remote snapshots older than ${RETENTION_WEEKS} weeks"
  AWS_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID}" \
  AWS_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY}" \
  AWS_DEFAULT_REGION="auto" \
    aws s3api list-objects-v2 \
      --bucket "${BUCKET}" \
      --prefix "${PREFIX}/" \
      --endpoint-url "${ENDPOINT}" \
      --query 'Contents[].{Key:Key,LastModified:LastModified}' \
      --output text 2>/dev/null | while read -r key lastmod; do
        [[ -z "${key}" ]] && continue
        obj_epoch="$(date -u -d "${lastmod}" +%s 2>/dev/null || echo 0)"
        if [[ "${obj_epoch}" -gt 0 && "${obj_epoch}" -lt "${CUTOFF_EPOCH}" ]]; then
          echo "  deleting ${key}"
          AWS_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID}" \
          AWS_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY}" \
          AWS_DEFAULT_REGION="auto" \
            aws s3 rm "s3://${BUCKET}/${key}" --endpoint-url "${ENDPOINT}" --only-show-errors || true
        fi
      done
fi

echo "[backup-weekly-r2] Done."
