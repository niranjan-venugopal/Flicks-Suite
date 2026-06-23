# Flicks Suite — Invoicing PRD v3 Completion Handoff

**As of:** commit `f8610f7` on `main` (synced to `origin/main`) · 2026-06-23
**Source PRD:** [`Flicks_Suite_Invoicing_PRD_v3-2.md`](../../Flicks_Suite_Invoicing_PRD_v3-2.md)
**Design prototype:** `Flicks Invoicing v3` (reference only, not in this repo)

---

## 1. Executive summary

The GST-compliant Indian invoicing module specified in **PRD v3** is **feature-complete
and beta-ready**, built on the existing V1 HRMS multi-tenant foundation.

- Every PRD screen is implemented for real (no placeholder stubs).
- **176/176** automated tests pass across **10** suites.
- Row-Level Security is enforced on **every tenant table**; the isolation diagnostic
  reports **leak = 0** with the app connection running as a `NOBYPASSRLS` role.
- Database migrations `0001 → 0021` apply cleanly and idempotently.
- `apps/api` and `apps/web` both typecheck and build clean.
- Money math is server-authoritative in integer paise; the client is never trusted.

**The only item not live is Razorpay *live* payments**, and that is **config-gated, not
unfinished** — the full implementation is merged and tested but stays dormant until
Razorpay provisions Technology-Partner OAuth credentials. UPI and manual payments are
fully live in the meantime. See [`Razorpay_Live_Payments_Handoff.md`](./Razorpay_Live_Payments_Handoff.md).

---

## 2. Verification snapshot

Reproduce locally (requires local Postgres — see §6):

```bash
# from repo root, with apps/api/.env populated
pnpm -F api typecheck && pnpm -F api build
pnpm -F api test            # 176/176 across 10 suites
pnpm -F web typecheck && pnpm -F web build
bash scripts/diagnose-rls.sh   # connected_as=flicks_app, leak_with_bogus_context=0
```

| Check | Result |
|-------|--------|
| API unit/integration tests | **176 / 176** (10 suites) |
| API typecheck / build | clean |
| Web typecheck / build | clean (68 routes) |
| Migrations | `0001 → 0021`, idempotent |
| RLS isolation (`diagnose-rls.sh`) | leak = 0, app role `NOBYPASSRLS` |
| Cross-tenant RLS suite | every tenant table covered + auditor-in-A&B + self-visibility |

> Note: `pnpm -F api lint` is currently broken project-wide by an ESLint v9 config
> migration issue (pre-existing, unrelated to feature work). The quality gate is
> typecheck + build + test, which all pass.

---

## 3. Completion by sprint (PRD v3 build order)

| # | Sprint | PRD area | Status |
|---|--------|----------|--------|
| 0 | Foundation & local harness | §1, §12 | ✅ Done |
| 1 | Full scaffold (data model + RLS + skeletons) | §4, §5, §12 | ✅ Done |
| 2 | Customers, Items, HSN/SAC, Numbering engine | §6.4 | ✅ Done |
| 3 | Invoice CRUD + single-column editor + GST/TDS | §6.1–6.5, §9.1 | ✅ Done |
| 4 | Send, preview, hosted public page, payments + webhook (stub) | §6.6, §9.2–9.3 | ✅ Done |
| 5 | Organization → Financial + bank accounts | §7.2, §8 | ✅ Done |
| 6 | Notes, adjustments, ledger, reminders, reports/GSTR-1 | §6.7, §6.9, §6.11 | ✅ Done |
| 7 | Subscriptions + dunning (Razorpay mandate stubbed) | §6.3, §6.8 | ✅ Done |
| 8 | Auditor role: grants, invite/switch, My Companies | §3, §4.4 | ✅ Done |
| 9 | FAM, setup wizard, settings polish | §10, §11 | ✅ Done |
| 10 | Audit-driven gap closure (security, overview, quotes, consented debug) | post-v3 | ✅ Done |
| 11 | Global polish: currency-aware GST/TDS, TDS UI, multi-country reports | §6.1/§6.10 | ✅ Done |
| 12 | Global polish round 2 (reports currency, settings blend, editor) | — | ✅ Done |
| 13 | Beta security hardening + PDF (rate-limit, CSP, audit, TOTP lockout, observability) | — | ✅ Done |
| 14 | Invoice UX batch (list actions, row-click, themed PDF toggle, VAT for non-INR) | — | ✅ Done |
| 15 | Razorpay **live** payments (OAuth Connect, one-off invoices) | §6.6, §9.3 | ✅ Code-complete — **config-gated for go-live** |

Full per-item detail lives in the working sprint tracker (kept outside the repo at
`~/.claude/plans/rosy-crafting-globe.md`); this table is the durable summary.

---

## 4. What's deferred (and why)

None of these block beta. They are explicitly out of the current scope:

| Item | Status | What remains |
|------|--------|--------------|
| **Razorpay live payments go-live** | Code done, merged, tested | Razorpay **Technology-Partner approval** + set 5 env vars + add partner webhook. No code change. See the Razorpay handoff. |
| **Subscription auto-debit mandate** | Recurring engine done; Razorpay mandate stubbed | Real Razorpay Subscriptions / UPI-AutoPay (`subscriptions.controller.ts` `mandate-link` + `activate`), `subscription.charged` webhook, dunning sync. ~2× the one-off work. |
| **FX live source** | Snapshot plumbing done; INR=1, others null | Wire a live rate source (config-gated `OPENEXCHANGERATES_APP_ID`). |
| **Branch-series numbering UI** | Server supports series | Front-end management UI (P1). |

---

## 5. Tech stack & repo layout

**Monorepo** (pnpm workspaces):

```
apps/
  api/    NestJS (modular monolith) — REST API, guards, jobs, webhooks
  web/    Next.js (App Router) — admin app + chrome-less public/print surfaces
packages/
  db/     Drizzle ORM schema + SQL migrations (packages/db/drizzle/0001…0021)
  emails/ Email templates (Resend)
  shared/ Shared types & constants
scripts/  setup-database.sh, diagnose-rls.sh, backups, supabase sync, …
docs/handoff/  ← you are here
```

**Key technologies:** NestJS · Next.js · Drizzle + PostgreSQL with **Row-Level Security**
(tenant isolation) · Supabase (managed PG) · Cloudflare R2 (PDF/exports) · Puppeteer
(invoice PDF) · Resend (email) · BullMQ/Redis (jobs) · JWT auth + FAM TOTP.

**Invoicing module:** `apps/api/src/modules/invoicing/**`,
web routes under `apps/web/app/(app)/invoicing/**` and the public hosted/print
surfaces under `apps/web/app/(public)/**`.

---

## 6. Run it locally

```bash
pnpm install

# 1. Provision the local DB (native PG or Supabase) + the NOBYPASSRLS app role,
#    apply migrations 0001 → 0021, seed HSN/SAC + module toggles:
bash scripts/setup-database.sh        # writes/uses apps/api/.env

# 2. Run the API and web app:
pnpm -F api dev                       # http://localhost:4000  (Swagger at /api/docs)
pnpm -F web dev                       # http://localhost:3000

# 3. (optional) Confirm tenant isolation:
bash scripts/diagnose-rls.sh
```

Environment is documented in `apps/api/.env.example` (and `.env.example` at root).
All external integrations (Razorpay, FX, R2, Sentry/PostHog) are **optional** and
no-op safely when unset, so local/CI run without live credentials.

---

## 7. Security & operational posture (beta gate, Sprint 13)

- **Rate limiting** active (ThrottlerGuard global; tight limits on OTP/login/invite/FAM).
- **Transport**: prod CORS wildcard rejection, prod CSP (API + web), HSTS, frame/MIME headers.
- **Audit**: denied-authorization attempts logged; PII masked in before/after audit state.
- **Account security**: FAM TOTP lockout + 10 hashed backup codes (migration `0020`).
- **Observability**: `/healthz` + `/readyz` (DB-latency) probes, `X-Request-ID` header.
- **PDF**: hosted invoice page → Puppeteer → R2 (light/dark themed).
- **Money**: integer-paise, server-authoritative; no stack-trace leakage (global filter).

See `RLS_HARDENING.md` and `RUNBOOK.md` for the full posture.

---

## 8. Pointers

- Architecture → `../../ARCHITECTURE.md`
- Operations → `../../RUNBOOK.md`
- RLS posture & table inventory → `../../RLS_HARDENING.md`
- Change history → `../../CHANGELOG.md`
- Source PRD → `../../Flicks_Suite_Invoicing_PRD_v3-2.md`
- Razorpay go-live → `./Razorpay_Live_Payments_Handoff.md`
