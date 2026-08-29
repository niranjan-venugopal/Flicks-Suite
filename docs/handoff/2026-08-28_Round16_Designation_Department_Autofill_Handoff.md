# Round 16 handoff — picking a designation auto-fills its department

**Date:** 2026-08-28 · **Branch:** `claude/handoff-patch-deploy-0g4sp6` → `main` + `production`
**Migration to apply:** none — web-only (no API, schema or env changes).
**Gate at handoff:** web typecheck ✓ · web production build ✓ · live Chromium pass ✓
(api suite unchanged from round 15's 602/602 — no API code touched).

Read after `2026-08-28_Round15_Employee_Attendance_Tab_Handoff.md`.

## The founder item

"When Selected Designation, The Department should auto fetch." Everything
upstream already existed — Settings → Designations has had an optional
department link since day one (round 3 made designations *assignable*
across departments; linked ones kept their `department_id`). The employee
forms just never used the link in this direction: they filtered designations
BY the chosen department, which meant a department-linked designation was
invisible until you picked its department first — the exact reverse of the
founder's flow.

## What shipped (both employee forms)

`apps/web/app/(app)/employees/add/page.tsx` and the Edit-profile dialog in
`apps/web/app/(app)/employees/[id]/page.tsx`:

- The **Designation dropdown now shows every active designation** regardless
  of the current Department value, labelled with its linked department —
  "Software Engineer (Engineering)" — while common designations show plain.
- **Picking a department-linked designation auto-fills the Department
  field** with its department (overwriting a different current value — the
  designation is the more specific signal). The field stays editable.
- Picking a **common** designation (no link) leaves the Department exactly
  as it was.
- The existing reverse guard is untouched: changing the Department still
  clears a designation that doesn't belong to the new department (common
  ones survive).

No API change: the designations list already returned
`departmentId`/`departmentName`, and Settings → Designations already offers
the department link on create/edit.

## For the founder's Labs 24 setup

For the auto-fetch to fire, link each designation to its department in
**Settings → Designations** (edit → Department dropdown). Designations left
on "All departments" (e.g. a shared **Intern**) simply don't auto-fill —
by design.

## Deploy checklist

1. Web-only: deploy the web app.
2. Smoke: Settings → Designations → link one designation to a department →
   People → Add employee → pick that designation with Department empty →
   Department fills itself.
