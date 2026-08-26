# Round 8 handoff — approvals integrity, avatars, module access, UI polish

**Date:** 2026-08-26 · **Branch:** `claude/handoff-patch-deploy-0g4sp6` → `main` + `production`
**Migration to apply:** `packages/db/drizzle/0052_role_module_defaults.sql`
**Gate at handoff:** api typecheck ✓ · api build ✓ · **jest 559/559 (48 files)** ✓ ·
`lint:boundaries` ✓ · web typecheck ✓ · web production build ✓ ·
`diagnose-rls.sh` → `leak_with_bogus_context = 0`, 137/137 tenant tables RLS ✓ ·
live verification in headless Chromium ✓ (every item below driven in the real app)

Read this next to `2026-08-25_Live_Ops_Session_Handoff.md` (rounds 3–7).

---

## 1. Nobody approves their own request  *(founder item 2)*

**The bug.** An OWNER applying for leave saw their own request in their own
approvals queue and could approve it. `leave.service.ts reviewLeave` only
checked that the request existed and was pending; owner (rank 5) clears the
route's `@Roles('manager')` gate. Attendance regularizations had the identical
hole. And `notifyOnApply` returned early when the applicant had no reporting
manager — the owner case — so applying as an owner notified **nobody** while
the request still sat in everyone else's queue.

**The fix** (mirrors the round-5 onboarding rules):

| Site | Change |
|---|---|
| `leave.service.ts reviewLeave` | resolves the applicant's `user_id` in-tx; `ForbiddenException` when it equals the reviewer |
| `attendance.service.ts reviewRegularization` | same guard |
| `leave.service.ts listPending` | `employees.user_id IS DISTINCT FROM callerUserId` |
| `attendance.service.ts listPendingRegularizations` | same predicate |
| `dashboard.service.ts` | `notOwnRequest()` applied to both buckets **and** both counts |
| `leave.service.ts resolveLeaveReviewers` / `attendance.service.ts resolveRegularizationReviewers` (new) | reporting manager when set, otherwise every OTHER owner/admin |
| `dashboard.controller.ts` | new `includeApprovals` flag (manager+) alongside `includeOnboarding` — a plain employee no longer receives the workspace's pending leave |

`pending.leaves[].userId` / `pending.regularizations[].userId` are now actually
shipped (they were selected and then dropped in the mapper, while the web type
already declared them) — that is what drives the Inbox presence dot.

## 2. The profile photo reaches every screen  *(founder item 3)*

**The bug.** Upload writes `users.avatar_key` **only**. Serving is meant to go
through `media.servedUrl(key, legacyUrl, size)`, but that was called in exactly
three places (`/auth/me`, the employees **list**, the tenant logo). Everything
else read `employees.avatar_url` / `users.avatar_url` — columns the upload path
never writes — so `GET /employees/:id` returned `COALESCE(null, null)` and the
header showed initials forever, no matter how many times you re-uploaded.

**The fix.**
- `EmployeesService` now takes `MediaService` and resolves avatars in
  `getEmployee`, `listMyTeam`, `getOrgChart`, `getOnboardingQueue` (shared
  `withAvatars()` helper).
- `SettingsService.listMembers`, `ReportsService` (attendance + leave),
  `DashboardService` (all three approval buckets) and `GET /pm/users`
  (resolved in `pm.controller.ts`) do the same.
- `useUploadAvatar` / `useRemoveAvatar` now invalidate `['auth','me']`,
  `['employees']`, `['settings','members']`, `['reports']`, `['pm','users']`
  and `['dashboard']` — previously only `['auth','me']`, so even the one
  correctly-plumbed screen served a stale cache for the 5-minute `staleTime`.
- `PmAv` / `MiniAv` / CRM `OwnerAv` / the Inbox row avatars gained an `src`
  prop (they were initials-only components and could never show a photo).

**Known gap, deliberate:** CRM record-owner chips (`OwnerAv` on deals, leads,
reports) still render initials — those payloads carry `owner_name` but no
avatar. The prop is in place; the CRM queries need the column added. Small,
isolated follow-up.

## 3. Module access from Settings  *(founder item 4)*

The engine already existed (`membership_grants` + `ModuleGrantGuard`); three
things were missing.

1. **Revocation was impossible.** The guard returned allow on the *role
   default* before ever reading the grant row, and CRM/PM default
   manager/employee/finance to `edit`. Writing `crm: none` did nothing.
2. `GRANT_MODULES` omitted `crm` and `pm`, so the endpoint 400'd on either.
3. No UI, and the sidebar decided CRM/Projects by role alone.

**New model** — one resolver, `apps/api/src/core/auth/module-access.service.ts`
(global module, `DatabaseService` only, no cycles), used by the guards, by
`/auth/me` and by Settings, so nav and API can never disagree:

```
full-access role  →  member grant row  →  tenant role policy  →  built-in default
```

- **Full-access roles stay unrevokable**: owner/admin everywhere, plus finance
  for invoicing (moving finance out would have silently broken the five
  capability-gated invoicing routes it passes today). The UI renders those
  cells as "Full access — by role" and disables them.
- **New table** `tenant_role_module_defaults` (migration 0052, RLS + FORCE RLS
  + tenant policy + `flicks_app` grants). Owner/admin/fam rows are rejected —
  they would be dead data.
- **New per-module endpoints**: `PATCH /settings/members/:id/grants/:module`
  and `DELETE …/:module` ("reset to role default"), plus
  `GET|PATCH /settings/members/role-defaults`. The old replace-all endpoint is
  untouched but **must not** be used by partial screens: it is
  delete-then-insert, so a three-module screen posting the full set silently
  destroys an auditor's `org_financial` row (a bug `MemberAccessModal` already
  has) or a PM guest's `pm:edit`.
- **Guests are rejected** on both grant endpoints (409): their `pm:edit` row IS
  their project invite and is managed on the project.
- The guard now folds the FAM toggle, membership liveness, the live role and
  the grant row into **one** `withTenant` call (it did two per request on all
  79 PM endpoints), and reads the **role from the membership row** — so a
  demotion bites immediately instead of waiting out the 15-minute access token.
  Only the tenant role policy is cached (30s, FlagEvalService pattern).
- ⚠ **Guard module ≠ requirement module.** `/invoicing/reports` and
  `/org-financial/*` ride `InvoicingGrantGuard` (so the invoicing kill-switch
  closes them) while requiring their own grants. `loadContext` therefore takes
  the toggle module *and* the grant module — reading the wrong one let an
  `invoicing:edit` row unlock financial data. There is a spec for this.
- `RolesGuard` still runs first, so grants can only **narrow**, never widen
  past the role hierarchy (39 CRM/PM routes also carry `@Roles`). The screen
  says so in one line.

**Web:** `app/(app)/settings/access/page.tsx` ("Module access", after Roles &
permissions) with a **By role** grid and a **By person** table; `Sidebar.tsx`
gates CRM / Projects / Invoicing on `/me`'s new `moduleAccess` map for every
role — a granted manager finally sees CRM, a revoked employee stops seeing it.

**Out of scope, stated:** HRMS surfaces (attendance, leave, timesheets,
employees, HR reports) have no grant guard at all; gating them means ~100
routes and is its own round.

## 4. UI items (1, 5, 6) + branding

- **Internal copy** (~30 rendered strings): the `employment_history` note,
  "Sprint 4", "PRD §5.6", "REST fallback", "sync engine", "IndexedDB",
  "cursor seq", "v1.5"/"v3" markers, the CRM `§19.4`/`§19.7` pills and the
  "tenant" jargon are all customer language now. `/fam/*`, the developer
  settings page, legal-page infrastructure text and "GSTR-1 §9B" (a statute)
  were left alone. Dead `components/invoicing/ScaffoldPage.tsx` deleted.
- **CRM calendars**: the last two OS pickers are gone — new `DateTimeField`
  (calendar + hour/minute selects, same `YYYY-MM-DDTHH:mm` value) in the
  Schedule-an-activity modal and `MonthField` (wrapping the existing
  `MonthYearPanel`) in the reports goal modal. `type="time"` inputs stay
  native — a clock, not a calendar.
- **Layering**: `globals.css` now documents a real scale and defines
  `--z-float: 1500` / `--z-toast: 2000`. `ui/popover` (was `z-[60]`),
  `ui/dropdown-menu`, `ui/select` moved to the float tier, `ui/toast` to the
  toast tier. That fixes the New-deal calendar opening *behind* the glass
  (verified live: calendar z=1500 vs scrim z=1100), the same latent bug in
  ProjectCreateModal / InviteAuditorModal / invoicing SubscriptionModal, and
  makes confirmation toasts visible above modals.
- **Sidebar byline**: "Flicks Suite · by Specflicks" (it repeated the
  workspace name, which the CompanySwitcher directly below already shows).

## 5. Deploy checklist

1. Apply `0052_role_module_defaults.sql` in the Supabase SQL editor (idempotent).
2. Deploy API + web as usual. No new env vars.
3. Smoke: Settings → Module access loads for an owner; set Employee → CRM =
   No access and confirm an employee loses the CRM nav item and gets 403 on
   `/api/v1/crm/pipelines`; set it back.
4. Two owners: one applies for leave, the other approves; the applicant sees
   no Approve button and no row in their Inbox.

## 6. Follow-ups this round leaves open

1. CRM owner chips still show initials (payloads lack an avatar column) — the
   `src` prop is already in place.
2. `MemberAccessModal` (Invite-auditor / auditor scope) still uses the
   replace-all endpoint and drops modules it does not render. Move it onto the
   per-module upsert.
3. `FamService.MANAGED_MODULES` has no `pm` entry, so Projects has no FAM
   kill-switch (the guard's "absent = enabled" default is what keeps it on).
   Three module lists now exist (`GrantModule` 7, `GRANT_MODULES` 7,
   FAM's 4) — worth reconciling.
4. Everything still open from §9 of the 2026-08-25 handoff, minus item 4
   (crm/reports month picker — done here).
