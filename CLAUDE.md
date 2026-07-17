# CLAUDE.md

Guidance for AI coding agents (Claude Code) working in this repository.

## What this is

Flicks Suite — a multi-tenant SaaS for Indian SMBs: **HRMS** (attendance,
leave, timesheets, onboarding) + **Invoicing** (GST invoices, quotes,
payments) + **CRM** (directory, deals, activities, leads, reports) + platform
billing (₹499/seat, trials, FAM admin console). pnpm + turbo monorepo:

```
apps/api        NestJS 11 REST API (port 4000), socket.io gateways, jobs
apps/web        Next.js 15 App Router (port 3000), React 19, react-query, zustand
packages/db     Drizzle ORM schema + hand-authored SQL migrations (drizzle/)
packages/shared Shared types (JwtPayload, roles, DTO helpers)
docs/handoff    Sprint status, testing guides, launch runbooks — read first
```

Current state: PRD v5 (CRM) complete → see
`docs/handoff/PRD_v5_Completion_Handoff.md`.

## Commands

```bash
pnpm install
pnpm sync:supabase                 # apply ALL migrations (globs drizzle/[0-9]*.sql, idempotent)
pnpm --filter @flicks/api dev      # API :4000 (no watch — restart to pick up changes)
pnpm --filter @flicks/web dev      # web :3000

# The per-change gate — ALL of it must pass before any push:
pnpm -F api typecheck
pnpm -F web typecheck
pnpm -F api test                   # Jest against a REAL Postgres (no mocks of the DB)
pnpm -F api lint:boundaries        # dependency-cruiser module-boundary rules
pnpm -F web build
bash scripts/diagnose-rls.sh       # expect leak_with_bogus_context = 0

# One suite: cd apps/api && pnpm jest <name-fragment>
```

Local prerequisites: Postgres 16 + Redis; `apps/api/.env` supplies
`DATABASE_URL` (RLS-bound app role) and `DATABASE_SERVICE_ROLE_URL` (admin).

## House rules (non-negotiable)

1. **Tenant isolation via RLS.** All tenant reads/writes go through
   `withTenant(tenantId, cb, userId?)` (`packages/db/src/client.ts`), which
   sets `app.tenant_id` inside a transaction. Tables have FORCE RLS. Prefer
   adding explicit `eq(table.tenant_id, tenantId)` predicates as
   defense-in-depth even where RLS already applies. `dbAdmin` bypasses RLS —
   every `dbAdmin` query must carry its own tenant predicate.
2. **FK checks bypass RLS.** Any id accepted from a DTO (`company_id`,
   `owner_user_id`, `deal_id`, …) must be existence-checked *inside the tenant
   transaction* before insert/update — see `assertRefsInTenant` in
   `apps/api/src/modules/crm/deals.service.ts` for the pattern. A bare FK
   constraint will happily accept another tenant's row.
3. **Module boundaries.** Cross-module imports ONLY via
   `modules/<x>/public.ts` facades — enforced by `lint:boundaries`. Don't
   deep-import another module's services.
4. **Migrations** are hand-authored SQL in `packages/db/drizzle/NNNN_name.sql`
   (next number after the highest), **idempotent and additive**
   (`IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`). New tenant tables get
   ENABLE + FORCE RLS, a `tenant_isolation_*` policy on
   `current_setting('app.tenant_id')`, and grants to `flicks_app` (copy the
   DO-loop from migration 0037). Mirror new indexes in the Drizzle schema
   (`packages/db/src/schema/*.ts`) so drizzle-kit never proposes dropping them.
   There is no meta journal — `sync:supabase` just applies every numbered file.
5. **ValidationPipe gotcha.** Any DTO field holding nested JSON objects needs
   `@Type(() => Object)` next to `@IsObject()`, or the global pipe rewrites
   nested values to `[]`.
6. **Notifications are best-effort.** `createInAppNotification` / `sendEmail`
   calls must never fail the surrounding write path — wrap in try/catch or
   `.catch(log)`. In-app notifications also emit `notification.created`, which
   the `/notifications` socket gateway pushes to `user:<id>` in real time.
7. **No network calls inside tenant transactions.** Do DB work in the tx,
   commit, then make the HTTP call (see `crm/email.service.ts send()`).
8. **Never leave a dead end.** Flows self-heal missing fixtures (default
   pipeline, shift template, employee bridge, FX static fallback) instead of
   erroring at the user.
9. **Feature flags** (`apps/web/lib/feature-flags.ts`): `crm_email` and
   `crm_automation` are OFF — their UI shows "Coming soon"; backend + tests
   stay intact. Gate any UI touching those areas on the flag.

## Testing conventions

- Specs live in `apps/api/src/__tests__/`, instantiate services directly with
  stubs for notifications/events/presence, and hit the real DB. Seed with
  `dbAdmin`, unique suffixes via `crypto.randomBytes`, clean up in `afterAll`
  by deleting the tenant (cascades) and end both pool clients.
- Don't compare wall-clock-derived state near day boundaries:
  `attendance-selfheal.spec.ts` is known to flake near IST midnight
  (environmental — don't chase it if the clock explains it).
- Web has no test suite; the gate is typecheck + production build, plus live
  verification with headless Chromium where behavior changed.

## Web conventions

- UI uses the in-repo **proto design system** (`components/proto`: `Btn`,
  `Icon`, `Modal`, `Pill`, `Kpi`, `SectionHead`, `Toggle`) with inline styles
  and CSS variables (`var(--surf-1)`, `var(--bord)`, …). Match it; don't
  introduce new UI kits. Native `<select className="input">` for dropdowns.
- Data via react-query hooks in `apps/web/lib/api/queries/` (staleTime 5m,
  no focus refetch). Mutations invalidate their own key trees — follow the
  `invalidateActivityScopes` pattern.
- Auth state in `lib/stores/auth.store.ts`. **Web roles are UPPERCASE**
  (`OWNER`, `HR_ADMIN`, …) — normalised from the API's lowercase membership
  roles (`owner`, `admin`, …). Compare against the right casing per side.
- Sockets: mirror `lib/presence/PresenceProvider.tsx` /
  `lib/notifications/NotificationsSocket.tsx` (cookie-authed handshake with
  `withCredentials: true`; API gateways accept the httpOnly `access_token`
  cookie).
- Real-time fan-out is in-process socket.io — single-instance only until the
  Redis adapter is added.

## Definition of done

Code + regression tests + the full gate green + live verification of the
changed surface (drive the real app, not just tests) + `docs/handoff` updated
when module status changes. Commit to `main` only after all of that passes.
