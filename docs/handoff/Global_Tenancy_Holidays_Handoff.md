# Global-audience round: holiday calendars, country-aware GST, designations

Status: **shipped** (single commit on main/production; gate green — API+web
typecheck, 481/482 jest against real Postgres with the sole failure being the
documented `attendance-selfheal` IST-midnight wall-clock flake reproduced on
the unmodified tree, `lint:boundaries`, web build, `diagnose-rls` 0 leaks).

## 1. Location-aware holiday calendars (Settings → Holiday calendar)

Model (the Zoho People shape, which mapped 1:1 onto our existing schema —
`holidays.location_id` had existed unused since migration 0001): each holiday
is either **company-wide** (`location_id NULL`) or tied to one **location**;
an employee's applicable set = company-wide + their `employees.location_id`
rows. Multi-country tenants create one location per office (locations already
carry `country_code`/`timezone`) and import each country's list against it.

- API (leave module): `GET /leave/holidays` (now caller-scoped by default;
  `?locationId=all|company|<uuid>` for admin screens, response gains
  `locationId/locationName/isRecurring`), and Owner/HR (`@Roles('admin')`)
  `POST /leave/holidays`, `PATCH|DELETE /leave/holidays/:id`,
  `POST /leave/holidays/import` (bulk, duplicate-skipping),
  `GET /leave/holidays/presets?country&year`.
- Presets (`leave/holiday-presets.ts`): IN/AE/US/GB for 2026 (researched
  dates; moon-sighting festivals carry a verify note) and 2027 (fixed-date
  holidays only, by design — festival calendars unannounced).
- Working-day math: leave day counts (`applyLeave`), leave-approval
  attendance writes, and the attendance month grid now use only holidays that
  apply to that employee's location, and **exclude `optional`/`restricted`
  types** (elective holidays show on calendars but never reduce day counts —
  Keka/Zoho semantics). Company calendar events are viewer-location-scoped.
- Web: new `settings/holidays` page (year + location filters, month-grouped
  table, add/edit dialog, country-preset import dialog); nav entry in
  `SettingsLayout`. Employee leave page reuses the now-scoped list unchanged.

## 2. Country-aware GST (Settings → General)

`tenants.country_code` is now editable (new Country select). For India the
page is unchanged (GSTIN/PAN/CIN + GST state dropdown, state derived from
GSTIN). For any other country: the Indian statutory block is hidden (with a
cleanup card if legacy IDs are on file — "Remove Indian tax IDs" sends `''`
which the API now stores as NULL), and State becomes free text
(`stateCode` cap raised to 40). GSTIN/PAN format validation applies only to
non-empty values (`@ValidateIf`). Invoicing needed no change: missing states
already resolve to INTER_STATE and foreign customers to EXPORT (`tax.util`).
Signup never asked for GST (workspace name/slug only) — the mandatory *feel*
was purely this page's India-only UI.

## 3. Designations usable + common across departments

Designations (already an optional-department table + settings CRUD) were not
assignable anywhere: the employee Add form and Edit-profile dialog had no
Designation field. Both now have one, filtered to **common designations
(no department) + the selected department's**, resetting on department switch
only when the designation no longer applies. Settings → Designations labels
no-department rows "All departments (common)". Hardening: employee
create/update now existence-check `departmentId/designationId/locationId/
managerId` inside the tenant transaction (`assertOrgRefsInTenant` — FK checks
bypass RLS; same pattern as CRM's `assertRefsInTenant`).

## Tests

`holidays-locations.spec.ts` (11): CRUD + duplicate + cross-tenant location
rejection, list scoping, location-aware/company-wide/optional leave-day math,
idempotent preset import, org-ref checks, org country/GST-clear update.

## No migrations

Schema untouched (columns existed since 0001). Only the Drizzle-side
`holidays.location_id` FK hack was replaced with a real `locations` reference
(SQL FK already existed — no DDL change).

## Post-deploy notes for the founder

- Settings → Holiday calendar → "Import country list" (India 2026) is the
  30-second setup; add regional festivals per location after.
- Existing single-location tenants: nothing changes until holidays are added.
- 2027 festival dates: import the fixed-date list, add festivals when
  announced (or ask for a preset refresh).

---

# Round 3 addendum (same session): location lifecycle, confirmed detail edits, sessions

Status: **shipped** (gate green — both typechecks, 491/492 jest with the sole
failure being the documented attendance-selfheal overnight-IST wall-clock
flake reproduced on the unmodified tree, boundaries lint, web build,
diagnose-rls 131 tenant tables / 0 leaks). New spec `founder-round3.spec.ts`
(10 tests). **Migration 0049 (`employee_change_requests`) must be applied to
production via the Supabase SQL-editor flow.**

## Locations
- Country (shared `apps/web/lib/countries.ts` list), state (GST dropdown for
  IN, free text otherwise), timezone and address line 2 are now editable in
  BOTH the create and edit dialogs; country switches suggest the local
  timezone. `UpdateLocationDto`/`updateLocation` persist the new fields.
- **Delete with transfer** (deactivate → Delete… on the row): impact preview
  (`GET settings/locations/:id/delete-preview`), then
  `DELETE settings/locations/:id?transferTo=` — refuses while active,
  requires a transfer target when employees are assigned, moves ALL
  employees (any status) to the chosen location in the same tx (they then
  follow that location's holiday calendar automatically — scoping is by
  `employees.location_id`), and **explicitly deletes the location's own
  holidays** (the FK is SET NULL and NULL means company-wide, so a naive
  delete would have granted them to everyone). Attendance punches keep
  their rows; their location tag nulls.

## Employee-confirmed detail edits (Edit details dialog)
- For an ACTIVE app-joined employee, admin edits to personal/identity/bank
  no longer write directly: they land in `employee_change_requests`
  (payload with PAN/account FieldCipher-encrypted, masked old→new summary),
  the employee gets an in-app ping, and a "Pending changes from HR" card on
  /profile offers Confirm (applies via the same step writer) or Reject
  (with reason, notifying the admin). Invited/onboarding employees still get
  direct writes. Admin dialog shows an "Awaiting employee confirmation"
  pill; a re-save of the same tab replaces the previous pending request.
- **Bug fixed en route:** admin saves on an onboarded employee used to
  recompute allStepsComplete=true (onboarding_step sticks at 5), silently
  re-flagging onboarding_submitted_for_review and re-emailing the manager.
  Admin-path writes now skip all onboarding bookkeeping (`isAdminEdit`).

## Role/designation display
- Topbar chip and /profile show the person's **designation** (job title),
  falling back to the role label; `/auth/me` now carries
  `currentMembership.designationTitle`. The role label for `owner` is
  displayed as **"Admin"** (role key unchanged; Members page + copy
  updated). FAM console unchanged.

## Sessions (the 15-minute logout fix)
- The web app never called `/auth/refresh`, so sessions effectively died
  when the 15-minute access cookie lapsed. The api client now does a
  single-flight silent refresh on the first 401 and retries once;
  `RefreshTokenDto.refreshToken` is optional (httpOnly cookie is the
  source; empty-body posts no longer 400). Sessions now genuinely last the
  7-day refresh window. The 180-day trusted-device flow is deferred by
  founder decision — this foundation makes it a TTL change later.

---

# Incident hardening (2026-08-24): deploys must never be blocked by a DB outage

Incident: Supabase pooler unreachable (`write CONNECT_TIMEOUT` on both :5432
and :6543) → every request 500'd, AND the round-3 deploy could never go live
because Railway's health check pointed at a DB-probing `/healthz` — the old
container kept serving, producing version skew (new web + old API: the
delete-preview 404 and the broken silent refresh, since the old API required
a body `refreshToken` that the new web no longer sends).

Shipped (gate green — 492/492 jest, typechecks, api `nest build`, boundaries,
web build, RLS 0 leaks; health split verified live against a stopped local
Postgres: /healthz 200 while /readyz 503):

- **/healthz is now liveness-only** (always 200 while the process runs) so
  Railway can always roll new code forward, even mid-DB-outage. **/readyz**
  keeps the 3s `SELECT 1` probe + dbLatencyMs — the uptime monitor must
  watch /readyz. prod-smoke.sh + RUNBOOK.md + go-live-runbook.md updated
  (incl. Supabase free-tier pause playbook and the aws-0→aws-1 pooler
  hostname drift check).
- **Build safety**: apps/api/tsconfig.build.json excludes `src/__tests__`
  from `nest build` (specs were compiled into prod dist; a spec-only type
  error could brick the Docker build that CI never exercised); CI gains a
  `pnpm --filter @flicks/api build` step; root `.dockerignore` added.
- **Pooler safety**: `prepare: false` pinned on the tenant pool
  (packages/db/src/client.ts) — Supavisor transaction mode (:6543) does not
  support named prepared statements.

Recovery steps (founder, dashboards): restore Supabase (check Paused state /
pooler hostname drift vs Railway env vars) → Redeploy latest on Railway →
apply migration 0049 in the SQL editor → verify /healthz + /readyz 200,
delete-preview no longer 404, confirmation toast works, silent refresh keeps
sessions alive past 15 minutes.

---

# Round 4 addendum (2026-08-25): year picker, session restore, 180-day trusted devices

## Calendar year selection (all pickers)
- `MonthYearPanel` (`apps/web/components/ui/date-picker.tsx`) — the shared
  popover behind BOTH the day-picker's month view and the month toolbars
  (`month-nav.tsx`) — now has a year view: the year header is a button that
  opens a 12-year grid (same blue-pill design, prev/next pages by 12,
  "2016–2027" range label); picking a year returns to the month grid. Day →
  month → year, every level clickable. One native `<input type="month">`
  remains on crm/reports (functional, untouched).

## Session restore on tab reopen
- Cold reopen already worked after the silent-refresh fix (open app →
  /dashboard → /me 401 → silent refresh → restored). The missing piece:
  `/login` had no already-authed redirect — a user reopening a bookmarked
  login page stayed there despite a live session. The login page now fires
  the `me` query on mount and `router.replace`s to /dashboard (platform
  admins → /fam/overview), mirroring the app-layout guard.

## 180-day trusted devices ("stay signed in" — previously deferred, now live)
- **Migration `0050_trusted_sessions.sql`** (⚠ apply in the Supabase SQL
  editor): adds `refresh_tokens.trusted boolean NOT NULL DEFAULT false`.
  Service-role-only table — no policy changes.
- **Device identity**: httpOnly `fs_device_id` cookie (uuid, ~400d, path /),
  minted by the auth controllers (verify-otp / magic-link / TOTP verify /
  refresh / select-tenant) when absent; `x-device-id` header still honoured.
  Logout keeps the cookie (device identity ≠ session).
- **Consent-only device rows**: `trusted_devices` rows are created ONLY by
  `POST /auth/trust-device` (login-time upsert became touch-only). The
  endpoint upserts the device row (180d expiry, `device_name` like
  "Chrome · macOS"), marks the CURRENT refresh token trusted + extends it
  to 180d, and re-sets the refresh cookie — session upgrades in place.
- **TTL decision** (`issueTokenPair`): 15m impersonation · 180d trusted
  (`TRUSTED_SESSION_EXPIRY_DAYS`, default 180, max 365; optional block in
  .env.production.example) · 7d default. Cookie maxAge follows the token
  (`refreshTtlMs` threaded through every setAuthCookies call site).
- **Trust survives logout/login** (a login carrying a trusted device id
  auto-issues 180d) **and rotation** (refresh re-validates the device row
  first; a revoked/expired row silently downgrades the chain to 7d — the
  future "sign out of this device" hook).
- **Prompt UX** (founder-chosen): `/auth/me` carries `deviceTrusted`;
  `TrustDevicePrompt` (mounted in the app shell) asks once per browser
  session after login — accept → /auth/trust-device + toast; "Not now" →
  sessionStorage dismissal, re-asks after the next sign-in. Skipped for
  impersonation and FAM sessions.
- **Tests**: `founder-round4.spec.ts` (6 specs) — untrusted login stays 7d,
  consent upgrades in place to ~180d + device row with name, rotation
  preserves 180d, trusted-device login re-issues 180d, other-device login
  stays 7d, revoked device downgrades rotation to 7d. Gate green: api
  typecheck + `nest build`, jest 499/500 (the one failure = the documented
  attendance-selfheal IST-midnight flake, run at 00:23 IST), boundaries,
  web typecheck + build, diagnose-rls 0 leaks.

---

# Round 5 addendum (2026-08-25): bank list, approval integrity, Inbox, live refresh, select styling

## Bank details (wizard + admin dialog)
- Shared `BANKS` list (31 major Indian banks incl. Indian Overseas Bank,
  alphabetized, "Other" last) now lives in `apps/web/lib/employee-details.ts`.
  Picking **Other** opens a free-text field; the typed name collapses into
  the single `bankName` string (API already free-text — no DTO change, and
  nothing new is POSTed past the whitelist pipe).
- The admin Edit-details dialog uses the same select+Other; a stored legacy
  value not on the list maps to Other with the text pre-filled, so an
  untouched save round-trips the identical string (never blanks it).

## Onboarding approval integrity (the second-owner bug)
- **Self-approval blocked at four layers**: `approveOnboarding` and
  `rejectOnboarding` throw ForbiddenException when the target employee's
  user is the caller; `getOnboardingQueue(tenantId, callerUserId)` and the
  new dashboard bucket exclude the caller's own row via
  `user_id IS DISTINCT FROM caller` (invited NULL-user rows stay visible);
  and the submit fan-out never notifies the submitter.
- **In-app notifications now fire**: final submit pings every active
  owner/admin (except the submitter) with `onboarding.submitted` →
  `/employees/onboarding`; approve pings the employee with
  `onboarding.approved` (reject already did). Preference mapping fixed so
  `onboarding.submitted` gates on the dedicated `onboarding_submitted`
  preference.
- **Inbox → Approvals** gains an *Onboarding* kind: dashboard admin overview
  returns `pending.onboarding[]` + `onboardingCount` (rolled into
  `stats.pendingApprovals`), server-gated to owner/admin via
  `includeOnboarding` (the endpoint stays open to all roles for leave/reg).
  ApprovalsTab renders the rows with Approve / **Send back** (comment =
  reason) + a "Review full profile" link.

## Real-time refresh
- New broadcast: services emit `employees.directory.changed` {tenantId} on
  submit/approve/reject → NotificationsGateway emits `employees_changed` to
  the `tenant:<id>` room (clients already join it) → web NotificationsSocket
  invalidates `['employees']` (directory, org chart, queue), `['dashboard']`
  (Inbox badge + bucket), `['auth','me']` and
  `['employee','onboarding-status']` — the just-approved user's own session
  unlocks live. Approver's own tab also invalidates via the widened
  approve/reject mutation hooks (single-instance socket caveat unchanged).

## Native-select "silver layer" (13" MacBooks)
- Root cause: `.input` never reset `appearance`, so WebKit painted the OS
  aqua gradient under ~100 dropdowns; no `color-scheme` meant light native
  popups. Fixes in `globals.css`: `color-scheme: dark` on `:root`;
  `select.input` gets `appearance:none` + an inline-SVG chevron
  (`Icon.chevD` path, white @50%); `.input:focus` switched to
  `background-color` so focus can't erase the chevron. Scoped to
  `select.input` so time/month/datetime-local indicators survive.
- Invoicing's inline-styled selects get the same via `invoSelectReset` /
  `invoSelect()` in `components/invoicing/invo.tsx`; all 11
  `<option style={{color:'#000'}}>` hacks removed (would be black-on-dark
  under color-scheme dark).

## Tests / gate
- `founder-round5.spec.ts` (8 specs): fan-out recipients + self-exclusion,
  self-approve/reject Forbidden, queue + bucket scoping (incl. NULL-user
  rows), approve/reject side-effects + broadcasts, preference mapping.
- Gate green: api typecheck + `nest build`, jest 508/508, boundaries, web
  typecheck + build, diagnose-rls 0 leaks. **No migration this round.**
- Known accepted: dashboard overview HTTP cache (max-age=15) can delay the
  Inbox badge up to 15s post-approve; socket fan-out is single-instance (no
  Redis adapter) with react-query staleTime as backstop; the overview
  endpoint's missing @Roles predates this round (new bucket is server-gated;
  leave/reg exposure noted as follow-up).

---

# Round 6 addendum (2026-08-25): refresh-logout root cause (rate limiter) fixed

Symptom: refreshing the browser (or reopening a tab) bounced a LIVE session
to /login — even trusted 180-day sessions. Root cause chain (introduced by
the "security & stability hardening" commit that wired ThrottlerGuard as a
global APP_GUARD):

1. The stock guard applied the module DEFAULTS (short 10 req/1s per IP) to
   EVERY route. An F5 of the dashboard fires 10-15 API calls in one second →
   the tail got 429s. A 429 on /auth/me (or on /auth/refresh mid
   silent-refresh) was treated as "signed out" by the web shell.
2. main.ts never set `trust proxy`, so behind Railway req.ip was the
   proxy's address — ALL users shared one 10/s bucket (and the per-IP OTP
   limits were effectively cross-user; auth events logged the proxy IP).
3. The (app)/(fam) layouts redirected to /login on ANY settled /me error,
   not just 401.

Fixes shipped:
- **ExplicitThrottlerGuard** (`core/common/explicit-throttler.guard.ts`)
  replaces ThrottlerGuard as APP_GUARD: rate-limits ONLY routes that
  explicitly declare @Throttle (request-otp 5/hr, verify-otp 15/min,
  magic-link 20/min, feedback/fam/public endpoints) — the SPA's own
  authenticated traffic is no longer throttled. Verified live: 20-request
  concurrent burst → zero 429s; 18 rapid verify-otp posts → 429 from #16.
  Follow-up (optional): a Redis-backed generous default for the whole
  surface once multi-instance lands.
- **`trust proxy = 1`** in main.ts — req.ip is the real client IP behind
  Railway (correct per-IP throttle keys + correct IPs in auth_events/audit).
- **Web resilience**: layouts bounce to /login only on a settled **401**
  (APIError.status); 429/5xx/network keep the skeleton and recover.
  `useCurrentUser` retries transient failures twice (401 still fails fast);
  `silentRefresh` retries once after 750ms on 429/5xx.
- Tests: `explicit-throttler.spec.ts` (burst passes on plain routes; explicit
  @Throttle still trips). Gate green: 510/510 jest, typechecks, api build,
  boundaries, web build, RLS 0 leaks. No migration.

---

# Round 7 addendum (2026-08-25): PM guest seats · workspace discovery · PM emails · Specflicks SEO

## A. PM guest seats (the "v1.5" deferral — now shipped)
- **Migration 0051**: `membership_role` gains `'guest'` (own file, value never
  used in-file — 0013 precedent) + `idx_pm_project_members_user`. RLS/grants
  for `pm_project_members` already shipped in 0042.
- **Model**: a guest is a real tenant membership (`role:'guest'`,
  `is_external`, non-billable — `seats()` excludes auditors AND guests) whose
  PM access comes from a `membership_grants {pm:edit}` row (PmGrantGuard
  default stays 'none'), and whose VISIBILITY is exactly their
  `pm_project_members` rows. RolesGuard: `guest: 0` (auditor tier) so every
  ranked `@Roles` route rejects them; PM view/edit routes gate via
  PmGrantGuard only.
- **API**: `POST/GET /pm/projects/:id/guests`,
  `POST /pm/projects/:id/guests/:userId/remove` (`@Roles('admin')` — it mints
  a membership, mirroring invite-auditor; invite throttled 10/min).
  `PmGuestsService` owns the project rows; membership mechanics live behind
  the NEW `modules/members/public.ts` facade (`MembersPublicService`).
  Revoking the last project deactivates the membership (ModuleGrantGuard's
  per-request liveness check then kills live sessions immediately).
- **Scoping — the security class**: `PmVisibilityService` is now THE scope
  authority — `scopeTx()` (role read from the DB, not the JWT, so
  promotion/revocation is immediate), `issueVisible()` (guest ⇒
  `project_id ∈ projects`; project-less issues invisible), `assertNotGuestTx()`.
  A duplicate `visibleTeamIds` inside issues.service was deleted (it would
  have leaked). Applied to: issues list/get/detail, search, projects
  list/detail, teams list (rosters empty), usersLite (only people connected
  to their projects), initiatives/cycles/templates/recently-deleted (empty or
  403), sync **bootstrap** (issues streamed per project; no rosters, cycles
  or initiatives) and sync **delta** (both the `pm_issues` case and the
  ISSUE_SCOPED default now filter via `issueVisible`), plus the mutate op
  whitelist. Writes: `assertIssueWritable` via a scope-aware `loadIssue` on
  every issue mutation, guests must create inside one of their projects, and
  `setProject` can only move between their own projects.
  ⚠ **Doctrine: every NEW PM read path must consult `scopeTx`/`issueVisible`,
  every NEW mutation must call the guest asserts** — module-level pm:edit
  alone does NOT scope a guest.
- **Web**: `GUEST` role added to the store + `normaliseRole` (an unknown role
  used to fall through to the FULL employee nav); `guestNavFor()` (Projects ·
  Inbox · My companies); guests skip employee self-onboarding and land on
  `/pm/projects`; `ProjectGuestsCard` (invite/list/revoke) in the project
  rail for Owner/Admin; `GuestWorkspaceNudge` on the project list.

## B. Workspace discovery (guest → customer)
- **Login auto-select** now ranks memberships: own (non-guest) first, the
  Specflicks platform tenant last, oldest within each class — users always
  land in their own workspace; guest-only users land in the guest workspace.
  No login-time picker (founder decision); the sidebar switcher covers the rest.
- **`refreshAuthForUser` bug fixed**: it picked an ARBITRARY membership
  (`.limit(1)`, unordered) — a guest creating their own workspace could be
  re-scoped straight back into the guest tenant. It now takes
  `preferTenantId` (create-tenant passes the new tenant) + the same rank.
- **Create-tenant unblocked**: `onboarding.service` now rejects only an
  existing **OWNER** membership ("You already own a workspace…"), so
  guests/employees/auditors can create their first workspace and become its
  owner. `GET /me/companies` returns `canCreateWorkspace`.
- **Signup wizard**: a registered email no longer dead-ends at a 409 after
  filling the whole form — after OTP it shows **"You already have access to
  these workspaces"** (name + role + invite-pending, Open → role-aware
  landing) plus "Create my own workspace →" when eligible. An
  already-signed-in visitor skips email/OTP entirely. `/my-companies`'s
  dead-end card became the same CTA; the switcher gained a permanent
  "Create your own workspace" row.

## C. PM notification emails (audit + fixes)
- Audit result: assignment → in-app + urgent email worked; **comments were
  in-app only** (pm_comment email default off); **mentions had a complete
  server path but no client ever sent `mentioned_user_ids`** (no @-picker);
  **creating an issue WITH an assignee notified nobody**.
- Shipped: `pm_comment` defaults to `{in_app:true, email:true}` (folds into
  the existing hourly/daily digest — user overrides win; mentions +
  assignments stay on the 5-min urgent sweep); `create()` now pings the
  assignee (self-assign silent); an inline **@-mention picker** in the issue
  composer (↑/↓/Enter/Esc, sends `mentioned_user_ids`) with a `/pm/users`
  REST fallback that also fixes the empty assignee menu in kill-switch mode.

## D. Specflicks branding + SEO
- Auth tagline "HRMS · India" → **"by Specflicks"** (one shared AuthLayout).
- Root metadata: `metadataBase` from `NEXT_PUBLIC_APP_URL` (fallback
  `https://app.flickssuite.com`), title template `%s · Flicks Suite`,
  Specflicks keywords/description, OpenGraph + `/og.png`; `app/icon.png` is
  the auto-favicon (the old `/favicon.ico` 404'd). Legal titles trimmed so
  the template doesn't double-suffix.
- Per-route metadata via server layouts: `/login` ("Sign in — Flicks Suite by
  Specflicks", canonical, "Specflicks Flicks Suite login" keywords),
  `/onboarding` ("Create your workspace — …"), and
  `/onboarding/employee` (`robots: noindex` — it nests under the signup URL).
- New `app/robots.ts` (allow /, disallow /api, sitemap link) + `app/sitemap.ts`
  (/login, /onboarding, legal). `/signup` → `/onboarding` permanent redirect.

## Gate
532/532 jest (22 new in `founder-round7.spec.ts`, incl. the guest leak suite:
list/get/search/bootstrap/delta cross-project + cross-tenant assertions),
api typecheck + `nest build`, boundaries (322 modules), web typecheck +
build, diagnose-rls 0 leaks. **Migration 0051 must be applied in Supabase.**
Founder note: the pm_comment default flip emails existing subscribers who
never opted out (approved) — their per-user overrides still win.

## Round 7 post-audit fixes (same day)

A self-audit against the plan + live browser verification (the plan's own
verification step) caught five things the unit tests didn't:

1. **Guests were billable.** `billing.service.NON_BILLABLE_ROLES` still read
   `['auditor','fam','super_admin']`, so every guest would have added ₹499/mo
   to the host's subscription (the `seats()` change alone wasn't enough —
   billing has its own predicate). Fixed there and in the FAM console count.
2. **`issues.restore()` bypassed guest scoping** — it loads a SOFT-DELETED
   row so it can't use the scoped `loadIssue`; a guest could have restored
   any deleted issue in a public team. Explicit check added.
3. **CRM pools included guests**: `pickRoundRobinOwner` could auto-assign a
   lead to a guest (who has no CRM access at all — the lead would be
   stranded), and the activity leaderboard listed them. Both now exclude
   guests alongside auditors.
4. **PM workspace seeding** auto-added guests to the default team.
5. **UI**: guests saw the HOST company's trial/billing banner (someone
   else's commercial state) and dead-end "New project" / "Load sample data"
   / "Led by me" controls the server 403s. All hidden for guests.

Live verification (headless Chromium, dev server + built API) now asserts the
whole flow end to end: invite → guest sign-in → sees only their project (list,
detail, search, sync bootstrap all clean) → `/employees` 403 → lands on
/pm/projects with the guest nav → nudge shown, no billing banner, no dead-end
actions → signup shows the existing-workspaces interstitial → guest creates
their OWN workspace (201) and the session lands in it as owner → the original
owner is still blocked from a second workspace (409) → seats billable=1,
guests=1, subscription user_count excludes the guest.

Gate after fixes: **535/535** jest, typechecks, api build, boundaries, web
build, RLS 0 leaks.

**Note for local dev:** the production CSP (`connect-src 'self' https:`)
blocks `http://localhost:4000`, so `pnpm --filter @flicks/web start` (a
production build) can't reach a local API — use `dev`. Production is
unaffected (the API is https). Also, `request-otp` is capped at 5/hour/IP by
design, so repeated scripted sign-ins must seed `auth_otps` directly.
