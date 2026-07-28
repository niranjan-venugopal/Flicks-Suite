# Testing Guide — PRD v6 Projects Module (Sprints 32–41)

Manual test scripts per user checkpoint (one per 2 sprints). Run each script
and confirm before the next sprint pair starts. Local setup: Postgres + Redis
running, `apps/api/.env` populated, `pnpm dev` in `apps/api` and `apps/web`,
signed in as the demo owner.

---

## CHECKPOINT 1 — the Sync Engine (after Sprints 32–33)

**What shipped:** the Flicks Sync Engine end-to-end (migrations 0039–0041;
bootstrap/delta/mutate + `/sync` socket + IndexedDB local store + offline
queue + undo + kill-switch), the seeded PM workspace, and the P2 Issue List
with quick-create (P4) on the engine. Spike-gate numbers:
`docs/fse-spike-gate.md` (optimistic 1.6ms, propagation ~420ms).

### 1. Real-time sync between two windows
1. Open **Projects → Issues** (`/pm/issues`) in two browser windows side by side.
2. In window A press `C`, type a title, Enter. The row appears **instantly**
   in A (blue pending dot fades once the server confirms) and in window B in
   **under a second** — no refresh.
3. In A: click a row's state glyph → pick "In Progress". B regroups the row
   under In Progress within a second.

### 2. Keyboard-first flow (§2.1 doctrine)
1. `C` → composer opens (no stray "c" in the input). Toggle **Create more**,
   create 2–3 issues without the composer closing, `Esc` to close.
2. `J`/`K` (or ↑/↓) moves the focus ring; with a row focused press `2` →
   priority High (bars glyph); `S` → state menu; `A` → assignee menu;
   `I` → assigns you.
3. `⌘Z` (Ctrl+Z on Windows) undoes your last change — e.g. the priority
   flips back. `⌘⇧Z` redoes it.

### 3. Offline queue
1. DevTools → Network → **Offline**. The header shows "OFFLINE — changes
   queue".
2. Create 2 issues and change a state — all apply instantly, pending counter
   climbs.
3. Go back **Online** → pending drains to 0, the new rows get real numbers
   (DC-n), and the second window receives them once each (no duplicates).

### 4. Warm start from the local cache
1. Reload the page — the list paints from IndexedDB (fast), then catches up
   via delta (watch `cursor` in the header advance).
2. Click **Reset local data** → cache wipes and the workspace re-bootstraps
   in under 5 seconds.

### 5. Kill-switch (zero-deploy fallback)
1. In the DB (or FAM → Features once surfaced): insert/enable a
   `feature_flags` row `pm_sync_engine` with `is_enabled_globally=false`,
   `enabled_tenant_ids='{}'`, `rollout_percentage=0`.
2. Wait ~30s (server flag cache) and open `/pm/issues` in a fresh session →
   the SAME list renders with a yellow **rest** pill (plain REST +
   react-query; network tab shows `/pm/issues` list calls, no `/pm/sync/*`).
3. Delete the flag row → fresh session returns to the **sync** pill.

### 6. Isolation (automated, verify green)
`cd apps/api && pnpm jest pm-sync` → 15 tests: private-team rows never in a
non-member's bootstrap/delta, membership revoke tombstones the team, auditor
mutations rejected, 20-mutation replay exactly-once, two-client convergence,
horizon re-bootstrap.

**Confirm CP1 to start Sprints 34–35 (board, filters, saved views, bulk edit,
issue detail, ⌘K palette, search).**

---

## CHECKPOINT 2 — after Sprints 34–35 (the Linear core)

**What shipped:** Sprint 34 — Board view (native drag with fractional ranks,
per-column quick-add, point sums), full filter model (priority / assignee /
closed), group-by state|priority|assignee, saved views + favorites (migration
0044), bulk bar (`X`/`⇧X` range select, 0–4/S/A/I as one batch, 500 cap).
Sprint 35 — Issue detail page (P7: description, sub-issues, relations,
comments with @mention→subscribe, activity, properties rail), `⌘K` command
palette (local graph first + server FTS/trigram merged), `?` keymap overlay,
G-then navigation, My Issues (P6), `/pm/search` (key-prefix + full-text +
partial-word).

### 1. Board + filters + saved views (Sprint 34)
1. `/pm/issues` → click **Board**. Columns = workflow states with point
   sums. Drag a card to another column → state changes (both windows if you
   kept two open). `+` at a column top quick-creates directly in that state.
2. Back to **List** → **Filters**: pick priority Urgent+High, assignee
   **Me**, toggle **Show closed**. Change **Group by** to priority.
3. Click **Save view**, name it, star it → it appears as a tab and under
   favorites. Switch tabs and confirm the filter set swaps with it.
4. Bulk: `J` to focus, `X` select, `J J` down, `⇧X` range-select, then `2`
   → all selected go High in ONE batch. `Esc` clears.

### 2. Issue detail (P7)
1. In the list, focus a row (`J`) and press **Enter** (or double-click) →
   the detail page opens: `TEAM-N` breadcrumb, title, description editor
   (`⌘↵` saves), Activity (history + comments), properties rail.
2. Comment `@`-mentioning a teammate → they appear under **Subscribers**
   (mention = auto-subscribe).
3. With the page open press `2` → priority High in the rail instantly.
   `Esc` goes back to the list.
4. Sub-issues: create one from the detail page → parent shows a completion
   fraction (0/1). Relations: add **Blocks** — the other issue shows the
   inverse ("Blocked by") chip. Mark one **duplicate of** another → it
   auto-moves to the Duplicate state (canceled category).

### 3. Palette + keyboard navigation (§10)
1. `⌘K` (or `/`) anywhere in PM → palette. Type an issue key like `DC-3` →
   direct hit. Type a **partial word** ("auth") → local matches instantly,
   server FTS/trigram results merge in a beat later. Enter opens it.
2. `?` → the full keymap overlay (every binding in one place). `Esc`
   dismisses it without touching the page underneath.
3. `G` then `I` → My Issues. `G` then `B` → Issues list.

### 4. My Issues (P6)
1. `/pm/my` (or `G I`): **Assigned / Created / Subscribed** tabs, straight
   from the local graph. The issues you just commented on appear under
   Subscribed. `J`/`K` + `Enter` opens; the footer shows the key hints.

### 5. REST fallback (kill-switch honesty)
1. Repeat the CP1 kill-switch drill (flag `pm_sync_engine` off, fresh
   session): the list still renders (REST mode), Enter/double-click still
   opens the detail page, and detail edits (state/priority/comment) work
   via plain REST. My Issues shows its "needs the sync engine" notice —
   the list view carries the load in fallback mode.

### 6. Automated (verify green)
`cd apps/api && pnpm jest pm-sync` → 24 tests, incl. Sprint 35's: search
key-prefix/FTS/trigram + private-team exclusion on every path, comment
mention→subscribe (bogus ids dropped), duplicate-close → Duplicate state +
`canceled_at`, detail bundle shape + outsider rejection.

**Confirm CP2 to start Sprints 36–37 (projects, milestones, initiatives,
timeline/roadmap, cycles + Autopilot, triage).**

---

## CHECKPOINT 3 — after Sprints 36–37 (the planning layer)

**What shipped:** Sprint 36 — projects with milestones, health updates and
computed progress (migration 0042), initiatives, timeline (drag-to-re-date
bars, milestone diamonds), roadmap (initiative lanes), weekly staleness
nudger. Sprint 37 — cycles with the hourly tz-aware scheduler + Autopilot
rollover + daily snapshots (migration 0043), cycle page with the Cycle
Review digest + burn columns + velocity/creep, the P8 triage conveyor,
Shift+T, snooze — plus the Appendix B sample pack so every surface has
something to look at before you create real data.

### 0. Load the sample pack (do this first)
Projects (`G then P`) → **Load sample data**. One click seeds: 24 issues
across states/priorities, 2 projects with milestones + health updates,
2 initiatives, a COMPLETED cycle with a Cycle Review, an ACTIVE cycle
mid-flight with daily snapshots, and 3 issues waiting in Triage — all
suffixed "(sample)" and removable with the same button (removal deletes
EXACTLY the seeded rows, never your own).

### 1. Projects (§6)
1. **Projects** (sidebar or `G then P`) → **New project**: name, lead,
   target date, pick your team → lands on the project page.
2. Add 2–3 **milestones** (+ Add · name + date · ⏎). A milestone past its
   date shows amber.
3. Post a **health update** (pick "At risk", write a line, Post update) →
   the chip flips project-wide (list, page, timeline color). The rail notes
   the staleness nudger: leads get an Inbox nudge after 7 quiet days.
4. Open an issue → properties rail → **Project** → pick your project. Back
   on the project page: the issue is listed and progress counts it
   (estimate points; unestimated issues weigh 1).

### 2. Timeline + roadmap (§9.3)
1. **Timeline** → your project renders as a health-colored bar from start
   to target with milestone diamonds; the blue line is today. Drag either
   END of the bar → dates change (check the project page after).
2. Toggle **By team / By initiative** and Month/Quarter zoom.
3. **Roadmap** → **New initiative** (Manager+), then "+ Add projects to
   this lane" → your project's bar appears inside the lane.

### 3. Cycles + Autopilot (§7)
1. **Cycle** (or `G then C`) → if cycles are off, **Enable cycles** — the
   hourly scheduler creates upcoming cycles at your team-timezone midnight
   boundary (verified by fake-clock tests down to the Berlin-midnight case).
2. With an active cycle: header shows progress %, **velocity** (3-cycle
   rolling), **creep +N%** (scope added after start); the burn columns are
   the daily snapshots; previous cycles list on the right.
3. Move an issue to **In Progress** while it's outside any cycle → it
   auto-joins the active cycle (§7.1 auto-add) — watch "In this cycle"
   count up.
4. Autopilot itself is time-driven; the fake-clock suite proves: urgent/
   high roll to the next cycle, medium/low return to backlog with ONE
   Cycle Review digest to the lead + assignees, cooldown blocks the next
   activation, and the cooldown banner renders.

### 4. Triage (§8)
1. On the issues list, focus a row (`J`) and press **⇧T** → sent to Triage.
2. **Triage** (or `G then T`): the conveyor is keyboard-only — `↑↓` move,
   `0–4` priority, `A` assignee, **⇧↵ Accept** (→ default backlog state,
   stamps triaged_at), **⇧⌫ Decline** (reason optional → Canceled),
   `Z` snooze 1d/3d/1w (hides until due), `M` merge-as-duplicate (type the
   issue key, e.g. DC-3 — links + moves to Duplicate).
3. Entry rules beyond ⇧T: issues created by non-team-members in a public
   team land in Triage automatically (tested), as will API-intake issues.

### 5. Automated (verify green)
`cd apps/api && pnpm jest pm-sync` → 36 tests, incl. Sprint 37's fake-clock
block: cycle auto-creation at Berlin-midnight boundaries, activation,
Autopilot P1-rolls/P3-returns with an exactly-once digest, cooldown
blocking, hand-computed velocity, and the full triage lifecycle.

**Confirm CP3 to start Sprints 38–39 (Inbox + digesting + notification
matrix + timesheet linkage, then the GitHub integration).**

---

## CHECKPOINT 4 — after Sprints 38–39 (the connected workflow)

**What shipped:** Sprint 38 — the Inbox (P9: one collapsing row per issue,
E archive / Z snooze, first-run coach), notification fan-out for assignment/
mention/comment/final-state, the 5-min unread-only urgent emails + hourly/
daily digest folds, the P10 notification matrix (Projects → Settings →
Notifications), and timesheet↔project/task linkage (migration 0045).
Sprint 39 — the GitHub App integration (migration 0046): signed webhooks,
TEAM-123 autolinks from branches/PRs/commits, per-team status automations,
magic words, git chips on issues, branch-name generator, and the P16 settings
screen. Run `bash scripts/setup-demo.sh` first — it seeds sample inbox rows,
a demo GitHub installation, 2 repo mappings, and git chips on 2 sample issues.

### 0. Setup
`git pull && pnpm sync:supabase` (applies 0045 + 0046), re-run
`bash scripts/setup-demo.sh`, hard-refresh.

### 1. Inbox (P9, §11)
1. **Projects → Inbox** (or `G` then `N`): the seeded rows show — a mention
   with a **+2 more** collapse pill, an assignment, a purple cycle-review row.
   The sidebar Inbox item carries the unread count badge.
2. First visit shows the 3-step **"How Inbox works"** coach — Skip/Next, and
   "don't show again" sticks.
3. `J`/`K` move the focus; **E** archives (row leaves), **Z** opens the
   snooze menu (1d/3d/1w) — a snoozed row drops into the dimmed **Snoozed**
   section with its due date. Enter (or click) opens the issue and marks read.
4. Have a teammate (or second browser as manager@demo.co) assign you an
   issue and comment on it twice: ONE inbox row for that issue, bumping with
   a climbing "+N more" — never three rows.

### 2. Notification matrix + email digests (P10)
1. **Projects → Settings → Notifications**: the 7-row matrix (In-app/Email
   toggles), the digest frequency segmented control (5-min urgent only /
   Hourly / Daily), and the DND note. Toggle "Comment on subscribed" off →
   new comments stop landing in your inbox (the automated suite proves the
   suppression + the 5-min unread-only email + exactly-once fold).

### 3. Timesheet ↔ Projects (§15.3)
1. **Time → Timesheets**: each category row now has a project picker and,
   once a project is chosen, a task picker (issues of that project). Save —
   reload keeps the linkage. Rows are now per (category, project, task).

### 4. GitHub (§12, P16)
1. **Projects → Settings** (GitHub tab): the demo seed shows the installed
   state — status card (`github.com/specflicks`, Healthy pill), 2 mapped
   repos with team badges + autolink chips, the status-automation card (4
   flow tiles + magic words / personal automation / bot comment), branch
   format with live preview, and webhook health.
2. Open the sample issue with git chips (issues list → the "(sample)" issue
   with the SSO title): the **Git** section shows the branch + PR chips
   (green open / purple merged); the header has **Branch ⌘⇧B** — press it
   and paste somewhere: `{you}/{team}-{n}-{slug}`. With "Personal
   automation" on, copying also assigns you + moves the issue to started.
3. **Live App test (only if you registered the GitHub App and set
   GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY / GITHUB_WEBHOOK_SECRET, webhook
   URL `https://<your-api>/api/v1/webhooks/github`):** install the App on a
   repo, map it to your team, then create a branch named after a real issue
   key (e.g. `you/di-12-test`) → the issue moves to In Progress with a
   branch chip; open a PR titled "Fixes DI-12" → In Review; merge → Done +
   an inbox ping. Without the App, the automated fixture chain is the proof.

### 5. Automated (verify green)
`cd apps/api && pnpm jest pm-github pm-sync` → 55 tests incl. Sprint 39's:
bad-signature 401, delivery-id replay no-op, the full fixture chain
Todo→In Progress→In Review→Done with history + inbox, close-unmerged revert,
magic-words toggle, commit chips, and the cross-tenant installation
isolation case.

**Confirm CP4 to start Sprints 40–41 (importers, templates, settings
suites, deal→project, public API scopes — then the beta gate).**

---

## CHECKPOINT 5 — after Sprints 40–41 (THE BETA GATE)

**What shipped:** Sprint 40 — Linear/Jira/CSV importers (P17 wizard,
external-id dedupe, 24h undo), issue templates (C prefills the team
default), deal→project with suite echoes, public API pm:read/pm:write,
Recently deleted + purge job, P18 workspace settings (migration 0047).
Sprint 41 — P15 Teams suite (index + tabbed settings: General/Members/
Workflow states/Labels/Templates/Cycles/Estimates/Danger zone), the
10k-issue perf seeder with CI budget assertions, and
`docs/pm-beta-gate.md` — the sign-off checklist.

### 1. Teams (P15)
1. **Projects → Teams**: the index lists every team (key, member avatars,
   cycles, estimate scale, visibility). **Join** a public team from the row.
   **Create team** (Owner/Admin/Manager) — name auto-derives the key.
2. Click a team → the tabbed settings screen. Walk the tabs:
   - **Workflow states** (default tab): rename via the pencil, re-color via
     the swatches, "+ Add state" inside a category — the glyph preview is
     live and the issue lists pick the change up on the next delta.
   - **Members**: add from the workspace directory, remove, ★ Lead marker.
   - **Labels**: team-scoped labels (workspace labels live in Workspace).
   - **Templates**: create one, set it default, give it a description +
     priority → press `C` on the issues list: the new issue carries them.
   - **Cycles**: the same config as the Cycle page header, per prototype.
   - **Estimates**: switch the scale (radio list with previews).
   - **General**: rename, timezone, color, and the **Private team** toggle —
     the confirm modal spells out the audit rules; flipping it hides the
     team from non-members on their next delta (tombstones).
   - **Danger zone**: delete (Owner/Admin) — issues restorable 30 days.

### 2. Import a REAL export (P17)
Repeat the CP4 §import walk with your actual Linear or Jira CSV export.
Spot-check 10 issues: states landed in sensible categories, priorities map,
epics became projects, re-running the same file updates instead of
duplicating.

### 3. Perf + drills (§21/§22)
1. `cd apps/api && pnpm jest pm-perf` → the 10k-issue reference workspace
   asserts bootstrap < 2s, delta < 150ms P95, search < 200ms P95.
2. Kill-switch drill: FAM → flag `pm_sync_engine` off → fresh session shows
   the same lists on REST; on again → sync pill returns.
3. Projects → Settings → Workspace → **Reset local data** → re-bootstrap
   in seconds, nothing lost.

### 4. Phone pass (P19)
Open `/pm/issues`, an issue, and `/pm/inbox` at 390px width (device
toolbar): rows stay readable, nothing overflows horizontally.

### 5. Sign-off
Work through `docs/pm-beta-gate.md` top to bottom. Confirming CP5 = the
beta gate is open and the 2-week dogfood clock starts.

---

*(End of the PRD v6 program guide — CP1…CP5.)*
