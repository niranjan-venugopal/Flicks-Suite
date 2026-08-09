-- =============================================================================
-- FIRST-BOOT step (runbook Phase 5) — seed the launch coupon sets.
-- Paste into: Supabase Dashboard -> SQL Editor -> New query -> Run.
--
-- SQL-editor equivalent of scripts/seed-coupons.sh (FOUNDER + CA sets).
-- Idempotent — re-running never duplicates codes. After running, redeem
-- FOUNDER-001 in the app: Settings -> Billing -> Redeem coupon.
-- =============================================================================
INSERT INTO coupon_codes (code, campaign, months, max_redemptions, expires_at, active)
SELECT 'FOUNDER-' || lpad(n::text, 3, '0'), 'founder', 3, 1, '2026-09-30T23:59:59+05:30', true
FROM generate_series(1, 50) n
ON CONFLICT (code) DO NOTHING;

INSERT INTO coupon_codes (code, campaign, months, max_redemptions, expires_at, active)
SELECT 'FLICKS-CA-' || lpad(n::text, 3, '0'), 'chartered-accountants', 3, 10, '2026-12-31T23:59:59+05:30', true
FROM generate_series(1, 15) n
ON CONFLICT (code) DO NOTHING;

SELECT campaign, count(*) AS codes, sum(redemption_count) AS redeemed
FROM coupon_codes GROUP BY campaign ORDER BY campaign;
