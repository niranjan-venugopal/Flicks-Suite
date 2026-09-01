# Round E — PM feels instant, issues land in their project, Linear composer, project members + Private projects, project logo

**Date**: 2026-09-01 · **Migration**: `0059` (apply in Supabase — see below)

The founder's six asks after using PM in production, and what shipped for
each. Everything passed the full gate (typechecks, `nest build`, **742/742**
Jest tests, `lint:boundaries`, web production build, `diagnose-rls = 0`) and
a live headless-Chromium pass on the production build.

---

## 1 · "Everything takes a lot of time to load" — PM speed

Measured on the production build after the fixes: **cold PM load 376 ms,
warm reload 330 ms, clicking an issue → content visible in 115 ms.**

What was actually slow, and the fix at each layer:

- **Opening an issue showed a spinner for a server round-trip even though
  the offline engine already had the row in memory.** The page now renders
  the title, state, priority, assignee and the whole properties rail
  instantly from the local graph; only the lazy parts (description,
  comments, history) show small skeletons while they fetch.
  (`pm/issues/[id]/page.tsx`)
- **Warm boot did 17 IndexedDB reads one at a time** before showing
  anything. They now run together. (`lib/pm/idb.ts`)
- **Every 30 seconds the engine rewrote the entire local cache** even when
  nothing had changed — a recurring stall proportional to workspace size.
  It now persists only when a delta actually returned rows.
  (`lib/pm/engine.ts`)
- **An expired 15-minute session cookie silently downgraded PM to the slow
  REST mode** (no board, spinners everywhere) because the sync bootstrap's
  raw fetch never used the app's silent token refresh. It now refreshes and
  retries — this is very likely a big share of the "slow in production"
  feeling. (`lib/pm/engine.ts` + `lib/api/client.ts`)
- **The server bootstrap ran ~24 queries one after another** (a per-team
  N+1, the visibility scope computed three times, the user roster on a
  second DB connection, an advisory lock taken even when nothing needed
  seeding). Queries now run in parallel groups, scope is computed once, and
  two missing indexes were added — including the one the bootstrap's
  hottest query (per-team issues ordered by recency) had no support for.
  (`sync/sync.service.ts`, `sync/visibility.service.ts`,
  `teams.service.ts`, migration `0059`)
- The projects list computed each row's progress bar by scanning every
  issue per project; now one pass covers all rows. The project and cycle
  pages' 700/800 ms guess-timer refetches were replaced by the engine's
  flush acknowledgement (the round-C `onFlushed` mechanism).

## 2 · Board view + clicks

- **Clicking a card on the board did nothing — the card had no click
  handler at all** (only drag handlers). Cards now open the issue, with a
  guard so finishing a drag never counts as a click.
  (`components/pm/board.tsx`)
- **The issues list needed a double-click to open an issue** — that's why
  clicking felt broken. A single click opens it now (shift-click still
  multi-selects, the checkbox still works). Board cards also show the real
  avatar photo instead of initials.

## 3 · "Issue created inside a project isn't getting assigned to it"

The data path was verified end to end — the link was never being dropped by
the server. Three real mechanisms produced the symptom, all fixed:

- **The composer silently reset your picks.** While the dialog was open, a
  background data refresh re-armed the presets and snapped project/
  milestone/state back — so a project you picked (or the pre-linked one)
  could quietly revert. It now arms only at the moment the dialog opens.
- **The project selector showed "No project" while the projects list was
  still loading**, even when the issue WAS linked — reading exactly like
  the bug. The pill now always names the linked project.
- The project page's "+ New issue" was a small text link that was disabled
  while teams loaded; it's now a real button that's never dead during load.
- Creating from a project **auto-assigns that project** (and "Create more"
  keeps it for every following issue) — user-changeable in the composer, as
  asked. A new executor-path test pins the project link on the exact wire
  path the app uses. Creating from the Issues tab still asks for a project
  (optional), unchanged.

## 4 · Linear-replica composer

The composer is rebuilt to match the attached Linear screenshot: a team
breadcrumb ("Team › New issue"), a big borderless **title**, a free-text
**description** area (no boxy form), and one row of compact **property
pills** — State, Priority, Assignee, Project, Milestone, Estimate, Due
date, Labels — each opening a popover menu with glyphs and avatars. Footer:
"Create more" toggle (label clickable), ⌘↵ hint, Cancel / Create issue.
Same composer everywhere (issues tab, board columns, project page, REST
fallback); templates, labels-at-create and both transports unchanged.
(`components/pm/IssueComposer.tsx`, new `components/pm/PropertyPill.tsx`,
additive `hideHeader`/`bodyPadding` props on the proto Modal)

## 5 · Project members + Private projects (your decision: Members + Private toggle)

- Every project page now has a **Members card**: add employees/managers
  from a picker, see them with their photo, email and **real workspace
  role** (Employee/Manager/…), the lead marked, remove with ✕. Guests keep
  their own card and can never be mixed into the members roster (their
  billing-free seats work differently). Managing members = the project
  lead, plus manager and above — the same bar as guest invites.
- **Private toggle** on the card: **off by default, nothing changes for
  existing projects.** Flipped on, the project (and every issue in it)
  is visible ONLY to its members, its lead, and owners/admins — enforced in
  one central visibility rule that covers the projects list, project page,
  issues lists, boards, search, the sync bootstrap AND live deltas: flip it
  and the project disappears from non-members' open apps within seconds
  (verified live with a second signed-in session); add a member and it
  appears for them the same way. Managers are NOT exempt — they're added
  as members, exactly as you framed it.
- Private projects show a small lock next to their name.

## 6 · Project logo

- **While creating a project**: a "Logo (optional)" file field — the server
  squares and re-encodes it, so any JPG/PNG/WebP works.
- **On the project page**: a logo button next to the icon opens the same
  crop dialog used for profile photos and the company logo (change or
  remove any time). The logo shows on the project page and in the projects
  list; the emoji icon remains the fallback everywhere.
- Storage-wise it's the exact company-logo pipeline (validated by file
  content, re-encoded, stored privately, served via short-lived signed
  URLs; the raw storage key never leaves the API). **Uploads need the R2
  storage config, which exists in production** — locally the API says
  "storage disabled" and the UI shows an honest error, which is expected.

---

## Migration 0059 — apply in Supabase

`packages/db/drizzle/0059_pm_members_private_logo.sql` — idempotent:
- `pm_projects`: `is_private` (default **false**), `logo_key`,
  `logo_updated_at`
- Two missing PM indexes (bootstrap's per-team issue query; the visibility
  scope's live-projects scan)

**Apply order note**: production Supabase still needs `0054 → 0058` from the
previous rounds (the combined `apply-0054-to-0058.sql` was delivered in
chat). 0059 can be appended to the same session — all six files are
idempotent. **Without 0059 the API errors on every PM read** (it selects
`is_private`/`logo_key`), so apply it before or together with deploying this
commit. Railway must deploy the latest `production` branch as usual.

## Gate

- API: 742/742 Jest (62 suites) incl. the new 18-test
  `founder-roundE.spec.ts` (executor project-link, members authority
  matrix, the full Private visibility matrix incl. delta tombstones on
  flip/removal, logo signing incl. never-leak-the-raw-key); typecheck +
  `nest build` + `lint:boundaries` clean.
- Web: typecheck + production build clean.
- RLS: `diagnose-rls.sh` → `leak_with_bogus_context = 0` (137 tables).
- Live pass (production build, real login): timings above; board click →
  issue; single-click open; composer pre-link + Create more; members add/
  remove; Private flip verified from a second user's session (loses, then
  regains on membership); logo affordances.

## Known notes / deferred

- Logo upload requires R2 (production has it; local dev shows a 503 toast).
- Signed logo/avatar URLs cached on a device expire after ~24h offline; the
  UI falls back to the emoji/initials and re-signs on the next sync.
- Deferred perf items (not needed to hit the feel-instant bar): list
  virtualization for 2000+ visible rows, streaming the bootstrap response,
  hover prefetch.
- Per-project permission levels (viewer/editor) are not modeled — a member
  IS a full participant; the workspace role still governs what they can do.
