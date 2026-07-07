# Flicks Suite — Handoff Documents

This folder collects the engineering handoff documentation for the Flicks Suite
**Invoicing v3** module (built on the V1 HRMS foundation).

| Document | Purpose |
|----------|---------|
| [`PRD_v3_Completion_Handoff.md`](./PRD_v3_Completion_Handoff.md) | Where we are against the Invoicing **PRD v3** — sprint-by-sprint completion status, verification snapshot, what's deferred, how to run & verify. **Start here.** |
| [`Razorpay_Live_Payments_Handoff.md`](./Razorpay_Live_Payments_Handoff.md) | Go-live runbook for the one config-gated item: enabling Razorpay live payments (OAuth Connect) once Razorpay grants Technology-Partner access. |
| [`Testing_Guide_Sprints_16-19.md`](./Testing_Guide_Sprints_16-19.md) | Manual + automated test scripts for the PRD v4 Sprints 16–19 (consent, media, presence, analytics) with SQL verification snippets. |
| [`Testing_Guide_Sprints_20-22.md`](./Testing_Guide_Sprints_20-22.md) | Manual + automated test scripts for PRD v4 Sprints 20–21 (feedback + NPS, platform billing/trial/paywall, FAM coupons console). |

## Quick status (as of commit `7661565`, 2026-07-07)

- **PRD v4 Sprints 16–22 are shipped on `main`** (16 trust/consent · 17 media ·
  18 presence · 19 analytics · 20 feedback+NPS · 21 platform billing ·
  22 FAM coupons/emails). Gate at
  push time: **217/217** tests, RLS `leak_with_bogus_context = 0`, migrations
  `0001 → 0028` idempotent, `api` + `web` typecheck/build clean.
- **Paused for user testing of Sprints 20–22** — see the testing guide above.
  Next up after sign-off: Sprint 23 (tenant-track auto-debit mandates + Sentry
  hardening) — the final v4 sprint.
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
