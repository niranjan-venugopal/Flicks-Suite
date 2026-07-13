# Testing Guide — Sprints 24–31 (PRD v5: CRM + architecture evolution → Beta)

Phase A: Sprint 24 **architecture evolution** (outbox event bus, worker split,
ModuleGrantGuard, public-API framework, webhooks, boundaries lint) · Sprint 25
**directory kernel** — Contacts/Companies (§3) → **Checkpoint 1**. Phase B:
Sprints 26–27 **deals** — pipelines, kanban, FX, deal→invoice/quote, custom
fields, saved views, global search (§4, §9, §12.1, §19.1-3/8) → **Checkpoint 2**.
Later phases add activities/email, automation/capture, reports (Checkpoints 3–5).

This guide grows per phase. **Checkpoint 2 is the current hand-off.**

## 0. Environment prep

```bash
git pull && pnpm install
# Apply the new migrations (idempotent, additive — safe to re-run):
pnpm sync:supabase          # applies packages/db/drizzle/0030–0033
# OR re-run the demo bootstrap (also idempotent; carries the 0030–0033 deltas
# inline + seeds a Sales pipeline, stages, lost reasons, and the crm toggle):
bash scripts/setup-demo.sh
pnpm dev
```

New optional env (`apps/api/.env`) — all blank-safe for testing:

```
OPENEXCHANGERATES_APP_ID=      # set to snapshot real FX on non-base-currency deals
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

## Checkpoint 2 (THIS hand-off) — Deals, pipeline, suite hooks

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
