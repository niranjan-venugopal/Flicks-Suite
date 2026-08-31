# Round A (2026-08-31) — Pre-code-freeze bug clearance

The founder reported eight problems in one message and asked for every bug to
be cleared before the production code freeze, with the headline being: *"Whenever
we are creating something i guess we are deleting something else in the
project"* — confirmed as **watched data loss** in Project Management. This
round fixes the data loss and five more of the eight; the remaining two
(Linear-style issue composer, CRM import to Zoho/HubSpot parity) are features,
scoped as Round B.

## ⚠️ Before the next deploy — not optional

Migrations **0054–0057** must be applied in Supabase **before** this code (or
anything after round 21) is deployed. Round 21's code reads
`employees.deleted_at`; without 0057 the dashboard, HR reports, employee
directory and org chart **500**. The verified combined script
(`apply-0054-to-0057.sql`) was delivered in chat — it runs clean in one
transaction and is idempotent (safe to run twice).

Also still waiting on the founder to run `pm-diagnostic.sql` (delivered in
chat) and send back the output, to confirm which data-loss mechanism actually
bit their workspace.

## 1. The data loss (RA-0) — eleven mechanisms, all closed

The audit found this was not one bug but a **class**: the offline-sync client
could silently drift out of date, and several writes then rebuilt server state
from that stale local view — erasing rows the client simply couldn't see.
Everything found is fixed:

| Mechanism | Fix |
|---|---|
| **"Remove sample data" silently stripped real work.** Deleting the sample projects SET-NULLed real issues' project links and cascaded away their labels — inside Postgres, with no count, no confirm, no sync refs. | Removal now (a) **asks first**, with preflight counts of the user's own issues touching the pack; (b) explicitly detaches them (audited); (c) names every touched row in the sync event; (d) **restores the team's pre-sample cycle/triage settings** (loading a demo used to permanently reconfigure the workspace). |
| **Delta window cap silently skipped history.** When more than 5000 events were pending, the cursor jumped to the head and everything past the window was never delivered — the root enabler of every stale-client bug. | The cursor only advances over events the response actually covered; the next poll picks up exactly where it stopped. |
| **A rejected mutation replayed as "duplicate" (= success).** The offline queue's retry then skipped the rollback, leaving a phantom row that "vanished" on reload. | The ledger now replays a rejection **as a rejection**, so the client rolls back. |
| **Rejection rollback deleted the wrong rows.** `row === null` was read as "this was a create → remove the row", but eleven *update* ops also produce a null pre-image — a rejected update removed a real issue from screen. | Rollback is keyed on the **op**, not the pre-image shape. |
| **Flush advanced the cursor over other people's writes.** The flush response's `latest_seq` is a global head, but it only carries *your* rows — concurrent events in the window were skipped forever. | The client no longer trusts it; a delta pull advances the cursor honestly. |
| **Initiative lanes destroyed soft-deleted projects' placement.** The roadmap's full-set replace was built from the client's view, which can't see a just-deleted project — its lane row died in Postgres, so restore lost its placement. | The replace only touches **live** projects' lane rows; foreign ids still fail the write; the client no longer prunes lanes on tombstone. |
| **Project page swapped whole datasets by length.** Milestones/updates showed whichever array (REST vs live) was *longer* — rows on the shorter side vanished, and posting an update in sync mode "did nothing". | Merged **by id** (live wins per row, tombstones respected); posting updates/milestones also refreshes the REST copy. |
| **"Reset local data" dropped the offline queue** — and reset also fires *automatically* on a cursor-too-old response, discarding unflushed offline work with no warning. | The pending queue **survives reset** and flushes after re-bootstrap. |
| **PM import left live clients with stale label sets** which the next label edit's full replace then wrote back destructively. | The import's completion event now carries label + issue-label refs. |

`issues.create` / `setProject` project-liveness validation was audited and
found already correct on both the REST and sync doors — no change needed.

## 2. Headcounts always 0 (RA-1)

A Drizzle rendering bug: on a select with **no join**, columns inside raw SQL
templates render unqualified, so the counters compared an employees column to
itself (`"department_id" = "id"`) — valid SQL, always 0, silently, for six
weeks. All four counters (Departments, Locations, Designations, Working-hours
`assigned`) are rewritten as real `LEFT JOIN … GROUP BY` aggregations, so the
bug class cannot recur. Per the founder's decision they count **everyone on
the books** — invited, active, on leave, on notice — excluding only
separated/absconded and removed rows, so Settings now agrees with the
directory. The Departments "Headcount placed" tile heals automatically (it
sums the same field).

## 3. Reporting manager + shifts (RA-2)

- **Reporting manager** could only ever be set at invite time. It's now in
  Edit profile — settable *and clearable* — with a self-report guard
  (an employee can't be their own manager).
- **Shift assignment did not exist.** No code anywhere wrote
  `employee_shifts`; the Add-employee form's Shift dropdown dropped its value
  before the request, and the server would have rejected it anyway. Every
  employee silently ran the tenant default shift, so **lateness and worked
  hours were wrong for anyone hired onto another shift**. Now: the invite
  writes the mapping from the joining date; Edit profile has a Shift picker
  (change takes effect today, history preserved; "Workspace default" reverts);
  the employee detail API reports the shift the attendance engine actually
  uses; and the Working-hours `assigned` counts are honest.

## 4. Project guest invites (RA-3)

Not a bug — the route was admin-only by design, and module "Full access"
(a grant) can never satisfy a *role* check. Per the founder's decision the
gate is now **the project lead, plus manager and above**, enforced in the
service (a route decorator can't express a per-project lead exception) and
mirrored in the UI. Also fixed: the platform-admin (FAM) omission in the
card's visibility check, and the Guests card rendering in the wrong grid cell
— it now sits in the right-hand rail under Health updates, where its comment
always claimed it was.

## 5. CRM sidebar (RA-4)

Reports moved to the end of the CRM group. Safe under both feature-flag
states.

## 6. Popup close buttons (RA-5)

Three modal systems, five close-button geometries. Fixed at the source files
so 45+ dialogs correct at once:

- **Radix dialog** (25 consumers): the X was 8px inside the 24px gutter,
  ~14px off the title line, scrolled away on tall dialogs, and long titles ran
  underneath it. Now: pinned to the card (scroll moved to an inner region),
  on the 24px gutter, centred on the title line, with reserved title space.
- **proto Modal**: long unbreakable titles clipped the X through
  `overflow:hidden` (title wrapper now `flex:1; minWidth:0`), and the X sat
  below the title's centreline (nudged onto it).
- Hand-rolled overlays (MediaCropModal, CRM keymap) aligned to the same
  geometry.

## Verification

- `founder-roundA.spec.ts` — **25 tests** against real Postgres pinning every
  server-side fix: sample-pack collateral protection + settings restore +
  preflight counts + sync refs; rejected-replay; the 5000-event delta window
  (flooding a real outbox); initiative-lane preservation; all four headcount
  rules; invite-with-shift, reassign, revert, manager edit/clear/self-guard;
  guest invites for manager / lead / non-lead / guest-as-lead.
- Full gate: both typechecks, api build, `lint:boundaries`, full jest
  (**692 passed**; the two failures are the documented IST-midnight
  environmental flake in attendance specs untouched by this round — verified
  at 01:59 IST), web production build, `diagnose-rls.sh` with
  `leak_with_bogus_context = 0`.
- Live headless-Chromium pass over every fixed surface: the four Settings
  counters showing true numbers; manager+shift set through the real dialog
  and confirmed via the API; a **manager** inviting a guest with the card in
  the right rail; CRM sidebar order; Radix close geometry measured on-screen
  (21px gutter); the sample-data confirm and post-removal settings restore.

## Still open

- **Round B** (features, next): Linear-style issue composer (title +
  description + assignee/priority/labels at create, shared across all entry
  points) and CRM import to Zoho/HubSpot parity (templates, leads dedupe —
  currently a silent duplicator — presets, error reports).
- **Round 21 UI** (`R21-C`): offboard/delete employee buttons — the API
  shipped in round 21, the UI is still pending.
- Founder-side: migrations 0054–0057 (above), and the `pm-diagnostic.sql`
  output.
