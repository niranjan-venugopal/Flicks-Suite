# Flicks Suite — Handoff Documents

This folder collects the engineering handoff documentation for the Flicks Suite
**Invoicing v3** module (built on the V1 HRMS foundation).

| Document | Purpose |
|----------|---------|
| [`PRD_v3_Completion_Handoff.md`](./PRD_v3_Completion_Handoff.md) | Where we are against the Invoicing **PRD v3** — sprint-by-sprint completion status, verification snapshot, what's deferred, how to run & verify. **Start here.** |
| [`Razorpay_Live_Payments_Handoff.md`](./Razorpay_Live_Payments_Handoff.md) | Go-live runbook for the one config-gated item: enabling Razorpay live payments (OAuth Connect) once Razorpay grants Technology-Partner access. |
| [`Testing_Guide_Sprints_16-19.md`](./Testing_Guide_Sprints_16-19.md) | Manual + automated test scripts for the PRD v4 Sprints 16–19 (consent, media, presence, analytics) with SQL verification snippets. |
| [`Testing_Guide_Sprints_20-23.md`](./Testing_Guide_Sprints_20-23.md) | Manual + automated test scripts for PRD v4 Sprints 20–21 (feedback + NPS, platform billing/trial/paywall, FAM coupons, tenant auto-debit mandates). |

## Quick status (as of 2026-07-11)

- **PRD v4 — ALL sprints (16–23) are shipped on `main`** (16 trust/consent · 17 media ·
  18 presence · 19 analytics · 20 feedback+NPS · 21 platform billing ·
  22 FAM coupons/emails · 23 tenant auto-debit + Sentry hardening). Gate at
  push time: **238/238** tests, RLS `leak_with_bogus_context = 0`, migrations
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

## Related top-level docs

- `../../README.md` — project overview & setup
- `../../ARCHITECTURE.md` — system architecture
- `../../RUNBOOK.md` — operational runbook
- `../../RLS_HARDENING.md` — row-level-security posture & table inventory
- `../../CHANGELOG.md` — change history
- `../../Flicks_Suite_Invoicing_PRD_v3-2.md` — the source PRD
