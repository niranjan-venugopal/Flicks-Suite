# Round Q · Off-boarding that off-boards, assets under People, HR access

**Date:** 2026-10-06 · **Migration:** none · **Ships on top of:** `86bd2e1` (key hard stop) · **Release:** API (`production`) then web (`main`) — the old web keeps working against the new API (`immediate` defaults to false)

Founder's report (2026-10-06), six items:

1. Off-boarding or deactivating someone put a stale "Siva Darshini S finished self-onboarding and is waiting for approval · 37d ago" card in Inbox → Approvals. Off-boarding should off-board **and deactivate**; delete later; a popup with the reason and a checkbox — ticked = off-boarded and deactivated **immediately**, unticked = the **notice period** starts.
2. Assets should not hang under Personal — put them under People with a "My assets | All assets" toggle for Owner / HR.
3. What can the HR role do? Onboard, add assets, verify onboarding? If HR does not approve within **24 hours** it should go to the HR manager's higher reporting manager.
4. HR should see Insights, with **Reports** only.
5. HR should have **Resend invite**; assets under People for everyone, not under Personal.
6. Only Owner and HR add / see all assets; everyone else sees their own. HR manages departments, designations, leave policies, company policies, shifts, locations / geofence, holidays.

Founder decisions: 24h escalation → **the HR admin's reporting manager when that person is an Owner or HR admin, otherwise the Owners** (no new permissions — PAN / bank / address stay with HR + Owners). Role changes → **only an Owner controls Owner and HR-admin seats**.

## 1. Why the stale card appeared (root cause)

Self-onboarding sets `custom_fields.onboarding_submitted_for_review = true` and approval never clears it. Both approval queues (Inbox → Approvals, People → Onboarding) selected `flag AND status <> 'active'` with no `deleted_at` filter, so the moment an approved person was off-boarded (status `notice_period`) they reappeared as "waiting for approval" with their original submit date. Worse, **Approve on that card switched the off-boarded person — and their sign-in — back on**. Off-boarding itself only set `notice_period`: it never deactivated the seat, never wrote `date_of_exit` / `exit_reason`, had no "not yourself / not an Owner" rules, and nothing ever ended the notice period.

## 2. What changed

| # | Area | Change |
|---|---|---|
| 1 | Approval queues | Only people who have **not joined yet** (`status = 'inactive'`, not removed) are listed. The stale cards (Siva's included) disappear on deploy — no data fix needed. |
| 1 | Approve / Send back | Refused with 409 *"… is no longer waiting for onboarding approval"* unless the person is genuinely pending; a pending joiner whose seat was switched off must be reactivated first. |
| 1 | Off-board popup | Separation type, **reason (required)**, checkbox **"Off-board immediately — skip the notice period"**. Unticked → last working day defaults to today + their notice period (30 days unless their profile says otherwise), editable. |
| 1 | Off-board immediately | Status **Separated**, exit date today, reason kept, **seat deactivated**, this company's sessions revoked (their other companies untouched) — the person's open browser is refused on the very next click. |
| 1 | Notice period | Status **Notice period**, last working day recorded; they keep working. An hourly job finishes it the day after the last working day (company timezone): separated, seat off, signed out, Owners / HR told in-app. People already on notice from before get the same, using their recorded separation date. |
| 1 | Employee page | Notice → "Serving notice · last working day …" with **End notice now** and **Cancel off-boarding**; separated → "Off-boarded on …" with **Reinstate** and **Delete employee** (archives when there is history — attendance / leave / payroll records are kept — and still needs equipment returned first). |
| 1 | Seat rules (shared) | One rule set for remove, off-board, reinstate, deactivate and role changes: nobody acts on their own seat; Owner / HR-admin seats are the Owner's call; never the last active Owner (`core/auth/seat-guards.ts`). |
| 1 | Any switched-off seat | Every tenant route now checks the live seat (previously only admin/manager routes did) — a deactivated, off-boarded or removed person can no longer read self-service pages from an open tab for up to 15 minutes. Sign-in, company switching and *My companies* stay reachable. |
| 2/5/6 | Assets | Personal → My assets is gone for every role. **People → Assets** for everyone: Owner / HR see **My assets \| All assets** (register by default); everyone else sees only their own equipment. Old `/assets/me` links (notifications, emails) redirect to `/employees/assets?view=me`. |
| 3 | 24h escalation | Every 15 minutes: an onboarding submitted over 24 hours ago and not yet decided goes to each HR admin's reporting manager **if** that person is an active Owner / HR admin, otherwise to the Owners (an HR admin's own onboarding always goes to the Owners). In-app + email ("Escalated to you … HR can still approve it too"); once per submission (a send-back starts a fresh clock). Inbox and People → Onboarding show **Waiting 24h+**. |
| 3 | Manager FYI email | The joiner's reporting manager now gets an information email ("HR will review and approve it") instead of a *Review* button into a page they could not open; names in that email are escaped. |
| 4 | Insights | HR admins see **Insights → Reports** only; the **Audit log** is Owner-only (sidebar, Reports tiles, the page and `GET audit/logs`). The company-wide HR reports (attendance, leave, headcount) are Owner / HR only (were open to any manager by URL). The dashboard activity feed — the audit trail — needs an Owner / HR seat (was readable by any member through the API). |
| 5 | Resend invite | Already on People (row + "Resend all pending"), the employee page and Settings → Members; now also on **People → Onboarding** ("Invited — not started yet", per row and *Resend all*). |
| — | **Security gap found** | An HR admin could make anyone — themselves included — an **Owner** (or, through the API, a platform admin) and demote or switch off Owners. Now: only an Owner gives or changes Owner / HR-admin roles or switches those seats off/on; nobody changes their own role; platform roles are never assignable from a workspace. Settings → Members shows HR only Manager / Finance / Employee. |
| — | Small | Managers no longer see *Invite employee* / *Import CSV* on People (they could only fail). |

## 3. What an HR admin can do (answer to item 3)

There is no separate "HR manager" role: the **HR Admin** seat (API role `admin`) is HR. The Owner is labelled "Admin" in the web.

| Capability | Owner | HR Admin | Manager | Employee |
|---|---|---|---|---|
| Invite / import employees, resend invites | ✓ | ✓ | — | — |
| Approve / send back onboarding | ✓ | ✓ (not an Owner's or another HR admin's file) | — | — |
| 24h escalation receives | Owners (fallback) | HR admin's manager if Owner / HR | — | — |
| Off-board, end notice, reinstate, delete | ✓ | ✓ (not Owners / HR admins) | — | — |
| Asset register: add, assign, return, all assets, CSV | ✓ | ✓ | own only | own only |
| Departments, designations, leave policies & types, shifts, locations / geofence, holidays | ✓ | ✓ | — | — |
| Company policies (write, publish, who agreed) | ✓ | ✓ | if granted | if granted |
| Insights → Reports | ✓ | ✓ | — | — |
| Insights → Audit log | ✓ | — | — | — |
| Give / change Owner or HR-admin roles; switch those seats off | ✓ | — | — | — |
| Set Manager / Finance / Employee roles; switch ordinary seats off | ✓ | ✓ | — | — |

## 4. Tests

- `founder-roundQ-offboarding.spec.ts` (20): the founder's stale-card case; legacy notice / separated / removed rows never queued; Approve / Send back → 409 and nothing reactivated; immediate (status, date, reason, seat, live-seat refusal, tokens revoked for this company only, history, audit); notice default = today + notice days, explicit date, past date refused, second notice refused, End notice now; the job (day after the last day only, idempotent, Owners / HR told, pre-Round-Q rows via history date); cancel / reinstate; seat rules (self, HR → Owner / HR admin, last Owner); never-joined → 409; foreign-company id → not found.
- `founder-roundQ-onboarding-escalation.spec.ts` (8): HR's manager when Owner; when another HR admin; plain-manager manager → Owners; no HR admins → Owners; an HR admin's own file → Owners; < 24h untouched and no second escalation; approved / removed skipped and send-back clears the marker; per-company isolation.
- `founder-roundQ-roles.spec.ts` (14): HR cannot create / change / switch off Owners or HR admins or themselves, can set Manager / Finance / Employee; Owner can; platform roles refused by DTO and service; audit log Owner-only, HR reports admin-only, activity feed admin-only, cancel-offboarding admin-only; a switched-off seat refused on unranked routes with the account routes exempt; foreign seat ids and look-alike paths never pass.
- Updated: `assets.spec.ts`, `founder-roundP-r4-employee-assets.spec.ts` (My assets link → `/employees/assets?view=me`).

## 5. Gate and live verification

**Gate:** API typecheck · nest build · **Jest 94 suites / 1 425 tests** · module boundaries (362 modules, 0 violations) · web typecheck · web production build · RLS probe `leak_with_bogus_context = 0`.

**Live** (production web build + real API + Postgres, scratchpad `verify-roundQ.mjs`): **48 / 48** — Owner off-boards immediately through the real popup (separated, exit date, seat off, sessions revoked, the person's open browser refused on the next request and unable to refresh); notice period (default date = today + 30, seat active, header + End notice / Cancel); the stale card gone from Inbox → Approvals while a genuinely pending joiner shows with *Waiting 24h+*; Approve on the stale person → 409; End notice now → separated; Reinstate → active with seat; Delete → archived; employee: People → Assets shows My assets, no Personal entry, `/assets/me` redirects; HR: register default + toggle with `?view=me`, Insights shows Reports only, Audit tile hidden, `/reports/audit` Owner-only note, `audit/logs` 403, reports 200, cannot make an Owner (403), cannot promote self (400), cannot switch the Owner off (403), Members role menu = Manager / Finance / Employee, Owner row read-only, People → Onboarding lists the invitee with a working Resend; manager: no Invite / Import, reports 403; employee: activity feed 403; Owner: audit log 200. (The live escalation pill used a pre-set marker; the escalation logic itself is covered by the spec above.)

## 6. Notes for the founder

- **Don't approve the stale "Siva" card before this ships** — today that would switch her back on. After deploy it disappears by itself.
- People already put on notice by the old flow without a date: the hourly job ends their notice on the date recorded when they were off-boarded; if none was recorded, open them and use **End notice now**.
- "Delete" keeps the statutory records (archive) for anyone with attendance / leave / payroll history; it hard-deletes only records added by mistake.
