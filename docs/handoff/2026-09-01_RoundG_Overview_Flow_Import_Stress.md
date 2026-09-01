# Round G — CRM Overview always shows the dashboard · bulk import isolation stress proof

**Date:** 2026-09-01 · follows the Round F tenant-isolation incident
(`2026-09-01_RoundF_Tenant_Isolation_Incident.md`).

## Why

After Round F closed the leak, workspaces that had been *seeing another
tenant's data* suddenly saw the CRM Overview's full-page "Your CRM is ready"
takeover — including the founder's own workspace. The takeover was gated on
`deals + activities === 0` only, so a workspace with imported leads or
contacts but no deals still got it, and the whole page was replaced rather
than the dashboard rendering with honest zeros. **Founder decision: always
render the dashboard.**

The founder also asked for the Round F import hardening to be exercised at
scale — thousands of rows, two tenants, overlapping identities, every file
type — "check for all".

## 1. CRM Overview — always the dashboard

`apps/web/app/(app)/crm/page.tsx`
- The early-return `EmptyState` takeover is gone. Every workspace renders
  `SectionHead` → quick-start checklist card → KPI row → Tasks today / Recent
  activity / Rotting deals / Shortcuts. Each list card already had its own
  empty text ("Nothing due today…", "Completed activities show up here.",
  "Nothing is rotting — nice.") and the KPIs null-guard, so a brand-new
  workspace renders cleanly with zeros.
- `SampleDataButton` (C22, load/remove the labelled sample pack) moved into
  the checklist card header, so onboarding keeps its one-click explore path
  until the checklist is completed or dismissed.
- No API or migration change.

## 2. Import isolation at scale

### Extra hardening (`apps/api/src/modules/crm/import.service.ts`)
`findOrCreateCompany`'s match-by-domain / match-by-name lookups now carry
explicit `tenant_id` predicates — the same class as the Round F `plan()`
dedupe fix. A contact import resolving its company must never be able to
*link* to another tenant's company row under any pool configuration.

### Stress spec — `apps/api/src/__tests__/founder-roundG-import-stress.spec.ts`
10,500 rows through the REAL `ImportService.run()` (all within the
`MAX_ROWS = 10,000` per-file cap):

| Step | What | Result |
|---|---|---|
| A imports | 2,000 leads · 1,000 contacts (250 auto-companies) · 500 companies · 1,000 combined (600 contacts + 400 leads) | 2,400 leads / 1,600 people / 750 companies — all stamped tenant A, 0 stray rows · ~12.5 s |
| B imports the SAME emails/domains/names, strategy **update** | 2,000 + 1,000 + 500 | all `rows_created`, `rows_updated = 0`; A's md5 checksum (every lead/person/company incl. `updated_at`) unchanged · ~7.6 s |
| B re-imports its leads file (update) | 2,000 | `rows_updated = 2,000`, `rows_created = 0` — within-tenant dedupe works; A checksum unchanged · ~3.8 s |
| Lists / search | `listBatches`, `leads.list` counts, ⌘K search | each tenant sees only its own volumes; every search hit is owned by the searching tenant |
| Undo B's 2,000-lead batch | | B's leads → 0, A checksum + counts unchanged |

Round F's 7-test spec still passes alongside. Throughput observation only
(not optimised this round): ~350 rows/s on the local per-row loop.

## 3. Live verification (production build, headless Chromium)

- Fresh workspace → `/crm` renders the **dashboard** (zero KPIs, "Get set
  up" checklist with "Load sample data" inside it); the takeover text is
  absent.
- A **1,000-row combined CSV driven through the real Import wizard UI**
  (choose file → auto-mapping → Continue → Run dry run → Import 1,000 rows →
  Import complete · 1,000 created) in tenant A.
- Tenant B, in a second browser session: Recent imports empty, Leads empty
  — the founder's original reproduction, at scale, through the UI.
- Tenant A's Contacts page shows its imported people.
- "Load sample data" on an empty workspace → populated dashboard.

Harness notes for future rounds: UI navigation needs the real login form
(an API-only cookie login bounces at the `(app)` layout guard); the
production CSP only allows `https:` connects, so local Chromium contexts
use `bypassCSP: true`; a first-run "Continue to workspace" dialog must be
dismissed before wizard clicks; repeated `request-otp` calls throttle per
IP — restart the API between runs.

## Gate

`pnpm -F api typecheck` · `nest build` · full API jest (incl. the new
stress spec) · `lint:boundaries` · `pnpm -F web typecheck` ·
`pnpm -F web build` · `diagnose-rls.sh` (`leak_with_bogus_context = 0`).
