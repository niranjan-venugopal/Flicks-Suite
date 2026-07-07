#!/usr/bin/env bash
# =============================================================================
# seed-coupons.sh — PRD v4 §14 LOCKED coupon seeding (Sprint 22)
# =============================================================================
# Mints the launch coupon sets into coupon_codes (idempotent — re-running
# never duplicates or renumbers):
#
#   • FOUNDER-001..050          — 3 free months · single-use · expires 2026-09-30
#   • FLICKS-CA-001..015        — 3 free months · 10 uses each · expires 2026-12-31
#   • FLICKS-<CAMP>-XXXXX ×N    — 2 free months · single-use · expires 2026-08-31
#                                 (community batches; pass campaign name(s) as
#                                 arguments, e.g. `seed-coupons.sh LAUNCH TWITTER`)
#
# Usage:
#   DATABASE_SERVICE_ROLE_URL=postgres://... bash scripts/seed-coupons.sh [CAMP ...]
#   COMMUNITY_COUNT=50 bash scripts/seed-coupons.sh PRODUCTHUNT
#
# The FAM console (Feedback → Coupons) can mint further batches interactively;
# this script exists so the LOCKED launch sets are reproducible.
# =============================================================================
set -euo pipefail

CONN="${DATABASE_SERVICE_ROLE_URL:-}"
if [[ -z "$CONN" ]]; then
  echo "ERROR: set DATABASE_SERVICE_ROLE_URL (service-role connection)." >&2
  exit 1
fi
COMMUNITY_COUNT="${COMMUNITY_COUNT:-50}"
if ! [[ "$COMMUNITY_COUNT" =~ ^[0-9]+$ ]]; then
  echo "ERROR: COMMUNITY_COUNT must be a plain integer (got: $COMMUNITY_COUNT)" >&2
  exit 1
fi
# Unambiguous alphabet (no 0/O/1/I/L) — matches the FAM console generator.
ALPHABET="ABCDEFGHJKMNPQRSTUVWXYZ"  # letters only — never collides with sequential numbering

run_sql() { psql "$CONN" -v ON_ERROR_STOP=1 --no-psqlrc -qAt -c "$1"; }

echo "─── FOUNDER-001..050 · 3 months · single-use · exp 2026-09-30 ───"
run_sql "
INSERT INTO coupon_codes (code, campaign, months, max_redemptions, expires_at, active)
SELECT 'FOUNDER-' || lpad(n::text, 3, '0'), 'founder', 3, 1, '2026-09-30T23:59:59+05:30', true
FROM generate_series(1, 50) n
ON CONFLICT (code) DO NOTHING;"
echo "  ✓ founder set ensured"

echo "─── FLICKS-CA-001..015 · 3 months · 10 uses · exp 2026-12-31 ───"
run_sql "
INSERT INTO coupon_codes (code, campaign, months, max_redemptions, expires_at, active)
SELECT 'FLICKS-CA-' || lpad(n::text, 3, '0'), 'chartered-accountants', 3, 10, '2026-12-31T23:59:59+05:30', true
FROM generate_series(1, 15) n
ON CONFLICT (code) DO NOTHING;"
echo "  ✓ CA set ensured"

for CAMP in "$@"; do
  CAMP_UPPER=$(echo "$CAMP" | tr '[:lower:]' '[:upper:]' | tr -cd 'A-Z0-9')
  [[ -z "$CAMP_UPPER" ]] && continue
  echo "─── FLICKS-${CAMP_UPPER}-XXXXX ×${COMMUNITY_COUNT} · 2 months · single-use · exp 2026-08-31 ───"
  # Random suffixes generated in SQL from the same unambiguous alphabet; the
  # count-guard keeps re-runs from growing the batch past COMMUNITY_COUNT.
  run_sql "
DO \$\$
DECLARE
  existing int;
  to_mint  int;
  suffix   text;
  i        int;
BEGIN
  SELECT count(*) INTO existing FROM coupon_codes
   WHERE campaign = lower('${CAMP_UPPER}') AND code LIKE 'FLICKS-${CAMP_UPPER}-%';
  to_mint := GREATEST(0, ${COMMUNITY_COUNT} - existing);
  i := 0;
  WHILE i < to_mint LOOP
    SELECT string_agg(substr('${ALPHABET}', (floor(random() * 23) + 1)::int, 1), '')
      INTO suffix FROM generate_series(1, 5);
    BEGIN
      INSERT INTO coupon_codes (code, campaign, months, max_redemptions, expires_at, active)
      VALUES ('FLICKS-${CAMP_UPPER}-' || suffix, lower('${CAMP_UPPER}'), 2, 1,
              '2026-08-31T23:59:59+05:30', true);
      i := i + 1;
    EXCEPTION WHEN unique_violation THEN
      -- collision: loop again for a fresh suffix
    END;
  END LOOP;
END \$\$;"
  echo "  ✓ ${CAMP_UPPER} batch ensured (${COMMUNITY_COUNT} codes)"
done

echo
echo "✅ Coupon seeding complete. Counts by campaign:"
psql "$CONN" --no-psqlrc -c \
  "SELECT campaign, count(*) AS codes, sum(redemption_count) AS redeemed FROM coupon_codes GROUP BY campaign ORDER BY campaign;"
