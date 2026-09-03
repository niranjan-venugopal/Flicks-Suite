# Round H — Guest sign-in ("Magic link has already been used") + guest isolation

**Date:** 2026-09-01 · **Severity:** High (guests locked out) + Medium (guest over-exposure)
**Reported by:** founder — guests invited through Project Management land on
"Link expired or invalid — Magic link has already been used" on their **first**
click; affected guests are on company / Outlook email; some ended up creating
their own workspace instead of joining the inviting one. Second ask: audit
whether guests can see anything they shouldn't.

## What was happening

1. **The invite link was consumed by whatever loaded the page first.** The
   invite email links to the web `/verify` page, which fired the single-use
   `GET /auth/magic-link` the moment it loaded (a 60-second idempotency window
   only covered React double-fires). Corporate mail security (Outlook /
   Defender Safe Links, Google link scanning) opens links at delivery time, so
   the token was burned minutes before the invitee clicked. The failure page
   was a dead end ("Back to sign in").
2. **Why some guests "created their own workspace".** After the dead end they
   signed in by email code, landed in the inviting workspace, and saw the
   round-7 "Create my workspace" nudge. Once they owned a workspace,
   `membershipRank` sent every later login — including the invite link — to
   their own workspace, so the invited project looked gone.
3. **Guest isolation.** PM reads/writes are scoped by `PmVisibilityService`
   (round-7 leak suite) and CRM/Invoicing are grant-gated (guests = none). But
   `RolesGuard` allows any route without `@Roles`, so a guest JWT could call
   the unranked self-service routes: `GET /settings/members` (roster with
   emails), `GET /settings/organization` (tax identifiers, address),
   `GET /employees/org-chart`, `GET /employees/:id` (+ history, signed document
   URLs), `GET /dashboard/admin/overview` and `/activity` (audit log),
   `GET /calendar/events`, `GET /billing`, and could punch attendance (which
   self-heals an **employee record** for the guest), apply for leave, submit
   timesheets. Not cross-tenant, and the guest UI never links there — but one
   URL away for an external person who must see nothing but their project.

## The fix

**Magic link — two-step and self-healing** (`apps/api/src/modules/auth`,
`apps/web/app/(auth)/verify`, `apps/web/app/(auth)/login`)
- `GET /auth/magic-link?token=` now only **peeks** (never consumes):
  `{ status: ready | consumed | expired | invalid, email? }`.
- `POST /auth/magic-link/consume { token }` is the single-use sign-in (same
  semantics as before, cookies set). The web page shows **"Continue as
  {email}"** and consumes only on that click — the explicit human step
  scanners never take.
- `POST /auth/magic-link/recover { token }` emails a fresh 6-digit code to the
  token's address (full `requestOtp` semantics: quota, invalidation, auth
  event — no new enum value, no migration) and returns the address; the page
  offers **"Email me a sign-in code"** on consumed/expired links and sends the
  user to `/login?email=…&sent=1`, which opens straight at the code step.
- **Accept lands where you were invited**: when a login activates exactly one
  invited membership, that workspace becomes the session's tenant even if the
  user owns another workspace (`handleSuccessfulAuth`). Ordinary logins keep
  the round-7 ranking.
- Invite email fallback copy now mentions the code.

**Guest isolation — one choke point** (`apps/api/src/core/auth/guards/guest-scope.guard.ts`,
registered as `APP_GUARD` after `RolesGuard`)
- For `role = guest` the API is **deny-by-default**: only `auth`, `me`,
  `presence`, `notifications`, `pm` (incl. `pm/sync`), `consents`,
  `media/avatar`, `onboarding/create-tenant` (round-7 founder decision),
  `feedback`, `events`, `employees/me/onboarding-status` are reachable.
  Everything else → 403 + audit `authz.denied` / `guest_scope`. A future
  unranked route is closed to guests automatically. `@Public`, platform staff
  and every real workspace role are untouched; per-project PM scoping stays in
  `PmVisibilityService`.
- Web hygiene so guests never trip the guard: `useAdminOverview(enabled)`
  (Sidebar / Inbox pass their approver gate), `useBilling({ enabled })`
  (BillingGate skips guests).

## Regression spec

`apps/api/src/__tests__/founder-roundH.spec.ts` (10 tests): the allowlist
function and the real guard (guest refused on 18 representative HRMS/CRM/admin
paths, allowed on 18 shell/PM paths; other roles, platform staff, public routes
and unauthenticated requests untouched; refusal audited); peek never consumes;
consume signs in, activates the membership and lands in the **inviting**
workspace for a user who owns another; ordinary login still ranks the owned
workspace first; a token consumed >60 s ago is refused and peek says
`consumed`; recover emails a `login-otp` code to the invitee and returns the
address; unknown tokens refused. `auditor-magic-link`, `founder-round7`
(guest leak suite) and `founder-round19` (role matrix) stay green.

## Live verification (production build)

Owner invites a guest → scanner simulation (page HTML + API peek, twice) leaves
the token unconsumed → the guest's click shows "Continue as …" → lands on
`/pm/projects` with their project → with the guest's cookies, HRMS/CRM/admin
routes return 403 and own shell + PM routes 200, punch-in is refused and creates
no employee record → back-dated `consumed_at` → "already been opened" →
"Email me a sign-in code" → `/login` prefilled at the code step → code → guest
signed in. Owner unaffected.

## Operator notes

- No migration. No env change (`MAGIC_LINK_BASE_URL` unchanged — the email
  still points at the web `/verify` page).
- Guests already stuck: re-open the invite link and press **Continue**, or use
  **Email me a sign-in code**. Guests who created their own workspace switch to
  the inviting company via **My companies**.

## Follow-ups (not in this round)

- Auditors share the unranked-route exposure (their grant guard covers
  invoicing only) — give the allowlist guard an auditor branch.
- PM saved-views list is unscoped for guests (filter definitions only).
