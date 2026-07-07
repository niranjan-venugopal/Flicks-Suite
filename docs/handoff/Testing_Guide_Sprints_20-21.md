# Testing Guide — Sprints 20 & 21 (PRD v4)

Sprint 20: in-app **Feedback + NPS** (§7, D10-R–D13) · Sprint 21: **Platform
billing** — ₹499/seat/month, 7-day trial, coupons, paywall (§8B, D18–D20).

## 0. Environment prep

```bash
git pull && pnpm install
# Apply the new migrations to your Supabase project (idempotent):
pnpm sync:supabase            # applies every file in packages/db/drizzle (0026 + 0028 are new)
# OR re-run the demo bootstrap (also idempotent; now carries the 0026+0028
# deltas inline and seeds coupon FLICKS-DEMO-TEST1):
bash scripts/setup-demo.sh
pnpm dev
```

New optional env (apps/api/.env) — leave blank for most testing:

```
RAZORPAY_PLATFORM_KEY_ID=          # sandbox rzp_test_… when you want live checkout
RAZORPAY_PLATFORM_KEY_SECRET=
RAZORPAY_PLATFORM_WEBHOOK_SECRET=
```

Blank keys = "Subscribe now" shows a clean not-configured message; **everything
else below still works** (trial, banner, wall, coupons are date-driven).

## 1. Sprint 20 — Feedback & NPS

1. **Send feedback (D10-R)**: avatar menu → "Send feedback" (below Settings,
   above Sign out). A 330px panel opens bottom-right: pick a category, type a
   message, submit → success state. No floating pill exists anywhere.
2. **Throttle**: submit 10 times in a day → the 11th shows the server's limit
   message in the panel (not "check your connection").
3. **FAM inbox (D12)**: sign in as the FAM admin → Feedback & NPS in the
   sidebar. Your submissions appear with tenant/user context. Email shows ONLY
   when "You can email me" was ticked. Open the drawer → add an internal note,
   change status (buttons disable while saving; each change is
   platform-audited). Reopening a resolved item clears its resolution stamp.
4. **NPS card (D11)**: appears bottom-left only when ALL gates pass — tenant
   ≥21 days old, you have ≥3 active days, tenant sent an invoice (quotes don't
   count) or finished HRMS onboarding, and you haven't answered before.
   *Later* = 14-day snooze · *×* = permanent · answering shows a thanks card
   that auto-hides. The FAM NPS tile (D13) shows score = %promoters −
   %detractors with a skeleton while loading.

## 2. Sprint 21 — Billing & plan

1. **Settings → Billing & plan (D18)**: every member can view; only
   Owner/Admin can act (others get a read-only note). Check: seats line counts
   active members **excluding auditors**, ₹499 each; trial end date; history
   is empty until you act.
2. **Trial banner (D19)**: yellow banner under the topbar all trial long —
   days left + Subscribe (Owner/Admin). The × hides it for TODAY only; it
   returns tomorrow.
3. **Coupon**: on Billing & plan, apply `FLICKS-DEMO-TEST1` (seeded by
   setup-demo) → trial extends by 2 months, banner + page update, coupon chip
   shows. A second coupon on the same workspace is refused (one ever per
   tenant). 10 bad codes in a day → attempts throttled.
4. **Paywall (D19 wall)**: to see it without waiting, expire your trial in SQL:
   ```sql
   UPDATE subscriptions SET trial_ends_at = now() - interval '1 day'
     WHERE tenant_id = '<your tenant id>';
   UPDATE tenants SET trial_ends_at = now() - interval '1 day' WHERE id = '<your tenant id>';
   ```
   Within a minute (lock verdicts cache 60s): the app shows the lock wall;
   reads still work; any save/create fails with 402 BILLING_REQUIRED;
   Billing & plan and Profile stay reachable; members see "ask your
   Owner/Admin" instead of a CTA. Undo by setting trial_ends_at forward again
   (or redeem the demo coupon from Billing & plan — it's exempt from the lock).
5. **Subscribe (needs sandbox keys)**: with RAZORPAY_PLATFORM_* set, Subscribe
   opens the Razorpay-hosted page in a new tab and the billing page polls;
   completing the sandbox payment flips status to Active via the webhook
   (`/api/v1/webhooks/razorpay-platform` must be registered in the Razorpay
   dashboard with the same secret). History then shows activation + charges,
   and a receipt email goes to owners/admins.
6. **Emails/jobs** (passive): trial reminders go out at T-3/T-1 (09:00 IST),
   pre-debit notices ~24h before a charge; each sends once (audit-marker
   dedupe).

## 3. Automated gate (already green at push time)

```bash
cd apps/api && pnpm test        # 216/216, includes billing + RLS isolation
bash scripts/diagnose-rls.sh    # leak_with_bogus_context = 0
pnpm -F web build && pnpm -F api build
```

## 4. Existing tenants after upgrade

The 0028 backfill gives every pre-existing tenant a trialing subscription row
with **at least 7 days of runway from migration time** — nobody gets locked
the moment billing ships. The Specflicks internal tenant is never billed.
