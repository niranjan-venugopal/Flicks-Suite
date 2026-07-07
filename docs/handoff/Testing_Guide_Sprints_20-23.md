# Testing Guide — Sprints 20–23 (PRD v4)

Sprint 20: in-app **Feedback + NPS** (§7, D10-R–D13) · Sprint 21: **Platform
billing** — ₹499/seat/month, 7-day trial, coupons, paywall (§8B, D18–D20) ·
Sprint 22: **FAM coupons console + billing visibility + platform emails**
(§8B.3, D21–D23, §14 seeding) · Sprint 23: **tenant auto-debit mandates +
Sentry hardening** (§8A, §9, D14–D15).

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

## 3. Sprint 22 — FAM coupons console & billing visibility

1. **Coupons console (D21)**: sign in as the FAM admin → Revenue → **Coupons**.
   Tiles up top show Platform MRR / Active subs / Trial→paid / Coupons
   redeemed. Mint a batch (e.g. prefix `PH`, random, 25 codes, 2 months) —
   the table updates; download the CSV (whole list or one campaign).
2. **Deactivate / drawer**: click a code → the drawer shows its redemptions
   (tenant + who + when). Deactivate a code, then try redeeming it from a
   tenant's Billing & plan → refused; reactivate → redeemable.
3. **§14 launch sets**: `DATABASE_SERVICE_ROLE_URL=... bash scripts/seed-coupons.sh LAUNCH`
   seeds FOUNDER-001..050 (3 mo), FLICKS-CA-001..015 (3 mo, 10 uses each) and
   50 random FLICKS-LAUNCH-XXXXX codes (2 mo). Idempotent — re-running never
   duplicates.
4. **D22 visibility**: FAM → Tenants list now carries a billing chip
   (active/trialing/past-due) next to the plan; FAM → Revenue has the
   Trial→paid tile; tenant detail's Billing tab was already live.
5. **D23 emails** (passive): trial-ended goes out with the expiry sweep;
   subscription-activated / payment-failed-retry / cancellation-confirmed ride
   the platform webhook. All to Owner+Admin, deduped by audit markers.

## 4. Sprint 23 — Tenant auto-debit (seller charges THEIR customer)

> Needs the seller's Razorpay connected via OAuth (Invoicing → Settings →
> Payments). Without it, "Enable auto-debit" shows a clear message and
> everything else still works. INR profiles only.

1. **D14a**: Invoicing → Recurring → New subscription — the modal now has a
   **Collection** choice: *Manual* (default, invoices each cycle) or
   *Auto-debit* (Razorpay e-mandate). Choosing auto-debit sets the mandate up
   right after creation and emails the customer the authorization link.
2. **D14b**: every row has a **Details** drawer — mandate status chip
   (⚡ pending/active/revoked), *Copy authorization link*, enable/disable
   auto-debit, and the charge-attempt timeline (green/red dots per cycle).
3. **D14c public page**: open the copied link in an incognito window —
   `/sub/<token>` shows the seller logo, plan amount + cadence, next charge
   date, and *Authorize with Razorpay*. Expired links show 410, unknown 404.
4. **Webhook lifecycle** (needs the seller-account webhook registered for
   subscription events): authorize on the hosted page → the profile flips to
   authorized → active; each cycle's charge appears in the timeline and marks
   the generated invoice **PAID** (source `subscription_charge` in the
   payments ledger). Three failed charges pause the profile and the customer
   gets a retry email; revoking the mandate flips the profile back to manual
   and notifies you.
5. **Dunning safety net**: PAST_DUE profiles with no webhook signal for 7+
   days get paused by the nightly sweep (audited).
6. **Sentry (§9, passive)**: with DSNs set, events carry no cookies/headers/
   bodies/query strings, user context is the opaque id only, session replays
   are fully off, and errors tunnel through `/monitoring` (ad-blocker safe).

## 5. Live ₹1 smoke (LATER — gated on Razorpay approval, not part of this round)

When the Technology-Partner approval lands and live keys exist:
1. Connect a real seller Razorpay account via OAuth on a staging tenant.
2. Create a ₹1 monthly auto-debit profile against a real UPI handle you own.
3. Authorize the mandate from the /sub page → verify `subscription.authenticated`
   + `activated` webhooks arrive (check razorpay_webhook_events).
4. Wait for (or trigger in dashboard) the first charge → attempt row
   `succeeded`, invoice PAID with source `subscription_charge`, pre-debit
   email received ≥24h prior.
5. Revoke the mandate from the UPI app → profile returns to manual, seller
   notified. Refund the ₹1 from the Razorpay dashboard.

**Known limitation (edge, live-keys only):** the Razorpay charge and the
hourly invoice-generation cron are independent. If a `subscription.charged`
webhook arrives *before* that cycle's invoice is generated, the charge is
recorded in the charge-attempt ledger but the not-yet-existent invoice isn't
settled — it generates SENT and stays open. In practice generation runs
hourly at/after the cycle date and Razorpay charges at cycle start, so the
invoice almost always exists first; a reconciliation pass is a P1 follow-up.

## 4. Automated gate (already green at push time)

```bash
cd apps/api && pnpm test        # 216/216, includes billing + RLS isolation
bash scripts/diagnose-rls.sh    # leak_with_bogus_context = 0
pnpm -F web build && pnpm -F api build
```

## 6. Existing tenants after upgrade

The 0028 backfill gives every pre-existing tenant a trialing subscription row
with **at least 7 days of runway from migration time** — nobody gets locked
the moment billing ships. The Specflicks internal tenant is never billed.
