# Round F — Cross-tenant CRM leak: incident, root cause, and the four-layer fix

**Date:** 2026-09-01 · **Severity:** Critical (production data isolation)
**Reported by:** founder — one tenant's imported CRM leads and its
"Recent imports" row (`pauket-leads-flicks-upload.csv · all · 105 created`)
were visible in **every** workspace on the platform.

## What happened

Row-Level Security only binds database roles that are subject to it. A role
with `BYPASSRLS` (or a superuser) skips every policy — including `FORCE`
policies. Production's `DATABASE_URL` was pointed at Supabase's default
`postgres` connection string, which is exactly such a role. From that moment
RLS was silently a no-op on the tenant pool, and any read that relied on RLS
alone returned **all** tenants' rows.

The visible symptom was the CRM: `leads.list()` and `import.listBatches()`
("Recent imports") filtered by status/order but had no explicit
`tenant_id` predicate — RLS was their only fence. With RLS bypassed, every
workspace saw the pauket tenant's leads and import history.

Proven locally before fixing: connecting with the service-role URL
(`postgres`, `rolbypassrls = t`) and running a tenant transaction for a
**bogus** tenant id returned every lead in the database; the same
transaction as `flicks_app` returned zero.

What did **not** happen: no cross-tenant writes or deletes. The import
**undo** path already carried its own tenant predicate, so no tenant could
destroy another's data. The leak was read-only.

## The fix — four independent layers

Any one of these alone stops the leak; all four ship together so no single
configuration mistake can ever reopen it.

1. **`withTenant` pins the RLS-bound role per transaction**
   (`packages/db/src/client.ts`). The same round-trip that sets
   `app.tenant_id` now also runs `set_config('role', 'flicks_app', true)`
   (≡ `SET LOCAL ROLE`, the PostgREST pattern). On a correct pool it's a
   no-op; on a mis-configured admin/superuser pool the transaction **drops
   privileges** to the RLS-bound role; if the role can't be assumed the
   transaction **fails closed**. Role name overridable via
   `DATABASE_APP_ROLE` (validated, default `flicks_app`).
2. **Migration `0060_rls_role_selfheal.sql`** — idempotent
   `GRANT flicks_app TO current_user`, so a pool mistakenly pointed at the
   admin user degrades to *safe* (layer 1 can drop role) instead of *down*.
3. **Boot-time proof** — `assertTenantIsolation()` (exported from
   `@flicks/db`) runs before the API serves a single request
   (`apps/api/src/main.ts`): inside a tenant transaction for a tenant that
   owns nothing it counts `leads` and `memberships`; anything visible ⇒ the
   process logs an exact remediation message and **exits**. The API now
   refuses to boot in a leaking configuration.
4. **Explicit tenant predicates on the CRM list surfaces** (house rule 1
   defense-in-depth): `leads.list` (rows + dupe-check + counts),
   `import.listBatches`, directory `listCompanies`/`listPeople`, ⌘K
   `search` (all three buckets), deals `board`/`listForRef`, activities
   `listForDeal`/`listForRef` — and the **import dedupe matching**
   (`import.service.ts plan()`: person/company/lead lookups), which decides
   which existing row an "update" import rewrites and so must never be able
   to match another tenant's record.

## Regression spec

`apps/api/src/__tests__/founder-roundF.spec.ts` (7 tests): the exact
bypass-pool round-trip sees zero foreign rows and really runs as
`flicks_app`; a control test reproduces the pre-fix leak (no role pin ⇒
foreign rows visible — the production bug, pinned forever); the boot probe
passes on the app pool; two-tenant end-to-end checks that tenant B sees
none of tenant A's leads, import batches, or search hits; and a REAL
combined import by tenant A that is invisible to tenant B — including the
sharpest case: B importing the *same email* under strategy "update"
creates B's own record and leaves A's untouched.

## Production remediation (operator runbook)

1. **Repoint the tenant pool at the RLS-bound role** (stops the leak
   immediately, even on old code):
   - Supabase SQL editor: `ALTER ROLE flicks_app WITH PASSWORD '<strong password>';`
   - Railway `DATABASE_URL`: same host/port/database, but user
     `flicks_app` and the new password.
   - `DATABASE_SERVICE_ROLE_URL` **stays** on the admin role — `dbAdmin`
     (FAM console, migrations, platform ops) needs it.
2. **Apply migration 0060** in Supabase (included in the combined
   `apply-0054-to-0060.sql` handed to the founder).
3. **Deploy this commit.** Note: the new build refuses to boot
   (intentional, layer 3) until isolation is effective — with 0060 applied
   it boots even under a mis-roled URL, because layer 1 drops the role.

## Gate

`pnpm -F api typecheck` · `pnpm -F web typecheck` · full API jest ·
`lint:boundaries` · `pnpm -F web build` · `diagnose-rls.sh`
(`leak_with_bogus_context = 0`, `connected_as = flicks_app`) — all green;
two-tenant live verification against the production build.
