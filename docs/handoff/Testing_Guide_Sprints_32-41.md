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

*(CP2 — after Sprint 35 · CP3 — after Sprint 37 · CP4 — after Sprint 39 ·
CP5/beta gate — after Sprint 41. Sections are appended as each pair lands.)*
