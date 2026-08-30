# Round 19 handoff — the FAM console's stray CRM menu, and a sweep of every role's sidebar

**Date:** 2026-08-30 · **Branch:** `claude/handoff-patch-deploy-0g4sp6` → `main` + `production`
**Migration to apply:** none — this round is entirely web/nav and one API doc-string fix.
**Gate at handoff:** api typecheck ✓ · api build ✓ · boundaries ✓ (324 modules) ·
web typecheck ✓ · web build ✓ · full jest ✓ **640/640 across 56 suites** ·
RLS `leak_with_bogus_context = 0` ✓ · live Chromium pass across 5 roles ✓

Read after `2026-08-30_Round18_Exports_Client_Address_Deletes_Handoff.md`.

## The founder's report

> "There is a bug in the admin panel (FAM). The CRM shows up and when clicked
> nothing happens… Also check others whether wrong roles and modules or the
> permission gets misplaced."

Reproduced exactly against the pre-fix code before touching anything: the FAM
console rendered a **CRM** group with the tenant sub-menu (Overview, Leads,
Deals, Activities, Web forms, Reports, Contacts, Companies, Import, Data
hygiene), and clicking **CRM → Leads** landed the browser back on
`/fam/overview`. That round-trip is the "nothing happens".

## Root cause

`Sidebar.tsx` decided which console it was in from the signed-in **role**, then
filtered the result through `/auth/me`'s `moduleAccess` map. Two things went
wrong at once:

1. `withModuleAccess()` was not purely subtractive. After pruning, it also
   **added** the Owner/Admin CRM group to any nav that lacked one — written for
   Managers and Employees, who legitimately hold CRM but have never had it in
   their base nav.
2. `FULL_ACCESS_ROLES` (module-access.service.ts) contains `'fam'` for **every**
   module, so a platform admin resolves `crm: 'edit'`. That is correct for the
   API — Specflicks staff act inside a tenant during support — but it made the
   helper bolt the customer CRM group onto the platform nav.

Each child link then navigated to `/crm/*`, which lives in the `(app)` route
group, whose layout redirects a platform admin to `/fam/overview`. Link → bounce
→ same screen.

## The fix: the console decides the nav, not the role

`Sidebar` and `Topbar` now take a **`variant`** prop supplied by the layout that
mounts them — `variant="fam"` from `app/(fam)/layout.tsx`, `variant="tenant"`
from `app/(app)/layout.tsx`. The FAM nav is returned before any access
filtering, so no tenant section can reach it.

This also closes a latent case the report didn't name. The `(fam)` layout admits
on the **user-level** `isPlatformAdmin` flag, not the membership role — it has
to, because a platform admin's active workspace is usually their own company
where they are `owner`. Under the old code that session rendered the **complete
Owner sidebar inside the platform console**. Reading the console from the layout
fixes both cases with one rule.

Supporting changes:

- `withModuleAccess()` is subtractive only; the CRM re-add moved to an explicit
  `withGrantedCrm()` that only the Manager/Employee branches call.
- `grantDriven` and the approvals badge are skipped in the console — those read
  a tenant's grants, which mean nothing at `/fam`.
- The avatar menu no longer offers **My profile** or **Settings** in the console;
  both are tenant routes that bounced straight back.
- `CRM_CHILDREN` / `PM_CHILDREN` are single shared lists (the PM list had been
  copy-pasted into three navs), so a module cannot show different menus to
  different people.

## "Check the others" — what the sweep found

Every sidebar href was checked against the app router (all 66 resolve to a real
page — no dead links), then every role's nav against the guard that actually
protects each destination.

### 1. Finance was given the Owner/Admin sidebar

Finance ranks **below** Manager in the API's hierarchy (`roles.guard.ts`:
owner 5 · admin 4 · manager 3 · **finance 2** · employee 1). It was still handed
`ADMIN_NAV`, so three whole groups were advertised and every one of them 403s —
verified live, not inferred:

| Advertised to Finance | Guard | Live result |
| --- | --- | --- |
| People → Employees | `@Roles('manager')` | **403** |
| People → Onboarding | `@Roles('admin')` | **403** |
| Insights → Reports | `@Roles('manager')` | 403 |
| Insights → Audit log | `@Roles('admin')` | **403** |
| Settings | `@Roles('admin')` | 403 |

Finance now gets its own nav built from what it really holds: **Invoicing** in
full and unrevokable (`FULL_ACCESS_ROLES`, and it leads the group — it is why
the seat exists), **CRM** and **Projects** at `edit` by built-in default, the
whole-workspace **attendance** view (`@Roles('finance')`), the ungated **org
chart**, and their own time + profile. Nothing they could open was removed.

### 2. The Payments link never appeared for a member who had been granted it

`invoicingChildrenFromGrants()` read `caps.record_payments` — **plural**. The
capability key is `record_payment`, singular: it is what `@RequireGrant` checks,
what `MemberAccessModal` and `InviteAuditorModal` write, and what
`useInvoicingAccess()` reads. So an Auditor or a granted Manager who *had* been
given "record payments" never got the Payments item, though the API would have
accepted them. Fixed, along with three stale plural spellings in the members
DTO/service doc strings that would have re-seeded the mistake.

### 3. Workspace Settings was offered to everyone

The topbar avatar menu linked **Settings** for every role. Every endpoint that
page reads is `@Roles('admin')`, so Finance, Managers, Employees, Auditors and
Guests only ever reached a 403. It now renders for Owner and HR admin only.

### Checked and found correct — no change

Owner / HR admin (full nav, all gates held); Manager (team gates yes, admin
gates no); Employee (self-service only); Auditor and Guest (outside the
hierarchy — every ranked gate shut, nav driven entirely by `membership_grants`);
`useInvoicingAccess` (matches `FULL_ACCESS_ROLES` exactly); the attendance and
timesheet team-view toggles; all 13 FAM console pages.

## The WebSocket errors in the founder's console — honest status

The second screenshot showed `wss://api.flickssuite.com/socket.io/…failed:
WebSocket is closed before the connection is established`, repeating.

**Not reproduced locally, and not caused by the CRM bug** — the pre-fix bounce
loop produced zero WebSocket errors in a controlled run, so that hypothesis is
dead. A rejected `CORS_ORIGINS` origin was also ruled out by experiment: with
the browser origin removed from the allow-list the **entire app** fails to load
(`/me` is blocked first), which is plainly not what production is doing.

What remains is something between the browser and the API declining to forward
the `Upgrade: websocket` header — a load balancer, CDN or proxy — which cannot
be diagnosed from this repo.

A mitigation did ship, because it is right regardless: all four sockets
(`/presence`, `/notifications`, `/crm`, `/sync`) opened with
`transports: ['websocket', 'polling']`, i.e. raw WebSocket **first**. When the
upgrade is blocked that is a hard failure, logged on every reconnect forever.
They now use socket.io's own default order via the shared `SOCKET_TRANSPORTS`
(`apps/web/lib/realtime.ts`): handshake over ordinary HTTP — the same path the
REST API already takes, so it works wherever the app works — then upgrade
silently. Where the upgrade succeeds nothing changes; where it is blocked,
real-time keeps working over long-polling instead of failing loudly.

**This is a robustness fix, not a confirmed root-cause fix.** If the errors
persist after deploy, the next step is the edge configuration (WebSocket support
must be enabled on whatever fronts `api.flickssuite.com`), not the app.

## Tests

New `founder-round19.spec.ts` (11 cases) runs the **real `RolesGuard`** against a
synthetic JWT per role — the pattern `role-matrix.spec.ts` uses for
`InvoicingGrantGuard` — plus the real `ModuleAccessService` against a seeded
tenant holding one active seat for each of the eight roles:

- Finance is denied Employees, Onboarding, Reports, Audit and Settings, and is
  allowed the workspace attendance view and all of Invoicing.
- Owner and Admin hold every gate the full sidebar advertises; Manager holds the
  team gates and not the admin ones; Employee holds none; Auditor and Guest hold
  none.
- A platform admin resolves `crm/invoicing/pm` to `edit` — pinned deliberately,
  with the comment explaining that this is exactly why the console's nav must be
  fixed rather than access-filtered.
- Only a platform admin passes `@Roles('fam')`, and `isPlatformAdmin` bypasses
  every ranked gate whatever the membership role says.
- Manager/Employee hold CRM and Projects by default but **not** Invoicing —
  which is why their Invoicing section is grant-built.

The web has no unit suite, so the nav itself is covered by the live pass below.

## Live verification

`verify-r19.mjs`, headless Chromium against the running app, for real signed-in
sessions:

- FAM console: nav is `Overview · Tenants · Revenue · Invoicing · Platform` and
  nothing else; **all 13** links stay inside `/fam/*`; each one was clicked and
  confirmed to land on its own page rather than bounce; the avatar menu offers
  no tenant route; zero WebSocket console errors.
- Finance: `Dashboard · Inbox · Calendar · Invoicing · CRM · Projects · Time ·
  Org chart · My profile` — and the three removed destinations were called
  directly and returned **403**, while `GET /invoices` returned 200.
- Owner/HR admin, Manager, Employee: unchanged navs, with CRM still present for
  Manager and Employee (the re-add survived the refactor).

A before/after pair was captured by checking out the pre-fix files and running
the same harness, so the regression is documented rather than described.

## Known follow-ups

- The production WebSocket upgrade (above) — an infrastructure check, not code.
- `fx_rate_to_inr` / INR equivalent on export invoices (round 18) — still needed
  for a complete GSTR-1 EXP filing.
- Migrations **0054** and **0055** are still pending in Supabase.
- Presence resolves "today" in UTC while attendance stores IST dates, so between
  midnight and 05:30 IST a clocked-in employee shows offline.
