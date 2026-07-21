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

*(CP3 — after Sprint 37 · CP4 — after Sprint 39 · CP5/beta gate — after
Sprint 41. Sections are appended as each pair lands.)*
