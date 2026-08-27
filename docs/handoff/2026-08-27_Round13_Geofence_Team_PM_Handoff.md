# Round 13 handoff — Geofence v1 shipped, team attendance for every admin role, PM milestones, gender-scoped leave, honest slug + real General tab

**Date:** 2026-08-27 · **Branch:** `claude/handoff-patch-deploy-0g4sp6` → `main` + `production`
**Migration to apply:** `packages/db/drizzle/0054_geofence_workmode_prefs_leave_gender.sql`
(idempotent — Supabase SQL editor, click-by-click in the founder walkthrough).
**Gate at handoff:** api typecheck ✓ · api build ✓ · jest **596/596 (52 files)** ✓ ·
`lint:boundaries` ✓ · web typecheck ✓ · web production build ✓ ·
`diagnose-rls.sh` → 0 leaks ✓ · live Chromium pass (geolocation contexts inside
+ outside the fence, owner + employee sessions) ✓

Read after `2026-08-27_Round12_Attendance_PM_Handoff.md`.

## 0. The founder's question first: why was the geofence never executed?

Honest answer, from the code's own history: **it was parked mid-implementation,
never re-scoped — not descoped by decision.** The HRMS PRD (§6.4) specced the
full flow including the Haversine distance step. Migration `0001` shipped every
column it needs (`locations.geofence_lat/lng/radius_m`,
`attendance_punches.geo_*`, `location_id`, `is_within_geofence`). The punch DTO
shipped the lat/lng validators. The settings API shipped geofence CRUD. Then
four things stopped it dead: the compute step was stubbed with
`is_within_geofence: null // deferred to Settings (PRD §6.8)`, the
"Locations & geofence" settings form was built **without** the geo inputs (so
every geofence in production is NULL), the clock card sent `{}` instead of
coordinates, and the web app's `Permissions-Policy` header set
`geolocation=()` — disabling the browser location API for the whole product.
No handoff document ever mentioned it again. Round 13 finishes the feature.

## 1. ✅ Geofence v1  *(founder items 5 + 8, incl. the failure-dialog design)*

- **`Permissions-Policy` unblocked** — `geolocation=(self)` (`next.config.ts`).
- **Settings → Locations & geofence finally has geofence inputs**: latitude,
  longitude, radius (m) on both the Add and Edit dialogs; a "Geofence · 150m"
  pill on the list. Clearing the fields turns the fence off. (API already
  accepted these — the update DTO/service now map them too.)
- **The clock card captures position** on both punches (8s timeout,
  best-effort). Denial/timeout/unsupported → the punch still goes through
  with no coordinates (PRD §6.4 graceful degradation — location can NEVER
  block clock-in).
- **The "You're not at the office" dialog** (the founder's design, verbatim):
  on clock-IN, when the office has a geofence and the detected position is
  outside it — DETECTED AT · ACCURACY · GEOFENCE RADIUS · DISTANCE, with
  **Mark as WFH today** (primary) / Try again / Cancel. Client-side Haversine
  is a courtesy check only; the server recomputes authoritatively.
- **Server resolution on every punch** (`attendance.service.ts`): the
  employee's assigned office is joined, Haversine against the fence, and the
  punch row now stores real `location_id`, `is_within_geofence`, and (finally)
  `user_agent`. NULL when either side is missing — never a guess.
- **`work_mode` on the day** (new enum column, migration 0054): `office`
  inside the fence, `remote` outside (including "Mark as WFH today"), NULL
  unknown. Deliberately NOT an `attendance_status` value — status already
  carries lateness/duration (`late`, `half_day`), so a late WFH day stays
  representable and the status-based compliance aggregations keep working.
  Clock-out never downgrades the day (leaving the office to clock out from
  home doesn't flip an office day to remote).
- **Approving a `wfh_request` regularization now writes `work_mode='remote'`**
  (status stays `present`) — before this round, WFH was never written
  anywhere, which is why the Team-attendance WFH tile always read 0.
- **The clock card shows the strip from the design**: "Inside Bengaluru HQ
  geofence · 12.9716° N, 77.5946° E · ±8m" (green), or the amber
  "Outside … — working from home" variant.

**Deliberately out of v1** (never started, not broken): the PRD's
`pending_approval` punch state (drags in an approval flow), the IP-allowlist
half (`is_within_ip_allowlist` still waits), a per-shift "requires on-site"
flag (no such column exists — old mock copy referencing it was dropped).

## 2. ✅ Team attendance for every non-employee role  *(founder items 6 + 7)*

The page always existed and matched the design (five KPI tiles, pills) — it
was reachable only from the MANAGER sidebar, and its API returned
direct-reports-only (empty for owners). Now:

- **Sidebar**: Time → "Team attendance" for Owner / Admin / Finance (the
  manager nav already had it).
- **API scoping**: managers keep direct reports; owner/admin/finance/fam get
  the whole workspace (guard widened `manager`→`finance`, hierarchical, per
  "for all roles except employee"). Optional `?managerId=` narrows org view.
- **Location column** (from the design): assigned office name, or **Home**
  for a WFH day; rows carry `workMode` + `locationName`.
- **KPI fixes**: WFH counts real `work_mode='remote'` days; half-days count
  as clocked-in; holiday/weekend rows no longer land in "Yet to clock in";
  the WFH-vs-office split works even for late arrivals.
- 60s auto-refresh (the page bills itself as live) + role-aware copy
  ("everyone in your workspace today" vs "direct reports").

## 3. ✅ PM: Create-issue button + milestone linking  *(founder items 1 + 2)*

- **Project page → Issues card → "+ New issue"**: creates in place, pre-linked
  to the project, with an optional **Milestone** select and a Team select when
  the project spans several teams. Works in both transports (sync engine +
  REST kill-switch).
- **Milestone at creation**: `milestone_id` on the create API + sync engine,
  existence-checked inside the tenant transaction (must belong to the given
  project; requires a project).
- **Milestone on the issue detail**: new "Milestone" rail row under Project —
  pick any milestone of the issue's project, or clear it. "Set a project
  first" when there's none.
- **Latent bug fixed** (was reachable in prod via demo data): moving an issue
  that had a milestone to a DIFFERENT project 400'd — the old milestone was
  validated against the new project. Now an implicit milestone survives only
  a same-project call; a project move clears it (server + engine optimistic
  patch kept in sync), and milestone changes are written to issue history.
- **Second latent crash fixed** (caught by this round's live pass): the issue
  detail page typed `/pm/users` as a bare array but the endpoint wraps the
  roster in `{ data }` — whenever that fallback query resolved before the
  sync engine finished bootstrapping, the whole page died with a client-side
  exception ("Application error"). Race-timing dependent, so it looked like
  a random white page in production.

## 4. ✅ Leave types follow the employee's gender  *(founder item 3)*

`leave_types.applicable_genders` existed since 0001 and onboarding seeded
Maternity=female / Paternity=male — but **no query ever filtered on it**. Now:

- My-balances, the leave-type list, and the 360° page's balances only show
  untagged types + types matching the employee's gender. No gender /
  other / prefer-not-to-say ⇒ untagged types only (nobody is guessed at).
- Applying for a non-applicable type is rejected server-side.
- Settings → Leave policy shows "Female only" / "Male only" pills.
- **Data backfill in 0054**: demo-script tenants seeded before tagging get
  Maternity→`{female}`, Paternity→`{male}` — keyed on NAME, not code ('PL'
  collides between Privilege and Paternity).

## 5. ✅ Documents tab = honest "Coming soon"  *(founder item 4)*

`People → Documents` was an empty state inviting an upload with no storage
behind it. Now a `hr_documents` feature flag (off) renders the house
ComingSoon card (per-employee folders / contracts / expiry reminders as the
promised scope). Sidebar entry stays visible; flip the flag when the vault
ships.

## 6. ✅ Full state names everywhere  *(founder item — "still showing TN")*

Codes stay stored (CGST/SGST-vs-IGST derivation compares 2-letter codes);
display is now always the full name via a new shared `stateName()` helper
(legacy alias codes OR/DD/DN/DH/OD included, raw fallback for foreign text):

- Employee 360° + onboarding review dialog (legacy "TN" in stored addresses
  renders "Tamil Nadu" — display-time, no data rewrite).
- Company profile + Locations selects/list (code-valued, name-labelled).
- **Invoicing customer modal: the free-text "State code" input became a
  select** — free text there could silently break the tax split.
- Invoice render: seller state, billing state, place of supply; invoicing
  settings' "Place of supply default".

## 7. ✅ Honest slug + the real General tab  *(founder items 8/9/10, 2nd message)*

**The slug hint was false on both counts** ("Immutable; used in URLs and
audit logs" — it appeared in zero user-facing URLs and wasn't in the audit
log). What shipped:

- **The slug (now "Workspace ID") is editable** on the new Company profile
  page — signup's reserved-name + global-uniqueness rules (excluding self),
  live availability check, `ConflictException` on collision.
- **Renaming the workspace suggests the matching ID** (until the ID is edited
  by hand), so the ID follows the name — saved only on Save, never silently.
- **CRM email-in safety**: the inbound BCC matcher was verified to match on
  the token alone — addresses saved with the OLD slug keep routing after a
  rename. The UI says so next to the field.
- **Slug changes are audited** (before/after in `tenant.updated`).
- **Honesty sweep**: truthful hint copy; the FAM tenant header's fake
  `{slug}.flickssuite.com` span now shows `ID: {slug}`; the signup wizard's
  "Workspace URL" preview relabelled "Workspace ID · your email-in address &
  future workspace URL"; a dead slug DB read removed from invoice sending.
- **Real subdomain URLs remain out of scope** — wildcard DNS is still an
  unchecked launch action and the web middleware routes no tenant hosts.
  When that project lands, the editable slug is ready for it.

**Settings → General is now literally the three preferences the founder
asked for** — Default timezone, Financial year starts, Week starts on —
with everything identity moved to **Settings → Company profile** (the
2026-07-06 "single edit surface" decision preserved, relocated; Organization
· Financial's cross-links updated).

- `timezone` and `fiscalYearStartMonth` finally have WRITE paths (they were
  read-only tenant columns). The FY field warns that invoice numbering
  follows it.
- **`week_starts_on` (new column, 0054) actually drives timesheet weeks** —
  the server's week boundary honours it for new get-or-create periods
  (historical periods keep their stored dates; a mid-week change applies from
  the next week). Fixed a latent client bug on the way: the timesheet grid
  re-snapped the server's `periodStart` to Monday, which would have mangled
  non-Monday weeks.
- All three (plus slug) added to the audit snapshots.

## Tests

`founder-round13.spec.ts` — 17 tests: Haversine punch resolution
(inside / outside / no-coords, user agent, no clock-out downgrade), WFH
regularization writes `work_mode`, team-today scoping (owner org-wide,
manager direct reports, legacy-call compat), gender-scoped leave (list,
balances, apply-rejection, NULL gender), milestone-at-create + wrong-project
rejection + the cross-project 400 regression, slug update (audit snapshot,
reserved, taken), and week-start driving the timesheet period (Sunday start
verified end-to-end).

## Deploy checklist

1. **Supabase**: run migration `0054` (idempotent — safe to re-run).
2. Deploy API + web (both changed).
3. No new env vars.
4. Smoke: Settings → Locations → set a geofence on the HQ office (lat/lng/
   radius) → assign employees to it → clock in from the office → the green
   "Inside … geofence" strip; from elsewhere → the WFH dialog. Sidebar →
   Time → Team attendance as the owner shows everyone with the Location
   column. Settings → General shows exactly the three preferences.
5. Until a location has a geofence set, everything behaves exactly as before
   (punches store coordinates when granted; no dialog, no strip, work_mode
   stays NULL).

## Open follow-ups from this round

1. Subdomain workspace URLs (`{slug}.flickssuite.com`) — DNS + middleware +
   per-tenant public URL base; the editable slug is the prerequisite, done.
2. Geofence v2 candidates (all PRD-specced, all deferred consciously):
   `pending_approval` punches for outside-fence clock-ins, the IP allowlist,
   auto-clock-out on fence exit (mobile), per-shift on-site requirement.
3. `work_mode='field'` exists in the enum for client-visit days — no UI
   writes it yet.
4. Leave-policy editor could let admins TAG genders on custom types (list
   shows the pills; editing stays name-derived from the defaults).
5. The `?managerId=` filter on team attendance has no UI select yet.
6. Documents vault behind `hr_documents` still needs its storage backend.
