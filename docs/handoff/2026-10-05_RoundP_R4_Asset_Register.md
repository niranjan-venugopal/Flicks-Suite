# Round P · R4 — Asset register: company equipment, assigned at onboarding, acknowledged by the employee, returned at exit

**Date:** 2026-10-05 · **Type:** feature (new module) · **Migration:** 0068 (`docs/handoff/apply-0068.sql`) · **Status:** see §7

Founder's ask: *"A particular client asks for the asset management for every Employee or the user, while onboarding. With the picture or something."* Decision: a **company equipment register** — every laptop, phone, SIM, ID card… has a photo, tag, serial, condition and status; HR assigns it to a person (during onboarding or later); the person sees it under **My assets** and acknowledges receipt; HR records the return at exit; a company-wide list with CSV export.

## 1. What the customer gets

**For HR / Owner — People → Assets**
- **Register equipment**: tag (the server suggests the next `AST-0001`-style number, or type your own), name, category (laptop, desktop, monitor, phone, SIM, tablet, ID card, access card, keys, peripheral, furniture, vehicle, other), brand, model, serial number, purchase date and value, condition, notes, and a **photo**.
- **Assign** it to a person — anyone in the company, including people who are still onboarding (that is the client's case: the day-one kit is recorded while the invite is still open). The person gets a notification and an email asking them to acknowledge receipt.
- **Return** it when it comes back: the condition it came back in, notes, and where it goes next (in stock, under repair, retired, lost). Every assignment stays in the asset's history and in the person's record.
- The list shows who holds what, the status (in stock / assigned / under repair / retired / lost), the condition, and KPIs (total, assigned, in stock, awaiting acknowledgement). Filter by status, category or search; **Export CSV**.
- **Employee page → Assets tab**: what the person holds now, what they returned, "Assign an asset".
- **Approving an onboarding** offers "Assign equipment" right from the confirmation.
- **Offboarding** lists the equipment still out with the person, with a Return button right there (offboarding itself is never blocked — equipment is returned by the last working day).
- **Removing** a person who still holds equipment is refused until the return is recorded ("… still holds 2 asset(s) (AST-0007, PH-01) — record their return in People → Assets first"). Anyone who ever held equipment is archived at removal, never hard-deleted, so the register keeps its trail.

**For employees — My assets**
- Every piece of equipment issued to them: photo, tag, serial, issued on / by, condition, notes, and **Acknowledge receipt**. HR sees who has not acknowledged yet.

## 2. How it works

- Tables `assets` (tag unique per tenant among live rows, photo key, purchase info, `condition`, lifecycle `status`, soft `deleted_at`) and `asset_assignments` (asset, employee, assigned at/by, issue condition, notes, `acknowledged_at`, returned at/by, return condition/notes). **One open assignment per asset** (partial unique index `WHERE returned_at IS NULL`); `status = assigned` always follows that row and is never set by hand. Both tables have ENABLE + FORCE RLS, tenant policies and `flicks_app` grants.
- Photos go through the same pipeline as avatars (`MediaService.processImage`: magic-byte check, re-encode to 256 px + 64 px WebP, private R2 key `tenants/<tenant>/assets/<asset>/photo_<uuid>_256.webp`, 15-minute signed URLs, previous image deleted after the row commits).
- The employees module reads the register through `modules/assets/public.ts` (plain in-transaction helpers): removal is refused while open assignments exist, the removal footprint counts every assignment (archive, never hard-delete), and the removal preview lists the open items so the web warns before the click.
- Assign/return notifications are best-effort after commit: in-app `asset.assigned` → `/assets/me` and the `asset-assigned` email.

## 3. API (all under `/api/v1/assets`)

| Route | Who | Purpose |
|---|---|---|
| `GET /assets?status&category&employee_id&q&limit&offset` | admin | register list with `total`, holder, signed photo URLs |
| `GET /assets/summary` | admin | KPI counts |
| `GET /assets/next-tag` | admin | next free `AST-NNNN` (deleted rows counted) |
| `GET /assets/export.csv` | admin | CSV (BOM, formula-neutralised) |
| `GET /assets/by-employee/:employeeId` | admin | what one person holds + returned history |
| `POST /assets` · `PATCH /:id` · `POST /:id/delete` | admin | create (409 `ASSET_TAG_TAKEN`) · edit (409 `ASSET_ASSIGNED` on a status change while held) · soft delete (409 while held) |
| `POST /:id/photo` (multipart `file`) · `POST /:id/photo/remove` | admin | photo |
| `POST /:id/assign` `{ employee_id, assigned_at?, issue_condition?, notes? }` | admin | 409 `ASSET_ALREADY_ASSIGNED` / `ASSET_UNAVAILABLE`, 400 when the person has left |
| `POST /:id/return` `{ return_condition, return_notes?, next_status? }` | admin | 409 `ASSET_NOT_ASSIGNED` |
| `GET /assets/me` | any member | my equipment |
| `POST /:id/acknowledge` | the holder | idempotent; 403 for anyone else |
| `GET /employees/:id/removal-preview` | admin | now also `assets` (count) and `openAssets[]` |
| `DELETE /employees/:id` | admin | 409 `ASSETS_ASSIGNED` while equipment is out |

## 4. Founder action — release order

1. Run **`docs/handoff/apply-0068.sql`** in the Supabase SQL editor (service role; idempotent).
2. Push `production` (API), then `main` (web). Photos need the same R2 configuration avatars already use — nothing new to set.

## 5. Tests

`assets.spec.ts` (service-level, real Postgres: tags, duplicates, list/filter/summary, assign rules incl. cross-tenant and separated people, return, acknowledge by holder only, my assets, by-employee, delete rules, photo pipeline with stubs, CSV, DTO validation) · `founder-roundP-r4-employee-assets.spec.ts` (removal refused while holding, archived after return, unchanged for people without equipment, removal preview shape, `asset-assigned` email template + escaping).

## 6. Follow-ups
- Bulk import of assets from CSV (today one at a time).
- Maintenance / warranty dates and reminders.
- A "handover" flow that returns and re-assigns in one step.
- Department / location on the asset for larger registers.
- The trusted-device prompt ("Stay signed in on this device?") is a focus-trapping dialog that opens once `/me` settles; if a page opens a modal programmatically at the same moment (the `?assign=` deep link in a brand-new tab) keystrokes go to the prompt first. People normally answer the prompt on their first screen, so this is cosmetic; the hardening is to defer the prompt while a proto overlay is open.
- `founder-round21.spec.ts` never ends its pool clients, so Jest prints "a worker process has failed to exit gracefully" when it runs with other suites (pre-existing; two `end()` calls in its `afterAll`).

## 7. Gate and live verification

**Build process.** Four implementers (API module · employees/notifications integration · web HR register · web employee page + navigation), three adversarial review lenses each, one fix pass each: 20 agents. The reviews caught two things worth recording: server-picked tags raced to a 409 with a nonsense message under parallel creates (now an advisory lock + retry, and the explicit-tag 409 names the real tag); and a person who had left the company could still be offered equipment through the `?assign=` deep link and the employee page (now filtered on every path, with a reason shown). Cross-file follow-ups applied by the orchestrator: the assign lookup takes `FOR SHARE` on the employee row so an assign racing a removal waits for it; the API now exposes `Content-Disposition` to the web, so CSV and PDF downloads keep the server's filename (this also fixes the policy-acknowledgements CSV name from R3); "My assets" is in the owner/admin sidebar too; photo URLs are signed for 15 minutes like policy PDFs.

**Gate (all green):** API typecheck · nest build · **Jest 88 suites / 1 346 tests** (two failed in the full parallel run: `pm-perf` search P95 under a loaded box while the web build ran — passes when re-run alone — and `attendance-selfheal`, which also failed when re-run alone at 00:23 IST: the documented IST-midnight flake, where the punch day and the presence day disagree; R4 touches no attendance or PM code) · module boundaries (358 modules, 0 violations) · web typecheck · web production build · RLS probe `leak_with_bogus_context = 0`. Migration 0068 applied locally twice (second run NOTICE-only) and once through `apply-0068.sql`.

**Live verification** (production web build, real API, real Postgres, S3-compatible mock for photos): `scratchpad/verify-roundP-r4.mjs` **51 pass / 0 fail / 0 skip** across 6 scenarios, plus the HR-register harness `verify-r4-web-hr.mjs` **90 pass / 0 fail** across 11 scenarios.

| # | Scenario | Result |
|---|---|---|
| 1 | Next tag `AST-0001` → create without a tag takes it; explicit tag `PH-…`; duplicate → 409 `ASSET_TAG_TAKEN`; bad category → 400; **photo upload** → signed 256/64 URLs that serve an image; list by search with `total`; summary; an employee gets 403 on the register | pass |
| 2 | Assign the laptop to a person **still onboarding** (inactive) → status assigned, holder name + issue condition; second assign → 409; a separated person → 400 "no longer with the company"; another tenant's employee refused; delete while held → 409; status edit while held → 409; in-app `asset.assigned` → `/assets/me` written; by-employee current/history; summary counts | pass |
| 3 | Employee: `/assets/me` lists the phone, sidebar "My assets", **Acknowledge receipt** → 2xx → "Acknowledged on"; acknowledging someone else's asset → 403; idempotent; `acknowledged_at` on the open assignment | pass |
| 4 | People → Assets: KPIs, table with holders and "awaiting acknowledgement", Add asset modal with the prefilled next tag; employee 360 → Assets tab; detail history (open assignment first, acknowledged) | pass |
| 5 | Exit: removal preview lists `openAssets`; `DELETE /employees/:id` → 409 `ASSETS_ASSIGNED` naming the tag; return → under repair / fair, history row; second return → 409; preview flips to **archive**; removal now archives the row and keeps the assignment history; CSV export; delete a free asset → 404 afterwards | pass |
| 6 | `/employees/assets?assign=<new hire>` opens "Assign equipment — pick what <name> is getting" (and "Nothing in stock → Add asset" when the register is empty); sidebar People → Assets | pass |
| HR | Lock card for an employee; Add asset through the form with photo and the duplicate-tag toast; assign from the row to an onboarding person (status label in the picker); drawer with history and Record return; edit + filters; `?assign=` pick-an-asset flow; employee 360 Assets tab; offboarding dialog lists outstanding assets with inline Return and never blocks; the Remove dialog says "Return 1 asset first (PH-…)"; approve toast → "Assign equipment"; delete via ⋯ and Export CSV; a separated person is never offered equipment | 90/90 |

Screenshots in the session scratchpad: `rp4-register`, `rp4-add-modal`, `rp4-my-assets`, `rp4-my-assets-acked`, `rp4-employee-assets-tab`, `rp4-assign-from-onboarding`.

**Worth knowing before the first customer uses it**
- Assigning to a person who has not accepted their invite works and sends them the email; the in-app notification waits for their first sign-in.
- Offboarding is never blocked by equipment; **removing** the record is, until every item is returned or marked lost.
- The owner/admin sidebar also has Personal → "My assets" (owners get issued equipment too).
