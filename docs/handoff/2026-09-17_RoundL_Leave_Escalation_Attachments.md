# Round L — Leave-aware attendance, manager-first approvals with 24 h escalation, PM relations, attachments & speed

**Date:** 2026-09-17 · **Type:** pre-freeze bug clearance + two PM feature asks · **Migrations:** `0062_approval_escalation.sql`, `0063_record_files_pm_attachments.sql` (**run `docs/handoff/apply-0062-0063.sql` in Supabase — see §10**)
**Reported by:** founder — eight items, verbatim in §1. Standing rule: *"no leakage of data at any point."*

## 1. What the founder gets

| # | Complaint | What changed |
|---|---|---|
| 1 | *"If a user is on leave, it shows the manager stating that the user has missed punch."* | Attendance now knows who is **expected** at work on a given day: approved leave, half-day leave, holidays (location-aware, elective ones excluded) and each person's shift working days are resolved by one shared rule and used by the manager's Team view, the dashboard "Today" tile, the person's own Clock card and month view. Someone on leave shows **On leave**, never "Yet to clock in"; a pending request shows **Leave pending**; clock-in on an approved leave day is refused with a clear message (§3). |
| 2 | *"Approvals are not going to their reporting manager, instead it comes to the admin…"* | Leave, regularization and timesheet approvals are **manager-first**: the reporting manager gets them; after **24 hours** without action, or immediately when the manager is on approved leave, they escalate to the **manager's manager**, and after another 24 hours (or when there is no manager above) to **Owner + HR Admins** — with a bell + email at each step. Owner/HR Admin queues and the sidebar badge now show only what is routed to them, but they can still act on anything they open directly. The reporting manager keeps the ability to approve or reject until the request is closed. Timesheets join the Inbox → Approvals tab (Approve / Reject / Rework) and no longer need a manager to be submitted (§4). |
| 3 | *"…check whether the clock-out of the request is ahead of time…"* | The regularization dialog knows the day's punch state: for **today**, while the person is still clocked in (or when the proposed clock-out is in the future) it explains that today's request can be raised after clocking out and disables Submit; the server refuses the same cases and any proposed times that are out of order or on the wrong day, in the person's shift timezone (§5). |
| 4 | *"The coupon activation notification … should not be shown all the time…"* | The trial countdown banner no longer shows to employees, managers or finance; Owner/HR Admin see it only in the **last 10 days** and can dismiss it once per trial period. Coupon activation sends a **bell notification + email** to Owner/HR Admin; trial reminders now fire at **10, 3 and 1 days** before expiry as bell + email to Owner/HR Admin only (§6). |
| 5 | *"An issue can be related to another issue."* | Issues get an **Add relation** action — *Relates to*, *Blocks*, *Blocked by*, *Duplicate of* — with a searchable issue picker, removable chips that show the other issue's key, a "linked / unlinked" line in the activity feed, and a **Parent** field for sub-issues (§7). |
| 6 | *"Uploading documents … an image in between lines … Attach button … multiple files…"* | A **Linear-style editor** for descriptions and comments (paste or drop an image and it sits between the lines; headings, lists, bold via shortcuts), an **Attach** button and drag-and-drop for files on the issue and on every comment (multiple files, progress, download, remove), for members **and guests** on the projects they belong to. Switched on for everyone, with a kill switch in the FAM console (§8). |
| 7 | *"More than 2 seconds to load an issue when clicked."* | The project page opened issues with a **full page reload**; it now opens them in-app and pre-loads the issue on hover, the detail paints from the local graph immediately, and the server returns the detail in one parallel batch with paged comments (§9, numbers in §12). |
| 8 | *"When I go back from a particular issue it takes me to My issues…"* | Back, Escape and post-delete return to **where you came from** (the project, My issues, a cycle, triage, the board), with the origin carried through sub-issue and relation hops (§9). |

## 2. Founder decisions (asked and answered)

| Question | Decision |
|---|---|
| Escalation target after 24 h / manager on leave | **Manager's manager first**, then Owner + HR Admins. |
| Owner/HR Admin before escalation | **May act when they open the request directly**; hidden from their Approvals queue and badge until escalated. |
| New-joiner onboarding reviews | **Stay with Owner/HR Admin** (manager keeps the awareness email). |
| Item 6 typing experience | **Linear-style rich editor** + Attach + drag-and-drop. |
| Attachments at launch | **On for everyone**, FAM kill switch. |
| 24 h clock | **Calendar hours**, weekends and holidays included. |

## 3. Item 1 — a person on leave is never "yet to clock in"

### Root cause

"Absent / yet to clock in" was never stored; it was **inferred from the
absence of an attendance row** in five places with five different rules:
the manager's Team view hard-coded IST and never looked at leave, the
dashboard used a **UTC** "today" (wrong for every Indian tenant after 17:30)
with no weekend awareness, the Clock card never consulted leave (so the
Clock-in button showed on a leave day and a punch overwrote the `on_leave`
row), and leave approval wrote full-day rows for half-day leave using a
hard-coded Sat/Sun weekend. A pending request was invisible everywhere.

### The fix — one read-only resolver

`apps/api/src/core/common/workday.ts` answers "is this person expected at work
on this day?" for one or many employees, deriving on read and **never seeding
rows**:

- **Shift** = the employee's active `employee_shifts` assignment → the tenant's
  default template → a literal Mon–Fri / IST fallback (the punch flow stays the
  only writer). "Today" is resolved **per employee in their shift timezone**;
  the dashboard uses a tenant "today" (default shift tz → tenant tz → IST).
- **Holidays**: company-wide rows apply to everyone, location rows only to
  employees at that location; elective types (`optional`, `restricted`) never
  block work — the same rule the leave module already used.
- **Leave**: overlapping `approved` + `pending` requests; approved beats
  pending, full-day beats half-day.
- **Precedence**: holiday → weekend → approved full-day leave (`expected:false`,
  kind `leave`) → approved half-day (`expected:true`, kind `half_day_leave`) →
  working. A pending request is labelled (`pendingLeave`) but the person is
  still expected until someone approves it.

Every query carries an explicit `tenant_id` on both sides of each join; a
foreign employee id never comes back as "working".

### Surfaces that now use it

| Surface | Before | Now |
|---|---|---|
| Attendance → Team view (manager, owner, HR, finance) | null status → "Yet to clock in" | pills **On leave** (purple), **Leave pending**, **Half-day leave**, **Holiday · name**, **Weekend**, **Not expected**; KPI counts only `expected && !status`. Finance sees the roster and the "on leave" state but **no leave type / request details** (only managers, Owner and HR Admin see those). |
| Manager dashboard "team today" widget, Direct reports KPIs | "Not in yet" / wrong buckets | same vocabulary; "yet to clock in" excludes leave, holiday, weekend, pending leave; a backfilled half-day without a punch counts as pending, not present. |
| Owner dashboard "Today" tile + donut | UTC today, no weekend, late counted twice | tenant-tz today; `present` now includes `late` (late is the subset) and the donut/on-time % were fixed to match; new `weekend`, `pendingLeave` (only for approvers), `expectedToday`. |
| The person's Clock card | Clock-in shown on a leave day | "On approved leave today (type) — no clock-in needed" with a **Cancel leave** action (no dead end); half-day: "clock in for the other half"; pending: hint, Clock-in kept. Timeline empty state says "On leave today / Holiday · name / Weekend" instead of "Not clocked in yet". |
| `POST attendance/punch-in` on an approved full-day leave day | overwrote the leave row | **409** "You're on approved leave today — no clock-in needed. If you are working today, cancel the leave first." (decided by the resolver, so a leave cancelled after approval self-heals). |
| Month view | no leave overlay | approved/pending leave per day; approved full-day leave reads `on_leave` without a row. |
| Leave day-counting and backfill | Sat/Sun hard-coded; half-day wrote full rows; approval demoted worked days | follows the person's **shift working days**; half-day leave writes `half_day`; approval never demotes `present / late / work_from_home / on_duty / comp_off`; cancelling an approved leave removes the system rows it wrote (rows with punches are kept). |

Also fixed on the way: the API's `localTimeToUTC` was wrong for wall times ≥
20:00 IST (landed on the next day), which mis-computed the late threshold and
early-departure for evening/overnight shifts — the correct algorithm now lives
in `core/common/time.ts` and the web `lib/time.ts` is the same code; the legacy
shift-template join carries the template's tenant predicate.

## 4. Item 2 — manager-first approvals with 24 h escalation

### Root cause

Owner / HR Admin approval queues were **workspace-wide from minute zero**
(three copies of the same "org-wide roles see everything" rule in leave,
attendance and the dashboard), so an admin saw and often acted before the
reporting manager. Timesheets had the inverse bug: only the stamped approver
could act, submission failed without a manager, and timesheets were missing
from the Inbox and the badge. No escalation, SLA or reminder existed.

### The model (leave requests, attendance regularizations, timesheets)

- **Levels**: 0 = reporting manager · 1 = the manager's manager (one hop) ·
  2 = Owner + HR Admins (`memberships.role IN ('owner','admin')`, active seats,
  active users).
- **Clock**: 24 **calendar** hours from the level's anchor (leave
  `applied_at`, regularization `created_at`, timesheet `submitted_at`; level 1
  from `escalated_at`), weekends and holidays included. A sweep runs every
  **15 minutes** (`approval-escalation` cron; `POST fam/jobs/approval-escalation/run`
  for the FAM console).
- **Immediate skips**: the current reviewer is on approved **full-day** leave
  today (`reviewer_on_leave`); no valid reporting manager (`no_manager` → HR);
  stuck at level 0 with no valid manager above (`no_skip_manager` → HR). A
  manager who is themselves the applicant, a cycle, a separated / deleted
  employee or a seat without an active membership is "no valid manager".
- **Who may act** (one server guard shared by the three services): the live
  reporting manager **always**; the manager's manager once it has escalated to
  them (and still after it reaches HR); Owner / HR Admin **always** when they
  open a request directly; **never the applicant** (checked by user id, employee
  id and the membership bridge — this also closes the old leave self-approval
  gap).
- **Queues and the badge**: direct reports always; escalated-to-me items;
  Owner / HR Admin only level-2 items (or items with no valid manager — the
  live safety net for legacy rows, see §12). Team → Leave / Team → Timesheets
  stay workspace-wide for Owner / HR Admin with a muted *With Arjun · escalates
  in 18h* chip — the "open directly" surface.
- **Notifications**: each step notifies the **new** reviewers only (bell +
  email, deep-linked): `leave.escalated`, `regularization.escalated`,
  `timesheet.escalated`, `timesheet.submitted`, email `approval-escalated`.
  When a request is born at level 1/2 the existing "requested" message carries
  the reason ("their manager is on leave today, so it is with you" / "no
  reporting manager is set, so it is with you as HR"). An over-the-head
  decision by HR or the skip-level manager tells the routed manager. The
  employee sees "With your manager" / "With HR" (never who above the manager,
  never why).

**Worked example.** Asha (reports to Arjun → Bhavana → Owner) applies on
Monday 10:00. Arjun gets the bell + email; Owner and Hema (HR Admin) see
nothing in Inbox → Approvals but can find it on Team → Leave and approve there.
Tuesday 10:15 (first sweep after 24 h): escalated to Bhavana — "Asha's leave
request (Casual Leave, 20 Sep, 1 day) was escalated to you — no action for 24
hours"; Arjun keeps the request in his queue and can still decide.
Wednesday 10:30: escalated to Owner + Hema; Arjun and Bhavana can still act
until it is closed. If Arjun is on approved leave on Monday, the request goes
to Bhavana straight away.

### Timesheets

Submission no longer needs a reporting manager (it routes to HR with
*No manager · with HR*); timesheets appear in **Inbox → Approvals** with
**Approve / Reject / Rework** (Rework requires a comment, resets the clock,
and resubmission re-notifies); `/team/timesheets?period=<id>` highlights the
row; the approver is stamped on the decision.

### Migration 0062

Adds `escalation_level`, `escalated_at`, `escalation_reason`,
`escalated_to_employee_id`, `routed_manager_employee_id` to `leave_requests`,
`attendance_regularizations`, `timesheet_periods` (guarded CHECKs, partial
indexes for the sweep). No new tables — RLS and grants already apply.
**First sweep after deploy**: every request already pending for more than 24 h
escalates on the first tick (a one-time burst of bells/emails to skip-level
managers and HR for the stale backlog).

## 5. Item 3 — regularization for today only after clocking out

Server (`POST attendance/regularizations`), evaluated in the person's **shift
timezone**, in this order: valid `YYYY-MM-DD` and strict ISO instants with an
offset (offset-less strings are refused) → not a future date → proposed
clock-in / clock-out must fall on the requested day (the next day only for an
overnight shift) → clock-out after clock-in → no proposed instant in the
future ("you can only regularize time that has already passed") → **for
today**: refused until the day is clocked out ("Regularization for today can
be requested after you clock out." / "You haven't clocked out yet today —
…") → no duplicate pending request for the day.

The dialog knows the same facts from the page's `/attendance/me/today`
snapshot (server clock, shift timezone, punches, `isOvernight`): picking
today while the day is not clocked out shows the info slab immediately and
disables Submit; a proposed out earlier than in shows an inline error; the
instants are built in the shift timezone (the browser's zone used to be used,
wrong for anyone travelling); overnight shifts build the clock-out on the
following day; server rejections render inside the dialog (not a toast);
"Times are in IST (General shift)".

## 6. Item 4 — trial banner scope, coupon and reminder notices

- **Banner** (`BillingGate`): only for **Owner / HR Admin**, only when the
  trial has **≤ 10 days** left, dismissable **once per trial period** (key
  `fs_trial_banner_<trial_ends_at>`; a coupon moves the end date, so the banner
  returns once). Employees, managers, finance, guests never see it. The
  past-due banner is unchanged for everyone. The banner and the bell use the
  same IST calendar-day number (`days_left` from the billing state).
- **Coupon redeemed**: after the redeem commits, a bell notification
  (`billing.coupon_redeemed`, zap icon, "Coupon CODE applied — N free months.
  Your trial now ends on 12 Oct 2026.") and the `coupon-redeemed` email go to
  Owner + HR Admin only; best-effort, never fails the redeem.
- **Reminders** (`trialReminders`, daily): T-3 and T-1 as before for every
  trial; a new **T-10** band only for **extended** trials (coupon applied or a
  trial longer than 10 days) so the stock 7-day trial does not get a "trial
  ends in 7 days" ping the morning after signup. Each band = email + one bell
  row per Owner / HR Admin (grouped, so repeats bump one row); separate
  markers for the bell and the email make a rerun a strict no-op and an email
  outage retry-safe.

## 7. Item 5 — issue relations

- **UI**: *Add relation* in the issue rail → *Relates to* / *Blocks* /
  *Blocked by* / *Duplicate of* → a searchable picker (local fuzzy over the
  synced graph + `GET /pm/search`, keyboard navigation, excludes the issue,
  its sub-issues and already-linked issues) → chips showing the **other**
  issue's key (cross-team keys correct), struck through when done or
  cancelled, × to remove, *Duplicate of* confirms because it closes the issue.
  A **Parent** row with the same picker. The activity feed reads "marked as
  blocking ENG-4", "marked as blocked by ENG-3", "linked to OPS-2", "removed the
  link to …", "set the parent to …". Escape inside the picker or a confirm
  closes it — it never leaves the issue.
- **API**: `POST pm/issues/:id/unrelate` (new), `relate`/`unrelate` write
  history on **both** sides, an inbox notice goes to the other issue's assignee
  (worded from the recipient's side only), `PATCH pm/issues/:id` accepts
  `parent_issue_id` (self / cycle ≤ 32 hops / invisible → refused).
- **Visibility**: history stores the other issue's **id** and resolves it to a
  key at read time through the caller's visibility (a private team's key never
  appears in a public issue's feed — "a hidden issue" instead); `parent_issue`,
  `sub_issues`, `relations[].related_issue` and the sync bootstrap/delta are all
  filtered the same way; DTO-supplied ids that the caller cannot see return
  404 (no 403 oracle).
- **Sync engine**: relations are a first-class synced collection (bootstrap and
  delta ship both directions, deduped), IndexedDB **v3 → v4** adds the store;
  the upgrade clears the cursor (one cold re-download per user) and **keeps
  the pending offline queue**; optimistic link/unlink with rollback. Both PM
  modes work (sync engine on or off).

## 8. Item 6 — attachments and the Linear-style editor

- **Editor** (TipTap, loaded only on PM pages): headings, lists, bold/italic
  via markdown shortcuts; paste or drop an image and it sits as a block
  **between the lines** (placeholder while uploading, swapped in place;
  Backspace on a selected image removes it); `Ctrl/⌘ + Enter` submits. Storage
  stays **markdown** in the existing columns; inline images are stored as
  `![name](flicks-file://<id>)` and resolved to a signed URL only when
  rendered — a signed URL never lands in the database. Every description /
  comment write passes `cleanMarkdown` (HTML stripped, `javascript:`/`data:`
  links dropped, images allowed only as `flicks-file://`, 50 000 / 10 000
  character caps). The read-only view, the comment thread ("Load earlier",
  keyset-paged, newest 50 first) and the composer all fall back to the
  previous plain UI when the flag is off.
- **Attach**: an **Attach** button and drag-and-drop on the issue
  description, on every comment box (members **and guests** of the project)
  and in the new-issue composer; multiple files, per-batch progress with
  Cancel, chips with type icon, name, size, download, and Remove (confirm;
  uploader or Owner / HR Admin). An attachment-only comment is allowed.
- **Server pipeline** (`POST pm/uploads`, `GET pm/issues/:id/files`,
  `GET pm/files/:id` → 302 to a 15-minute signed URL (`?dl=1` forces
  download), `POST pm/files/:id/delete`, `GET pm/uploads/config`): type
  decided from **magic bytes** (never the declared type) — jpg/png/webp/gif,
  pdf, zip, docx/xlsx/pptx (exact extensions), doc/xls, utf-8 txt/csv/md/json;
  svg, html, scripts and executables refused; **25 MB per file, 10 per
  upload, 2 GB per workspace** (`PM_ATTACHMENTS_TENANT_QUOTA_MB`), images
  re-encoded (rotation, metadata stripped, ≤ 4096 px, 50 MP bomb guard) with a
  480-px thumbnail; keys `tenants/<tenant>/pm-files/<uuid>/<name>`; uploads
  happen **outside** any transaction, rows are written after, orphans are
  cleaned on failure; files uploaded while composing are **drafts** bound to
  the issue / comment on save (only the ones still referenced) and pruned
  after 24 h (`pm-draft-files-prune`, daily 03:45 UTC). Reads are visibility
  checked (private teams / projects / guests), a deleted comment's files stop
  listing, the quota is taken under an advisory lock, and the throttle is per
  user. Migration 0063 widens `record_files` (already RLS-protected since 0033)
  with `comment` / `draft` object types, `kind`, image size, thumb key, sha256.
- **Switch**: FAM feature flag `pm_attachments`, **on by default**; off ⇒
  uploads refused, Attach / editor hidden, existing files stay readable.
- **Storage must be configured** in production (`R2_*` on Railway — already
  required by logos and avatars); without it the API returns 503 and the web
  hides Attach.
- **Accepted risks** (documented, not fixed): `.doc/.xls/.ppt` may carry
  macros; PDFs may carry JavaScript (served from the storage origin, no app
  cookies there); ZIPs are not inspected; CSV formula injection is not
  filtered; text files may contain `<script` mid-file (safe because the stored
  content type is `text/*`); no virus scanning; the workspace quota is shared
  with CRM files.

## 9. Items 7 & 8 — opening an issue, and getting back

### Root cause of the 2 s

The project page opened issues with a plain `<a href>` — a **full page
reload**: document + JavaScript, the app shell gated on `/me` (6–8 serialized
round trips), the sync engine restarted from IndexedDB and `/pm/users`, and
only then the issue detail (itself ~5 serialized round trips with an unbounded
comment list). Every other entry point already used client-side navigation.

### Fixes

1. Project rows are client-side links with **hover prefetch** (deferred 120 ms,
   cancelled on leave, at most two in flight).
2. The detail page paints from the local graph immediately and only spins when
   neither the store row nor the detail exists; "Issue not found" instead of an
   infinite spinner.
3. `detail()` batches its reads in parallel, returns the **newest 50 comments**
   (+ total, "Load earlier"), 20 history rows; a second tab holding the old
   IndexedDB version no longer parks a new tab on a spinner.

### Numbers (Chromium, production build + API on the build box, 30-issue project)

| Scenario | Before (plain `<a href>`) | After |
|---|---|---|
| Warm shell, click → title visible, median / p95 | 442 / 490 ms, **10/10 full reloads** | **80 / 91 ms**, 0 reloads |
| Same with 150 ms emulated network RTT | 560 / 579 ms, 10/10 reloads (cold 692 / 1 144 ms) | **222 / 233 ms**, 0 reloads (cold: title painted at ≈ 440 ms; the harness reports 822 ms because the editor's ≈ 470 KB of JavaScript keeps the main thread busy for ≈ 400 ms after the paint — see §12) |
| Fresh browser context (no cache), median / p95 | 453 / 554 ms, 10/10 reloads | **183 / 194 ms**, 0 reloads |

The build box hides the founder's real cost — the reload paid the Vercel →
Railway round trips serially — which is why production read as "more than
2 seconds". The mechanism (no document navigation on click) is what the
harness asserts (`perf-issue-open.mjs`).

### Back to where you came from

Every entry point (project, issues list, board, My issues, cycle, triage,
⌘K palette, sub-issue rows, relation chips, parent link) carries its origin
in `?from=`; Back, **Escape** and post-delete return there ("‹ Diwali launch",
"‹ My issues", "‹ ENG issues", "‹ ENG board"); the browser's own Back button
agrees (in-app Back uses history when the origin is the previous entry; hops
replace, so a sub-issue hop then Back returns to the original list). Only
internal `/pm/...` paths are accepted (`//evil`, `/settings`, encoded slashes
and `javascript:` fall back to the team's issues list).

## 10. Deploy

1. **Supabase**: run `docs/handoff/apply-0062-0063.sql` once (idempotent).
2. **Railway API** auto-deploys from `production`; two new crons start with it
   (`approval-escalation` every 15 min, `pm-draft-files-prune` daily 03:45 UTC).
   Optional env: `PM_ATTACHMENTS_TENANT_QUOTA_MB` (default 2048). `R2_*` must
   already be set (it is, for logos).
3. **Vercel web** deploys from `production`.
4. Expect the one-time escalation burst for requests already pending > 24 h
   (§4). Existing PM users get one cold re-download of their graph (IndexedDB
   v4).
5. FAM console: `pm_attachments` is on by default; to switch it off for
   everyone upsert the flag with *enabled globally* off (or list the tenants to
   keep on).

## 11. Verification

**Gate** (all green on the final tree):

| Check | Result |
|---|---|
| `pnpm -F api typecheck` | clean |
| `cd apps/api && pnpm build` | clean |
| `pnpm -F api test` (full Jest, real Postgres) | **73 suites, 986 tests passed** — new: `founder-roundL-a` (36), `founder-roundL-b` (39), `founder-roundL-c` (13), `founder-roundL-d` (18), `pm-attachments` (25); routed-model pins updated in `founder-roundI`, `founder-round13`, `founder-roundK` |
| `pnpm -F api lint:boundaries` | no dependency violations (339 modules) |
| `pnpm -F web typecheck` | clean |
| `pnpm -F web build` | clean |
| `bash scripts/diagnose-rls.sh` | `leak_with_bogus_context = 0`, 138 tenant tables, none without RLS |

Each implementer's work was reviewed by three independent read-only reviewers (correctness, tenant isolation, product/UX) before integration; every finding was fixed in the same round (the notable ones: finance no longer receives leave details on the roster, the owner dashboard's on-time % was double-counting late arrivals, the manager's manager kept "may act" after a request reached HR, the escalation sweep could be disabled for every tenant by one bad timezone string, an invisible parent issue's title leaked through `parent_issue`, private team keys leaked into history rows, deleted comments' files were still listed, a just-bound file could be pruned, autolinks were stripped by the sanitiser, and a `<https://…>`-style paste of a signed URL could have persisted).

**Live verification** (`scratchpad/verify-roundL.mjs`, Chromium against the
production web build + API + a local S3 stand-in for R2, screenshots
`rl-*.png`): all seven driven sections pass — (1) Asha on approved leave reads **On leave** on Arjun's Team view, his dashboard widget, the Direct-reports KPIs and the owner's Today tile; her Clock card shows the leave with a *Cancel leave* action and no Clock-in; punch-in over the API → 409; Yusuf's pending request reads *Leave pending* with Clock-in kept; finance sees "on leave" without the type; cancelling the leave puts her back to expected and clock-in works. (2) Asha's request goes to Arjun only (owner's Approvals tab empty, Team → Leave shows *With Arjun · escalates in 24h*, Bhavana 403, owner approves directly and Arjun is told); a request idle for 25 h escalates to Bhavana on the sweep (bell + Inbox row *Escalated to Bhavana · no action for 24h*, rerun no-op, still in Arjun's queue), another 25 h → Owner + HR Admin, and Arjun still approves; with Arjun on approved leave a new request goes straight to Bhavana (*manager on leave*); Nomad (no manager) submits a timesheet → *No manager · with HR* in the owner's Inbox → Rework with a required comment → resubmit → highlighted for Hema via `?period=` → approved with the approver stamped; the employee pages show *With your manager* / *With HR*. (3) Zara clocked in but not out: the dialog shows the banner and a disabled Submit for today; a forced future clock-out and a future date are refused over the API; a past day with out < in shows the inline error; 09:30–18:30 on a past day stores the shift-timezone instants. (4) No trial banner for the employee at 9 days; the owner sees it, dismisses it, and it stays dismissed after reload; none at 30 days; a redeemed coupon rings the bell for Owner + HR Admin only. (5) Relations added from the UI (blocks / blocked by / relates to a second team — chip shows the other team's key), the mirror on the other issue, removal, plain-English activity lines, IndexedDB v4 with the relations store, and the same UI in REST mode. (6) A real clipboard paste puts the PNG **between paragraph 1 and 2**, the saved body holds `flicks-file://` and never a signed URL; Attach pdf + docx + csv, SVG refused with a readable message, 26 MB → 413, HTML behind a `.png` name → 400, download 302 with `no-store`; a guest attaches a PDF on a comment and is refused outside their project; removal 403 for another member, allowed for the uploader and the owner; a new issue from the project page carries two attachments; the FAM kill switch hides the editor and Attach and refuses uploads (the flag cache means a flip takes effect within 30 s). (8) Back / Escape / delete return to the project or My issues with the right label, a sub-issue hop keeps the origin, and `?from=https://evil…`, `/settings`, `//evil…` are ignored.

Latency harness: `scratchpad/perf-issue-open.mjs` (after) and
`perf-issue-open-before.mjs` (baseline worktree at `90cf386`).

## 12. Defaults taken (tell the founder) and follow-ups

1. 24 h escalation is calendar hours (weekends/holidays included), the clock
   restarts at each level, the sweep runs every 15 minutes.
2. A manager on approved **full-day** leave is skipped immediately; half-day
   leave does not count.
3. Owner / HR Admin see every request on Team → Leave / Team → Timesheets (with
   a *With <manager>* chip) and may act there; Inbox → Approvals and the badge
   show only items routed to them — plus, as a safety net, requests with no
   valid manager at all (they would otherwise sit with nobody until the sweep).
4. Each escalation notifies the new reviewers only; an over-the-head decision
   notifies the routed manager.
5. Timesheets no longer need a reporting manager (they route to HR) and appear
   in Inbox → Approvals with Approve / Reject / Rework.
6. Pending leave shows as *Leave pending*; the person still counts as expected
   until approved.
7. Leave day-counting follows the person's shift working days; half-day leave
   marks the day *half day*; approval never demotes a worked day.
8. Regularization for **today** is refused until the day is clocked out (even
   with no punch at all); past days are unaffected; nothing in the future can
   be regularized.
9. Finance sees "on leave" on the roster but not the leave type or pending
   requests; only managers, Owner and HR Admin do.
10. Employees, managers and finance never see the trial banner; Owner / HR
    Admin see it in the last 10 days, once per trial period; T-10 reminders
    only for extended trials; T-3 / T-1 for everyone; the past-due banner stays.
11. *Duplicate of* closes the current issue into Duplicate (existing rule);
    *Blocked by* is stored as *blocks* on the other issue; the other issue's
    assignee gets an inbox notice; a private team's key is never shown to
    non-members.
12. Attachments: 25 MB / file, 10 / upload, 2 GB / workspace, the allow-list in
    §8, no virus scanning, on for everyone with a FAM kill switch; an
    attachment-only comment is allowed.
13. Back from a sub-issue or relation hop returns to the original list; a
    notification deep link (no origin) goes back to that team's issues list.

**Follow-ups (not in this round)**: the read-only description view still loads the TipTap/markdown bundle (≈ 470 KB) on the first open of an issue — the title paints first, but the main thread is busy for ≈ 400 ms afterwards; a static markdown renderer for read-only bodies would remove that; virus scanning and per-user quotas; hard
purge of soft-deleted attachments (drafts are purged, bound files are only
soft-deleted); a working-days option for the 24 h clock; exposing the sync
engine before its first bootstrap so a cold deep link paints from IndexedDB;
streaming the PM bootstrap; a lightbox for image attachments.
