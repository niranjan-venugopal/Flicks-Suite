# Round 12 handoff — Regularize bug CLEARED, Projects as the PM main page, project-first tour

**Date:** 2026-08-27 · **Branch:** `claude/handoff-patch-deploy-0g4sp6` → `main` + `production`
**Migration to apply:** none — this round is web-only (no API, schema or env changes).
**Gate at handoff:** api typecheck ✓ · api build ✓ · jest **579/579 (51 files)** ✓ ·
`lint:boundaries` ✓ · web typecheck ✓ · web production build ✓ ·
`diagnose-rls.sh` → 0 leaks ✓ · live Chromium pass (owner + guest sessions) ✓

Read after `2026-08-27_Round11_Founder_Fixes_Handoff.md`.

## 1. ✅ BUG CLEARANCE — the Daily-log "Regularize" button  *(founder item)*

**Confirmed fixed and verified live.** The button in the Attendance → Daily
log rows was shipped with **no click handler at all** — a styled button wired
to nothing. The regularization dialog and the API behind it
(`POST /attendance/regularizations`, manager notification, round-8
self-approval guard) were always healthy — the page-header "Request
regularization" button used them; only the per-row CTA was dead.

Fix (`apps/web/app/(app)/attendance/page.tsx`):
- `DailyLogTable` now takes an `onRegularize(date)` callback; the row button
  opens the existing `RegularizationDialog` **with that day pre-filled**
  (new `initialDate` prop — before, even a wired click would have landed the
  user on an empty date picker).
- The CTA now also shows on `half_day` rows (was only late/absent) — a
  half-day is a prime regularization case.

**Live proof:** seeded a `late` day → clicked the row's Regularize → dialog
opened with that exact date pre-filled → submitted a reason → a `pending`
row landed in `attendance_regularizations` for that date, manager notified.

**Known limitation:** a day that already has a pending request still shows
the button; the API's 400 ("A pending regularization already exists for this
date") surfaces as the dialog's error toast. Hiding the CTA would need the
range endpoint to expose pending state (it only carries `isRegularized`).

## 2. Projects is the PM module's main page  *(founder item)*

- **Sidebar**: "Projects" is now the FIRST item inside the Projects group for
  every role — reordered in all three duplicated nav arrays (admin :131,
  manager :198, employee :234). New order: Projects · My Issues · Issues ·
  Triage · Cycle · Timeline · Roadmap · Teams · Settings. The guest nav
  already pointed straight at `/pm/projects` (untouched); the `pm_github`
  Settings remap and active-highlight logic are order-independent.
- **`/pm` no longer 404s**: new `app/(app)/pm/page.tsx` redirects to
  `/pm/projects`. Every other entry point (guest landing, onboarding,
  company switcher, ⌘K "G then P", CRM deal→project) already targeted
  `/pm/projects` — this round converges the sidebar with them.
- Deliberate non-change: clicking the group header still only expands the
  menu (with Projects on top). Making the header itself navigate would
  re-break the round-11 stuck-sidebar fix (click-to-collapse would
  re-navigate/re-open).

## 3. The guided tour: create a project FIRST  *(founder item — "that's how Linear works")*

`components/pm/FirstRunChecklist.tsx` (the "Setup n/4" chip strip):
- **Step order is now: Create a project → Create an issue → Invite your
  team → Start a cycle** (was issue-first). The step predicates are
  independent store counts, so nothing regresses.
- The card **moved from My Issues to the Projects page** (its new home per
  item 2), rendered right under the page header in sync mode. The REST
  fallback never showed it (needs the sync engine) — unchanged.
- "Create a project" now **opens the New-project modal in place** (the old
  href was about to become a link to the page it already lived on).
- "Create an issue" now routes to `/pm/issues` — the old `?create=1`
  parameter was dead (the issues page never read it); the same dead link in
  the ⌘K palette's "Create issue…" entry got the identical fix. First-run
  users land on the issues empty state whose "Create your first issue"
  button is right there. (Teaching the issues page to auto-open its
  composer from a URL param is a possible future nicety — noted, not done.)
- **Guests never see the tour** (every step is a server 403 for a guest
  seat) — guarded inside the component so any future host inherits it.
- Dismissal key bumped to `pm-first-run-checklist.v2` so the moved card
  resurfaces once for anyone who dismissed the old placement; it still
  self-hides at 4/4 and dismisses forever with the ×.

**Live proof:** `/pm` redirected to Projects; the sidebar's first PM link is
Projects; the tour chips read exactly `Create a project · Create an issue ·
Invite your team · Start a cycle`; clicking the first chip opened the
New-project modal; creating "Website revamp" ticked the chip to 1/4; the
issue chip landed on `/pm/issues`; a guest session saw no tour.

## Deploy checklist

1. Web-only: deploy the web app (API redeploy harmless but not required).
2. No SQL, no env vars.
3. Smoke: Attendance → Daily log → Regularize on a late day opens the dialog
   with that date; sidebar Projects group starts with Projects; the setup
   chips on Projects start with "Create a project".

## Open follow-ups from this round

1. Hide/disable the row Regularize CTA for days with an already-pending
   request (needs pending state on the range endpoint).
2. Optional: auto-open the issue composer via a URL param (`/pm/issues` +
   Suspense-wrapped `useSearchParams`) so the tour/palette can deep-link
   into creation, not just the page.
3. The bank sub-step country gating from round 10 remains the standing
   international follow-up.
