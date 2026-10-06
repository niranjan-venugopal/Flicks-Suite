# Round P · R3 — Company policies: write or upload, publish, employees must agree

**Date:** 2026-10-05 · **Type:** feature (new module) · **Migration:** 0067 (`docs/handoff/apply-0067.sql`) · **Status:** see §7

Founder's ask: *"One more client wanted to add the Company policies to their organisation. Like a policy document which a user should be able to agree on during onboarding, when they self-onboard. These policies can be updated by the HR manager and the Owner or any position that's given access by the Owner. They can create new policies and ask the employees to agree when it's ready, or even just upload a PDF as the company policy document."* Decision: asking employees to agree = a **blocking screen at their next sign-in** (like the terms re-acceptance screen) plus a step in self-onboarding.

## 1. What the customer gets

**For HR / Owner — Settings → Policies**
- Create a policy by **writing it** (the same rich-text editor as Projects) or by **uploading a PDF** (10 MB max, real PDFs only). Give it a title and an optional category.
- Choose who it applies to: everyone, or only managers / employees / finance / owners and HR.
- Choose whether employees must agree to it (default yes).
- **Publish** when ready. Everyone it applies to gets a notification and an email. Editing a published policy does nothing until you publish again; when you re-publish you choose whether everyone must agree **again** (a new version) or whether the change is minor.
- See **who has agreed and who is pending**, remind the pending people (at most once an hour), export the list as CSV, and archive a policy when it no longer applies.
- **Give someone else the job**: Settings → Access now has a **Policies** column. Any member the Owner grants "edit" can manage policies; "view" can read the lists.

**For employees**
- At the next sign-in a **"Company policies" screen** appears before the app (after the Terms screen if that is also due): read the policy, tick "I have read and agree", continue. Several pending policies come one at a time ("Policy 1 of 2"). It cannot be dismissed.
- New hires get a **"Company policies" step** in the self-onboarding wizard before Review.
- **Policies** in the personal navigation lists every applicable policy with "Agreed on <date>" and their own history. PDFs open inline and always have an "Open PDF" link.

## 2. How it works

- Tables `company_policies` (title, category, kind rich_text|pdf, body_md, file_key…, **version**, status draft|published|archived, requires_acknowledgement, applies_to_roles) and `policy_acknowledgements` (policy, **policy_version**, user, employee, acknowledged_at, ip_hash, user_agent; unique per tenant + policy + version + user). Both have ENABLE + FORCE RLS, tenant policies and `flicks_app` grants.
- "Pending for a person" = published, requires acknowledgement, the person's active membership role is in `applies_to_roles` (null = owner, admin, manager, finance, employee; never guest/auditor), and no acknowledgement row for the current version.
- Publishing a published policy with "ask everyone to agree again" bumps `version`; old acknowledgements stay as history.
- PDFs go to R2 under `tenants/<tenant>/policies/<policy>/<uuid>.pdf` (magic-byte checked, uploaded outside the tenant transaction, previous object deleted after commit); readers get a **15-minute signed URL**. The production CSP `frame-src` reads extra origins from `NEXT_PUBLIC_FILES_FRAME_SRC` so the inline PDF viewer works for the R2 host; "Open PDF" works regardless.
- Access: a new module key `policies` in the grant system (`GrantModule`, `MANAGED_ACCESS_MODULES`, `PoliciesGrantGuard`), full access for owner/admin, nothing for other roles unless granted.
- The gate (`components/policies/PolicyGate.tsx`) is a copy of the terms re-acceptance overlay, mounted right after it in the app layout, fed by `GET /policies/pending`.
- Notifications and emails (`policy-published`, `policy-reminder`) are best-effort; the data export bundles include acknowledgements (and policies for the org export).

## 3. API (all under `/api/v1/policies`)

| Route | Who | Purpose |
|---|---|---|
| `GET /policies` | policies:view | list with signed/pending counts |
| `POST /policies`, `PATCH /:id` | policies:edit | create / edit (markdown cleaned) |
| `POST /:id/file` | policies:edit | upload a PDF (multipart `file`) |
| `POST /:id/publish` `{ require_reacknowledgement? }` | policies:edit | publish / re-publish (optionally new version) |
| `POST /:id/archive` | policies:edit | archive |
| `GET /:id/acknowledgements[?format=csv]` | policies:view | signed / pending |
| `POST /:id/remind` | policies:edit | notify pending (1/hour → 429 `REMIND_TOO_SOON`) |
| `GET /policies/pending` | any member | what I still have to agree to |
| `GET /:id` | member (published + applicable) or view | detail with `file_url` |
| `POST /:id/acknowledge` `{ version }` | any member | agree (idempotent; stale → 409 `POLICY_VERSION_STALE`) |
| `GET /policies/me/history` | any member | my acknowledgements |

## 4. Founder action — release order

1. Run **`docs/handoff/apply-0067.sql`** in the Supabase SQL editor (service role; idempotent).
2. Push `production` (API), then `main` (web).
3. Optional: set `NEXT_PUBLIC_FILES_FRAME_SRC` on Vercel to the API's `R2_ENDPOINT` value (signed links are served from that host, not the public files domain; the full value can be pasted — only its origin is used, since 2026-10-06), then redeploy the web so PDFs show inline; without it the "Open PDF" link still works.

## 5. Tests

`policies.spec.ts` (service-level, real Postgres: pending rules by role/status/version, idempotent acknowledge, stale version, re-acknowledgement version bump, acknowledgements split + CSV, remind throttle, archive, cross-tenant 404, publish validation, markdown cleaning, DTO validation, PDF magic-byte and size checks) · `founder-roundP-r3-policy-notifications.spec.ts` (templates, data export with/without the facade).

## 6. Follow-ups
- Per-version body history (today the audit log keeps before/after; a `policy_versions` table would let HR diff versions).
- Department targeting (role targeting only in v1).
- A dashboard card "N people still have to agree" for HR.
- `GET /policies/me`: a published policy with "must agree" switched off is visible to HR only — employees have no list of informational policies yet (the `/policies` page is pending ∪ history).
- The FAM console has no Policies kill-switch toggle in the UI (the API `MANAGED_MODULES` entry exists).
- The same magic-byte sniffer (`file-type`) is also called unguarded for avatars/logos (`media.service.ts`) and project files (`pm/files.service.ts`): a truncated header there answers 500 instead of 400. Harmless (the user retries) but worth the same two-line guard.
- `Access-Control-Expose-Headers: Content-Disposition` on the CSV route so the browser uses the server's filename (today the web falls back to `<title>-acknowledgements.csv`).

## 7. Gate and live verification

**Build process.** Four implementers (API module + migration + access model · API email templates + data export + allowlists · web HR settings · web employee gate + onboarding step), three adversarial review lenses each, one fix pass each: 19 agents. The reviews caught three things worth recording: editing a published policy could leave it with nothing to read behind the non-dismissible gate (now a 400 — "Upload the PDF first" / "A published policy needs its text"); the gate had no exit when a PDF policy came back without a signed URL or when the policy was archived while the reader was open (the gate now skips unreadable policies and a 404 on agree drops the policy from the list); and the new settings rail filter had hidden Billing and Notifications from non-admin seats (they are open to everyone again).

**Gate (all green):** API typecheck · nest build · **Jest 86 suites / 1 303 tests, all passing** (one pre-existing spec, `founder-round19.spec.ts`, pinned the exact module-access map and now includes `policies`) · module boundaries (352 modules, 0 violations) · web typecheck · web production build · RLS probe `leak_with_bogus_context = 0`. Migration 0067 applied locally twice (second run NOTICE-only) and once through `apply-0067.sql`.

**Live verification** (`scratchpad/verify-roundP-r3.mjs`, production web build, real API, real Postgres, S3-compatible mock for R2): **51 pass / 0 fail / 0 skip** across 5 scenarios, plus the HR-settings harness (`verify-r3-web-hr.mjs`): **66 pass / 1 stale assertion** (it expected Billing to be hidden from a manager's settings rail — the review fix deliberately keeps it visible).

| # | Scenario | Result |
|---|---|---|
| 1 | HR creates a rich-text policy (script tag stripped) → not pending while draft → employee cannot POST (403) → publish notifies 28 people → pending for the employee with body, HR list shows 0 signed / N pending | pass |
| 2 | Employee's next sign-in is blocked by the gate on the dashboard → reads, ticks, Agree → 201, gate gone, acknowledgement row with version + employee id → agreeing again is idempotent, a stale version is 409 → history lists it → HR roster: employee signed, manager pending → CSV export → `/policies` shows "Agreed on" | pass |
| 3 | Remind → 28 reminded; second remind within the hour → 429 REMIND_TOO_SOON → PATCH keeps v1 → re-publish with "agree again" → v2 pending for employee and manager → a managers-only policy is pending for the manager only → archive clears it | pass |
| 4 | PDF policy: upload → stored with name/size; a PNG disguised as .pdf → 400 (**was a 500**: the magic-byte sniffer throws on a truncated header — now caught, spec added); pending carries a 15-minute signed `file_url`; the gate runs "Policy 1 of 2" → agree → "Policy 2 of 2" (the PDF) with the inline viewer on the files origin (0 CSP violations with `NEXT_PUBLIC_FILES_FRAME_SRC` set at build time), "Open PDF" link, agree checkbox arms after the frame loads | pass |
| 5 | Settings → Policies list + editor (Signed / Pending, Remind, Export CSV); a manager is 403 until the Owner grants `policies: edit` (`PATCH settings/members/:id/grants/policies`) → `/auth/me` carries it → list 200, create 201, sidebar "Manage policies", Settings → Policies opens → revoke → 403 again; a fresh invitee's wizard lists "Company policies — Read & agree" as step 5 of 6 | pass |

Screenshots in the session scratchpad: `rp3-gate`, `rp3-gate-pdf`, `rp3-employee-policies`, `rp3-settings-policies`, `rp3-policy-editor`, `rp3-manager-settings-policies`, `rp3-onboarding-step`, `r3hr-*`.

**Worth knowing before the first customer uses it**
- The person who publishes an "Everyone" policy is asked to agree too — the gate appears for them on their very next page. That is the founder's "everyone must agree" rule, not a bug; agree once and it is gone. Auto-recording the publisher's agreement is a one-line change if customers find it odd.
- Publishing a policy whose audience is in the hundreds sends the notifications before answering (chunks of 5); fine at SMB sizes, a queue later.
- Draft policies show 0 / 0 in the list (counts are only computed once published).

Harness notes: leftover published policies from an earlier harness run would sit in front of the new one in the gate ("Policy 1 of 2"), so the harness archives its own policies at start and end. The seed tenant keeps the archived harness rows.
