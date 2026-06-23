# Flicks Suite — Handoff Documents

This folder collects the engineering handoff documentation for the Flicks Suite
**Invoicing v3** module (built on the V1 HRMS foundation).

| Document | Purpose |
|----------|---------|
| [`PRD_v3_Completion_Handoff.md`](./PRD_v3_Completion_Handoff.md) | Where we are against the Invoicing **PRD v3** — sprint-by-sprint completion status, verification snapshot, what's deferred, how to run & verify. **Start here.** |
| [`Razorpay_Live_Payments_Handoff.md`](./Razorpay_Live_Payments_Handoff.md) | Go-live runbook for the one config-gated item: enabling Razorpay live payments (OAuth Connect) once Razorpay grants Technology-Partner access. |

## Quick status (as of commit `f8610f7`, 2026-06-23)

- **PRD v3 is feature-complete and beta-ready.** All screens are real (no stubs),
  **176/176** automated tests green, RLS enforced on every tenant table, migrations
  `0001 → 0021` apply idempotently, `api` + `web` typecheck/build clean.
- **One item is intentionally config-gated, not unfinished:** Razorpay **live**
  payments. The code is complete, tested, and merged; it stays dormant (UPI +
  manual payments work) until Razorpay partner credentials are provisioned. See the
  Razorpay handoff for the remaining (non-code) steps.

## Related top-level docs

- `../../README.md` — project overview & setup
- `../../ARCHITECTURE.md` — system architecture
- `../../RUNBOOK.md` — operational runbook
- `../../RLS_HARDENING.md` — row-level-security posture & table inventory
- `../../CHANGELOG.md` — change history
- `../../Flicks_Suite_Invoicing_PRD_v3-2.md` — the source PRD
