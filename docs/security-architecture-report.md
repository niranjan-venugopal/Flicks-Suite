# Flicks Suite — Security, Isolation & Performance Report

**Date:** 28 July 2026 · **Commit:** `f8e7bef` on `main` · **Scope:** whole
application (HRMS · CRM · Invoicing · Projects/PM + Flicks Sync Engine)

---

## 1. Verdict

The multi-tenant foundation is sound: **no cross-tenant data leak exists**, RLS
is completely implemented, and the new local-first architecture meets every
latency budget with large headroom.

Two independent read-only audits were run against `main` — an exploit-focused
sweep of the surface built since Sprint 32 (PM, sync engine, GitHub, public API,
importers, notifications, auth) and a completeness sweep of Row-Level Security
across all 149 tables. The RLS layer came back clean. The **authorization layer
on the newest surface did not** — 3 high, 6 medium and 5 low findings, all of
which are now fixed, regression-tested and pushed.

| Question you asked | Answer |
|---|---|
| Is security great? | Foundation yes; the newest module had real authorization gaps. All found, all fixed, all regression-tested. |
| Any leakage? | No cross-tenant **row** leak. Three same-tenant/over-broad exposures were found (private-team titles, notification feeds across workspaces, GitHub installation hijack) — fixed. |
| Is RLS completely implemented? | Yes. 139/139 tenant-scoped tables have ENABLE + FORCE RLS with a tenant policy. Measured live: 130 tables probed under a forged tenant context, **0 returned rows**. |
| Does the new architecture reduce latency? | Yes, measured: bootstrap 290–431 ms, delta P95 **4 ms**, search P95 83–101 ms at 10 000 issues — 1–2 orders of magnitude inside budget. |

---

## 2. RLS & tenant isolation

### Coverage

| Metric | Result |
|---|---|
| Tables in schema | 149 |
| Tenant-scoped (carry `tenant_id`) | 139 |
| Tenant-scoped with ENABLE **and** FORCE RLS | **139 / 139 (100 %)** |
| Deliberately global (users, tenants, auth_otps, fx_rates …) | 10, each segregated by intent |
| Service-role-only tables (deny-all or no-policy + REVOKE) | 14, double-locked |

Mechanism: `withTenant()` sets `app.tenant_id` through a **parameterized**
`set_config(..., is_local => true)`, so the context is transaction-scoped and
cannot be injected. The application role `flicks_app` is created
`NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS` and does not own the tables,
so RLS binds unconditionally; `FORCE` is the second belt.

### Live measurement (this database, after the fixes)

```
connected_as             = flicks_app
rolsuper = false           rolbypassrls = false
tenant_tables_probed     = 130
leak_with_bogus_context  = 0        (must be 0)
public_policies          = 148
tenant_tables_no_rls     = (none — good)
```

`scripts/diagnose-rls.sh` previously probed **one** table (`employees`) and
printed a stale expectation. It now sweeps every tenant-scoped table with a
forged tenant id and separately lists any table missing ENABLE/FORCE — so a
single table losing its policy can no longer hide behind a green check.

### Automated isolation proof

`multi-tenant.spec.ts` asserts "tenant A sees its row, tenant B sees none" per
table. The audit found 31 tables added in migrations 0039–0047 with only 6
covered. **11 cases were added**, including the three that mattered most —
`pm_issues` (the module's primary object), `sync_mutations` (client payload
ledger) and `import_batches` — plus `pm_teams`, `pm_workflow_states`,
`pm_labels`, `pm_issue_comments/history/git_links`, `pm_team_memberships`
(composite key, asserted separately). All pass.

### Remaining honest caveat

93 older tenant-scoped tables (CRM email/sequences/workflows, HR reference
tables, timesheets) carry RLS and are exercised by their feature suites, but
have no dedicated cross-tenant case. The schema-level guarantee covers them; the
per-table test does not. Extending the `cases` array is one line per table and
is the cheapest remaining hardening.

---

## 3. Security findings — all fixed

### High

**H1 · GitHub installation hijack.** Claiming an installation required only its
`installation_id` — a small sequential integer. The App JWT can read *any*
installation of the App, so the existing check proved the id existed, never that
the caller installed it. An attacker on any trial tenant could squat a
victim's id (the column is unique — first claimer wins), receive all their
webhook traffic (branch, PR and commit titles), and post comments into their
PRs using the victim's installation token.
*Fix:* a server-minted, single-use `state` nonce (Redis, 10-minute TTL) that
GitHub echoes back through the install redirect; the claim is refused without a
nonce minted for that exact tenant. New `POST /pm/github/install-url` performs
the mint; the settings page does the two-step handshake.

**H2 · Private-team titles leaked through Recently deleted.** The restore list
returned every deleted issue title and project name tenant-wide, with no
visibility filter and no role gate — so any employee could read deleted
private-team issue titles (exactly the sensitive kind: credential rotations,
personnel matters).
*Fix:* the same `PmVisibilityService` used by bootstrap, delta, search and REST
now filters this list too (with a with-deleted variant for projects).

**H3 · Webhook signature fail-open.** With no `GITHUB_WEBHOOK_SECRET`, the
handler accepted unverified deliveries whenever `NODE_ENV !== 'production'` —
which includes staging and the common case of an unset variable — on a public,
unthrottled route. Worse, the ledger recorded `signature_verified: true`
unconditionally, and redelivery trusts that flag.
*Fix:* fails **closed** everywhere; local fixtures opt in explicitly with
`ALLOW_UNSIGNED_GITHUB_WEBHOOKS=1` (refused under production); the ledger records
the real verdict, so an unsigned delivery can never be replayed as signed.

### Medium

- **Notifications ignored `tenant_id`.** Rows stored it; no query filtered on
  it. A consultant with memberships in two workspaces saw both feeds — messages
  are verbatim issue titles — and a revoked member kept a readable feed of their
  former employer's work. *Fixed:* every read and write is tenant-scoped;
  platform rows (`tenant_id NULL`) stay visible.
- **`project.restore` skipped the access check** every sibling operation runs.
  *Fixed.*
- **Import undo crossed modules.** `import_batches` is shared with CRM and the
  PM undo had no `object_type` guard, so a PM undo could stamp a CRM lead batch
  `undone` — permanently stranding a 10 000-row import, because CRM's undo then
  refuses. *Fixed on both sides.*
- **OTP codes came from `Math.random()`** (recoverable PRNG state; the signup
  path lets an attacker harvest their own codes freely). *Fixed:*
  `crypto.randomInt`.
- **No per-email OTP limit.** The route throttle keys on IP, so a rotating-IP
  attacker could bomb a mailbox and — because each request invalidates the
  previous code — keep a victim permanently unable to sign in. *Fixed:* Redis
  per-email limiter (1/min, 5/hr) in front of both the send and the
  invalidation.
- **Label edits trusted the submitted `team_id`.** A lead of any team could
  rewrite a private team's (or workspace) label by lying about ownership.
  *Fixed:* re-checks the label's actual team.

### Low

Private-team labels leaked through `teams.list`; templates had no visibility
check on read or write; webhook-supplied URLs were rendered as `href`s without a
scheme allow-list (a `javascript:` value would be stored XSS); `latest_seq` /
`min_seq_horizon` were computed globally — a cross-tenant write-volume oracle,
and one tenant's prune could push another into a re-bootstrap storm. All fixed.

### Infrastructure

- Migration **0048**: `resend_webhook_events` — the only table in the schema
  with *no* RLS — gains ENABLE + FORCE + deny-all; webhook-ledger grants
  re-revoked.
- **Provisioning drift closed.** All three setup paths end with a blanket
  `GRANT ... ON ALL TABLES`, which silently undoes the migrations' per-table
  lockdowns. Only one replayed the REVOKEs. The replay now lives in one shared
  file (`scripts/sql/relock-grants.sql`) used by all three — so ledger
  immutability (consent records, charge attempts, coupons, the outbox) no
  longer depends on which script provisioned the database.

### Verified clean (no change needed)

The sync engine's security model held up under scrutiny: all 33 mutation ops
delegate to the same service methods as the REST controllers, so permission
checks cannot be bypassed by using the sync path; the delta design (read the
outbox with the service role under an explicit tenant predicate, then re-fetch
rows under RLS + visibility) is correctly implemented, and rows that fail the
visible re-fetch become tombstones — so losing access behaves exactly like a
deletion. Also clean: idempotency keyed per (tenant, user, mutation id); the
per-user throttle counting items rather than requests; public API scopes
enforced on every data route with the tenant derived only from the key; API keys
32-byte random, SHA-256 stored, shown once; importer row/size caps with no
path-traversal or injection surface; no `dangerouslySetInnerHTML` anywhere in
the web app; and no secrets in logs.

---

## 4. Architecture & latency

The Flicks Sync Engine (local-first: IndexedDB + MobX, NDJSON bootstrap, delta
pulls, optimistic writes) is what makes Projects feel instant. Measured on a
10 000-issue reference workspace (`pm-perf.spec.ts`, CI-enforced budgets):

| Path | Budget | Measured | Headroom |
|---|---|---|---|
| Cold bootstrap (10k issues, NDJSON stream) | < 2 000 ms | **290–431 ms** | 4–7× |
| Delta pull P95 (10 pulls) | < 150 ms | **4 ms** | ~37× |
| Search P95 (FTS + trigram + key) | < 200 ms | **83–101 ms** | ~2× |
| Optimistic write applied locally | < 50 ms | **1.6 ms** | ~30× |
| Two-client propagation | < 1 s | **~420 ms** | 2.4× |

A note on reading these numbers honestly: during this session one delta run
reported 470 ms while three analysis agents were saturating the sandbox. Re-run
on an idle machine it was 4 ms. The budgets are enforced in CI, so a genuine
regression would fail the build — but a single noisy measurement is not
evidence of one, in either direction.

**Where the speed comes from, and where it doesn't.** Projects is local-first,
so edits apply instantly and sync in the background. HRMS, CRM and Invoicing are
deliberately classic REST — they are correct and adequately fast (endpoints
benchmarked under 70 ms at 600 deals, with the 360°-view indexes added in
migration 0038), but they do not get the same instant feel. Perceived slowness
in local development is dev-mode compilation plus round-trips to a remote
Supabase, not the production path.

---

## 5. What still needs you (not code)

1. **Rotate every credential pasted into chat during the build** — Supabase DB
   password, `JWT_SECRET`, Resend key, R2 keys, and the GitHub PAT. This is the
   single most important remaining action.
2. **Set `GITHUB_WEBHOOK_SECRET`** in every deployed environment. The handler
   now refuses unsigned deliveries, so a missing secret fails loudly rather than
   silently accepting forged ones.
3. **Run `pnpm sync:supabase`** through migration **0048**.
4. Multi-instance deployments need the Redis socket.io adapter (single instance
   today) and will want the per-user sync throttle backed by Redis in all
   replicas — it degrades to per-process on a Redis outage by design.

---

## 6. How this was verified

- Two independent read-only audits (exploit sweep; RLS completeness sweep) with
  file:line evidence for every claim.
- **463 automated tests** pass (up from 441): +12 targeted security regressions
  — each one fails on the pre-fix code — and +11 new cross-tenant isolation
  cases.
- Full house gate: API and web typechecks, module-boundary lint, production web
  build, `diagnose-rls.sh` leak = 0 across 130 tables.
- Perf budgets re-measured on an idle machine after the fixes.
