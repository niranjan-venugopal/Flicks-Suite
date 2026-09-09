# Round I — Closed deals, Mark-as-lost fix, manager team scope, leave-email actions, Team leave/timesheets

**Date:** 2026-09-09 · **Severity:** High (CRM "Lost" dead end; Team leave always empty) + Medium (manager over-exposure; wrong tile numbers)
**Reported by:** founder — five production items with screenshots, plus the standing
rule: *"Do not mess with the User details or the security … no leakage of data
at any point."*

## The five items, what was actually wrong, what changed

### 1. "Once a deal is closed, we are unable to track it"
Every deals read was open-only: the kanban filters `status='open'` and drops
the Won/Lost columns, there was no list endpoint at all, and the deal page never
showed the close date or the lost reason. A won or lost deal simply vanished.

- **API** `GET /crm/deals` (`DealsService.list`): `status = closed (default) |
  won | lost | open`, `owner_user_id`, `pipeline_id`, `q` (ILIKE-escaped),
  `page`/`limit ≤ 100`. Rows carry stage/owner/company names, `closed_at =
  coalesce(won_at, lost_at)`, `lost_reason_label` + `lost_reason_note`; ordered
  most-recently-closed first; `{ data, pagination, base_currency }`. Every join
  carries an explicit tenant predicate (Round F rule) — `lost_reasons` has no FK
  from `deals`, so the label join is tenant-scoped by hand.
- **Web** Deals page gains a **Closed** view tab (founder decision: one view with
  **All closed / 🏆 Won / Lost** chips) → `ClosedDealsTable`: Deal · Company ·
  Owner · Value · Stage · Closed on · Outcome · Reason (note as tooltip) ·
  **Reopen** (manager and above), pagination, per-outcome empty states, honours
  the page's owner filter / search / pipeline. The deal page shows a closed
  summary ("Lost on 9 Sept 2026 · Price · note") and Details gains *Closed on* /
  *Lost reason*. `GET /crm/deals/:id` now returns `lost_reason_label`.

### 2. "Lost in the CRM is not working"
Root cause: default lost reasons were seeded **once** by migration 0032 for the
tenants that existed then. Every tenant created afterwards had an empty
`lost_reasons` table; `DealsService.ensureDefaultPipeline` self-healed the
pipeline but not the reasons its docstring promised; there is no create UI.
`LostDialog` rendered zero pills, said "Pick a reason to continue" forever and
hard-disabled **Mark lost** (`disabled` + `pointerEvents:'none'`) — exactly the
screenshot. The API itself already accepted a note-only lost.

- **`crm/lost-reasons.seed.ts`** — `ensureDefaultLostReasons(tx, tenantId)`:
  fast-path read → per-tenant `pg_advisory_xact_lock` → re-check → insert the
  six (Price, Competitor, No budget, No response, Bad timing, Not a fit).
  Called from `GET /crm/lost-reasons` and from `ensureDefaultPipeline` (board /
  create), i.e. **existing tenants heal on their next board view**. Tenants
  with any live custom reason are never touched; 8 concurrent first hits seed
  exactly six (spec).
- **`moveStage`**: a supplied `lost_reason_id` must exist **in this tenant**
  (400 otherwise — house rule 2, the column has no FK); the note is trimmed and
  capped at 500; note-only lost stays accepted.
- **`LostDialog`** can never deadlock again: an **Other** pill is always
  offered; valid = a real reason **or** a non-empty note; loading skeletons;
  a failed reasons load shows an error line + Retry (and Other still works);
  the `pointerEvents:'none'` override is gone.

### 3. "My team says 7 direct reports, the Direct reports page shows 3"
The manager dashboard tile was the **tenant-wide headcount** from
`GET /dashboard/admin/overview` (only the label said "Direct reports"; the other
three tiles were tenant-wide too). The Direct reports page is the manager-scoped
`GET /employees/team/me`, which also forgot `deleted_at IS NULL` and status.
"Your team today" was a hard-coded placeholder.

- **Founder decision: managers see only their direct reports.**
  `getAdminOverview(…, { scope: 'org' | 'team' })` — for `team`, every
  people-derived number (headcount, joiners/exits, attendance today, 30-day
  trends, pending leave/regularization counts and rows) is narrowed with an
  `EXISTS (… reporting_manager_id = <me> AND deleted_at IS NULL)` predicate; a
  manager seat with **no employee row gets an empty dashboard, never the
  workspace**. The controller passes `team` for role `manager` (platform staff
  and owner/admin/finance stay `org`). Response carries `scope`.
- `listMyTeam` now excludes removed (round 21) and separated staff — the tile
  and the page count the same people.
- Web: the Direct reports tile **links to `/team`** ("View team →"); "Your team
  today" is the live manager-scoped roster from `GET /attendance/team/today`
  (name, first punch, location, state pill; capped at 8 + View all); the Direct
  reports page's *Pending approvals* KPI read an envelope as an array (always 0)
  — fixed.

### 4. "Approve/reject option in the leave email"
The `leave-requested` email had no link, unescaped strings, and wasn't
preference-gated; nothing preserved a deep link across sign-in (the app bounced
to a bare `/login` and login hard-redirected to `/dashboard`).

- Email now has **Approve** / **Reject** buttons + "Review in Flicks Suite",
  and the line *"Nothing changes until you confirm in the app."* The links are
  `${APP_URL}/team/leave?request=<id>[&action=approve|reject]` — they only
  **open** the request (a mail-security scanner following them changes
  nothing); every interpolated string is escaped; the send is gated on the
  reviewer's `leave_requested` email preference like the in-app ping already
  was. The in-app notification deep-links to the same request.
- **Web deep link**: `/team/leave?request=…&action=…` highlights + scrolls to
  the row and opens the **confirm dialog preset** to that decision (optional
  comment, one confirming click). Unknown / already-decided / out-of-scope id →
  toast + params cleared.
- **Sign-in keeps the destination**: both signed-out bounces (the app layout
  and the api client's 401 handler — `loginHref()` in `lib/api/client.ts`)
  send `/login?next=<path+query>`; login honours `next` after the code step
  **only for a same-origin relative path** (`^/(?![/\\])`) — never a
  protocol-relative or absolute URL. `/` and `/dashboard` carry nothing.

### 5. "Team leave shows 'nothing waiting for you'; same for timesheets"
`/team/leave` did `Array.isArray(data)` on a `{ data, pagination }` envelope →
**always empty**. Worse: `GET /leave/pending` and `POST /leave/:id/review`
weren't scoped to direct reports at all — any manager saw and could approve the
whole workspace. Timesheets listed only `submitted` periods with
`approver_id = me`; periods created before a manager was assigned keep
`approver_id NULL` and could never be reviewed by anyone.

- **Scoping (founder decision):** `LeaveService.resolveReviewer` → owner/admin
  (and platform staff) are **org-wide**; managers get their employee id and are
  scoped to `employees.reporting_manager_id = me` (**empty** if the seat has no
  employee row). Applied to `listPending`, `reviewLeave` (403 for a non-report),
  the new `listTeam`, and — for consistency — attendance
  `listPendingRegularizations` / `reviewRegularization`. The JWT role the guard
  already trusted is the hint; service-level callers fall back to the active
  membership role.
- **`GET /leave/team`** (`status pending|approved|rejected|cancelled|all`,
  `from`, `to`, pagination; joins leave type + approver; real total; `scope`).
  Team → Leave = **Pending** (approve/reject via the dialog) · **Upcoming**
  (approved, not yet ended) · **History** (last 90 days, status pill, reviewer +
  comment).
- **`GET /timesheet/team`** (any status, scoped by the org chart, approver
  resolved). Team → Timesheets = **Pending review** (submitted to me **plus** my
  reports' submitted periods with no approver stamped) · **All periods**
  (status, approver, "No approver set" hint). `reviewTimesheet` **self-heals**
  `approver_id` when it is NULL and the caller is the employee's reporting
  manager today; anyone else stays 403. `listPending` is unchanged.

## Security notes (the founder's standing rule)

- No new unauthenticated surface. `GET /crm/deals` sits behind the CRM grant
  guard; `/leave/team` and `/timesheet/team` behind `@Roles('manager')` **and**
  the reviewer scope. Guests are still refused by `GuestScopeGuard`.
- Managers **lost** visibility they should never have had (other teams'
  requests and review rights). Owner/HR admin are unchanged.
- Every new read carries explicit tenant predicates inside `withTenant`; the
  lost-reason id from a DTO is existence-checked in-tenant before it is stored.
- Email links never act; `next` is validated against open redirects; the email
  template escapes names, leave types, reasons and hrefs.

## Regression spec — `apps/api/src/__tests__/founder-roundI.spec.ts` (30 tests)

Lost-reason self-heal (six in order · 8 concurrent → exactly six · board heals
pipeline + reasons · custom reasons untouched · archived-only heals · no
cross-tenant rows) · `moveStage` (note-only accepted + trimmed · healed reason
resolves its label · foreign / random `lost_reason_id` → 400, deal stays open) ·
closed list (won + lost only, order, names, reason, `closed_at` · status / owner
/ `q` (`%`/`_` escaped) / pipeline filters · pagination + limit clamp · tenant
isolation · reopen removes + clears) · manager scope (`listMyTeam` = 3 active
reports; overview `scope=team` totalEmployees 3 == listMyTeam.total, buckets
hold only the reports' requests; owner org-wide = 9; no-employee manager seat →
0) · team-today roster · leave `listPending` scoping (with/without hint, owner,
empty seat) · `reviewLeave` 403 / ok / owner · `listTeam` statuses, window,
scope, total · regularization list + review scoping · timesheet `listTeam` +
unchanged `listPending` · approver self-heal vs 403 · email props carry the
three URLs + reason with `{ userId, event: 'leave_requested' }`, in-app link
`/team/leave?request=` · template escapes `<img>`/`&` and the hrefs, renders
both buttons · URL-less render still works. `leave-notify.spec.ts` updated for
the new in-app link. Full suite: **66 suites / 795 tests green**.

## Live verification (production build, headless Chromium)

Fresh tenant (no pipeline, no lost reasons; manager M with 3 active + 1
separated + 1 removed reports; 3 unrelated employees; owner O). As M: dashboard
tile **3**, roster lists exactly the 3, tile → `/team` with 3 rows · R1 and X1
apply for leave → Team → Leave shows R1's only · Team → Timesheets renders both
tabs · probes: employee `GET /leave/team` 403, M reviewing X1's request 403 (row
untouched), M's `/leave/team` `scope=team` without X1 · signed-out
`/team/leave?request=<id>&action=approve` → `/login?next=…` → sign-in → lands on
the request with the **Approve** dialog preset; Cancel leaves it pending;
confirm from the row → approved by M with comment; Upcoming lists it · as O: Mark
as lost shows the **6 healed reasons + Other**, Other needs a note, Price works,
detail shows date + reason · Closed view lists both with reasons, Won chip empty,
Lost chip 2, Reopen → back on the board.

## Operator notes

- **No migration, no env change.** `APP_URL` (already set for other emails) is
  the base for the leave deep links.
- Managers now see only their direct reports on the dashboard, Team leave,
  Team timesheets and the regularization queue. If a manager was relied on to
  approve across teams, give them the HR admin role or fix the reporting lines.
- Existing tenants without lost reasons heal on the next board view / Lost
  click — nothing to run.

## Follow-ups (not in this round)

- Magic-link sign-in (the link in the code email) still lands on `/dashboard`;
  only the code path preserves `next`.
- No lost-reasons management UI (CRM settings) — "Other + note" covers it.
- The Inbox approvals tab still calls the org-wide dashboard buckets for
  owner/admin; managers get the scoped buckets automatically.
