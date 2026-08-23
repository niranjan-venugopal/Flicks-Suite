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
