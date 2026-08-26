-- 06 — Retire the unused coupon codes (Round 9, founder decision 2026-08-26)
--
-- Deletes every FOUNDER-* and FLICKS-CA-* code that has NEVER been redeemed.
-- FOUNDER-001 is redeemed on the founder's own workspace: its
-- redemption_count is >= 1, so this statement cannot touch it — and even a
-- direct delete would be refused by the coupon_redemptions foreign key.
-- The free months it granted were already written into
-- subscriptions/tenants.trial_ends_at at redemption time, so nothing about
-- the live subscription changes.
--
-- Run in the Supabase SQL editor (service role). Idempotent — a second run
-- deletes nothing and returns zero rows.

DELETE FROM coupon_codes
 WHERE campaign IN ('founder', 'chartered-accountants')
   AND redemption_count = 0
RETURNING code, campaign;

-- Expected: up to 49 FOUNDER rows + 15 FLICKS-CA rows on the first run.
-- Verify what remains (should be exactly FOUNDER-001):
--   SELECT code, campaign, redemption_count, active FROM coupon_codes ORDER BY code;
