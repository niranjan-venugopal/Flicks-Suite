# Round P · R1 — Go-live fixes (resend invite, re-adding people, status pills, numbering, quotes, hardening)

**Date:** 2026-10-04 · **Type:** fixes, no migration · **Status:** see §7 · **Why now:** ten new companies onboard on 2026-10-05; two clients reported invite problems; a readiness sweep of every module found the items in §2.

Round P is the founder's "fine-tune and complete the existing modules" brief. It ships in daily releases: **R1 (this note)** fixes only · R2 invoice numbering formats · R3 company policies · R4 asset register · R5 project icon library. The plan with all five lives in the session plan; each release gets its own handoff.

## 1. What the clients reported

1. *"They need a Resend Invite button … Also if the same person is onboarded again with the same records it should work, right now it's not working."* — There was no resend anywhere, and re-adding an email that already had an employee row (live, mid-wizard or removed) failed with the raw database text `duplicate key value violates unique constraint "employees_tenant_work_email_unique"`.
2. Everyone invited showed as a grey **Inactive** in the Employees list because the list keyed on status values the API never produces.

## 2. What changed

### People / onboarding
- **Resend invite** — `POST /employees/:id/resend-invite` and `POST /employees/resend-invites` (all pending, or a list). Button on the Employees list row, the employee page header, Settings → Members (invited seats) and a "Resend all pending (N)" header action with a confirm. A fresh 7-day link is issued (earlier links stay valid — invite links are per person, not per workspace), the welcome email goes out as a reminder, one resend per person per minute (429 with a clear message), and every send is now written to `employee_invitations` (first use of that table; `resent_count` is the ordinal).
- **Re-adding the same person** now works instead of a raw 500:
  - still waiting on their invite → their details are updated from the form and the link is re-sent ("Invite re-sent to …");
  - removed earlier (archived) → **re-hired in place**: same record, history and bank/statutory details kept, onboarding reset, seat re-invited;
  - removed with nothing behind them (hard delete) → new record and the old deactivated seat is re-invited (previously the person could never sign in again);
  - already active → clear 409 "already an employee (code) — open their profile";
  - holds a guest/auditor seat → 409 asking to remove that seat first.
  CSV import rows that match a pending invitee are **skipped** with "already invited — use Resend invite" (no mass re-mailing).
- **Restore** (People → Removed) relinks the seat (active if they had accepted, invited otherwise) and Settings → Members → Reactivate links the employee record — neither is a dead end any more.
- A failed invite no longer leaves an orphan platform user behind (tenant checks run before the user is created). Any unique-constraint violation anywhere in the API now returns **409 "A record with the same value already exists"** (friendly text for work email / employee code) instead of Postgres text.
- **Employee status pill** is derived properly: **Invited → Onboarding → Awaiting approval → Active**, plus On leave / Notice period / Separated / No access; header "N active · N invited · N awaiting approval"; filters match; the list fetches up to 100 (was silently 20) and shows "first 100 of T" when larger.
- Add employee: the never-sent "Send invite immediately" checkbox and Annual CTC field are gone; the false "Saved as draft" toast is gone; the suggested code comes from the API (`GET /employees/next-code`, considers removed people too); the manager list is no longer capped at 20.
- **Owners / HR admins can "Skip for now"** on the personal onboarding wizard (`POST /employees/me/onboarding/defer`). They land on the dashboard with a "Finish setting up your profile" card; employees still complete the wizard.
- Welcome email greets the founder by name (it used the email prefix).
- New companies get the curated India holiday list for the signup year (Holi, Eid, Dussehra, Diwali, Good Friday … ) instead of six fixed dates. Existing companies are untouched — import the rest from Settings → Holidays → country presets.

### Leave
- Requests that exceed the days left are **blocked** ("You have N day(s) of <type> left for this year"); unpaid / loss-of-pay and untracked types are exempt; the apply form shows the remaining days and the exact message. Concurrent double-submits are serialised.

### Invoicing
- **Numbering settings bug:** choosing any financial-year format other than `26-27` showed the settings as reset and could restart the series at 0001 (the current row was looked up with a hard-coded label and a parallel row was created). The row is now found by its FY window and updated in place; the first invoice of a new FY can no longer race (advisory lock + conflict-safe insert). Tenants that hit the old bug resolve to the row with the highest counter; the twin row is folded away on their next save. Diagnostic for support:
  `SELECT tenant_id, document_type, fy_start_date, count(*) FROM invoice_sequences GROUP BY 1,2,3 HAVING count(*) > 1;`
- **Quotes no longer leak into money reports:** overview, aging, revenue, TDS, GSTR-1, Form 131, the customer statement, the dashboard widgets and the payment-reminder job all count invoices only.
- **Quote validity** (`valid_until`) is now saved (the editor's date reads "Valid until" for quotes) so quotes can expire.
- **Supplier state guard:** creating an invoice for an Indian client while the workspace has neither a state nor a GSTIN returned IGST silently; it now says "Set your business state or GSTIN in Settings → General so GST is split correctly" with an Open Settings action. The invoicing setup step "Confirm business details" links to Settings → General (GSTIN, state & address).
- Sending an invoice/quote returns `emailSent`; the UI says "Marked as sent, but the email could not be delivered — share the link instead" when the provider refused.

### Sign-in and errors
- Sign-in code requests: when the email provider refuses, the user now sees "We couldn't send the code right now. Please try again in a minute" (503) instead of a false "we sent a code"; the hourly per-email quota is refunded for that attempt. Per-IP limit raised from 5 to **30 requests/hour** (an office signs in from one address); the per-email limit is unchanged.
- In production, unexpected server errors return "Something went wrong. Please try again." with a short `errorId` that is also in the server log — no SQL or driver text reaches a customer.
- New `app/error.tsx` (Retry) and `app/not-found.tsx`; a failed workspace load shows "Couldn't load your workspace — Retry" instead of an endless skeleton.
- Dashboard approve/reject errors are shown; the dead Export (dashboard) and New report (reports) buttons are gone; `/help`, the login "Need help?" and the legal pages use **support@flickssuite.com**; the Documents pages are hidden while `hr_documents` is off (the page's dead Upload button says "Coming soon").
- CRM: `GET /crm/pipelines` self-heals the default pipeline (the deals page could cache an empty list for five minutes on a brand-new workspace); the deals service shares the same locked helper, so two first reads can no longer seed two "Sales" pipelines.

## 3. API contract changes (additive)

| Endpoint | Change |
|---|---|
| `POST /employees/:id/resend-invite` (admin) | new → `{ data: { employeeId, email, resentCount, emailSent } }`; 409 `ALREADY_ONBOARDED` / `SEAT_DEACTIVATED` / `EMPLOYEE_REMOVED`; 429 `RESEND_TOO_SOON` |
| `POST /employees/resend-invites` (admin) | new; body `{ employeeIds?: [] }` (omitted = all pending, `[]` = nobody) → `{ data: { sent, skipped[] } }` |
| `POST /employees/invite` | response adds `reinvited?`, `rehired?`, `emailSent`; 409 codes `ALREADY_EMPLOYEE`, `EXTERNAL_SEAT`, `SEAT_DEACTIVATED`, `DUPLICATE` |
| `POST /employees/import` | response adds `skipped[]` (already-invited rows) |
| `GET /employees`, `GET /employees/:id` | rows add `membershipStatus`, `onboardingStep`, `onboardingSubmitted`; `pagination.total` is real; `limit` ≤ 100 |
| `GET /employees/next-code` (admin) | new → `{ data: { suggested } }` |
| `POST /employees/me/onboarding/defer` | new (owner/admin) → `{ data: { deferred: true } }`; `GET …/onboarding-status` adds `deferred`, `canDefer` |
| `POST /employees/:id/restore` | response adds `seat: 'active' \| 'invited' \| 'unchanged'` |
| `POST /leave/apply` | 400 `LEAVE_BALANCE_EXCEEDED` |
| `POST /invoices`, `PATCH /invoices/:id` | `valid_until` accepted; 400 `SUPPLIER_STATE_UNKNOWN` |
| `POST /invoices/:id/send` | response adds `emailSent` |
| `POST /auth/request-otp` | 503 `EMAIL_DELIVERY_FAILED`; per-IP 30/hour |
| any | 23505 → 409 `DUPLICATE`; production 500s carry `errorId` and a generic message |

## 4. Founder's go-live checklist (tomorrow)

1. **Trials:** Razorpay platform keys are not set in production, so Subscribe is disabled on day 8. Extend each new company's trial from the FAM console before then (FAM → Tenants → Extend trial).
2. In Railway, confirm these variables exist (names only, never share values): `RESEND_API_KEY`, `EMAIL_FROM` (a verified sender on your Resend domain), `APP_URL`, `MAGIC_LINK_BASE_URL`, `PUBLIC_INVOICE_BASE_URL`, `EMPLOYEE_DATA_ENC_KEY` (without it PAN and bank numbers are stored unencrypted), `RAZORPAY_*` as applicable.
3. Ask each new company to enter **GSTIN (or at least the state)** in Settings → General before their first invoice; the app now insists.
4. Companies created before tonight have the old six-holiday seed; Settings → Holidays → "Import from country list" adds the rest.
5. Recurring (subscription) invoices for a workspace with no state are held until the state is set — the generation log names the workspace.

## 5. Follow-ups found tonight (not in R1)
- Quote emails reuse the invoice wording ("invoice … is due"); a quote template is R2 material.
- Add `app/global-error.tsx` with Sentry instrumentation (build warning).
- `terminateEmployee`/offboarding still don't check anything about assets (R4) or policies (R3).
- The reports catalogue tiles keep a decorative download icon inside the tile link.
- Leave balance model: the ledger `opening` is a snapshot of the quota at the first apply — a quota raised later in the year is not reflected until next year (pre-existing).
- The readiness sweep's longer list (non-transactional tenant creation, FAM suspend not enforced, no leave accrual job, presence in UTC, Redis socket adapter, 67 pages without error states, dead `components/dashboard/*`) is in the Round P plan's "Readiness backlog".

## 6. Tests

- New: `founder-roundP-r1-invites.spec.ts` (34), `founder-roundP-r1-hardening.spec.ts` (30), `founder-roundP-r1-invoicing.spec.ts` (24), `numbering.util.spec.ts` (+cases).
- Updated: `founder-round21.spec.ts` ("restore relinks the seat"), four suites seed a supplier state (`crm-deals`, `invoicing-services`, `platform-evolution`, `role-matrix`).

## 7. Gate and live verification

**Build process.** Five implementers on disjoint file sets (API people/auth · API hardening · API invoicing · web people/onboarding · web invoicing/hardening), three adversarial review lenses each (correctness · tenant isolation/auth · dead ends/copy/house rules), one fix pass each: 25 agents, 16 blocker/major findings, all applied or carried into the follow-ups above. Cross-file follow-ups applied by hand afterwards: the round-21 spec that pinned the old Restore behaviour, five spec fixtures that needed a supplier state, the reminders job predicate, the shared pipeline helper, `valid_until` on the invoice list.

**Gate (all green):** API typecheck · nest build · **Jest 82 suites / 1 207 tests — 1 206 pass**; the one failure is `attendance-selfheal` "clock-in clears Appear offline", which fails identically on a pristine checkout of the released commit at this hour (the known near-IST-midnight flake in CLAUDE.md) · module boundaries (345 modules, 0 violations) · web typecheck · web production build · RLS probe `leak_with_bogus_context = 0` across 138 tenant tables, none without RLS.

**Live verification** (`scratchpad/verify-roundP-r1.mjs`: production web build, real API and database, every assertion against the API response, the database row or the rendered page): **68 pass / 0 fail / 0 skip** across 10 scenarios.

| # | Scenario | Result |
|---|---|---|
| 1 | Invite → **Invited** pill, header "N invited", ledger row; UI **Resend invite** → 200; immediate second resend → 429 `RESEND_TOO_SOON`; ledger rows 0, 1; Settings → Members lists the invitee with Resend | pass |
| 2 | Invitee signs in → seat active + linked → **Onboarding**; submitted → **Awaiting approval**; resend → 409 `ALREADY_ONBOARDED`; approve → `active` | pass |
| 3 | Remove (hard delete) → seat deactivated → re-add same email → 201, seat re-invited + linked, person signs in; re-add after removal (second person) → 201 + seat linked; archive via SQL → Restore → seat active + linked | pass |
| 4 | Re-add a pending invitee from the form → 201 `reinvited:true`, same row, code updated; re-add an active employee → 409 `ALREADY_EMPLOYEE`; `next-code` suggests | pass |
| 5 | Owner on a fresh record → bounced to the wizard → **Skip for now** → `defer` 200 → `/dashboard` with the reminder card → reload stays; employee → 403 | pass |
| 6 | Over-balance leave → 400 "You have 3 day(s) of … left for this year"; one day within balance → 201; apply dialog shows "2 days left" for the selected type | pass |
| 7 | Numbering: save `2026-27` → list returns it with the row id → preview `RP/2026-27/0001`; switch back → the same row (one row per FY) | pass |
| 8 | SENT quote leaves the reports dashboard unchanged; a real invoice adds 1; `valid_until` stored; statement excludes the quote; `emailSent` on send; no state → 400 `SUPPLIER_STATE_UNKNOWN` pointing to Settings → General | pass |
| 9 | Brand-new company via `create-tenant`: holidays include Holi, Eid, Dussehra, Diwali…; `GET /crm/pipelines` returns the default pipeline; duplicate department → 409 with friendly copy | pass |
| 10 | Custom 404 page; `/help` and the login "Need help?" are `mailto:support@flickssuite.com`; dashboard has no dead Export; `/documents` has no dead Upload | pass |

Screenshots in the session scratchpad: `rp1-employees-invited`, `rp1-resend-toast`, `rp1-members-resend`, `rp2-awaiting-approval`, `rp5-wizard-skip`, `rp5-dashboard-reminder`, `rp6-leave-balance`, `rp7-numbering`, `rp8-quotes`, `rp10-not-found`.

Harness notes: the seed tenant has no leave types, so scenario 6 creates one through `POST /leave/types`; the resend window is aged in SQL before the UI click; the archive path of re-adding (a person with history) is pinned by the spec — the live run's second person had no footprint and took the hard-delete path.

**Release:** no migration. Push `production` (API) first — the web calls three new endpoints — then `main` (web).
