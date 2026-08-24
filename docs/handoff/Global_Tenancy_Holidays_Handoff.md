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
