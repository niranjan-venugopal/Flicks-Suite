# Round B (2026-08-31) — Linear-style issue composer + CRM import parity

The two feature builds from the founder's pre-freeze list, sequenced after
the Round A bug clearance per their decision ("Bugs first, then the big
builds"). No migration.

## B1 — "I want the thing to be exactly like linear"

The four create paths were four different forms: the project modal had
title/team/milestone, the issues list had title/priority, the board column
and the REST fallback had a bare title input. Creating with a description or
an assignee meant creating first, then opening the issue to fill it in —
exactly what the founder called out.

There is now **one composer** (`components/pm/IssueComposer.tsx`) carrying
**title + description + state + priority + assignee + estimate + labels +
project + milestone + due date**, used everywhere an issue is born:

- the issues list ("New issue" / the C key),
- the project page (project pre-linked, team picker restricted to the
  project's teams),
- every board column's + (state pre-picked),
- the REST kill-switch view (same composer, no engine).

It works in both transports (offline-sync engine or REST), honors the
team's default template (description/priority/estimate prefill; an explicit
pick wins), keeps the "Create more" toggle (property picks survive, title
clears — Linear behavior), and submits on ⌘↵. Description stays a plain
textarea per the founder's decision.

The one missing backend piece was **labels at create**: `CreateIssueDto`
gains `label_ids` (validated exactly like `setLabels` — workspace labels or
the team's own; a foreign id fails the create), written in the same
transaction and named in the created event's sync refs so live clients
converge. Sync mode chains a `set_labels` op after the create, both
idempotent under replay. `engine.createIssue` also learned `due_date`.

## B2 — CRM import to Zoho/HubSpot parity

- **Leads are finally deduped.** The plan branch returned `create`
  unconditionally — the Step-3 strategy screen was a **no-op for the
  most-imported entity**, and re-uploading a leads file silently doubled
  every lead. Leads now match on email like both competitors: `skip` skips,
  `update` patches (name/company/phone/note), and a **discarded** lead never
  blocks a fresh import of the same address.
- **Within-file duplicates are skipped** (first row wins) for all three
  entities — person/lead email, company domain/name — matching Zoho and
  HubSpot, instead of "update" rewriting one record row by row.
- **Downloadable templates** (`GET /crm/import/template?object=…`) — a
  starter CSV per entity whose columns **auto-map 100%** on upload, with
  sample rows showing the expected shapes (HubSpot's sample-file pattern;
  neither of our importers ever had one). Linked from step 1 of the wizard.
- **Errors are finally shown.** The per-row failures were stored since C14
  (up to 200 per batch) and never rendered — users just saw a smaller count.
  The Results step now lists every failed row with its reason and offers a
  downloadable error report CSV.
- **"Drop your CSV" accepts a drop** — the copy had promised drag-and-drop
  since C14 with no handler behind it.
- **Entity pages link in**: Leads / Contacts / Companies each get an Import
  button deep-linking to `/crm/import?object=…` with the entity preselected.
- Zoho/HubSpot header names auto-map (their `Description` column now lands
  in `note`; the rest already did).

## Verification

- `founder-roundB.spec.ts` — 10 tests against real Postgres: labels at
  create (rows + event refs + foreign-id rejection), due date at create,
  leads re-import updating instead of doubling, skip strategy, within-file
  collapse, discarded-lead re-import, and all three templates auto-mapping
  100% through the real parser.
- Full gate: both typechecks, api build, `lint:boundaries`, full jest
  (701 passed; the two failures are the documented IST-midnight attendance
  flake, and `platform-evolution` passes in isolation — its dispatcher
  assertion races the dev API server draining the same outbox), web
  production build, `diagnose-rls.sh` = 0.
- Live Chromium pass: composed an issue with description/priority/assignee/
  label through the real modal and asserted every field in Postgres; the
  project-page composer pre-linked its project; `?object=leads` preselected
  Leads; the template endpoint served the starter CSV; an invalid row
  surfaced in Results with its reason; re-importing the same lead updated
  one row instead of creating a second.

## Still on the founder

Migrations **0054–0057** in Supabase before the next deploy (unchanged from
Round A — the verified script is in chat), and the `pm-diagnostic.sql`
output when convenient.
