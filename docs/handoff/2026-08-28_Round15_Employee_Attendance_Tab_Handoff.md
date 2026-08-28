# Round 15 handoff — the employee-360° Attendance tab shows real history

**Date:** 2026-08-28 · **Branch:** `claude/handoff-patch-deploy-0g4sp6` → `main` + `production`
**Migration to apply:** none (round 13's `0054` still applies if not yet run).
**Gate at handoff:** api typecheck ✓ · api build ✓ · jest **602/602 (53 files)** ✓ ·
`lint:boundaries` ✓ · web typecheck ✓ · web production build ✓ ·
`diagnose-rls.sh` → 0 leaks ✓ · live Chromium pass (owner + self + unrelated-peer sessions) ✓

Read after `2026-08-27_Round14_Attendance_Toggle_Settings_Handoff.md`.

## The founder item

The Attendance tab on an employee's profile (People → employee → Attendance)
was a dead end: "Full attendance for this employee is available in the
dedicated module" with an **Open Attendance** button — which opened *your own*
attendance, not theirs. Now the tab shows **that employee's actual history**.

## What shipped

- **New API**: `GET /api/v1/attendance/employee/:employeeId`
  (`attendance.service.listForEmployee`) — same shape as `/attendance/me`
  plus `workMode`, with month-range/status filters and paging.
  **Access rules enforced in the service** (the employee 360° page itself is
  workspace-visible, so day-by-day punch history gets its own gate):
  - the employee themselves,
  - their reporting manager (direct reports only),
  - owner / admin / finance / fam — anyone in the workspace hierarchy at
    finance level or above sees everyone.
  - Everyone else → 403 with an honest message. The read path deliberately
    does NOT use the punch flow's employee self-heal — a read never mints
    employee records.
- **Web**: `components/employees/EmployeeAttendanceTab.tsx` replaces the
  placeholder on `/employees/[id]` — month navigation (same MonthNav as the
  Attendance page), four KPIs (**Days present · WFH days · Avg hours/day ·
  Late arrivals**), and the daily log (Date/Day/In/Out/Hours/Break/Status
  with WFH-aware pills from `work_mode`, "+Nm" late chips, and the
  "regularized" marker). A viewer without access sees a card explaining who
  can view history — never an empty table pretending there's no data.
- New hook `useEmployeeAttendance` in `lib/api/queries/use-attendance.ts`.

## Tests

`founder-round15.spec.ts` — 6 tests: owner reads anyone (ordering +
`workMode` + lateness in the payload), self-read, manager reads a direct
report, unrelated employee refused, manager refused for a NON-report,
404 on unknown id + date-range filtering.

## Deploy checklist

1. Deploy API + web (both changed). No SQL, no env vars.
2. Smoke: People → any employee → Attendance shows their month history with
   KPIs; a plain employee opening a colleague's profile sees the
   "visible to the employee, their manager, and admins" card instead.

## Open follow-ups

1. The 360°'s **Leave** and **Timesheet** tabs are still "open the module"
   placeholders — same pattern would give them per-employee views.
2. Export/date-range download of an employee's history (payroll ask).
3. The `?managerId=` filter on the team view still has no UI select.
