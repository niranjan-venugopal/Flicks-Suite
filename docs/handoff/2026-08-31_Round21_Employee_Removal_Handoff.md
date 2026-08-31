# Round 21 (2026-08-30/31) — Employee offboarding + removal, end to end

The founder's ask, verbatim: *"We had an option to delete the employee
right?. Why it is not showing?"* — and, when offered the choice: offboard for
real exits, **plus delete for mistakes, for any employee**. The backend
shipped first (2026-08-30); this completes the UI (2026-08-31).

## ⚠️ Migration prerequisite

This work reads `employees.deleted_at` from **migration 0057**. Apply
migrations **0054–0057** in Supabase before deploying (the verified combined
script was delivered in chat) — without 0057 the dashboard, HR reports,
directory and org chart 500.

## What removal actually does (backend, round 21)

Handing a raw DELETE to the database would destroy the person's attendance,
punches, leave, timesheets and employment history — the PF/ESI and
wage-register substrate that 14 tables cascade off. So removal is
**mode-aware**:

- **No history** (added by mistake, never worked a day): a genuine DELETE —
  the record goes for good.
- **Any history**: `deleted_at` is stamped — they leave every directory,
  report, org chart and picker, while the statutory rows survive.
  Restorable.

Either way the **workspace seat is revoked** — a removed person must not
keep a login. (Offboarding never did this either; the revoke lives where
both paths reach it.) Role rules: an admin removes ordinary staff, but
removing an owner/admin is owner-only; you cannot remove yourself; a
`removal-preview` endpoint returns the mode + the record counts behind it so
the UI never guesses.

## The UI (this round)

**Employee page** (Owner/HR admin):

- **Offboard** — the proper exit: separation type (resigned / terminated /
  retired / end of contract / absconded), last working day, and a required
  reason. Files through the existing terminate flow: status flips to notice
  period and a separation row lands in employment history. The dialog says
  plainly that it deletes nothing.
- **Remove** (danger) — fetches the removal preview first, then confirms
  with mode-specific copy: a no-history record warns *"deleted for good …
  cannot be undone"*; a history-bearing one lists the real counts
  (attendance days, leave requests, timesheet entries) and says the records
  are kept. On success you land back on the directory.

**Directory**: the status filter gains **Removed** — a server-side view of
archived people (`removed=true`), each row with a **Restore** button.
Restore puts the record back; the sign-in stays revoked (re-invite them if
they need access again — by design).

## Verification

- Backend: round 21's spec (`founder-round21.spec.ts`) already pins the
  delete-vs-archive decision, the role rules, the seat revoke and directory
  hiding.
- This round: web typecheck + production build, plus a live
  headless-Chromium pass driving the real app: offboarding an employee
  (status + history row asserted in Postgres), deleting a no-history record
  (row gone), archiving a history-bearing one (deleted_at stamped,
  attendance intact), and the Removed filter + Restore round-trip.
