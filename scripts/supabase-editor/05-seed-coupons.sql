-- =============================================================================
-- FIRST-BOOT step (runbook Phase 5) — seed the launch coupon.
-- Paste into: Supabase Dashboard -> SQL Editor -> New query -> Run.
--
-- SQL-editor equivalent of scripts/seed-coupons.sh. Idempotent — re-running
-- never duplicates codes. After running, redeem FOUNDER-001 in the app:
-- Settings -> Billing -> Redeem coupon.
--
-- Round 9 (2026-08-26, founder decision): the FOUNDER-002..050 and
-- FLICKS-CA-* sets were retired — a guessable numbered sequence is abusable,
-- and each CA code carried 10 redemptions. Only FOUNDER-001 remains. To
-- retire already-minted rows, run 06-retire-coupons.sql.
-- =============================================================================
INSERT INTO coupon_codes (code, campaign, months, max_redemptions, expires_at, active)
VALUES ('FOUNDER-001', 'founder', 3, 1, '2026-09-30T23:59:59+05:30', true)
ON CONFLICT (code) DO NOTHING;

SELECT campaign, count(*) AS codes, sum(redemption_count) AS redeemed
FROM coupon_codes GROUP BY campaign ORDER BY campaign;
