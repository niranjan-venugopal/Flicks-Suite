# Testing Guide — Sprints 24–31 (PRD v5: CRM + architecture evolution → Beta)

Phase A: Sprint 24 **architecture evolution** (outbox event bus, worker split,
ModuleGrantGuard, public-API framework, webhooks, boundaries lint) · Sprint 25
**directory kernel** — Contacts/Companies (§3) → **Checkpoint 1**. Phase B:
Sprints 26–27 **deals** — pipelines, kanban, FX, deal→invoice/quote, custom
fields, saved views, global search (§4, §9, §12.1, §19.1-3/8) → **Checkpoint 2**.
Phase C: Sprints 28–29 **activities & email** — follow-up loop, pings/digest,
Email Phase A (compose, tracking, DNC, BCC dropbox, sequences, templates,
signature) → **Checkpoint 3**. Phase D: Sprint 30 **automation & capture** —
leads inbox, web forms, workflows, public API resources + webhook log →
**Checkpoint 4**. Phase E: Sprint 31 **reports & polish** — reports/forecast/
goals, CSV import, merge & dedupe, offboarding reassignment, sample data →
**BETA GATE**.

This guide grows per phase. **The BETA GATE is the current hand-off.**

> **Currently parked behind "Coming soon":** the Email suite (sequences,
> templates/signature, the deal Emails tab) and Automation (workflows) are
> hidden in the UI while the product direction is rethought — the pages show
> a Coming-soon card instead. The code, APIs and tests underneath are intact;
> flipping `FEATURES.crm_email` / `FEATURES.crm_automation` in
> `apps/web/lib/feature-flags.ts` to `true` restores them instantly. Skip the
> email/sequence/workflow walkthroughs below until then — everything else
> (leads, web forms, deals, activities, reports, import/merge, public API)
> is live.

## 0. Environment prep

```bash
git pull && pnpm install
# Apply the new migrations (idempotent, additive — safe to re-run):
pnpm sync:supabase          # applies packages/db/drizzle/0030–0037
# OR re-run the demo bootstrap (also idempotent; carries the 0030–0037 deltas
# inline + seeds a Sales pipeline, stages, lost reasons, and the crm toggle):
bash scripts/setup-demo.sh
pnpm dev
```

New optional env (`apps/api/.env`) — all blank-safe for testing:

```
OPENEXCHANGERATES_APP_ID=      # set to snapshot real FX on non-base-currency deals
RESEND_WEBHOOK_SECRET=         # svix secret from the Resend webhook you create (Checkpoint 3)
INBOUND_EMAIL_DOMAIN=          # e.g. in.yourdomain.com — the BCC dropbox domain (Checkpoint 3)
```

Blank FX key = deals in your **base currency** always work; a deal entered in a
*different* currency with no rates loaded is **rejected with a clear message**
(by design — see §Security). Load rates by setting the key and running the FX
refresh, or enter the value in your base currency.

---

## Checkpoint 1 (recap) — Directory: Contacts & Companies (§3)

1. **Nav & grants**: the sidebar shows **CRM** (Contacts, Companies) only when
   the CRM module is enabled for the workspace (FAM can toggle it). Employees get
   edit access by default (org-open SMB model); auditors are read-only.
2. **Companies (C5)** / **Contacts (C4)**: create, edit, search. A company detail
   shows its people and — via the invoicing facade — any linked billing customer.
3. **Backfill**: existing invoicing customers appear as directory
   companies/people (business→company, individual→person), de-duped by
   email/domain/name. Re-running the backfill makes no duplicates.

---

## Checkpoint 2 (recap) — Deals, pipeline, suite hooks

### 1. Pipeline board / kanban (C2, §4.1)

1. **CRM → Deals** shows the kanban for your default "Sales" pipeline: columns
   are the *open* stages only (Won/Lost are drop targets, not columns).
2. **Quick-add** a deal at the top of any column: title + value. It appears
   immediately.
3. **Drag** a card between columns → it moves stage. Open a second browser/tab on
   the same board → the move appears there **live** (socket broadcast).
4. **Column chips**: each column shows count, total (base currency), and the
   probability-**weighted** total.
5. **Rotting**: a deal sitting past a stage's rotting-days shows **amber**; past
   1.5× shows **red**. (Demo tip: a stage with `rotting_days` set + an old card.)

### 2. Deal lifecycle (C3, §4.2)

1. **Open a deal** → header, stage stepper, details. Move it forward through the
   stepper; each move records history (visible via the API `stage_history`).
2. **Currency / FX (§12.1)**: create a deal in your base currency → FX rate 1.0,
   base amount = value. Create one in another currency *with rates loaded* → it
   snapshots the rate and a base amount that **doesn't drift** if rates change
   later.
3. **Won / Lost**: drag to **Won** → status won, timeline event. Drag to **Lost**
   → you can record a lost reason; it's stored. Move a lost deal back to open/won
   → the stale loss reason is **cleared**.
4. **Reopen**: only **Manager and above** can reopen a won/lost deal (employees
   are refused). Reopening drops it back to the first open stage and records the
   move in history.

### 3. Deal → Invoice (§4.4 — the flagship hook)

1. On a deal with a linked company, click **Create invoice** → a **DRAFT** invoice
   opens in Invoicing, back-linked to the deal; a billing customer is
   auto-created (or reused) from the directory company/person.
2. **Idempotent**: click Create invoice again → you get the **same** invoice, not
   a duplicate.
3. **Discount-correct**: if the deal has products with a discount, the invoice
   bills the **discounted** total (no over-billing).

### 4. Deal → Quote + hosted accept (§4.4 / §19.3)

1. On a deal, click **Create quote** → a DRAFT **QUOTE** opens in Invoicing →
   Quotes (separate from any invoice — a deal can have one of each).
2. **Send** the quote (mints its public link). Open the public link as the
   "customer" → instead of a Pay block you see **Accept quote**.
3. Click **Accept** → the quote flips to **ACCEPTED** and the seller is notified.
4. **Auto-advance (§19.3)**: if the pipeline has a "when a quote is accepted, move
   the deal to…" stage configured, the deal **auto-advances** to it on accept.
   (Set `pipelines.quote_accepted_stage_id` to try it.)

### 5. Custom fields (§9.1)

1. As **Owner/Admin**, define a custom field for deals/contacts/companies (label +
   type: text/number/date/select/…). Employees can't define fields (403).
2. Values live on the record; archiving a field hides it but keeps stored values.

### 6. Saved views (§9.2)

1. Save a filtered/sorted view of a list. It's **private** to you unless you mark
   it **shared**. You see your own + shared views, never someone else's private
   one. Only the **owner** can edit or delete a view.

### 7. ⌘K global search (§19.8)

Press **⌘K / Ctrl-K** anywhere in CRM → type ≥2 chars → grouped results across
**companies, people, and deals**. Enter opens the top hit. Results never include
another workspace's records.

---

## Checkpoint 3 (recap) — Activities & Email Phase A

### 1. Activities & the follow-up loop (§6, C8)

1. On any deal: **Schedule activity** (call/meeting/task/email/note, due date,
   assignee). The deal card shows the next-activity chip; overdue turns coral.
2. **Complete** an activity → the "what's next?" prompt asks you to schedule the
   follow-up right there — the loop never leaves a deal without a next step.
3. **CRM → Activities (C8)**: your day/week lists with overdue rollup; complete
   or reschedule inline.
4. **Assignment pings (§6.3)**: assign an activity to a teammate → they get an
   in-app ping, unless they're in **Do-Not-Disturb** (presence-aware).
5. **Daily digest (§6.4)**: at local 8am each user gets one in-app digest of
   today + overdue items (idempotent — re-runs never duplicate).

### 2. Compose & tracked email (C9/C11, §7.1)

1. Deal → **Emails tab → Compose**. Variables (`{{first_name}}`, `{{company}}`,
   `{{deal_title}}`, `{{sender_name}}`, `{{unsubscribe_link}}`) render per
   recipient; your **signature** (§19.4) is appended automatically.
2. Sent mail shows in the tab with **delivery/open/click badges** (tracking
   pixel + wrapped links). Opens/clicks tick in near-live (60s refetch).
3. **Do-not-contact (§19.5)**: recipients can unsubscribe via the footer link;
   bounces/complaints auto-set DNC. A DNC contact is **hard-blocked** from any
   further send — compose and sequences both refuse.
4. **BCC dropbox**: CRM → Email settings shows your tenant's
   `{slug}-{token}@in.…` address. Auto-BCC it from Gmail/Outlook and every sent
   email files itself onto the matching contact + latest open deal; replies
   also **exit** that person's active sequences.

### 3. Sequences (C10, §7.1)

1. **CRM → Sequences → New sequence**: name, send window (e.g. 09:00–18:00, its
   own timezone), steps with subject/body and **wait days** between them.
2. On an open deal: **Enroll in sequence** (uses the primary contact; disabled
   when the deal has no contact; DNC contacts are refused server-side). One
   active enrollment per contact per sequence — duplicates get a friendly 409.
3. The engine ticks **every 5 minutes**: sends the due step *inside the window
   only* (outside → deferred to the next window opening), max **200
   sequence-sends per user per day** (over → deferred an hour, the step is
   never skipped), then schedules the next step after its wait.
4. **Exits are automatic**: reply (via webhook/BCC), unsubscribe/DNC, deal
   **won/lost** — plus a manual Exit button in the sequence's Enrollments
   drawer. Completed enrollments show as **completed**.

### 4. Templates & signature (CRM → Email settings)

1. **Templates**: create/archive; they appear in the compose modal and are
   usable as sequence-step bodies. Variables resolve per recipient.
2. **Your signature (§19.4)**: per-user HTML, appended to composed AND
   sequence email.
3. **Connected accounts (C21)**: shows the Phase B two-way sync card as
   **Coming soon** — BCC covers logging until Google/Microsoft verifications
   clear. (Security posture already enforced: a connected account row and its
   encrypted tokens are visible **only to the owning user**, not even to other
   admins of the same workspace.)

### Checkpoint 3 ops box (your side)

- In Resend: create a **webhook** pointing at
  `https://<api-host>/api/v1/webhooks/resend`, subscribe to delivery/open/
  click/bounce/complaint/inbound events, and copy its signing secret into
  `RESEND_WEBHOOK_SECRET`. Unverified webhook calls are **rejected in
  production**.
- Verify the **receiving domain** (`in.<your-domain>`) in Resend and set
  `INBOUND_EMAIL_DOMAIN` so the BCC dropbox address resolves.
- No extra process needed: the API drains its own outbox and runs the sequence
  tick + digests **inline** by default. (Set `INLINE_WORKER=false` + run a
  `WORKER_MODE=true` replica only if you want the split later.)

---

## Checkpoint 4 (recap) — Automation & Capture

### 1. Leads inbox (C6, §5.1)

1. **CRM → Leads**: triage tabs (New / Working / Converted / Discarded) with
   per-tab counts. Each row shows a **rule-based score** (§5.3: email +10,
   company +10, form source +10, phone +5, long note +5, UTM +5), the source
   pill, owner and age.
2. A lead whose email matches an existing contact shows a **possible
   duplicate** pill; the convert modal then offers **Link to existing** vs
   Create new — linking never duplicates the person.
3. **Convert** = ONE action: person (link-or-create) + company
   (match-by-name-or-create) + a deal in your chosen pipeline/stage (FX rules
   apply). The lead flips to Converted with a **View deal →** link; converting
   twice is refused.
4. **Discard** needs no reason; the row stays for source analytics.

### 2. Web forms (C13, §5.2)

1. **CRM → Web forms → Create form**: pick fields (name/email/company/phone/
   note, required toggles), title + intro. You get a **hosted page** at
   `/f/<token>` — copy the link or open the preview.
2. Submissions become **leads** with source `form:<tag>`, **round-robin
   assigned** (skips reps whose presence is Out of office) and the owner gets
   an in-app ping. `utm_*` query params on the hosted page are captured.
3. **Spam defense** (test it): a submission with the hidden honeypot filled,
   or made under 3 seconds after page load, is **silently accepted but
   dropped** — bots learn nothing. The 11th submission from one IP within an
   hour is rejected. No CAPTCHAs, no third parties.
4. The **Submissions** drawer shows each capture with its UTM source and the
   lead's current status.

### 3. Workflows (C12, §8) — Manager and above

1. **CRM → Automation**: enable a **starter** in one click (form lead →
   assign + call task; hot lead → ping; deal won → invoice task; bounce →
   notify) or build your own: trigger (lead created, form submitted, deal
   created/stage-changed/won/lost, activity overdue, email bounced/replied) →
   conditions (field/op/value over source, score, status, stage, value…) →
   up to 5 actions (create task, notify, round-robin assign, send template
   email, move stage).
2. **Guards you can verify**: a workflow runs **once per event** (idempotent);
   the same record churning through workflows within a minute trips the
   **loop guard** (run recorded as `skipped`); beta caps are 20 active
   workflows and 2,000 runs/day; **email actions respect do-not-contact** and
   the 200/user/day throttle exactly like human sends.
3. **Run history** shows every run with per-step results — failures show the
   step error and mark the run, later steps still execute.

### 4. Public API & webhook log (C19, §13) — Owner/Admin

1. **Settings → API & webhooks**: create an **API key** (scoped, shown once).
   Then, with `Authorization: Bearer <key>`:
   `GET /api/public/v1/me`, `GET/POST …/people`, `…/companies`, `…/leads`,
   `GET …/deals/:id`, `POST …/deals`. Writes act as the workspace owner and
   flow through the SAME services as the UI — RLS, FX snapshots, dedupe and
   domain events apply. API-created leads/deals carry source `api` (and
   trigger workflows).
2. **Webhook endpoints**: create one (signing secret shown once; SSRF-vetted
   URL), pick events. The **Delivery log** shows each POST with attempts/
   status; failed or exhausted deliveries have a **Redrive** button that
   re-queues the SAME event id/payload (receiver idempotency keys keep
   working). 20 consecutive failures auto-disable the endpoint + notify
   owners.

---

## BETA GATE (THIS hand-off) — Reports, import/merge, polish

### 1. Reports dashboard (C16, §10)

1. **CRM → Reports**: pipeline snapshot (raw vs weighted bars per stage, avg
   days in stage), funnel conversion (how far deals created in the window
   travelled, overall win rate), win/loss by **source ⇄ owner** with lost-
   reason distribution, monthly **sales velocity**, and the **activity
   leaderboard** (calls/meetings/tasks/emails per rep). All sums in base
   currency from the deals' FX snapshots.
2. Empty workspaces get a friendly "not enough data" state — load the sample
   pack (below) to see every chart filled.

### 2. Forecast & goals (C17, §19.6)

1. **Reports → Forecast**: bars per close month — weighted (Σ value×stage
   probability), committed (stages ≥70%), won to date — with the **goal** as
   a dashed line and the gap-to-goal computed. Click a month for the deal
   drill-down.
2. **Reports → Goals**: set a monthly won-revenue target for the **whole
   team** (drives the forecast line) or **per rep** (fills the leaderboard
   progress bar). Target 0 removes a goal. Manager+ writes.

### 3. CSV import (C14) — Manager and above

1. **CRM → Import**: pick contacts/companies/leads → drop a CSV (or paste
   text) → column mapping is **suggested from the headers** (Pipedrive/
   HubSpot-style names recognised) → pick the duplicate strategy (skip /
   update / create; match on person email, company domain+name) → **dry run**
   shows create/update/skip/error counts + first 50 rows, writing nothing →
   run it.
2. **Undo (24h)**: every import is listed under Recent imports — Undo
   retracts exactly what the batch created (soft-delete), never touching
   pre-existing records. Beta cap: 10,000 rows/file.

### 4. Merge & dedupe (C15) + offboarding (§19.7)

1. **CRM → Data hygiene**: the finder lists candidate pairs (same email /
   same domain / similar company name with legal suffixes ignored). Review →
   pick the survivor → merge. Every reference moves (deals, participants,
   activities, emails, sequence enrollments, leads); the loser is
   soft-deleted with a `merged_into_id` tombstone; `crm.contact.merged` /
   `crm.company.merged` publish for webhooks.
2. **Offboarding — reassign work**: pick From/To members, see the live count
   of open deals/activities/leads, apply. Completed work keeps its history.
   Do this before deactivating a member.

### 5. Sample data (C22)

On an empty CRM Overview: **Load sample data** seeds a small labelled pack
(companies, contacts, deals across stages, activities, leads, a template) so
every screen has something to show; **Remove sample data** deletes exactly
those records and nothing else.

### Known beta limits (honest list)

- Import: CSV only (no XLSX), 10k rows, one object type per file.
- Merge finder: exact email/domain + normalized-name matching (no trigram
  fuzzy matching yet).
- Reports window: 7–365 days, single pipeline at a time.
- UI language: English only in this beta; i18n is scaffolded for post-beta.

---

## Security notes (worth a spot-check)

- **Tenant isolation**: everything above is RLS-enforced; a deal/contact/company/
  field/view/search result never crosses workspaces (isolation suite is green).
- **FX correctness**: a non-base-currency deal with no available rate is
  **rejected**, never silently valued 1:1.
- **Concurrent moves**: stage moves are row-locked, so two people dragging the
  same deal at once can't corrupt its history.
- **Public accept endpoint** is unauthenticated-by-signed-token only, throttled,
  idempotent, and only acts on a *sent/viewed quote* (never an invoice). A quote
  past its **valid-until** date cannot be accepted — trying flips it to
  **EXPIRED** (an hourly sweep also retires stale quotes).

## Deferred to a later phase (not in Checkpoint 2)

- **File attachments on records (§19.2)**: the `record_files` table ships now, but
  the upload UI/service is built in **Phase C** alongside email attachments (they
  share one magic-byte upload service).
- Board/list **bulk actions** and the custom-field **form rendering** UI are
  wired at the API/hook level; richer inline UI lands with the activities phase.

## Ops actions (unchanged from CRM_Launch_Actions.md)

Day-1 external actions (Google/Microsoft OAuth verification, DNS, Resend
receiving domain, `OPENEXCHANGERATES_APP_ID`) remain as listed in
`docs/handoff/CRM_Launch_Actions.md`. **PAT rotation** is still on the list.
