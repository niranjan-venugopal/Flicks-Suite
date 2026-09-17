# Round M — Linear-style project overview, PM pages at app size, project priority, project updates with change blocks

**Date:** 2026-09-17 · **Type:** PM UI round (four founder asks after Round L went live) · **Migration:** `0064_pm_project_priority_updates.sql` (**run `docs/handoff/apply-0064.sql` in Supabase — see §10**)
**Reported by:** founder, verbatim in §1, with three Linear screenshots (project overview with the Insights rail; the update card with its grey "changes since" block). Standing rule: *"no leakage of data at any point."*

## 1. What the founder gets

| # | Ask | What changed |
|---|---|---|
| 1 | *"Lets have a graphical representation like the one in ClickUp or Linear when someone opens a project with the details. Do a small research on these two tools and suggest a plan."* | The project page gets Linear's right rail: an **Insights** card (choose what to count — issues or estimate points — and how to break it down — status, priority, assignee, milestone, label, optionally split by a second property — shown as a stacked bar chart with a table underneath) and a **Progress graph** (scope, started and done per week, with a dotted **predicted finish** and the target date marked). Research summary in §3, design in §5. |
| 2 | *"The Project listing page and the issue page looks a little smaller to audience. So align it in a way which doesnt misalign the screens."* | Every Projects page now uses the **same page frame as the rest of the app** (the dashboard's 1280 px column with the same margins), 13 px body text and taller rows, wider side rails; nothing shifts between pages and nothing scrolls sideways on a phone. Numbers in §4. |
| 3 | *"The milestone update on the project update should be shown in the way I attached because that looks good, also look for ClickUp for this and let me know how we can show."* | Project updates work like Linear's: a **Latest update** card at the top of the project with the health, the author, the text, and an automatic grey block of what changed since the previous update — `Priority: No priority → Urgent`, `Lead: Priya assigned`, `Target date: set to Apr 30th`, `Progress since May 18: ◆ Milestone 0% → 100% May 22`, `3 issues completed`. Older updates fold underneath. Project members and the lead get a bell. Milestones themselves read `◆ Name · Jul 13 · 11 issues · 100%` and fold open to notes. ClickUp has no equivalent block (§3), so we followed Linear. §7, §8. |
| 4 | (from the screenshots) Projects have a **priority** in Linear. | Projects get a priority (Urgent / High / Medium / Low / None) on the header, the create dialog, the listing (with sorting), the roadmap chip, and inside the update's change block. §6. |

Also in this round, because the screenshots showed them: the project **description** is now rendered on the project page with the Round L editor and attachments (it was saved but never shown), and the projects **listing** shows a progress ring with %, the milestone count and the priority (§9).

## 2. Founder decisions (asked and answered)

| Question | Decision |
|---|---|
| Which graphics | **Linear's rail** — Insights (measure × slice × segment, chart + table) and a Progress graph with predicted completion; milestones gain counts and %. |
| Sizing | **Match the rest of the app** — 1280 px max, the same margins, 13 px text, wider rails; nothing misaligned. |
| Project priority | **Add it**, same five levels as issues. |
| Who hears about an update | **Bell to project members and the lead** (not the author), no email. |

## 3. Research — how Linear and ClickUp do it, and what we took

**Linear.** A project page is: header with properties (status, priority, lead, members, dates), the latest update, the description, milestones with issue count and percent, then issues. The right rail has **Insights** — pick a *measure* (issue count or estimate), a *slice* (status, priority, assignee, label, …) and an optional *segment*; the result is a stacked bar chart plus a table ([Insights](https://linear.app/docs/insights)). The **project graph** draws scope, started and completed per week with a dotted predicted-completion line extrapolated from recent weekly velocity ([Project graph](https://linear.app/docs/project-graph)). **Project updates** carry a health and text plus an automatic block of changes since the previous update: issues completed, milestone progress, target-date / lead / team changes; members are notified and stale projects get a reminder ([Project progress reports](https://linear.app/changelog/2023-08-16-project-progress-reports), [Initiative and project updates](https://linear.app/docs/initiative-and-project-updates)).

**ClickUp.** Progress lives in dashboard cards — status pie, priority breakdown, workload per assignee, burn-up/burn-down/velocity ([Dashboards](https://help.clickup.com/hc/en-us/sections/6132309544215-Dashboards), [Sprint Burnup cards](https://help.clickup.com/hc/en-us/articles/13352825669527-Sprint-Burnup-cards)); lists roll up a progress %; **milestones** are a task type drawn as diamonds on the Gantt ([Milestones](https://help.clickup.com/hc/en-us/articles/6304458574615-Milestones)). ClickUp has **no automatic "since the last update" block** — its status updates are free text.

**What we did.** Followed Linear for the page, the rail and the update block (that is what the founder's screenshots show and what has the automatic change block). Borrowed ClickUp's progress-% rollup for the projects listing (a ring with the percentage on every row). Nothing else from ClickUp's dashboards was needed.

## 4. Item 2 — PM pages at the app's size

### Root cause

Every other page in the app renders inside the same frame: `padding 28px 32px 64px` on an outer wrapper and a `max-width: 1280px` column inside it (`apps/web/app/(app)/dashboard/page.tsx`). The Projects pages each owned their own frame, capped at 960–1120 px, with 12–12.5 px text and 34-px rows, and the two-column pages used fixed rails of 280–300 px. Side by side with the dashboard the content was up to 372 px narrower and everything on it a size smaller — that is the "looks smaller".

### The fix — one frame for every PM page

- `apps/web/components/pm/PmPage.tsx` — the shared frame, byte-for-byte the dashboard's wrapper pattern (outer padding, inner 1280 column; `wide` for the board so its columns may scroll). Applied to all 15 PM pages (projects list, project, issues list/board, issue, my issues, triage, cycle, roadmap, timeline, teams, team settings, workspace/import/GitHub/notification settings). Narrow settings forms keep their 640–880 px column *inside* the frame.
- `.pm-split` in `globals.css` — the two-column grid (`minmax(0,1fr)` + a rail of 320 px on the issue page, 360 px on the project page, 300 px on cycles, 260 px on triage) that collapses to one column at ≤ 960 px. Every column has `min-width: 0`, so long titles and tables ellipsis or scroll inside their card instead of widening the page.
- Density: issue title 22 px (was 20), rail labels 11.5 (10.5), rail inputs 30 px tall (26), list rows 38 px with 13 px titles (34 / 12), project rows 46 px / 13.5 px (44 / 12.5), rich text 13.5 px with 19/16/14.5 headings (12.5), board columns fluid `minmax(248px, 1fr)` (fixed 264), comment bodies 13 px. Nothing under 10.5 px except mono keys and avatar initials.
- Phone (390 px): the project header, listing rows and milestone rows wrap instead of overflowing; the board and the teams table scroll inside their own container, never the page.

### Numbers (Chromium, production build; content width / left gutter)

| Viewport | Dashboard | Projects list before → after | Issue page before → after | Project page before → after |
|---|---|---|---|---|
| 1440 | 1124 / 32 | 908 / 140 → **1124 / 32** | 1068 / 60 → **1124 / 32** | 928 / 130 → **1124 / 32** |
| 1920 | 1280 / 194 | 908 / 380 → **1280 / 194** | 1068 / 300 → **1280 / 194** | 928 / 370 → **1280 / 194** |
| 390 | 254 / 32 | overflowed sideways → **254 / 32, no horizontal scroll** | overflowed → **254 / 32** | overflowed → **254 / 32** |

(Live-run figures in §11.)

## 5. Item 1 — the project rail: Insights and the Progress graph

### Design

**Insights card** (`components/pm/project/ProjectInsightsCard.tsx`). Header "Insights · N issues"; three pickers — *Measure* (Issue count | Estimate points), *Slice* (Status | Priority | Assignee | Milestone | Label), *Segment* (None | Priority | Status | Assignee); a stacked bar chart (bars = slice values, stacks = segment values, integer axis) and a table underneath (rows = slice values, columns = segment values + Total). Colours: workflow-state category colours for status, coral/yellow/blue/grey for priority, a stable hashed palette for people, milestones and labels. Canceled issues never count. Your own choice of pickers is remembered in the browser per project; owners, HR admins and the project lead see **Set default for everyone**, which stores the configuration on the project (`pm_projects.insights_default`) for people who have not chosen their own.

**Progress graph** (`components/pm/project/ProjectProgressGraph.tsx`). One point per week (Monday to Sunday): *Scope* (issues created and not canceled by then), *Started*, *Done*. Lines in grey / yellow / green; a dotted green continuation to the **predicted finish** = the pace of the last four complete weeks applied to what is left (needs at least two complete weeks; disappears when nothing was finished recently; capped a year out); the target date is a thin marker, coral when the prediction is past it. Caption reads like "Predicted: Oct 8 · 3 weeks past target · 2 left · about 0.7 done a week", or "Not enough history to predict yet". A single week draws dots.

### Data — computed on the fly, no snapshot table

Every issue already carries `created_at / started_at / completed_at / canceled_at / estimate`, so both cards are derived from the issues themselves. In **sync mode** (the default) the cards read the local store and make **no request** — the project page stays as fast as Round L left it. In REST mode (kill switch) one call returns everything.

The maths is shared and pure (`packages/shared/src/pm/insights.ts`): `pivotInsights`, `buildProgressSeries`, `predictCompletion`. Two known simplifications, both hidden by the weekly grain: an issue moved into the project later counts from its creation week, and estimate edits are not historised. Exact daily history would need a `pm_project_snapshots` table (follow-up, §12).

### API

| Route | Notes |
|---|---|
| `GET pm/projects/:id/insights` | Same visibility rule and status codes as `GET pm/projects/:id/detail` (403 for a project you cannot see, unknown or foreign ids included). One issues ⋈ states query with explicit tenant/project predicates and `deleted_at IS NULL`; labels, milestones and the names of the *assignees that appear* (guest-aware, never the whole roster); workflow states limited to the ones the returned issues reference. **Cap: 5 000 most recent issues**, `truncated: true` and a caption when hit. Returns issues, lookups, the weekly series, the prediction, target date, the project default and `generated_at`. |
| `POST pm/projects/:id/insights-default` | Owner / admin / manager roles or the project lead (same bar as project delete); guests refused; `@IsIn` on the three enums; publishes `pm.project.updated` so the sync store receives the row. |

## 6. Item 4 — project priority

Same scale as issues: 0 none, 1 urgent, 2 high, 3 medium, 4 low. `pm_projects.priority smallint NOT NULL DEFAULT 0` with a `CHECK (0..4)`; the create and update DTOs validate it (`@IsInt @Min(0) @Max(4)`), and the service re-checks on the sync-executor door so an out-of-range value is a clean 400, never a raw database error. Surfaces: the header (native select with the priority glyph beside it), the New project dialog, the listing (glyph + tooltip, sort by priority), the roadmap bar chip, and the update block (`Priority: No priority → Urgent`). Cached project rows from before the deploy read as "No priority" until they next change (the detail call carries the real value).

## 7. Item 3 — project updates like Linear

### Root cause

Updates stored only `{health, body_md, author, created_at}`; the composer was a one-line input in the rail with a pre-wrap feed; posting one notified nobody. There was no record of the project's properties or milestone progress at the time of an update, so a "changes since" block was impossible.

### The model

- **Snapshot at write time.** `POST pm/projects/:id/updates` inserts the update and, in the same transaction, stores `snapshot` (jsonb): `{ at, progress {scope, started, done}, issues_done, props {status, priority, lead_user_id, start_date, target_date, health}, milestones [{ id, name, target_date, scope, done, pct, completed_at }] }`. Milestone numbers are **issue counts** (Linear's `11 issues · 100%`), canceled issues skipped, `completed_at` = the latest issue completion when the milestone is 100 %.
- **Diff at read time**, pure and shared (`packages/shared/src/pm/update-diff.ts`, `diffProjectUpdate(curr, prev, baseline)`): only the properties that changed, milestones whose % moved (or that completed), and `issues_done_delta`. The **first** update compares against the project as it was created (status planned, no priority, no lead, no dates, milestones at 0 %), so it reads exactly like the screenshot. Updates from before this round (no snapshot) simply show no block. The web recomputes the block from the snapshots it has (works identically for REST rows and live sync rows); the API also attaches `diff` per update in `detail` for API consumers.
- **Sync executor** returns the saved update row and the project row, so the optimistic card is replaced on acknowledgement (previously it waited for the next delta). A rejected post rolls the card and the health back.

### The card and the composer

`components/pm/project/ProjectUpdates.tsx` is the **Latest update** card at the top of the main column: health chip, author, relative time, the rendered body, the grey change block — `Priority: …`, `Lead: X assigned` / `A → B`, `Target date: set to Apr 30th` / `Apr 30th → May 12th`, `Start date: …`, `Status: Planned → In progress`, then `Progress since <Mon D, YYYY>:` with one `◆ Name 0% → 100% <date>` line per milestone and `N issues completed`. "Show N earlier updates" folds the rest. The header shows "No update in N days" for in-progress projects past the 7-day nudge rule. Empty state: **Write first project update**.

`ProjectUpdateComposer.tsx` is a dialog: three health buttons, the Round L rich editor (plain textarea when attachments are off), `Ctrl/⌘+Enter` posts, Escape closes, an inline error when the server refuses (empty or HTML-only body → "Update body is required"). Body limit 20 000 characters, cleaned like issue descriptions.

### Notifications

In-app type `pm.project.update_posted` — "*Priya posted an update on Launch — At risk*", link to the project, grouped per project (a second update bumps the same row). Recipients: project members ∪ lead, **minus the author**, and only people whose workspace membership is still **active**; collected inside the transaction, fanned out after commit, best-effort. Preference event `pm_project_update` (bell on, email off) with a "Project updates" row in PM → Settings → Notifications. Domain event `pm.project.update_posted` (ids + health only, same payload shape as the existing `health_updated`).

### Security hardening found in review

- Client-minted update ids (sync mode) are validated as UUIDs (400) and a collision returns a neutral 409 instead of the raw `duplicate key` driver text; a foreign row can never be overwritten (plain insert).
- Who may post: unchanged from before — any non-guest member who can see the project (same bar as editing the project). Guests are refused on both doors; a non-member of a private project gets 403 like `detail`. Pinned by tests.
- Every snapshot query carries tenant + project predicates; the states join now has an explicit tenant predicate too (defense in depth over RLS).

## 8. Milestones, description, attachments

**Milestones** (`ProjectMilestones.tsx`): `◆ Name ▾ · Jul 13 · 6 issues · 100%` with a thin green bar; the diamond turns green at 100 %; `▾` folds open the milestone's **notes** (`pm_project_milestones.description_md`, rich editor, ≤ 20 000 chars, cleaned); inline rename (Escape cancels cleanly), date change, delete with confirmation — on both transports. Milestone % uses **issue counts** and skips canceled issues; it is the same rule as the update snapshot and rounds to 99 % until every issue is done. Both milestone doors (REST DTO and sync executor) validate `target_date` and `position`, so malformed input is a clean 400.

**Description** (`ProjectDescription.tsx` over the Round L `IssueDescription`, headed "Description"): renders `description_md` under the latest update; editors get the rich editor with paste-an-image and Attach; saves through `project.update` (sync) or `PATCH pm/projects/:id`, then binds the pasted images with `POST pm/projects/:id/files/bind`. Project descriptions are now **cleaned on create and update** like issue descriptions (they were stored raw before). Attachments: object type `project` in the files pipeline — `GET pm/projects/:id/files`, `POST pm/projects/:id/files/bind { draft_ids ≤ 50 }`, uploads with `object_type=project`; visibility = the project's own readability (404 otherwise, guests read-only), re-binding an already-attached file is a no-op instead of an error, and **purging a deleted project or issue now removes its attachments** from storage (they used to sit against the quota forever).

## 9. Projects listing

One row component for both transports (`ProjectListRow.tsx`): logo · name (lock when private, deal chip) · health · priority glyph · **progress ring + %** (estimate-weighted like the header bar) · milestones `1/2` with a diamond · lead · target date · team chips · delete. Sort: Target date (default) | Priority | Progress | Name. The server's `GET pm/projects` returns `milestones: { [projectId]: { done, total } }` from one grouped query scoped to the projects the caller can see (a milestone counts as done only when it has issues and all are done); sync mode derives the same from the store. On a phone the row wraps onto two lines. The New project dialog forwards the priority.

## 10. Deploy

**Order matters this round:** the new API selects the 0064 columns by name, so it must not run against a database that lacks them. `main` and the session branch carry Round M; **`production` was deliberately held at the Round L commit** (`b2f8071`) until the migration is in.

1. **Supabase → SQL editor → paste `docs/handoff/apply-0064.sql` → Run** (idempotent; safe to re-run). Adds `pm_projects.priority` + check, `pm_projects.insights_default`, `pm_project_milestones.description_md`, `pm_project_updates.snapshot`. No new tables (existing RLS and grants apply), no backfill needed.
2. Then release: `git push origin main:production` — Railway deploys the API and Vercel deploys the web from `production`. No new environment variables.
3. Nothing to flip: the rail, the update card and the listing are on for everyone. The editor and attachments follow the existing `pm_attachments` flag (kill switch in the FAM console; textarea fallback everywhere when off). The local browser cache keeps its version; cached project rows learn their priority on their next change.

## 11. Verification

**Gate** (all green on the final tree): API typecheck · API build · full Jest suite against the real Postgres · `lint:boundaries` (no violations) · web typecheck · web production build · `diagnose-rls.sh` → `leak_with_bogus_context = 0`, 133 tenant tables probed, none without RLS.

**New specs** — `apps/api/src/__tests__/founder-roundM-b.spec.ts` (insights: week maths incl. Sunday boundaries, prediction null/steady, canceled exclusion, points measure, label multi-count, visibility parity with `detail` for foreign/unknown/private, set-default authority, the 5 000 cap, guest name scoping, DTO validation), `founder-roundM-c.spec.ts` (priority validation on both doors, first-update baseline block, second-update delta, reopened issue, milestone created after the previous update, executor replay = duplicate, bell fan-out incl. author exclusion, grouping, preference off, active-membership filter, cross-tenant / guest / private rules, client-minted id 400/409, event payload), `founder-roundM-d.spec.ts` (milestone notes round-trip and `''`→NULL, count-based rule vs snapshot, listing rollup with canceled-only milestone, project files visibility 404s, foreign draft ids ignored, re-bind idempotent, typed milestone validation, DTO pipe). Re-run green: `pm-sync`, `pm-attachments`, `pm-perf`, `founder-roundL-d`, `founder-round13`.

**Live** — `scratchpad/verify-roundM.mjs` (Chromium, production build + API + local S3 stand-in; seeds a tenant with a lead, three members, a project of 40 backdated issues over three weeks, two milestones): see the results table below (filled from the run) and screenshots `rm-*.png` per section and viewport.

| Section | Result |
|---|---|
| 1 · Sizing (6 pages × 3 viewports) | **PASS** — PM content column 1124 / gutter 32 at 1440, 1280 / 194 at 1920, 254 / 32 at 390 on every PM page, identical to the dashboard; no horizontal overflow inside `main` at 390 on any PM page (the dashboard itself still overflows by 120 px at 390 — pre-existing, §12); issue rows 38 px, project rows 46 px (two-line 95 px on the phone), rich text 13.5 px; the board keeps the dashboard's 32 px padding with its cap lifted. |
| 2 · Rail | **PASS** — Insights chart + table render from the store with no request; switching Slice to Assignee re-pivots the table; *Set default for everyone* as the owner is seen by a member in a fresh session; Progress graph with 4 weekly points and a predicted date. |
| 3 · Milestones | **PASS** — rows read `6 issues · 100%` / `6 issues · 33%`; notes added, folded, persisted across reload. |
| 4 · Updates | **PASS** — first update's block: `Status: Planned → In progress · Priority: No priority → Urgent · Lead: Owner assigned · Target date: set to Oct 15th · Start date: set to Aug 27th · Progress since Sep 18, 2026: ◆ Alpha ready 0% → 100% Sep 8, 2026 · ◆ Beta ready 0% → 33% · 15 issues completed`; second update after a lead change shows only `Lead: Owner → Priya`; the three members each have exactly one grouped `pm.project.update_posted` bell row, the author none. |
| 5 · Description | **PASS** — real clipboard paste of a PNG lands in the text and uploads (signed URL in the editor, `flicks-file://` in the stored markdown), a PDF attaches, the rendered description shows the image and one chip after reload, `GET pm/projects/:id/files` returns both. |
| 6 · Listing | **PASS** — ring `42%`, priority glyph, milestones `1/2`, sort by priority puts the urgent project first; no overflow at 390. |
| Total | **126 PASS / 0 FAIL** (`verify-roundM-final.log`) |

**Issue-open latency** (`perf-issue-open.mjs`, Round L harness, 30-issue project, same box): first click 237 ms; warm opens median **105 ms** (p95 156, Round L: 80); cold median **199 ms** (p95 272); **0 hard navigations**; targets 300 / 800 ms — the rail cards render synchronously from the store and add no request.

**Jest note:** the full suite ran at 01:10 IST and the one failure was `attendance-selfheal.spec.ts` (clock-in → presence "in_office" read "offline"), the spec CLAUDE.md documents as flaking near IST midnight; Round M touched no attendance or presence code (`git diff` on those paths is empty).

Screenshots for the walkthrough: `rm-1-*-{1440,1920,390}.png` (sizing, all PM pages + dashboard), `rm-2-project-1440.png`, `rm-2-rail-1440.png`, `rm-2-rail-member-1440.png`, `rm-3-milestones-1440.png`, `rm-3-milestone-editor-1440.png`, `rm-4-updates-{1440,390}.png`, `rm-5-description-1440.png`, `rm-6-projects-{1440,390}.png`, `rm-6-projects-sorted-1440.png`.

## 12. Defaults taken (tell the founder) and follow-ups

**Defaults**

1. Insights opens as *Issue count × Status × Priority*; anyone can change it for themselves (remembered in their browser); owners, HR admins, managers and the project lead can set the default for everyone.
2. The Progress graph is weekly; the predicted finish needs two complete weeks of history and disappears when nothing was finished in the last four weeks.
3. Canceled issues never count — not in progress, not in milestones, not in the graph.
4. Project priority defaults to "No priority" and uses the same five levels as issues.
5. Posting an update rings the bell for project members and the lead only; no email; the author is not notified; people who left the workspace are not notified.
6. The update body uses the same editor as issues; older updates fold under the latest one.
7. The "changes since" block on the first update compares against the project as created.
8. Milestone percentages count issues (like Linear); the project-level bar and the listing ring stay estimate-weighted (as before).
9. Anyone who can edit a project can post an update (unchanged rule); guests cannot.
10. The Insights response caps at the 5 000 most recent issues of a project and says so.

**Follow-ups**

- Daily project snapshots (`pm_project_snapshots`, like cycles) for exact history in the Progress graph.
- A Resources / links row on the project (attachments under the description cover documents today).
- Reactions and comments on updates; an email or Slack digest of updates.
- Former members appear as "Unknown member" in Insights and the store; a names fallback for departed staff (both modes).
- `detail` returns the latest 30 updates; the oldest one's block is computed against the baseline rather than the real 31st update.
- Pre-existing, outside this round: the notification **socket** pushes by user id without a tenant filter (the REST inbox is tenant-scoped) — scope the live push to the connected session's tenant; the sync executor and the HTTP exception filter echo a non-HTTP error's raw message; project soft-delete does not soft-delete its files (reads fail closed; quota only).
- The "sync / rest" transport pills on PM pages are developer words in the UI (cross-page convention; decide once).
- The **dashboard** (not a PM page) still overflows `main` by ~120 px at 390 px, and the app shell keeps the sidebar at phone widths, leaving 318 px for content; a phone pass on the shell is a separate round.
- Insights table columns beyond the 360 px rail scroll inside the card; "Slice / Segment" are Linear's words — "Group by / Split by" would be plainer if the founder prefers.
