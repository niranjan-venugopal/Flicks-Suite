# Flicks Suite — Handoff Documents

This folder collects the engineering handoff documentation for Flicks Suite —
the V1 HRMS foundation, the **Invoicing v3** module, the **PRD v4** platform
work, and the **PRD v5 CRM** module.

| Document | Purpose |
|----------|---------|
| [`2026-08-31_RoundC_Prefreeze_Handoff.md`](./2026-08-31_RoundC_Prefreeze_Handoff.md) | **Start here.** Round C (2026-08-31), the final pre-freeze fixes, all seven founder items: **avatars finally reach Project management** (the sync bootstrap shipped unsigned rows — signing moved into `usersLite` + the guests listing, and four `PmAv` sites got their `src`); **projects editable after creation** (click-to-edit name + icon select in the header); the invoice **Items picker** (Description cell searches the catalogue server-side and autofills id/rate/HSN/unit/tax; usage stats finally written); the **combined one-file CRM import** — Type column decides Contact vs Lead per row with a wizard fallback toggle, company columns build the contact's directory company, lead rows stay text-only, **.xlsx parses in the browser**, and undo now retracts all three tables (fixing the legacy people-import bug); **issue saves stick without a reload** (the 600 ms guess-timer refetch raced the 250 ms flush and reverted typed text — replaced by a dirty guard + the engine's new `onFlushed` ack hook; REST issue rows became clickable); a platform-wide **CTA-latency pass** (punch-in 5 transactions→1, `getMyToday` 6→1, detached audit/notification/presence writes, bulk leave-day insert, gzip, guard grant-row cache with live liveness — punch-in **28 ms** locally); and **Delete issue** in the UI (both transports, ConfirmDialog, Recently deleted). 20-test spec (`founder-roundC.spec.ts`). **Migration `0058` + the pending 0054–0057 must be applied before the next deploy.** |
| [`2026-08-31_RoundB_Composer_Import_Parity_Handoff.md`](./2026-08-31_RoundB_Composer_Import_Parity_Handoff.md) | Round B (2026-08-31), the founder's two feature builds: **one Linear-style issue composer** (title + description + state + priority + assignee + estimate + labels + project + milestone + due date at create) replacing four inconsistent create forms — issues list, project page, board columns and the REST fallback — with `label_ids` added to the create API as the one missing backend piece; and **CRM import to Zoho/HubSpot parity**: leads finally deduped by email (the strategy screen had been a no-op — re-uploads silently doubled every lead), within-file duplicates skipped, downloadable per-entity templates that auto-map 100%, stored-but-never-shown row errors surfaced with a downloadable report, real drag-and-drop, and Import buttons on the Leads/Contacts/Companies pages. 10-test regression spec (`founder-roundB.spec.ts`). No migration — but **0054–0057 must still be applied before the next deploy**. |
| [`2026-08-31_Round21_Employee_Removal_Handoff.md`](./2026-08-31_Round21_Employee_Removal_Handoff.md) | Round 21 (completed 2026-08-31): employee **offboarding + removal** end to end. Removal is mode-aware — a record with **no history is deleted for good**; anyone with attendance/leave/timesheet history is **archived** (`deleted_at`, migration `0057`): gone from every directory read while the statutory rows survive, restorable from the directory's new **Removed** filter. Either way the **workspace seat is revoked**. Owner-only when the target is an owner/admin; you can't remove yourself; a preview endpoint drives honest confirm copy with the real record counts. The employee page gains **Offboard** (separation type + last working day + reason → notice period + history row) and **Remove**; Restore keeps the login revoked by design. **Apply migrations 0054–0057 before deploying.** |
| [`2026-08-31_RoundA_Prefreeze_Bug_Clearance_Handoff.md`](./2026-08-31_RoundA_Prefreeze_Bug_Clearance_Handoff.md) | Round A (2026-08-31), pre-code-freeze bug clearance: the founder-confirmed **PM data loss** closed as a CLASS — eleven mechanisms where a stale offline-sync client silently erased server rows ("Remove sample data" stripping real work with no confirm, the 5000-event delta window skipping history forever, rejected mutations replaying as success, lossy rejection rollback, full-set replaces built from the client's view destroying initiative lanes, the project page swapping datasets by array length, reset dropping the offline queue, and more). Plus: the four Settings **headcounts always 0** (Drizzle unqualified-subquery bug — rewritten as real joins, counting everyone on the books), **reporting manager + shift** finally editable (shift assignment had never existed end-to-end, so attendance math was wrong off the default shift), **project guest invites** widened to the lead + manager-and-above, CRM sidebar order, and the close-button geometry of all three modal systems fixed at the source. 25-test regression spec (`founder-roundA.spec.ts`). **Apply migrations 0054–0057 before deploying.** No new migration. |
| [`2026-08-30_Round20_PM_Project_Delete_Handoff.md`](./2026-08-30_Round20_PM_Project_Delete_Handoff.md) | Round 20 (2026-08-30): Projects finally has a **delete** — the server-side softDelete/restore had existed since PRD v6 with no button anywhere. Wiring it up safely meant fixing what sat underneath: a deleted project's **issues stayed live** in the issue list, My Issues, Triage, search and both sync paths, so delete now **cascades to its issues** (marked by `deleted_with_project_id` so restore returns exactly that set); delete had **no authority check at all** (any member could destroy any project they could see) so the bar is now manager-and-above-or-the-lead, enforced in the service because the sync executor is a second door with no `@Roles`; **guests kept a deleted project forever**; the purge **detached** issues instead of deleting them; the offline engine's undo was **lossy**; and restore came back without its milestones or team chips. Delete lives on the project row and in the project header; Recently deleted (Settings → Workspace) restores it. Migration `0056`. |
| [`2026-08-30_Round19_FAM_Console_Nav_Role_Audit_Handoff.md`](./2026-08-30_Round19_FAM_Console_Nav_Role_Audit_Handoff.md) | Round 19 (2026-08-30): the FAM console showed a customer **CRM** menu whose links did nothing — the sidebar derived the console from the signed-in role and a helper bolted the tenant CRM group onto any nav lacking one, so a platform admin (who resolves every module to `edit`) got it, and each link bounced back to `/fam/overview`. The console now comes from the layout (`variant`), not the role. Same sweep: **Finance** was handed the Owner/Admin nav although it ranks below Manager — People, Insights and Settings all 403'd, so it gets its own nav (Invoicing-first, CRM, Projects, Time, org chart); the sidebar read the Payments capability as `record_payments` instead of `record_payment`, so a member who HAD been granted it never saw the link; and workspace Settings was offered to every role in the avatar menu. Plus a socket transport-order fix for the WebSocket console errors (mitigation — the production cause is the edge, see the doc). No migration. |
| [`2026-08-30_Round18_Exports_Client_Address_Deletes_Handoff.md`](./2026-08-30_Round18_Exports_Client_Address_Deletes_Handoff.md) | Round 18 (2026-08-30): HR-admin onboarding is now owner-approved only (with a no-active-owner escape hatch); the client form finally asks for a country + billing address (every invoice PDF was printing a name-only Bill-To); a client outside India is treated as a real **export of services** — no GSTIN, zero-rated under LUT, place of supply `96`, Rule 46 endorsement printed, and GSTR-1 filing them in **EXP** instead of B2B; and invoices/clients can be deleted (soft + Restore, blocked once paid, numbers never reused) with the long-built Cancel action finally exposed. Migration `0055`. |
| [`2026-08-29_Round17_Employment_Terms_Owner_Onboarding_Handoff.md`](./2026-08-29_Round17_Employment_Terms_Owner_Onboarding_Handoff.md) | Round 17 (2026-08-29): probation end / confirmation date / notice period become editable (columns shipped in `0001` but no write path ever existed — invite form, Edit profile, DTOs, plus the six org fields the audit snapshot silently dropped), and the **owner** now gets a 4-step onboarding wizard that finishes without the Documents step or HR review, activating them directly (server-derived from the membership role). HR admins keep the full 5-step flow and are reviewed by the owner, never by a peer admin. Also fixes the send-back deep link that 404'd. No migration. |
| [`2026-08-28_Round16_Designation_Department_Autofill_Handoff.md`](./2026-08-28_Round16_Designation_Department_Autofill_Handoff.md) | Round 16 (2026-08-28): picking a designation in the employee forms now auto-fills its linked department (designations show in any order, labelled with their department; common ones leave the field untouched). Web-only. |
| [`2026-08-28_Round15_Employee_Attendance_Tab_Handoff.md`](./2026-08-28_Round15_Employee_Attendance_Tab_Handoff.md) | Round 15 (2026-08-28): the employee-360° Attendance tab shows the employee's REAL month-by-month history (KPIs incl. WFH days + daily log) instead of the "open the module" dead end — new scoped API (`GET /attendance/employee/:id`: self, reporting manager, owner/admin/finance; honest restricted card for everyone else). |
| [`2026-08-27_Round14_Attendance_Toggle_Settings_Handoff.md`](./2026-08-27_Round14_Attendance_Toggle_Settings_Handoff.md) | Round 14 (2026-08-27, UI placement corrections to round 13): the team view is now a My attendance / Everyone TOGGLE on the Attendance page (segmented control, no separate sidebar tab — `/team/attendance` redirects); Settings → General restored to the original single page (overview, workspace details, tax IDs, registered address) with one appended "Workspace preferences" card holding Default timezone · Financial year · Week starts on. Web-only, no migration. |
| [`2026-08-27_Round13_Geofence_Team_PM_Handoff.md`](./2026-08-27_Round13_Geofence_Team_PM_Handoff.md) | Round 13 (2026-08-27): geofence v1 finally shipped (the honest "why was it never executed" answer + settings geo inputs, clock-card capture, the "You're not at the office → Mark as WFH" dialog, server Haversine writing `work_mode`), Team attendance opened to owner/admin/finance org-wide with the Location column and a real WFH KPI, PM "+ New issue" on the project page + milestone linking (and a cross-project milestone 400 fixed), gender-scoped leave types, Documents as Coming soon, full state names across profile/settings/invoicing, and the editable workspace ID + the General tab reduced to timezone / financial year / week-start (which now drives timesheet weeks). Migration `0054`. |
| [`2026-08-27_Round12_Attendance_PM_Handoff.md`](./2026-08-27_Round12_Attendance_PM_Handoff.md) | Round 12 (2026-08-27): BUG CLEARANCE — the Attendance Daily-log "Regularize" button (was rendered with no click handler) now opens the request dialog with the clicked day pre-filled and files a real regularization; Projects becomes the PM module's main page (first sidebar item, /pm redirect) hosting the first-run setup tour, reordered Linear-style so "Create a project" comes before "Create an issue" (with two dead tour links fixed). |
| [`2026-08-27_Round11_Founder_Fixes_Handoff.md`](./2026-08-27_Round11_Founder_Fixes_Handoff.md) | Round 11 (2026-08-27): every native browser confirm replaced by the house ConfirmDialog (15 sites), web-forms row alignment, delete buttons on the contacts/companies lists, the onboarding-approval notification deep-linking into a real review modal (submitted data + Approve/Send-back), FAM signup notifications + deep-linkable verification queue + Verified/Unverified pills + tenant logos served signed, and the stuck sidebar dropdown root-caused and fixed for all roles. |
| [`2026-08-26_Round10_Onboarding_UX_Handoff.md`](./2026-08-26_Round10_Onboarding_UX_Handoff.md) | Round 10 (2026-08-26, tester feedback): readable dropdown options on Windows (opaque `option` rule), full state names in the wizard + HR dialog, India-only statutory fields (PAN/Aadhaar/UAN gated by location country; passport for foreign locations, Aadhaar last-4 finally persisted, the fake PF auto-fetch input removed with the honest EPFO answer), and the stuck terms checkbox root-caused (Radix body pointer-events) + fixed with the modal sequence enforced. |
| [`2026-08-26_Round9_Cleanup_Coupons_Handoff.md`](./2026-08-26_Round9_Cleanup_Coupons_Handoff.md) | Round 9 (2026-08-26): the notifications-401 diagnosis + proactive token refresh (and the background-poll ejection fix), the CRM quick-start checklist flash + honest predicates, lead/web-form deletes + detail-page deletes + the bulk activity purge, and the coupon retirement (FOUNDER-001 only, sequential minting removed, FAM delete). |
| [`2026-08-26_Round8_Access_Approvals_Handoff.md`](./2026-08-26_Round8_Access_Approvals_Handoff.md) | Round 8: Round 8 (2026-08-26): nobody approves their own leave/regularization, profile photos reach every screen, per-module access (CRM · Invoicing · Projects) from Settings with real revocation, customer-facing copy sweep, house date+time/month pickers in CRM, and a documented z-index scale so pickers open above modals. |
| [`2026-08-25_Live_Ops_Session_Handoff.md`](./2026-08-25_Live_Ops_Session_Handoff.md) | Rounds 3–7: Everything shipped AFTER the CRM MVP (2026-08-22 → 08-25): global tenancy + holiday calendars, employee-confirmed edits, the production incident + hardening, 180-day trusted devices, onboarding-approval integrity + Inbox, and the rate-limiter refresh-logout fix — plus current conventions, invariants, and open follow-ups. |
| [`Global_Tenancy_Holidays_Handoff.md`](./Global_Tenancy_Holidays_Handoff.md) | The detailed per-round addenda (rounds 2–6) behind the live-ops session doc above. |
| [`PRD_v5_Completion_Handoff.md`](./PRD_v5_Completion_Handoff.md) | Where we are against the CRM **PRD v5** and the MVP release — sprint map, post-gate hardening passes, parked/deferred items, ops checklist, how to run & verify. |
| [`CRM_Launch_Actions.md`](./CRM_Launch_Actions.md) | User-side day-1 external actions for the CRM launch (OAuth verifications, DNS, Resend, keys). |
| [`Testing_Guide_Sprints_24-31.md`](./Testing_Guide_Sprints_24-31.md) | The de-facto **PRD v5 spec** (§3–§19, screens C1–C22) plus manual + automated test scripts for CRM sprints 24–31 and every checkpoint. |
| [`PRD_v3_Completion_Handoff.md`](./PRD_v3_Completion_Handoff.md) | Where we are against the Invoicing **PRD v3** — sprint-by-sprint completion status, verification snapshot, what's deferred, how to run & verify. |
| [`Razorpay_Live_Payments_Handoff.md`](./Razorpay_Live_Payments_Handoff.md) | Go-live runbook for the one config-gated item: enabling Razorpay live payments (OAuth Connect) once Razorpay grants Technology-Partner access. |
| [`Testing_Guide_Sprints_16-19.md`](./Testing_Guide_Sprints_16-19.md) | Manual + automated test scripts for the PRD v4 Sprints 16–19 (consent, media, presence, analytics) with SQL verification snippets. |
| [`Testing_Guide_Sprints_20-23.md`](./Testing_Guide_Sprints_20-23.md) | Manual + automated test scripts for PRD v4 Sprints 20–23 (feedback + NPS, platform billing/trial/paywall, FAM coupons, tenant auto-debit mandates). |

## Quick status (as of 2026-08-25)

- **Live in production** (Railway API + Vercel web + Supabase, deploying
  from `production` which always equals `main`): all of PRD v5 plus the
  live-ops rounds — location-aware holiday calendars, country-aware GST,
  employee-confirmed detail edits, 7-day sessions with silent refresh and
  opt-in **180-day trusted devices**, onboarding approvals in the Inbox
  with self-approval blocked, tenant-wide real-time refresh, and the
  explicit-only rate limiter (the "refresh logs me out" fix). Gate at
  handoff: **510/510** API tests, RLS `leak_with_bogus_context = 0`,
  migrations `0001 → 0050` applied in production, api + web
  typecheck/build clean, boundaries clean. Details:
  `2026-08-25_Live_Ops_Session_Handoff.md`.

## Earlier status (as of 2026-07-17)

- **PRD v5 CRM — ALL sprints (24–31) shipped on `main` through the beta gate,
  plus five post-gate hardening/polish passes → MVP-release-ready.** Gate at
  handoff: **359/359** API tests, RLS `leak_with_bogus_context = 0`, migrations
  `0001 → 0038` idempotent, api + web typecheck/build clean, boundaries lint
  clean. Email suite + Automation are parked behind feature flags by product
  decision (code + tests intact). Details: `PRD_v5_Completion_Handoff.md`.
- Remaining pre-user actions are **ops-side only** (deploy prod build, sync
  migrations, rotate the build PAT, Resend/FX/Sentry config) — see §4 of the
  v5 handoff.

## Earlier status (as of 2026-07-11)

- **PRD v4 — ALL sprints (16–23) are shipped on `main`** (16 trust/consent · 17 media ·
  18 presence · 19 analytics · 20 feedback+NPS · 21 platform billing ·
  22 FAM coupons/emails · 23 tenant auto-debit + Sentry hardening). Gate at
  push time: **239/239** tests, RLS `leak_with_bogus_context = 0`, migrations
  `0001 → 0029` idempotent, `api` + `web` typecheck/build clean.
- **Conformance pass against the authoritative PRD v4 doc (2026-07-11):**
  migration `0029` aligns the auto-debit enums to §8.3 (CHECK-pinned;
  `authenticated`/`halted` reachable); presence liveness moved to Redis
  (§5.2, multi-instance safe); Sentry beforeSend redacts email-shaped
  strings; personal data export includes feedback + activity summary;
  pre-debit email carries invoice ref + manage/cancel link; approvals inbox
  shows presence dots; `setup-database.sh` now re-asserts the migrations'
  REVOKE lockdowns after its blanket grant (fresh-sync posture fix).
- **Paused for user testing — v4 is code-complete** — see the testing guide above.
  After sign-off, the remaining items are non-code: Razorpay
  Technology-Partner approval (tenant-track live payments + the ₹1 smoke),
  platform sandbox keys for checkout UAT, and legal counsel sign-off on the
  ToS/Privacy drafts.
- **Config-gated, not unfinished:** platform checkout needs
  `RAZORPAY_PLATFORM_*` sandbox keys (trial/paywall/coupons run without them);
  tenant-track live payments still await Razorpay Technology-Partner approval.
- **v1 scope decision (2026-07-11):** the invoicing-module Razorpay features
  (seller connect, auto-debit mandates, hosted-invoice online checkout) are
  **deferred to the next version** — the UI shows them disabled with "Coming
  soon" badges; the code stays in place behind those gates. Platform-billing
  Razorpay (₹499/seat subscription) remains live and unaffected.

## Related top-level docs

- `../../README.md` — project overview & setup
- `../../ARCHITECTURE.md` — system architecture
- `../../RUNBOOK.md` — operational runbook
- `../../RLS_HARDENING.md` — row-level-security posture & table inventory
- `../../CHANGELOG.md` — change history
- `../../Flicks_Suite_Invoicing_PRD_v3-2.md` — the source PRD
