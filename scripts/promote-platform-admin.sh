#!/usr/bin/env bash
# =============================================================================
# promote-platform-admin.sh — grant platform-admin (FAM) to an existing user
# =============================================================================
# Nothing in the product sets users.is_platform_admin — this script is the ONLY
# bootstrap path. It must run against the service-role connection (RLS bypass).
#
# What it does, in ONE transaction:
#   1. Ensures the Specflicks seed tenant (00000000-…-0001) exists — the
#      hardcoded never-billing-locked platform tenant FAM memberships live on.
#   2. Flips users.is_platform_admin = true for the given email. FAILS LOUDLY
#      on 0 rows: the user must sign up in the app first (login 404s unknown
#      emails, so there is no users row to promote until they do).
#   3. Upserts a memberships row (role='fam', status='active') on the seed
#      tenant, keyed on the (tenant_id, user_id) unique index.
#
# Usage:
#   DATABASE_SERVICE_ROLE_URL=postgres://... \
#     bash scripts/promote-platform-admin.sh you@example.com
#
# ⚠ Before the promoted user's FIRST FAM login, set TOTP_SECRET on the API —
#   FAM logins are gated on TOTP enrolment, and a blank TOTP_SECRET makes
#   enrolment a silent no-op (you'd be locked out of the FAM console).
#
# Idempotent — safe to re-run for the same email.
# =============================================================================
set -euo pipefail

CONN="${DATABASE_SERVICE_ROLE_URL:-}"
if [[ -z "$CONN" ]]; then
  echo "ERROR: set DATABASE_SERVICE_ROLE_URL (service-role connection)." >&2
  exit 1
fi

EMAIL="${1:-}"
if [[ -z "$EMAIL" ]]; then
  echo "Usage: bash scripts/promote-platform-admin.sh <email>" >&2
  exit 1
fi

SEED_TENANT_ID="00000000-0000-0000-0000-000000000001"

psql "$CONN" -v ON_ERROR_STOP=1 --no-psqlrc -v email="$EMAIL" -v tenant="$SEED_TENANT_ID" <<'SQL'
BEGIN;

-- 1. Seed platform tenant (billing.service hardcodes this id as never-locked).
INSERT INTO tenants (id, name, slug, status)
VALUES (:'tenant', 'Specflicks', 'specflicks', 'active')
ON CONFLICT (id) DO NOTHING;

-- 2. Promote the user — loudly refuse if they haven't signed up yet.
-- (psql :'email' doesn't interpolate inside dollar-quoted blocks, so pass it
-- through a transaction-local GUC.)
SELECT set_config('promote.email', :'email', true);
DO $$
DECLARE
  promoted int;
BEGIN
  UPDATE users SET is_platform_admin = true, updated_at = now()
   WHERE lower(email) = lower(current_setting('promote.email'));
  GET DIAGNOSTICS promoted = ROW_COUNT;
  IF promoted = 0 THEN
    RAISE EXCEPTION 'No users row for %. Sign up in the app first (login 404s unknown emails), then re-run.',
      current_setting('promote.email');
  END IF;
END $$;

-- 3. FAM membership on the seed tenant (unique on (tenant_id, user_id)).
INSERT INTO memberships (tenant_id, user_id, role, status, accepted_at)
SELECT :'tenant', u.id, 'fam', 'active', now()
  FROM users u
 WHERE lower(u.email) = lower(:'email')
ON CONFLICT (tenant_id, user_id)
DO UPDATE SET role = 'fam', status = 'active',
              accepted_at = coalesce(memberships.accepted_at, now());

COMMIT;

-- Verification readout.
SELECT u.email, u.is_platform_admin, m.role AS fam_role, m.status AS fam_status,
       (u.totp_secret IS NOT NULL) AS totp_enrolled
  FROM users u
  LEFT JOIN memberships m ON m.user_id = u.id AND m.tenant_id = :'tenant'
 WHERE lower(u.email) = lower(:'email');
SQL
