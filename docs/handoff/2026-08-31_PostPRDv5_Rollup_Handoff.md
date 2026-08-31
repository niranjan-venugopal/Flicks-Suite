# Flicks Suite — everything shipped since PRD v5 (2026-08-22 → 2026-08-31)

One document for the whole stretch between the **PRD v5 (CRM) completion
handoff** and the code freeze: twenty-five delivery rounds (3–21, A, B, C, D)
of founder-driven fixes and features, live in production throughout. Each
section links the per-round handoff that carries the full detail.

**State at freeze**: HRMS (attendance incl. geofence v1, leave, timesheets,
onboarding, employee lifecycle) + Invoicing (GST + exports, clients, items,
payments) + CRM (directory, leads, deals, activities, imports, reports) +
Project management (Linear-class offline-sync engine, projects, issues,
cycles, guests) + platform billing/FAM — with tenant RLS everywhere, a
724-test API suite, and sub-second server timings on the hot CTAs.

---

## 1 · Attendance & Time

- **Geofence v1 shipped end to end** (R13, migration `0054`): office
  coordinates + radius in Settings, browser capture at clock-in, server-side
  Haversine writes `work_mode` (office/remote), the "You're not at the
  office → Mark as WFH today" dialog, and the clock-card location strip.
- **Team attendance** for owner/admin/finance org-wide with a Location
  column and a real WFH KPI (R13); presented as a **My attendance /
  Everyone toggle** on one page (R14).
- **Employee-360° Attendance tab** shows the person's real month-by-month
  history (KPIs + daily log) via a new scoped API — self, their reporting
  manager, and owner/admin/finance; honest restricted card otherwise (R15).
- The Daily-log **Regularize** button actually files a regularization (it
  had no click handler) with the day pre-filled (R12); self-approval of
  leave and regularizations is blocked server-side (R8).
- **Attendance math is right off the default shift** because shift
  assignment finally exists end to end (R-A): employee forms write
  `employee_shifts`, and the resolver picks the assignment before the
  tenant default.
- **Clock-in is fast** (R-C): punch-in/out/breaks and the today-snapshot
  each collapsed from 4–6 transactions to **one** (punch-in ≈24 serial
  round-trips → one transaction, 28 ms locally); audit/notification/
  presence writes detached from the response; the web button un-freezes at
  response time; GPS wait capped at 3 s with cached fixes used instantly.
- Leave: types are **gender-scoped** (R13); approval writes its on-leave
  attendance days in one bulk insert (R-C); leave request/decision pings
  land in-app in real time (R5/R8).

## 2 · People, onboarding & employee lifecycle

- **Onboarding approvals with integrity** (R5–R11): fan-out to the right
  reviewers (never the submitter; an admin's own file goes to the owner —
  R17/R18), an Inbox approvals bucket, and the notification deep-linking
  into a real review modal with the submitted data + Approve / Send back.
- **Role-aware wizards** (R17): owners/admins get a 4-step flow that
  activates them directly; everyone else keeps the 5-step + review path.
  Probation / confirmation / notice period finally editable everywhere.
- **Employee-confirmed edits** (R3): HR edits to an active employee's
  personal/identity/bank details are held until the employee confirms.
- **Designations** are assignable, department-linked (picking one
  auto-fills the department — R16), and shown in profile/topbar (R3).
- **India-aware statutory fields** (R10): PAN/Aadhaar/UAN gated by location
  country, passport for foreign locations, Aadhaar last-4 persisted, the
  fake PF auto-fetch removed.
- **Offboard + Remove** (R21, migration `0057`): separation type / last
  working day / reason; removal deletes a history-free record outright and
  archives anyone with statutory history (restorable from the directory's
  Removed filter); the seat is revoked either way; owner-only for
  owner/admin targets; honest confirm copy with real record counts.
- Headcounts on Departments / Locations / Shifts count everyone actually on
  the books (they were always 0 — R-A); reporting manager is editable.

## 3 · Invoicing

- **Clients**: country + full billing address (invoices printed a name-only
  Bill-To before), country-aware tax fields, archive, and **delete** with
  the invoiced-clients-are-hidden-not-erased rule (R18, migration `0055`).
- **Exports** (R18): a non-Indian client is a real export of services —
  zero-rated under LUT (settings switch), place-of-supply `96`, the Rule 46
  endorsement printed, GSTR-1 files them under EXP.
- **Invoices**: soft delete + restore (blocked once paid; numbers never
  reused), the long-built Cancel exposed, bank list fixes incl. free-text
  "Other" (R5), house pickers and z-index scale so calendars open above
  modals (R8).
- **Items reach invoice lines** (R-C): the editor's Description cell
  searches the catalogue server-side and a pick autofills item link, name,
  rate, HSN/SAC, unit, cess and the GST/VAT rate; usage stats now recorded.
- Platform payments: Razorpay auto-debit mandates and the trial/paywall
  machinery predate this stretch; coupons were retired to FOUNDER-001 only
  with sequential minting removed (R9).

## 4 · CRM

- **Deletes everywhere they were missing** (R9/R11): leads + web forms
  (soft), contacts/companies from their lists and detail pages, bulk
  activity purge.
- **Zoho/HubSpot-parity import** (R-B): leads deduped by email (re-uploads
  used to silently double every lead), within-file duplicates skipped,
  per-entity templates that auto-map 100%, per-row errors surfaced with a
  downloadable report, drag-and-drop, Import buttons on the three lists.
- **One combined file + Excel** (R-C, migration `0058`): the wizard's
  default is now "One file (everything)" — a **Type** column decides
  Contact vs Lead per row (blank rows follow a fallback toggle), company
  columns build the contact's directory company (domain-first match, never
  overwritten), lead rows stay text-only, **.xlsx parses in the browser**,
  and undo retracts contacts + companies + leads (also fixing the legacy
  bug where auto-created companies survived undo).
- Quick-start checklist honesty, lead convert consolidation, CRM search
  palette, house calendar for the last two date inputs (R8/R9).
- `crm_email` and `crm_automation` remain feature-flagged OFF ("Coming
  soon") with backend + tests intact.

## 5 · Project management

- **The data-loss class closed** (R-A — the most important fix of the
  stretch): eleven mechanisms by which a stale offline-sync client silently
  erased server rows, including "Remove sample data" stripping real work,
  the delta-window skip, rejected mutations replaying as success, lossy
  rollbacks, and full-set replaces built from the client's view.
- **Projects**: delete with cascade to issues + Recently deleted + restore,
  service-enforced authority (R20, migration `0056`); **name + icon
  editable in the header** (R-C); guests invitable by the lead + manager
  and above (R-A); project-scoped **guest seats** with strict read/write
  scoping across REST, search, sync bootstrap and delta (R7).
- **Issues**: one Linear-style composer everywhere — description, state,
  priority, assignee, estimate, labels, project, milestone, due date at
  create (R-B); **delete from the UI** with confirm + 30-day restore (R-C);
  milestone linking + "+ New issue" from the project page (R13); **saves
  stick without a reload** — the guess-timer refetch that raced the flush
  and reverted typed text replaced by a dirty guard + the engine's
  ack-driven `onFlushed` hook (R-C); REST-mode rows finally open the detail
  page.
- **Avatars propagate into PM** (R-C + R-D): the sync bootstrap ships signed
  avatar URLs (it shipped raw keys before), every PmAv face renders the real
  photo — and because the offline engine warm-boots from an IndexedDB
  snapshot that nothing ever refreshed (an avatar upload emits no pm.* sync
  event, and signed URLs age out), the engine now re-fetches the small
  `/pm/users` roster once per session, so a photo uploaded AFTER a device
  cached the workspace appears on the next reload instead of never.
- PM notification emails: comment digests (default on), create-with-
  assignee pings, @-mentions (R7).

## 6 · Platform: access, billing, FAM

- **Per-module access** (R8): CRM / Invoicing / Projects grants per member
  from Settings, subtractive-only `withModuleAccess` (R19), tenant role
  defaults, real revocation. Round C removed the guard's per-request
  transaction: membership liveness and the FAM kill-switch stay live;
  only the grant row is cached (60 s, busted in-process on every write).
- **Role-true navigation** (R19): the FAM console renders only the
  platform nav (customer CRM links used to appear and dead-end), Finance
  gets its own nav, capability names fixed so granted Payments links show.
- **FAM**: signup notifications + deep-linkable verification queue +
  Verified pills + tenant logos (R11); impersonation with the DPDP notice.
- **Specflicks branding + SEO** (R7): tagline, metadata, sitemap, robots.

## 7 · Auth & sessions

- 7-day sessions with silent refresh that actually survives (R3), session
  restore on tab reopen, opt-in **180-day trusted devices** (R4), the
  rate-limiter "refresh logs me out" fix (explicit-only throttling + trust
  proxy + 401-only bounce — R5/R9), proactive token refresh so background
  polls never eject a live session (R9), and the stuck terms-gate checkbox
  root-caused and fixed (R10).

## 8 · Performance & reliability (R-C)

- `createInAppNotification` can never throw into a write path (house rule 6
  enforced at source); hot-path audit/notification/presence writes are
  fire-and-forget; nested-transaction audits hoisted out.
- **gzip on the API** (the PM bootstrap shrinks ~5–10×).
- Local timings after the pass: punch-in 28 ms · punch-out 39 ms ·
  today-snapshot p95 17 ms · lead convert 35 ms · issue update p95 16 ms.
- Real-time fan-out remains single-instance in-process socket.io (Redis
  adapter still future work); the grant-cache bust shares that constraint.

## 9 · Design system & UX polish

- House **ConfirmDialog** replacing every native confirm (R11), close-button
  geometry fixed at the source across all three modal systems (R-A),
  readable native selects on Windows (R10), full state names everywhere
  (R10/R13), forms row alignment + sidebar un-stick (R11), pickers above
  modals via the documented z-index scale (R8).
- **Round D (this commit): dialogs get an opaque face.** The glass card
  recipe (2–8% white + backdrop blur) nested inside each overlay's own blur
  — which Chromium composites unreliably (the founder's Delete-client
  dialog rendered as loose slabs with the footer not painting) and vanishes
  on near-black pages. A single `modal-card` rule now gives every
  overlay-hosted dialog an opaque panel: applied to the proto Modal (all
  ConfirmDialogs + composer inherit), the Radix DialogContent (all ~25
  invoicing/HR dialogs), the CRM kit modal, QuickAdd, the CRM search
  palette, the snooze/team/workspace/lost-reason dialogs. Verified on the
  production build over the darkest screens. Round D also ships the PM
  roster-freshness fix described in §5 (avatars uploaded after a device
  cached the workspace).

---

## Migrations shipped in this stretch

| # | What | Round |
|---|------|-------|
| `0051` | PM guest role plumbing | R7 |
| `0052` | Tenant role module defaults | R8 |
| `0053` | CRM soft delete (leads, forms) | R9 |
| `0054` | Geofence + work_mode + workspace prefs + leave gender backfill | R13 |
| `0055` | Invoice soft delete + export/LUT | R18 |
| `0056` | PM project delete cascade | R20 |
| `0057` | Employee soft delete | R21 |
| `0058` | Combined-import `object_type 'all'` | R-C |

**Production Supabase still needs `0054 → 0058`** (combined script delivered
in chat as `apply-0054-to-0058.sql`) — apply before the next API deploy;
without them geofence/work-mode, export invoicing, project/employee removal
and the combined import fail server-side.

## Gate at freeze

- API: **724 Jest tests** (722 green in the last full run; the 2 fails are
  the documented IST-midnight environmental flake), typecheck + `nest build`
  clean, `lint:boundaries` clean.
- Web: typecheck + production build clean.
- RLS: `diagnose-rls.sh` → `leak_with_bogus_context = 0`, 137 tenant tables
  all FORCE-RLS.
- Every founder round closed with a live headless-Chromium pass of the
  changed surface plus a `founder-round*.spec.ts` regression suite
  (rounds 5–21, A, B, C).

## Known open items / deferred

- Migrations `0054–0058` pending in production Supabase (above).
- `pm-diagnostic.sql` output from production still awaited (round-A follow-up).
- Redis socket.io adapter before any multi-instance API deploy.
- Razorpay live payments remain config-gated on Technology-Partner access.
- `crm_email` / `crm_automation` flags OFF by design.
- PM project/cycle-page refetch timers (benign; `onFlushed` makes removal
  trivial when touched next).
