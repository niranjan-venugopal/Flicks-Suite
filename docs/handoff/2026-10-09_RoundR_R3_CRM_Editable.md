# Round R · R3 — CRM: closed deals, leads and activities are editable

**Date:** 2026-10-09 · **Migration:** none · **Ships on top of:** `98df300` (Round R · R2) · **Release:** API (`production`) then web (`main`) — the old web keeps working against the new API (every new route is additive; the one behaviour change the old web meets is `POST crm/deals/:id/move` on a *closed* deal answering 403 for a non-manager, which no web screen sends)

Founder's brief (2026-10-07), item **8**: *"Once a deal is won or lost nothing about it can be changed — wrong reason, wrong date, marked won by mistake — and the same for a lead (a typo in the email means discard and re-add) and for an activity (a wrong due date means delete and recreate). Let a manager fix these without losing the history."* R1 (items 2–7) shipped 2026-10-08, R2 (item 1) 2026-10-09; R4 (CRM form builder + forms on deals, item 9) follows.

## 1. What was really wrong

| Area | Before |
|---|---|
| A closed deal | Frozen. The only way out was **Reopen**, which always dropped the deal into the *first* stage. Fixing a deal marked won by mistake meant reopen → mark lost again: a second won / lost event (automations and sequences fired twice), two extra stage-history rows, and the close date became *today* — so win-rate, cycle time and the Closed view reported the wrong month. The lost reason and note could not be touched at all. |
| Who could move a closed deal | `POST crm/deals/:id/move` never looked at the deal's status. Reopen is manager-and-above, but any CRM editor (every employee has CRM *edit* by default) could call `/move` onto an open stage and reopen a closed deal through the back door — or onto the *other* terminal stage. |
| Details of a closed deal | The API already accepted `PATCH` for title / owner / source / company / primary contact; the Details tab showed them read-only. |
| Leads | No edit route. A wrong email, phone or owner on a lead meant discard + re-add, losing the source and the score history; a lead discarded by mistake could never come back. |
| Activities | No edit route. A wrong subject, due time or assignee meant delete + recreate; a task completed by accident stayed done, and the deal's "next step" went empty. |

## 2. What changed

### Deals (`crm/deals.service.ts`, `deals.controller.ts`)
| Change | Detail |
|---|---|
| `POST crm/deals/:id/outcome` (manager and above) | `{ outcome: 'won' \| 'lost', lost_reason_id?, lost_reason_note?, closed_at? }`. **Switching the verdict** is a real stage move onto the pipeline's Won / Lost stage: one history row, `crm.deal.stage_changed` + `crm.deal.won { deal_id, value_base }` / `crm.deal.lost { deal_id, lost_reason_id }` (so sequences, workflows and webhooks react exactly as they would to a fresh close), a board push after commit; the close *moment* is kept (`lost_at` inherits the old `won_at` and vice versa) unless a date is given; marking won clears the lost reason and note. **Same verdict** = a plain update: edit the reason / note, or correct the date, with `crm.deal.updated` — no second won / lost event, no history row. Audit `crm.deal.outcome_change` / `crm.deal.outcome_update` with the before / after state. |
| Refusals | An open deal ("close it from its stage first"); a date in the future; an unparseable date; a lost reason that is not this workspace's (checked inside the tenant transaction — a bare id is never trusted); a rep (403); another company's deal (404). Back-dating is allowed on purpose, even before the deal was entered (reports clamp the cycle time at 0). |
| `POST crm/deals/:id/reopen` takes `{ stage_id? }` | Reopen into a **chosen** open stage of the deal's pipeline (default: the first). A won / lost stage or a stage of another pipeline is refused. `crm.deal.reopened` now carries `to_stage`; the audit row records from / to / previous status. |
| `POST crm/deals/:id/move` on a closed deal | Refused for a non-manager ("Only managers and above can move a closed deal — ask them to reopen it or change its outcome"). The role is the **live seat's** — `RolesGuard` now hands the live membership role to every tenant handler (ranked and unranked routes), so a demotion bites on the next request; internal callers (quote accepted → auto-won, workflow *move stage*) pass none and are unchanged. Moving an **open** deal is untouched. |
| `PATCH crm/deals/:id` | Still open to every CRM editor on a closed deal (title, owner, value, source, company, contact, expected close) — the verdict itself is the manager's call. |

### Leads (`crm/leads.service.ts`, `leads.controller.ts`)
| Change | Detail |
|---|---|
| `PATCH crm/leads/:id` | First / last name, company, email, phone, note, source, **owner**, **status** (`new` ↔ `working` only). A converted lead ("edit the contact it became") and a discarded one ("restore it first") are refused; the owner must be an active member; the score is recomputed; a lead moved to *Working* with nobody on it becomes the editor's (the same rule as *Claim*); assigning an owner implies *Working*, clearing one implies *New*. Audit `crm.lead.update`, event `crm.lead.updated`. |
| `POST crm/leads/:id/restore` | Only from `discarded`: back to *New* (no owner) or *Working* (owner kept). Audit `crm.lead.restore`, event `crm.lead.restored`. |

### Activities (`crm/activities.service.ts`, `activities.controller.ts`)
| Change | Detail |
|---|---|
| `PATCH crm/activities/:id` | Subject, notes, due time, type (task / call / meeting — a note cannot become scheduled and a scheduled one cannot become a note), assignee (active member; the new assignee is pinged in-app), call outcome. The deal's `next_activity_at` / `last_activity_at` are recomputed. Audit `crm.activity.update`, event `crm.activity.updated`. |
| `POST crm/activities/:id/reopen` ("Not done") | Clears `completed_at / completed_by` on a task / call / meeting (idempotent); a note is refused; the deal's next-step stamp comes back. Audit `crm.activity.reopen`, event `crm.activity.reopened`. |

### Events
`DOMAIN_EVENTS` gains `crm.lead.updated`, `crm.lead.restored`, `crm.activity.updated`, `crm.activity.reopened` (webhook subscriptions can pick them; the developer page's common-events list adds `crm.lead.restored` and `crm.deal.reopened`).

### Web
| Screen | Change |
|---|---|
| Deal page header (closed deal) | Manager and above: **Mark lost… / Mark won** (`OutcomeDialog`: reason pills + *Other* with a note, optional date that keeps the current one when left alone), **Edit reason** (lost deals), **Edit date** (calendar, no future days), **Reopen…** (`ReopenDialog`: pick any open stage of the pipeline). Everyone else sees the outcome and *"Manager and above can change the outcome"*. Every action toasts its result, including the API's refusal text. `components/crm/outcome-dialogs.tsx`. |
| Deal page · Details tab | Title, **owner** (picker from `/crm/reps`), **source**, **company** and **primary contact** (search-as-you-type pickers with *Clear*), expected close and value are editable on open *and* closed deals; "Closed on" and "Lost reason" are read-only and say *edit from the header*. The note composer no longer sends an unknown key (which the strict validation pipe would have refused). |
| Deals → Closed view | Row actions for manager and above: **Mark lost / Mark won**, **Edit reason** (lost rows), **Reopen…** into a chosen stage; the row updates in place. |
| Leads | **Edit** on New / Working rows (fields, owner, New ↔ Working); **Restore** on Discarded rows. |
| My activities | **Edit** on every row (subject, type, due, assignee, notes — a note offers subject + notes only); **Not done** on a finished task / call / meeting. |
| Query cache | `invalidateDealScopes` refreshes the board, the deal, the Closed list, forecast and reports after any verdict / reopen / edit. |

## 3. Migration
None. No schema change; `pnpm sync:supabase` is a no-op for this release.

**Order:** push `production` (API) → push `main` (web).

## 4. Proof
- **Spec** `founder-roundR-r3-crm.spec.ts` — 12 tests against the real database (review fixes folded in: the lead contradiction, the finished-activity ping, the company-change contact rule): won → lost (history row, reason, `crm.deal.lost`, board push, the close moment kept, audit before / after), lost → won (`crm.deal.won` with the base value, reason cleared), same-verdict reason edit (no second event, no history row, date untouched), date correction (what the reports read moves; switching with a date uses it), refusals (open deal, future / invalid date, foreign reason, rep, other company; back-dating allowed), reopen into a chosen stage (default first; won / foreign-pipeline stages refused; rep refused), `/move` role gate (rep on open OK, rep on closed 403, manager OK, internal callers unchanged), `PATCH` on a closed deal, lead edit (fields, owner, status, score, owner ↔ status implications, the editor-owns-a-working-lead rule), discarded refused until restored / restore to New or Working / only discarded restore, activity edit (subject, notes, due, assignee ping, type guard, deal stamps), mark not done (deal next-activity back, notes refused, idempotent).
- **Full gate:** API typecheck · API build · Jest **1481 / 1481** (97 suites; `pm-perf`'s search budget tripped once at 366 ms while the web build was compiling on the same box and passes alone at 128 ms) · `lint:boundaries` 0 violations (369 modules) · web typecheck · web production build · `diagnose-rls.sh` `leak_with_bogus_context = 0`.
- **Live** (`verify-roundR-r3.mjs`, production web build + real API + Postgres + s3-mock): **118 / 118**. A manager on the deal page: Mark lost… (confirm disabled until a reason) → *Lost on … · Price · note*; Edit reason → *Other* + note (reason id cleared, date and history untouched); Edit date through the calendar to the 15th of last month (`lost_at` moves, reason kept, page shows it), then to today (accepted at any hour); Mark won (the corrected moment becomes `won_at`, reason cleared); Reopen… into stage 2 (dialog lists only the open stages; the header returns to the open-deal controls). Details tab on a won deal: title, owner, source, company and primary contact saved through the pickers; moving it to a second company drops the contact with a toast that says so; a cleared title reverts in place; "Closed on" read-only. Closed view: *Mark lost* from the row (reason, row updates), *Reopen…* from the row (leaves the list). An employee: no buttons, the caption, API 403 on `/outcome`, `/reopen` and `/move` of a closed deal, `/move` of an open deal still 201, `PATCH` 200; another company's owner: 404 on all seven new / changed routes; a foreign reason id 400, a future date 400, an open deal 400, an unknown body key 400. Leads: Edit (name, phone, company; Working with nobody on it fills in the editor, *Unassigned* flips to New, naming the rep flips to Working), it leaves New and shows in Working with the rep; Restore from Discarded → *Back in New*; `status: converted` refused; *Working* + *Unassigned* through the API → 400. My activities: Edit (subject, type → call, assignee → rep with an in-app ping, notes), a finished task offers no assignee and re-attributing it through the API never pings, Not done on a finished task (the deal's next-activity stamp follows), a note offers subject + notes only, a note cannot be reopened, a task cannot become a note. Audit rows for every new action. Screenshots in the session scratchpad (`shots-roundR-r3/`).
- **Cross-company attack harness** (`audit/cross-tenant.mjs`): **106 / 106** over 215 cross-company requests, unchanged.
- **Adversarial review** (four lenses — deal state machine, leads / activities, web, regressions — every finding challenged by two skeptics): **11 findings, 9 fixed before release, 2 kept as notes.** What was fixed:
  - **(high) Picking *today* before local noon was refused as "in the future".** The dialog turned a picked day into local noon; the server refuses anything after now + 60 s. Today is now sent as *right now*; earlier days stay at local noon. Live check: the date dialog accepts today at any hour.
  - **(medium) Lead edit: *Unassigned* + *Working* quietly made the editor the owner.** The modal now mirrors the API's rules visibly — naming an owner flips the status to Working, *Unassigned* flips it to New, Working with nobody on it fills in the editor — and the API refuses the literal contradiction (400 "A lead in Working needs an owner — pick one, or move it to New") for any other client.
  - **(medium) Company / contact pages kept stale deal lists** after a Details-tab company or contact change — `invalidateDealScopes` now refreshes the company and contact query trees too.
  - **(low) `/move` on a closed deal ranked the role baked into the 15-minute token** while `/reopen` and `/outcome` rank the live seat. `RolesGuard` now hands the live role to the handler on every tenant route (ranked and unranked), so a demoted manager loses the closed-deal move on the next request, like the other two.
  - **(low) A malformed id (`stage_id: "abc"`) on the new routes was a 500** — `@IsUUID()` on `stage_id`, `lost_reason_id`, `owner_user_id`, `assignee_user_id` (move, reopen, outcome, lead update, activity update); live check: 400 on all five.
  - **(low) Moving a deal to another company left a primary contact of the old company behind** — the API drops a mismatched primary contact when the company changes (a contact with no company, or the same company, stays), and the toast says *"pick one again"*.
  - **(low) Re-attributing a finished activity pinged "assigned to you"** — the modal hides the assignee on completed items and the API never pings for them.
  - **(low) The company / contact pickers fetched the whole directory on mount and once per keystroke** — the search only exists while a picker is open, debounced 250 ms.
  - **(low) A text field kept its draft after the server normalised it, and a cleared title silently never saved** — fields follow the refetched value; a refused value reverts in place.
  - Kept as notes: the web gates the closed-deal buttons on the stored role (reload after a role change; the API decides either way) and the new `crm.lead.restored` webhook chip exists on the new web only — the release order (API first) covers it.

## 5. Residuals / notes for the next round
- **Flipping a verdict re-fires the win / loss automations** (sequences exit, workflows on `crm.deal.won` / `lost`, webhooks) — on purpose and said so in the dialog. A deal flipped won → lost → won fires `crm.deal.won` twice over its life; anything that must run once per deal should key on the deal id.
- Activities are edited from **My activities** (every task assigned to or completed by the person); the deal timeline keeps its complete / log actions. "Not done" keeps a recorded call outcome — clear it from Edit if it was wrong.
- An **archived** lost reason is still accepted by id (the picker only offers active ones); the label shows as before.
- The web gates the closed-deal actions on the **stored** role (same as the existing Reopen / delete buttons): a person whose role changes mid-session sees the right buttons after a reload; the API ranks the live seat on every call either way.
- `PATCH crm/deals/:id` on a closed deal remains open to every CRM editor (title, owner, value, source, company, contact) — only the verdict, reason, date and reopen are manager-and-above. Tighten in a later round if the founder wants closed deals fully locked for reps.
