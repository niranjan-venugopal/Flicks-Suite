# Round 14 handoff — team view as a toggle on Attendance, Settings → General restored whole

**Date:** 2026-08-27 · **Branch:** `claude/handoff-patch-deploy-0g4sp6` → `main` + `production`
**Migration to apply:** none — web-only (round 13's `0054` still applies if not yet run).
**Gate at handoff:** api typecheck ✓ · jest **596/596 (52 files)** ✓ · `lint:boundaries` ✓ ·
web typecheck ✓ · web production build ✓ · live Chromium pass (owner + employee sessions) ✓

Read after `2026-08-27_Round13_Geofence_Team_PM_Handoff.md`. Both changes are
UI-placement corrections to round 13 — no behavior underneath moved.

## 1. Team attendance is a TOGGLE on the Attendance page  *(founder item)*

Round 13 exposed the team view as its own sidebar entry ("Time → Team
attendance"). The founder wants one Attendance surface instead:

- **`/attendance` now has a segmented toggle** in the page header —
  **My attendance | Everyone** (managers see **My team**, since their API
  scope is direct reports). Flipping it swaps the page body in place: the
  personal view (clock card, timeline, month KPIs, daily log) ⇄ the complete
  view (live KPI tiles, roster with Status/Location/Clock in/out/Worked).
- The toggle only renders for Owner / Admin / Finance / Manager — employees
  see the page exactly as before, no toggle.
- "Request regularization" hides while the team view is showing (it belongs
  to the personal view).
- The team view itself moved unchanged into
  `components/attendance/TeamToday.tsx`; the API and its role-based scoping
  are untouched from round 13.
- **Sidebar entries removed**: the round-13 "Team attendance" link in the
  admin nav AND the manager nav's long-standing one — the toggle replaces
  both. `/team/attendance` survives as a redirect to `/attendance` so old
  bookmarks keep working.

## 2. Settings → General is ONE page again  *(founder item)*

Round 13 split identity off to a new "Company profile" page and reduced
General to three preference fields. Reverted to the pre-round-13 structure —
**nothing moved, nothing renamed**:

- `/settings` (rail: "General") again holds the overview card, Workspace
  details, Tax & legal identifiers, and Registered address — exactly the old
  layout — **plus one appended card: "Workspace preferences"** with the
  round-13 additions (Default timezone · Financial year starts · Week starts
  on), saved through the page's existing Save/Discard footer.
- The "Company profile" page and its rail entry are gone; cross-links
  (Organization · Financial, invoicing settings) point back to
  Settings → General.
- Kept from round 13 (they were the founder's own asks, and they live where
  they always did): the editable **Workspace ID** with availability check +
  rename suggestion, and the full-state-name dropdown.
- Backend untouched: the three preferences still ride the same
  organization-update endpoint; week-start still drives timesheet weeks.

## Deploy checklist

1. Web-only: deploy the web app (API redeploy harmless but not required).
2. No SQL, no env vars (run round 13's `0054` first if it hasn't been).
3. Smoke: as the owner, Attendance shows the My attendance | Everyone
   toggle and no "Team attendance" sidebar entry; as an employee, no
   toggle. Settings → General shows the old sections plus Workspace
   preferences at the bottom, and Save persists a week-start change.

## Open follow-ups

1. The toggle state is in-page only (deliberate — one surface, founder's
   ask). If a deep link to the team view is ever wanted, add
   `?view=team` reading with a Suspense boundary.
2. Everything else carries over from round 13's list.
