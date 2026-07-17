# PRD v5 (CRM) — Completion & MVP-Release Handoff

**Status: CODE-COMPLETE and MVP-release-ready.** All PRD v5 sprints (24–31)
shipped through the beta gate, followed by five post-gate hardening/polish
passes requested during release review. `main` is the only branch; everything
below is on it.

**Snapshot at handoff:** API suite **359/359** (30 suites, real Postgres),
api + web typecheck clean, web production build clean (88 static pages),
boundaries lint clean, RLS diagnosis `leak_with_bogus_context = 0`, migrations
**0001 → 0038** idempotent.

> **Start here for the next module (PRD v6):** read this doc, then `CLAUDE.md`
> at the repo root for conventions, then `Testing_Guide_Sprints_24-31.md`
> (the de-facto v5 spec, §3–§19 / screens C1–C22) for what exists.

---

## 1. What shipped (sprint map)

| Sprint | Scope | Checkpoint |
|--------|-------|------------|
| 24 | Architecture evolution: outbox event bus (inline worker default), ModuleGrantGuard, public API framework, outbound webhooks, boundaries lint | WS0 |
| 25 | Directory kernel + Contacts/Companies (C4/C5) | CP 1 |
| 26–27 | Deals: kanban board, detail, FX, deal→invoice/quote + hosted accept, tags, saved views, ⌘K, quick-add, sample data | CP 2 |
| 28 | Activities & follow-up loop, My Activities (C8), assignment pings (DND-aware), morning digest, CRM Overview (C1) | — |
| 29 | Email Phase A: compose/templates/signatures/tracking, DNC, Resend webhook, BCC dropbox, sequences engine + UI | CP 3 |
| 30 | Automation & capture: leads inbox (scoring, convert, round-robin), web forms (hosted `/f/:token`, spam defense, UTM), workflows, public API resources, API-keys/webhooks settings | CP 4 |
| 31 | Reports/forecast/goals (C16/C17), CSV import + 24h undo (C14), merge & dedupe (C15), offboarding reassign, sample-data toggle, mobile pass | **BETA GATE** |

## 2. Post-gate hardening passes (release review)

| Commit | Pass |
|--------|------|
| `bf32018` | **Security & stability remediation** — tenant ref-validation in directory writers (FK checks bypass RLS), atomic `leads.convert`, row-locked merge, ValidationPipe nested-JSON DTO fixes, public-form submit hardening, house-rule cleanups. All with regression tests. |
| `9ffa7ea` | **MVP polish** — parked-feature seams removed (nav/tabs/columns/copy); Contact & Company 360° detail pages rebuilt (deals + activity timeline + details), new `/contacts\|companies/:id/deals` & `/activities` endpoints. |
| `535f445` | **Capture follow-up** — web-form leads get an automatic "Call within 1h" task for the assigned owner (survives Automation being parked). |
| `975fd01` | **Launch readiness** — bell wired to the `/notifications` socket (real-time push; 120s poll as fallback), in-app notifications for leave/regularization submit + decisions, migration 0038 (360°-query + email-sender indexes, EXPLAIN-verified), DB pool hardening (idle/lifetime/connect timeouts + per-tx `statement_timeout`), Resend HTTP calls moved outside tenant transactions. |
| `1ad55b3` + `3816a4a` | **My Activities ownership** — "Assign to" picker (default Me, resets on close, roster-guarded), assignee shown on deal timelines, completed bucket includes work done **for** teammates ("for {name}" labels). |
| `0d10ebe` | **Pre-release polish** — org "Data & legal" block moved to Settings → Privacy & data (owner/HR-admin gated); TanStack devtools dev-only; `devIndicators: false`. Production build verified icon-free. |

## 3. Parked / deferred (intentional, not gaps)

- **Email suite (C9–C11) + Automation (C12)** — parked by product decision
  behind `FEATURES.crm_email` / `FEATURES.crm_automation`
  (`apps/web/lib/feature-flags.ts`, both `false`). Backend, services and tests
  are intact; flip the flags to restore the UI.
- **Phase B/C deferrals (documented in the v5 guide):** two-way Gmail/Outlook
  sync (C21, OAuth-verification-gated), file attachments on records (§19.2).
- **Post-launch quality backlog:** notification grouping + date buckets,
  pagination/virtualization on contacts & companies lists, unified approvals
  inbox (beyond leave/regularization), `next/image` migration, icon-system
  consolidation, bounding of `reports.forecast` / `merge.candidates` /
  `activities.mine` queries, committed load-benchmark harness.
- **Architecture note:** socket.io fan-out is in-process. Fine for the
  single-instance MVP (the bell also has the 120s poll as a safety net);
  a multi-instance API needs the Redis socket.io adapter first.

## 4. Ops actions before real users (user-side)

The complete checklist lives in [`CRM_Launch_Actions.md`](./CRM_Launch_Actions.md).
Non-negotiables:

1. `git pull && pnpm sync:supabase` — applies migrations through **0038**.
2. Deploy the web app with a **production build** (`next build` + `next start`
   / Vercel default). Dev-server deploys show dev tooling and skip the
   production CSP + security headers.
3. **Rotate the GitHub PAT** used during this build.
4. Resend: `RESEND_WEBHOOK_SECRET`, webhook → `/api/v1/webhooks/resend`,
   verify the `in.<domain>` receiving domain, set `INBOUND_EMAIL_DOMAIN`.
5. `OPENEXCHANGERATES_APP_ID` (static FX fallback covers testing only).
6. Sentry prod DSN, R2 prod bucket, legal review.
7. Google/Microsoft OAuth verifications (only unlocks parked C21 — start
   early, takes weeks; see the launch-actions doc).

## 5. How to run & verify

```bash
# Local prerequisites: Postgres 16 + Redis running, apps/api/.env populated.
pnpm install
pnpm sync:supabase              # or scripts/setup-db.sh for a fresh local DB

# The standing per-change gate (run all of it before any push):
pnpm -F api typecheck
pnpm -F web typecheck
pnpm -F api test                # 359 tests, real Postgres
pnpm -F api lint:boundaries
pnpm -F web build
bash scripts/diagnose-rls.sh    # expect leak_with_bogus_context = 0

# Dev servers
pnpm --filter @flicks/api dev   # :4000
pnpm --filter @flicks/web dev   # :3000
```

Manual test scripts for every v5 feature: `Testing_Guide_Sprints_24-31.md`
(checkpoint sections 1–4 + beta-gate section). Demo tenant seeding:
`pnpm setup:demo`.

**Known test-environment flake (do not chase):** `attendance-selfheal.spec.ts`
can fail when the wall clock is near IST midnight (evening UTC) — the presence
resolver's date boundary makes clock-in resolve `offline`. It is environmental;
green at any other hour.
