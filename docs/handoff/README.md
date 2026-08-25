# Flicks Suite — Handoff Documents

This folder collects the engineering handoff documentation for Flicks Suite —
the V1 HRMS foundation, the **Invoicing v3** module, the **PRD v4** platform
work, and the **PRD v5 CRM** module.

| Document | Purpose |
|----------|---------|
| [`2026-08-25_Live_Ops_Session_Handoff.md`](./2026-08-25_Live_Ops_Session_Handoff.md) | **Start here.** Everything shipped AFTER the CRM MVP (2026-08-22 → 08-25): global tenancy + holiday calendars, employee-confirmed edits, the production incident + hardening, 180-day trusted devices, onboarding-approval integrity + Inbox, and the rate-limiter refresh-logout fix — plus current conventions, invariants, and open follow-ups. |
| [`Global_Tenancy_Holidays_Handoff.md`](./Global_Tenancy_Holidays_Handoff.md) | The detailed per-round addenda (rounds 2–6) behind the live-ops session doc above. |
| [`PRD_v5_Completion_Handoff.md`](./PRD_v5_Completion_Handoff.md) | Where we are against the CRM **PRD v5** and the MVP release — sprint map, post-gate hardening passes, parked/deferred items, ops checklist, how to run & verify. |
| [`CRM_Launch_Actions.md`](./CRM_Launch_Actions.md) | User-side day-1 external actions for the CRM launch (OAuth verifications, DNS, Resend, keys). |
| [`Testing_Guide_Sprints_24-31.md`](./Testing_Guide_Sprints_24-31.md) | The de-facto **PRD v5 spec** (§3–§19, screens C1–C22) plus manual + automated test scripts for CRM sprints 24–31 and every checkpoint. |
| [`PRD_v3_Completion_Handoff.md`](./PRD_v3_Completion_Handoff.md) | Where we are against the Invoicing **PRD v3** — sprint-by-sprint completion status, verification snapshot, what's deferred, how to run & verify. |
| [`Razorpay_Live_Payments_Handoff.md`](./Razorpay_Live_Payments_Handoff.md) | Go-live runbook for the one config-gated item: enabling Razorpay live payments (OAuth Connect) once Razorpay grants Technology-Partner access. |
| [`Testing_Guide_Sprints_16-19.md`](./Testing_Guide_Sprints_16-19.md) | Manual + automated test scripts for the PRD v4 Sprints 16–19 (consent, media, presence, analytics) with SQL verification snippets. |
| [`Testing_Guide_Sprints_20-23.md`](./Testing_Guide_Sprints_20-23.md) | Manual + automated test scripts for PRD v4 Sprints 20–23 (feedback + NPS, platform billing/trial/paywall, FAM coupons, tenant auto-debit mandates). |

## Quick status (as of 2026-08-25)

- **Live in production** (Railway API + Vercel web + Supabase, deploying
  from `production` which always equals `main`): all of PRD v5 plus the
  live-ops rounds — location-aware holiday calendars, country-aware GST,
  employee-confirmed detail edits, 7-day sessions with silent refresh and
  opt-in **180-day trusted devices**, onboarding approvals in the Inbox
  with self-approval blocked, tenant-wide real-time refresh, and the
  explicit-only rate limiter (the "refresh logs me out" fix). Gate at
  handoff: **510/510** API tests, RLS `leak_with_bogus_context = 0`,
  migrations `0001 → 0050` applied in production, api + web
  typecheck/build clean, boundaries clean. Details:
  `2026-08-25_Live_Ops_Session_Handoff.md`.

## Earlier status (as of 2026-07-17)

- **PRD v5 CRM — ALL sprints (24–31) shipped on `main` through the beta gate,
  plus five post-gate hardening/polish passes → MVP-release-ready.** Gate at
  handoff: **359/359** API tests, RLS `leak_with_bogus_context = 0`, migrations
  `0001 → 0038` idempotent, api + web typecheck/build clean, boundaries lint
  clean. Email suite + Automation are parked behind feature flags by product
  decision (code + tests intact). Details: `PRD_v5_Completion_Handoff.md`.
- Remaining pre-user actions are **ops-side only** (deploy prod build, sync
  migrations, rotate the build PAT, Resend/FX/Sentry config) — see §4 of the
  v5 handoff.

## Earlier status (as of 2026-07-11)

- **PRD v4 — ALL sprints (16–23) are shipped on `main`** (16 trust/consent · 17 media ·
  18 presence · 19 analytics · 20 feedback+NPS · 21 platform billing ·
  22 FAM coupons/emails · 23 tenant auto-debit + Sentry hardening). Gate at
  push time: **239/239** tests, RLS `leak_with_bogus_context = 0`, migrations
  `0001 → 0029` idempotent, `api` + `web` typecheck/build clean.
- **Conformance pass against the authoritative PRD v4 doc (2026-07-11):**
  migration `0029` aligns the auto-debit enums to §8.3 (CHECK-pinned;
  `authenticated`/`halted` reachable); presence liveness moved to Redis
  (§5.2, multi-instance safe); Sentry beforeSend redacts email-shaped
  strings; personal data export includes feedback + activity summary;
  pre-debit email carries invoice ref + manage/cancel link; approvals inbox
  shows presence dots; `setup-database.sh` now re-asserts the migrations'
  REVOKE lockdowns after its blanket grant (fresh-sync posture fix).
- **Paused for user testing — v4 is code-complete** — see the testing guide above.
  After sign-off, the remaining items are non-code: Razorpay
  Technology-Partner approval (tenant-track live payments + the ₹1 smoke),
  platform sandbox keys for checkout UAT, and legal counsel sign-off on the
  ToS/Privacy drafts.
- **Config-gated, not unfinished:** platform checkout needs
  `RAZORPAY_PLATFORM_*` sandbox keys (trial/paywall/coupons run without them);
  tenant-track live payments still await Razorpay Technology-Partner approval.
- **v1 scope decision (2026-07-11):** the invoicing-module Razorpay features
  (seller connect, auto-debit mandates, hosted-invoice online checkout) are
  **deferred to the next version** — the UI shows them disabled with "Coming
  soon" badges; the code stays in place behind those gates. Platform-billing
  Razorpay (₹499/seat subscription) remains live and unaffected.

## Related top-level docs

- `../../README.md` — project overview & setup
- `../../ARCHITECTURE.md` — system architecture
- `../../RUNBOOK.md` — operational runbook
- `../../RLS_HARDENING.md` — row-level-security posture & table inventory
- `../../CHANGELOG.md` — change history
- `../../Flicks_Suite_Invoicing_PRD_v3-2.md` — the source PRD
