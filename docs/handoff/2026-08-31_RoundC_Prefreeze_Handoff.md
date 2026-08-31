# Round C — final pre-freeze fixes (2026-08-31)

Seven founder-reported items closed before the code freeze: avatars reaching
Project management, projects editable after creation, the invoice Items
picker, the combined one-file CRM import (with Excel), issue saves that stick
without a reload, a platform-wide CTA-latency pass, and issue deletion from
the UI.

**One migration: `0058_import_combined_all.sql` — must be applied in Supabase
before the next deploy** (it widens the `import_batches.object_type` CHECK to
accept `'all'`; without it every combined import 500s). Migrations
**0054–0057 from earlier rounds are still pending too** — apply all five.

---

## RC-1 · Avatars propagate into Project management

**Symptom** (founder screenshot): the project lead's photo showed the initials
placeholder everywhere in PM.

**Mechanism**: avatars are stored as an R2 `avatar_key` and must be signed to
a URL. Only the REST `GET /pm/users` door signed — but production runs the
sync engine, whose bootstrap ships the user roster from
`PmTeamsService.usersLite` **verbatim and unsigned** (`users.avatar_url` is
the always-null legacy column). And four `PmAv` call sites never passed `src`
at all.

**Fix**: `usersLite` signs in the service (`MediaService.servedUrl`, 64px
variant, outside the tenant transaction) and drops the raw key from the
payload; the controller became a passthrough. The guests listing
(`PmGuestsService.list`) signs the same way. Web passes `src` at the four
bare sites: project page lead chip, health-update authors, projects-list lead
chip (both sync and REST branches — REST rows also gained the lead name they
never showed), and the guests card.

## RC-2 · Project name + icon editable after creation

Backend and sync already accepted `{name, icon}` — only the header UI was
missing. The name is now click-to-edit (commit on blur/Enter, Escape cancels,
blank names rejected client- and server-side) and the icon is a native
`<select>` seeded with the current icon prepended when it's not in the stock
list. `PROJECT_ICONS` exported from `components/pm/projects.tsx`.

## RC-3 · Invoice lines auto-populate from the Items catalogue

The catalogue was complete end-to-end (schema, `ItemsService.list` with
server-side `q` search, CRUD page) and invoice lines already persisted
`item_id` — the editor just never used any of it. The Description cell is now
a search-as-you-type picker (same pattern as the HSN/SAC picker in
`ItemModal`): type 2+ characters → server-side search → pick → autofills
`item_id`, name, description, rate, HSN/SAC, unit, cess, and the tax % by the
editor's currency branch (GST domestic / VAT foreign). Free text still works
exactly as before. Picked items finally get real `usage_count` /
`last_used_at` stats (columns existed since C-series, never written).

## RC-4 · One combined import file + Excel

**"When the client has their own excel with everything in it."**

- **`'all'` import mode** (`One file (everything)`, now the wizard default):
  a **Type column** decides Contact vs Lead per row; blank Type falls back to
  the wizard's Step-3 toggle (founder decision: Type column + toggle);
  unrecognized Type is a per-row error, never a silent guess.
- **Company columns build the contact's directory company**: match by domain
  then name (a match is never overwritten by a file); a create carries
  domain/website/industry/phone/city/country. **Lead rows keep the company as
  text** — they never create directory companies (same as today's lead
  import). `company_phone` etc. resolve the person/company field collision.
- **Combined template** downloadable from the wizard; auto-maps 100%
  (pinned in the spec, like the round-B per-entity templates).
- **Excel**: `.xlsx` files parse **in the browser** (`read-excel-file`,
  dynamically imported so the normal bundle never carries it; first sheet;
  API contract stays CSV-only). The plan wanted the SheetJS CDN build, but
  that CDN is unreachable from the build environment and the npm `xlsx`
  package is stale with known advisories — `read-excel-file` is
  browser-first, maintained, and advisory-free. Legacy `.xls` (pre-2007) is
  deliberately not offered; Excel's "Save As → .xlsx" is the escape hatch.
- **Undo rewritten** to one unconditional sweep across people + companies +
  leads by batch id — which also fixes a **pre-existing bug**: companies
  auto-created during a plain *people* import were never retracted by undo.

## RC-5 · Issue edits reflect immediately (no full-page refresh)

**Mechanism found**: the description renders from local state that an effect
reseeds from the REST detail payload. `saveDesc` scheduled a refetch on a
**600 ms guess-timer** that raced the sync engine's 250 ms-debounced flush —
when the refetch won, the stale payload **reverted the just-typed text**, and
nothing ever corrected it. Exactly "I must refresh the whole page".

**Fix**:
- a dirty guard (`lastSavedDescRef`): while a save is in flight, only a
  server payload that already carries the saved text may reseed;
- the engine gained its one react-query coupling point —
  `engine.onFlushed(listener)` fires with the acked ops after each flush
  batch; the detail page invalidates its own query when *its* issue's write
  is really on the server. Refetch is now correct-by-construction, not timed.
- REST-mode tenants also got a way INTO the detail page: the kill-switch
  issues list rendered plain unclickable divs — rows now open the issue.

## RC-6 · CTA latency: sub-second hot paths

Verified mechanisms and fixes, in shipped order:

| # | Change |
|---|--------|
| S0 | `createInAppNotification` **never throws** (try/catch at source — house rule 6 enforced once, not per call site) |
| S1 | Audit writes detached (`void audit.log`) on punch-in/out, regularization request/review, leave review; the two audits **nested inside another transaction** hoisted out (attendance self-heal, CRM lead convert) |
| S2 | In-app notifications detached on review paths (leave/timesheet/regularization decisions, employee onboarding approve/reject, details-change, CRM activity ping, workflows, forms, PM cycle close). **Not** touched: invoice send (the email *is* the CTA), auth, FAM impersonation (DPDP notice stays awaited), invite emails |
| S3 | `presence.clearStatus` detached from punch responses (the changed event now follows the write) |
| S4 | **Transaction consolidation**: punch-in, punch-out, break punches and `getMyToday` each run in **one** `withTenant` transaction (employee resolution + shift + geofence + write). Punch-in was 5 transactions ≈24 serial round-trips; `getMyToday` was 6 — and it refetches after every punch |
| S5 | Leave approval writes its on-leave attendance days in **one bulk upsert** (was one round-trip per business day) |
| S6 | **gzip compression** on the API (`compression` middleware) — the PM bootstrap/detail payloads shrink ~5-10× for Indian mobile links |
| S7 | **Module-access guard**: the per-request ~4-round-trip transaction is gone. Membership liveness and the FAM kill-switch stay **live** (flat parallel service-role reads — a deactivated member or a disabled module is denied on the very next request, the Sprint-10 contract); only the slow-moving **grant row is cached 60 s** (founder decision) with an in-process bust on every grant write through MembersService |
| F1 | Web: punch mutations no longer **await** the whole-`['attendance']` invalidation (that await kept `isPending` — and the frozen button — alive through every refetch on screen); narrowed to `['attendance','me']` |
| F2 | Geolocation: cached fix ≤30 s used instantly; cold-GPS wait 8 s → **3 s**, then the punch proceeds without coordinates (founder decision: punch fast) |

**Measured locally** (rc6-timing, network ≈0): punch-in **28 ms**, punch-out
**39 ms**, `me/today` p95 **17 ms**, lead convert **35 ms**, issue update p95
**16 ms** — the button now unfreezes at response time, so end-user latency is
dominated by their network + the (now 3 s max) GPS wait.

## RC-7 · Delete an issue

Everything below the UI existed since round 20 (softDelete + Recently deleted
+ restore) — only the sync engine had a door. Added `POST /pm/issues/:id/delete`
(`pm:edit`, service-side visibility — mirrors `restore`), a Delete button on
the issue page behind a danger `ConfirmDialog` ("moves to Recently deleted —
restorable for 30 days"), and a "Delete issue…" entry in the issues-list row
menu. Works in both transports.

---

## Verification

- **`founder-roundC.spec.ts` — 20 tests** pinning C1–C7 (avatar signing incl.
  guests; rename/re-icon + blank-name reject; items search + `item_id`
  round-trip + usage stats; the full combined-import matrix incl. the undo
  legacy fix and 100% template auto-map; the `.returning()` echo; never-throw
  notifications; bulk leave-day insert (exactly N rows); grant-cache
  mask-then-bust; delete/restore + guest visibility).
- **Full gate green**: api+web typecheck, api build, full jest (**722/724**;
  the 2 fails are the documented IST-midnight environmental flake —
  attendance-month and the presence flip both compare UTC-derived "today"
  against IST attendance dates, and the run happened at 04:1x IST),
  `lint:boundaries`, web production build, `diagnose-rls` →
  `leak_with_bogus_context = 0`.
- **Live Chromium pass** (`verify-roundC.mjs`, all green): avatar on the lead
  chip; in-place rename/re-icon persisted; items dropdown → autofilled line;
  a real **.xlsx** through the wizard (Type column + fallback toggle) with DB
  assertions and a full undo; description Save watched for 4 s with no reload
  (the old bug reverted at ~600 ms) then confirmed persisted; UI delete →
  tombstone → restore. Compression verified (3126 → 1226 bytes on a small
  page).
- Existing spec updates that go with the behavior changes: presence flip
  polls ≤5 s (PRD promises ≤5 s propagation, not same-response);
  `ModuleAccessService` takes the service-role handle (8 spec constructor
  sites); PM spec constructors carry the media stub (10 sites).

## Deploy notes

1. **Apply migrations 0054–0058 in Supabase first** (0058 is this round's;
   see `apply-0054-to-0058.sql` provided in chat, or run them in order).
2. New dependencies: `compression` (api), `read-excel-file` (web).
3. `PmTeamsService` and `PmGuestsService` now inject `MediaService`;
   `ModuleAccessService` injects the service-role DB handle — both wired via
   existing global/imported modules, no module changes needed beyond what's
   in this commit.
4. Real-time fan-out is still single-instance in-process; the grant cache's
   in-process bust shares that constraint (noted in code for the Redis-adapter
   day).
