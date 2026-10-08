# Round R · R1 — Nothing shared between companies, policy delete, the attention widget, logos, plan label

**Date:** 2026-10-07/08 · **Migration:** `0069_policy_delete_and_tenant_fk.sql` (→ `apply-0069.sql`, run BEFORE the API deploys) · **Ships on top of:** `f1f4b50` (Round Q) · **Release:** API (`production`) then web (`main`) — the old web keeps working against the new API (the tenant header is optional on the wire; the policy `file_url` the old web used to iframe is now the API route, which it opens as a plain link)

Founder's brief (2026-10-07), nine items. This release is items **2, 3, 4, 5, 6, 7** plus the leaks the audit turned up. Item 1 (FAM support console) is R2, item 8 (CRM closed things editable) is R3, item 9 (CRM form builder + forms on deals) is R4.

Founder decisions: delete a policy = **hide it, keep the proof** (soft delete; who agreed and when stays, audited); the sidebar label = **"Trial · N days left" / "Pro Plan"** (+ "Payment due", "Suspended"); the four FAM toolsets and multi-page forms are scheduled for R2 / R4.

## 1. Root causes

| Item | What was really wrong |
|---|---|
| 2 — "Needs your attention" with several items | Three things. The overview answered `Cache-Control: private, max-age=15` and the dashboard URL had no cache-buster, so after **Approve** the browser re-served the old list and the second click answered *"Cannot review an approved request"*. One `isPending` was shared by every row, so one click greyed out all of them. The list only ever held leaves + regularizations while the header counted timesheets and onboarding too — "All caught up" could sit under "4 items waiting". |
| 3/4 — policies shared between companies? | **No company could read another company's policies** — every query runs inside the company's transaction with RLS forced (0067) and the cross-company spec already proved it. What the audit found instead was *how a person could end up in the wrong company by mistake*: (a) two tabs of one browser share the sign-in cookie, so switching company in tab 2 silently made tab 1's writes land in company B; (b) a policy PDF link was a bare 15-minute bucket URL — forwardable to anyone; (c) the acknowledgement table tied to the policy by id alone (FK checks bypass RLS); (d) live notifications were pushed to `user:<id>` — one room per person across all their companies; (e) a notification group-bump had no company predicate; (f) policy / asset links in emails and in-app notifications carried no company, so a person with several companies landed in whichever was active; (g) web-form tokens were 40-bit; (h) `GET fam/funnel/invoicing` had no `@Roles` — any signed-in member could read platform revenue. |
| 6 — FAM Top tenants logos | The revenue, health, feature-usage and feedback payloads never selected `logo_key` — the web had nothing to show. |
| 7 — "Free" in the sidebar | `adaptTenant()` hard-coded `plan: 'free'`; `/auth/me` carried no billing state at all. |

## 2. What changed

| # | Area | Change |
|---|---|---|
| 2 | Dashboard — Owner / HR card and the manager's Approvals queue | One component (`components/dashboard/AttentionQueue.tsx`): **every kind** is listed (leave, regularize, timesheet, onboarding), newest first; **per-row** busy state; a decided row leaves the card the moment the server confirms (no refetch race); the header and "+N more" use the server's own counts; onboarding rows link to **Review** instead of a blind approve; long names truncate. Owner / HR card and the manager's queue share it. |
| 2/4 | Tenant JSON is never browser-cached | `dashboard/admin/overview` and the three HR reports answer `Cache-Control: private, no-store` — nothing from the previous company is ever re-served after a switch. |
| 3/4 | **Company-bound requests** | The web sends `X-Flicks-Tenant: <company id>` on every call once `/auth/me` has confirmed the company — JSON, downloads **and** multipart uploads (logo, policy PDF, asset photo, PM bootstrap). A new global guard refuses a mismatch with the session's company: **409 `TENANT_MISMATCH`**, nothing read or written; the tab reloads into the right company. Account routes (`/auth/*`, `/me/*`) stay reachable so the tab can learn the truth. A `BroadcastChannel` makes other tabs reload at once on a company switch and go to `/login` on sign-out. |
| 3/4 | Policy PDFs behind the sign-in | `file_url` is now `GET /api/v1/policies/:id/file` — the sign-in, the company and the policy's audience are checked, then a **60-second** signed redirect with `Cache-Control: private, no-store`. A forwarded link answers 401 signed-out and 404 from another company. The reader and the editor open PDFs through it; `frame-src` gains the API origin (`NEXT_PUBLIC_API_URL`, nothing new to configure). |
| 3/4 | Database tie | `policy_acknowledgements (tenant_id, policy_id)` → `company_policies (tenant_id, id)`: the database itself refuses an acknowledgement pointing at another company's policy (proved in the spec with a forced insert). |
| 3/4 | Live events per company | Sockets join `tenant:<company>:user:<id>`; company pushes go there, never to the cross-company `user:<id>` room. A deactivated / off-boarded / removed seat emits `seat.revoked` and all four gateways **disconnect that person's sockets for that company**. |
| 3/4 | Links carry the company | Policy and asset emails / in-app notifications link with `?company=<id>`; the app switches into that company when the person belongs to it and ignores an unknown id. |
| 3/4 | Small leaks closed | Notification group-bump adds the company predicate; new web-form tokens are 128-bit (old links keep working); `GET fam/funnel/invoicing` is platform-only. |
| 5 | Delete a policy | `POST policies/:id/delete` — **Owner or HR admin** (ranked like assets; the policies grant still applies). Soft delete: gone from every list, the pending gate, the reader, the roster and the file route; the stored PDF is removed; **every acknowledgement row is kept** and the person's own history still shows what they agreed to; a deleted policy can never take a new agreement; audit `policy.deleted` with title, version, acknowledgements kept and whether a file was removed. Web: **Delete** in the editor and a trash button on each list row (Owner / HR only), confirm *"Employees will no longer see it … The record of who agreed and when is kept"*; Reports → Audit log filters by *Company policy*. |
| 6 | FAM logos | Revenue (Top tenants), health, feature usage and feedback payloads carry a signed `logoUrl` (`MediaService.servedUrl`, 64 px); every FAM table shows the logo next to the company name. Also fixed: the overview activation funnel showed percentages ×100; the `beta` plan had no colour on the revenue page. |
| 7 | Workspace card label | `PLATFORM_PLAN.name = 'Pro'` (one constant). `/auth/me` → `currentMembership.billing { status, trialEndsAt, trialDaysLeft, planName, hasCoupon }` from the cached subscription read (never the writing `GET /billing`). Card: **Trial · N days left** / **Trial · ends today** / **Trial ended** (free or code-given), **Pro Plan**, **Payment due** (past due / unpaid), **Canceled**, **Paused**, **Suspended**; guests keep "Guest access"; the Specflicks tenant reads **Platform**. The day count can never say "ends today" while the paywall already says expired. |

## 3. Security review (adversarial, before release)

A four-lens review of the diff (isolation, API correctness, web correctness, migration safety) with a skeptic per finding — 12 findings, 6 real, all fixed in this release:

1. A deleted policy could still take a **new** agreement (`acknowledge()` ignored `deleted_at`) → 404 now, spec added.
2. Multipart / raw-fetch helpers did not send the company header, so a drifted tab could still **replace company B's logo** → every raw fetch now sends it and honours 409.
3. The editor's *Open PDF* resolved the API-relative `file_url` against the web origin → resolved against the API origin.
4. `broadcastSignedOut` was never called → sign-out now reaches every tab.
5. `/auth/me` handed billing state to guest seats → null for guests.
6. "Trial · ends today" could show while the workspace was already read-only → never.

Refuted (kept as designed): `?company=` auto-switching into an invited company (the invite was already accepted by the person's own click on the link); one-shot `?company=` handling per mount; a brief "not found" flash on delete (react-query's `removeQueries` does not refetch).

## 4. Verification

- **Specs:** `founder-roundR-r1-isolation.spec.ts` (9 — tenant header guard incl. look-alike prefixes, rooms, no-store headers on both controllers, FAM funnel role, billing summary states incl. "ended an hour ago"); `policies.spec.ts` +4 (file route visibility, delete end to end incl. acknowledge-after-delete, controller roles, composite FK refuses a foreign policy id); `assets.spec.ts` / `founder-roundO-theme.spec.ts` adjusted for the company links and the `/me` constructor. Full Jest suite: 95 suites, **1 438 / 1 438**.
- **Gate:** API typecheck · API build · Jest · `lint:boundaries` (364 modules, 0 violations) · web typecheck · web production build · `diagnose-rls.sh` → `leak_with_bogus_context = 0`, 142 tenant tables, none without RLS.
- **Live (production web build + real API + Postgres + S3 mock), `verify-roundR-r1.mjs` — 62 / 62:** four kinds on the Owner dashboard, three approvals in a row each leaving at once with no failed call, server counts, nothing resurrected on reload; two tabs — a switch announced from tab 2 reloads tab 1, a drifted tab gets **409 TENANT_MISMATCH** and reloads into the right company with no mix, `?company=` lands in the right company, an unknown id is dropped, sign-out reaches the other tab; PDF `file_url` is the API route, a forwarded link is 401 signed-out and 404 from another company, a member gets a ≤ 60 s signed redirect that serves the bytes, the gate's *Open PDF* points at the API origin; delete from the editor and from the list row — hidden everywhere, PDF gone from storage (200 → 404), all three acknowledgement rows kept, audit row with the right metadata, employee refused (403), other company 404, no new agreement (404), Owner's audit page lists it; Bravo's uploaded logo shows in FAM Top tenants; cards read **Trial · 5 days left / Pro Plan / Payment due**, no "Free" anywhere.
- **Cross-company attack harness** (`audit/cross-tenant.mjs`, extended with the file route, delete, the header guard and the no-store checks): **106 / 106**, 215 cross-company requests, no canary in any response, company A's rows byte-identical afterwards, RLS probe clean.
- Screenshots in the session scratchpad (`shots-roundR-r1/`).

Note for anyone re-running the live harness: headless Chromium has no inline PDF viewer, so the reader shows its *Open the PDF* path — the check is that the link targets the API route on the API origin.

## 5. Release steps

1. **Supabase → SQL editor:** run `docs/handoff/apply-0069.sql` (idempotent; ends with a 4-row `OK` check). It only adds a nullable column, a partial index, a unique key and a composite FK — nothing is rewritten; the live app keeps working during it.
2. Push `production` (Railway): the API reads `company_policies.deleted_at` from the first request, so step 1 must be done first.
3. Push `main` (Vercel). No new environment variable: `frame-src` derives the API origin from `NEXT_PUBLIC_API_URL`.
4. Check: open a policy PDF (it opens through `api.flickssuite.com/api/v1/policies/…/file`), delete a test policy as HR, approve two things in a row on the dashboard, look at FAM → Overview → Top tenants.

## 6. Residuals / next

- **R2** FAM support console (migration 0070), **R3** CRM closed deals / leads / activities editable, **R4** CRM form builder + forms on deals + send-on-won (0071) — plan unchanged.
- Avatars and names are per person across companies by design (one account, several seats).
- Real-time fan-out is still in-process socket.io (single instance) until the Redis adapter.
- A tab that never talks to the API after a switch in another tab is reloaded by the broadcast; a browser without `BroadcastChannel` is caught by the 409 on its next request.
