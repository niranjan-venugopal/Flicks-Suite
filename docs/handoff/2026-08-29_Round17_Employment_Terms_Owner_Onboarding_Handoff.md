# Round 17 handoff — editable employment terms · owner/admin onboarding without HR review

**Date:** 2026-08-29 · **Branch:** `claude/handoff-patch-deploy-0g4sp6` → `main` + `production`
**Migration to apply:** none — the columns have existed since `0001`; this round
adds the missing write paths.
**Gate at handoff:** api typecheck ✓ · api build ✓ · full jest ✓ ·
boundaries ✓ · web typecheck ✓ · web build ✓ · RLS `leak_with_bogus_context = 0` ✓ ·
live Chromium pass ✓

Read after `2026-08-28_Round16_Designation_Department_Autofill_Handoff.md`.

## The two founder items

1. **"Probation, Confirmed & Notice period … are not able to be updated. Owner
   (Admin), HR can update these things while onboarding or after onboarding."**
2. **"When Admin or the Owner role is getting onboarded, then the HR review
   should not be shown, also the Documents. When it's the first user or the
   Admin user (Owner) then he should be the one in charge."**
   Followed by (round 17.1): **"Can you also have the Admin (HR) also with
   incl. Documents and submit for review (to owner)."** — so the shortcut is
   **owner-only**; HR admins keep the full flow and are signed off by the
   owner.

## Item 1 — why nothing could be edited

`employees.probation_end_date`, `employees.date_of_confirmation` and
`employees.notice_period_days` shipped in migration `0001`, and the employee
360° Employment card has always rendered them. What never existed was a **write
path**: neither `UpdateEmployeeDto` nor `InviteEmployeeDto` carried the fields,
no form collected them, and no service ever set them. The "30 days" everyone
sees is the *column default* applied at insert; the dashes are NULLs nobody
could fill.

### What shipped

- `UpdateEmployeeDto` gains `probationEndDate`, `dateOfConfirmation`
  (`@IsDateString`) and `noticePeriodDays` (`@IsInt`, 0–365); `updateEmployee`
  maps all three into its patch. The `@Roles('admin')` guard is hierarchical,
  so Owner **and** HR Admin already pass — no guard change.
- `InviteEmployeeDto` gains `probationEndDate` + `noticePeriodDays` only
  (a new hire is not confirmed yet — confirmation date stays edit-only). The
  insert keys notice period on `!== undefined` so an explicit **0** persists;
  omitting it still falls through to the column default of 30.
- Web: the **Add employee** form gains "Probation ends" (house `DateField`) and
  "Notice period (days)"; the 360° **Edit profile** dialog gains all three.
  Both validate 0–365 client-side before sending.
- **Audit hole closed while in here:** `updateEmployee`'s before/after snapshot
  was a hand-maintained five-field list that already omitted `employeeCode`,
  `departmentId`, `locationId`, `reportingManagerId`, `employmentType` and
  `dateOfJoining` — every org/employment edit was invisible in the audit trail.
  The snapshot now carries those six plus the three new terms.

These are employer-set terms, so they take the **direct-apply** path
(`PUT /employees/:id`) like `dateOfJoining` — not the employee-confirmed
change-request flow (`EditDetailsDialog` / migration `0049`), which is
untouched.

## Item 2 — why the founder was pushed into an HR review

`onboarding.createTenant` seeds the founder's employee row with **no
`custom_fields` at all**, so `/employees/me/onboarding-status` reports step 0
and `submittedForReview: false`. The app-layout guard sends anyone in that state
to the wizard — which was one-size-fits-all: a Documents step that only says
"uploads coming soon", and a Review step that submits for HR approval. For the
founder that queue contains nobody: `getOnboardingQueue` excludes the caller's
own row *and* anyone already `status='active'`, and `approveOnboarding` throws
on self-approval. He was being asked to wait for a reviewer who cannot exist.

### What shipped

**Wizard (web).** The **owner** gets **4 steps** — Personal info · Identity ·
Bank & statutory · Review. Documents is dropped for them; the Review step keeps
the summary and the DPDP consents but reads **"Confirm your details"** with the
button **"Finish setup"**, and its banner says finishing activates the profile
with no review. **Every other role, HR admins included, is unchanged**
(5 steps with Documents, "Submit for review").

The step list previously hardcoded `5` and the step indices in seven places,
with the UI index doubling as the server `:step` number. `StepMeta` now carries
an explicit `key` and `serverStep`, and every site derives from the list:
resume-clamp, advance-clamp, `AuthLayout total`, "Step X of N", the render
switch, and the button label. A clamp effect guards the moment `/me` resolves
and the list shrinks 5 → 4.

**Server (authoritative).** `submitOnboardingStep` looks up the **caller's
membership role inside the transaction**: when the person completing is an
`owner` finishing *their own* record, it

- sets `employees.status = 'active'` and activates the membership
  (`accepted_at` coalesced),
- **skips** the reviewer fan-out and the reporting-manager email,
- still emits `employees.directory.changed` (activation changes the roster),
- audits as `employee.onboarding_completed` with `selfActivated: true`.

Because the decision is derived server-side from the role, an ordinary employee
posting `submitForReview: true` cannot skip review. Admin, finance and manager
all keep the full review path. The terminal state reuses the existing flags
(`onboarding_submitted_for_review` + `onboarding_completed_at`, step 5), so the
layout guard, the employee-list "onboarding complete" column and NPS
eligibility keep working with **no new fields**.

**Reviewer routing (round 17.1).** When the submitter holds `admin`, the
in-app fan-out targets the **owners only** — a peer HR admin must not sign off
a colleague's file. If the workspace has no active owner the query falls back
to the full owner+admin pool, so a request can never land nowhere (house rule
8). Ordinary joiners still notify owners *and* admins: reviewing them is HR's
job. Note the People → Onboarding queue itself is unchanged — it still shows
every pending row (minus the caller's own) to any admin and above, so a second
HR admin could still approve a colleague from that screen. Locking approvals
of HR staff to owners is a queue/guard change, flagged to the founder rather
than assumed.

**Bundled bugfix.** Send-back (reject) notifications deep-linked to
`/employees/me/onboarding` — a route that has never existed, so every "please
resubmit" link 404'd. Both the in-app link and the email now point at
`/onboarding/employee`.

## Tests

New `apps/api/src/__tests__/founder-round17.spec.ts` (10 cases): the three terms
persist including a zero notice period, the widened audit snapshot, invite
pre-fill + the 30-day default, owner self-completion (activated, nobody
notified, absent from the queue), idempotency on a founder-shaped row, an HR
admin submitting for review (no self-activation, notified to the owners and
**not** to a peer admin, lands in the owner's queue), an ordinary employee
still fanning out to owners *and* admins, admin edits never completing anyone,
and the send-back links.

`founder-round5.spec.ts` changed: its submitter fixture was a **second owner**,
which now self-completes by design. It is reseeded as a **manager** — the most
senior role that still needs someone else to approve it — so every contract that
spec exists for (fan-out, queue visibility, self-approval Forbidden) still holds.

## Deploy checklist

1. Deploy API + web. **No SQL this round.**
2. Smoke: create a workspace → the owner's wizard shows 4 steps with no
   Documents and "Finish setup" → finishing lands on the dashboard and stays
   there on reload, with nothing in People → Onboarding. An HR admin signing
   in gets 5 steps with Documents and "Submit for review", which reaches the
   owner.
3. Smoke: People → Add employee with a probation date + notice period → the new
   hire's Employment card shows both; Edit profile sets "Confirmed on".

## Known follow-ups (unchanged from round 16)

- 360° Leave and Timesheet tabs are still placeholders.
- Geofence v2 (pending-approval punches, IP allowlist, `work_mode = 'field'`).
- `hr_documents` backend (the Documents step is still a placeholder for
  non-admin joiners; HR collects those over email).
- `terminateEmployee` still doesn't use `notice_period_days` to compute a last
  working day — now that the field is editable, that calculation is worth doing.
