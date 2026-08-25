# Live-Ops Session Handoff — 2026-08-22 → 2026-08-25

**Start here for anything after the CRM MVP.** This documents the six
founder-driven rounds shipped after `PRD_v5_Completion_Handoff.md`: global
tenancy + holiday calendars, the location/employee-confirmation round, a
production incident + hardening, 180-day trusted devices, the
onboarding-approval integrity round, and the rate-limiter fix that ended the
"refresh logs me out" saga. Written for the next developer or Claude session.

Companion doc: `Global_Tenancy_Holidays_Handoff.md` carries the detailed
per-round addenda (rounds 2–6). This file is the map; that one is the deep
dive.

---

## 1. Non-negotiable working conventions (learned/confirmed this session)

- **Branches**: work lands on `main`, and `production` is fast-forwarded to
  the SAME commit in the same push (`git push origin HEAD:main
  HEAD:production`). Railway (API) and Vercel (web) auto-deploy from
  `production`. Never let the two diverge — version skew between deployed
  web and API caused real breakage during the incident (see §4).
- **Migrations are applied manually** in the Supabase SQL editor by the
  founder — the API never auto-migrates. Hand-authored idempotent SQL in
  `packages/db/drizzle/NNNN_name.sql` (next number), RLS + grants per the
  0037 DO-loop pattern for new tenant tables. `pnpm sync:supabase` applies
  all numbered files locally.
- **The per-change gate — ALL of it before any push**:
  ```bash
  pnpm -F api typecheck
  pnpm --filter @flicks/api build     # added post-incident: specs were compiled into prod dist before
  cd apps/api && pnpm jest            # real Postgres 16 + Redis (see §8)
  pnpm -F api lint:boundaries
  pnpm -F web typecheck
  pnpm -F web build
  bash scripts/diagnose-rls.sh        # leak_with_bogus_context must be 0
  ```
- **Definition of done** additionally includes live verification of the
  changed surface and an addendum in `docs/handoff/` when module status
  changes.
- The founder is not terminal-savvy: walkthroughs must be click-by-click
  (Supabase SQL editor, Railway/Vercel dashboards).

## 2. Session commit map (`afa2969 → b92665d`, all on main = production)

| Commit | Round | What shipped |
|---|---|---|
| `3128eea` | 1 (handoff patch) | Self-onboarding for all tenant roles; admin editing of personal/statutory/banking; AES-256-GCM field encryption (`EMPLOYEE_DATA_ENC_KEY`) for PAN/bank columns. Applied via `git am` from the previous session's patch. |
| `21f63a9` | 2 | Location-aware **holiday calendars** (Zoho-style location scoping + Keka-style country presets, IN/AE/US/GB 2026), **country-aware GST** (optional for non-IN tenants; Settings→General state field GST-gated), designations common across departments + in employee forms. Migrations to `0048`. |
| `6b950e0` | 3 | Locations: editable country/state/timezone + guarded **delete with employee transfer** (holidays/policies follow the new location); **employee-confirmed detail changes** (admin edits to active app-joined employees held as encrypted pending change requests until the employee confirms — migration `0049`); role label Owner→"Admin", profile shows designation; **web silent refresh** (single-flight 401 → `/auth/refresh` retry — sessions actually last the 7-day window). |
| `d73e805` | incident | **/healthz liveness-only + /readyz DB probe** (Railway healthcheck deploy-deadlock fix), `tsconfig.build.json` excludes specs from prod dist, CI build step, `prepare:false` on the transaction-pooler client, `scripts/prod-smoke.sh`, RUNBOOK updates. |
| `2528f50` | incident | **Log-flood guard**: per-signature stack suppression (30s window) in the HTTP exception filter + exponential backoff (4s→60s) in the outbox dispatcher — fixes Railway's 500 logs/sec drop cap. |
| `035b08a` | 4 | **Year grid** in every date/month picker (12-year pages in `MonthYearPanel`); login page redirects already-authed visitors (tab-reopen restore); **180-day trusted devices** (migration `0050`: `refresh_tokens.trusted`; consent-only `trusted_devices` rows via `POST /auth/trust-device`; `fs_device_id` httpOnly cookie; rotation re-validates device consent; post-login `TrustDevicePrompt`). |
| `e9a2054` | 5 | **BANKS list** (31 banks incl. Indian Overseas Bank) + working "Other" free-text in wizard AND admin dialog; **self-approval blocked** (a second owner can no longer approve their own onboarding — service guards + queue/bucket scoping + fan-out exclusion); in-app notifications for submit/approve; **Inbox → Approvals Onboarding kind** (dashboard `pending.onboarding` bucket, admin+-gated); **live refresh** (`employees.directory.changed` → tenant-room socket → query invalidation); **native-select "silver layer" fix** (`color-scheme: dark`, `select.input` appearance reset + chevron, invoicing `invoSelect`, option-color hacks removed). |
| `b92665d` | 6 | **Refresh-logout root cause**: global ThrottlerGuard's default 10 req/s/IP throttled the SPA's own F5 burst → 429 on /auth/me read as "signed out". Fixed with `ExplicitThrottlerGuard` (rate-limits ONLY routes declaring `@Throttle`), `trust proxy = 1` (real client IPs behind Railway — the whole userbase had shared ONE bucket), and web-side 401-only session ejection + transient-failure retries. |

## 3. Auth/session architecture (as it stands now)

- Passwordless email OTP + magic link; JWT access token **15 min**
  (httpOnly `access_token`, path `/`); opaque refresh token (sha256-hashed
  in `refresh_tokens`), httpOnly `refresh_token` cookie at path
  `/api/v1/auth`; rotation with reuse detection (reuse revokes the user's
  whole token family).
- **Silent refresh** (web `lib/api/client.ts`): first 401 → single-flight
  `POST /auth/refresh` → retry original once; retries once after 750ms on
  429/5xx. `RefreshTokenDto.refreshToken` optional (cookie is the source).
- **Session lengths**: 7 days default · **180 days** when the device is
  trusted (`TRUSTED_SESSION_EXPIRY_DAYS`, default 180) · 15 min
  impersonation. Cookie maxAge always tracks the minted token
  (`refreshTtlMs` threaded through every `setAuthCookies` call).
- **Trusted devices**: rows in `trusted_devices` exist ONLY via explicit
  consent (`POST /auth/trust-device` — upgrades the CURRENT session in
  place); logins on a trusted `fs_device_id` auto-issue 180d; rotation
  re-validates the device row and silently downgrades to 7d if
  revoked/expired (the future "sign out of this device" hook). `/auth/me`
  returns `deviceTrusted`; `TrustDevicePrompt` in the app shell asks once
  per browser session ("Not now" re-asks after next sign-in).
- **Ejection rule (web)**: `(app)`/`(fam)` layouts redirect to /login only
  on a settled **401** from `/auth/me`; 429/5xx/network keep the skeleton
  and retry. Never widen this back.
- **Rate limiting**: `ExplicitThrottlerGuard` (APP_GUARD) enforces ONLY
  explicit `@Throttle` routes — request-otp 5/hr, verify-otp 15/min,
  magic-link 20/min, plus feedback/fam/public endpoints. Everything else is
  unthrottled by design (follow-up idea: Redis-backed generous defaults
  when multi-instance lands). `trust proxy = 1` is load-bearing for this.

## 4. Deploy topology + incident learnings

- **Railway**: API Docker build (`apps/api/Dockerfile`, repo root context),
  healthcheck **must stay `/healthz`** (liveness-only, always 200 while the
  process runs) — a DB-probing healthcheck blocked ALL deploys during the
  Supabase outage (deploy deadlock → version skew). `/readyz` does the 3s
  DB probe and is the **uptime-monitor** target (Better Stack, 30s / 2
  failures — confirm it's pointed there). Single instance; do NOT set
  `WORKER_MODE` / `INLINE_WORKER`.
- **Supabase**: app role `flicks_app` over the transaction pooler `:6543`
  (`prepare: false` pinned — Supavisor tx mode breaks named prepared
  statements); service role over session pooler `:5432`. Watch for pooler
  hostname drift (aws-0 → aws-1) and free-tier pausing — both in
  `RUNBOOK.md` + `docs/go-live-runbook.md`; smoke: `scripts/prod-smoke.sh`.
- **Log volume**: Railway drops logs beyond 500/sec — the exception filter
  suppresses repeated stacks per signature (30s window) and the outbox
  dispatcher backs off failing events (4s→60s). Watch for "OUTBOX STALLED".
- **Migrations applied to production so far: `0001 → 0050`** (0049
  employee change requests, 0050 trusted sessions — both confirmed run by
  the founder in the Supabase SQL editor).

## 5. Real-time + notifications wiring

- Socket namespaces (in-process only — no Redis adapter yet, single
  instance): `/notifications` (bell push to `user:<id>` + tenant-wide
  `employees_changed` to `tenant:<id>`), `/presence`, `/crm`, `/sync`.
- `createInAppNotification` is preference-gated (`eventForInAppType` —
  specific-first mapping; `onboarding.submitted` has its own preference),
  best-effort (never fail the write path), and emits `notification.created`.
- Pattern for "everyone's screen should update": service emits a domain
  event → gateway broadcasts to `tenant:<id>` → web socket handler
  invalidates the query-key trees. See `employees.directory.changed` end to
  end (employees.service → notifications.gateway → NotificationsSocket).

## 6. Approval-integrity invariants (round 5 — keep these true)

- Nobody ever reviews their own onboarding: service-level
  ForbiddenException guards in approve/reject, `IS DISTINCT FROM` caller
  scoping in the queue AND the dashboard bucket (NULL-user invited rows
  stay visible), and the reviewer fan-out excludes the submitter.
- `GET /dashboard/admin/overview` has **no @Roles** (the Inbox calls it for
  every role) — the onboarding bucket is gated server-side via
  `includeOnboarding` (owner/admin/fam only). Pre-existing follow-up: the
  leave/reg names in that payload are visible to all roles.
- Onboarding approvals live in **Inbox → Approvals** (kind `onboarding`,
  approve / send-back with reason) — keep new approval types in that tab.

## 7. UI conventions added

- Native `<select className="input">` now has an appearance reset + SVG
  chevron in `globals.css`; the app declares `color-scheme: dark`. Any
  select styled inline must spread `invoSelectReset`
  (`components/invoicing/invo.tsx`) or use `.input`. **Never** use the
  `background:` shorthand in a rule that can apply to a select (it erases
  the chevron — `.input:focus` uses `background-color` for exactly this).
- Date/month pickers: `components/ui/date-picker.tsx` (`DateField`, and
  `MonthYearPanel` with month grid + 12-year grid). One native
  `<input type="month">` remains on crm/reports — known, low priority.
- Shared employee-form constants (banks list incl. `OTHER_BANK` sentinel,
  PAN/IFSC regexes, blood groups…) live in `apps/web/lib/employee-details.ts`
  — used by the wizard AND the admin dialog so they can't drift.

## 8. Testing notes

- Suite: **510/510** at handoff (46 files) against real Postgres. Local
  prerequisites in this container: `sudo pg_ctlcluster 16 main start` and
  `redis-server --daemonize yes` (both stop when the container idles);
  `flicks_app` role must exist before migration 0019 on a fresh DB.
- Session specs to read for patterns: `founder-round3.spec.ts` (service
  construction with stubs, OTP signup flow, consents as 6th positional
  arg), `founder-round4.spec.ts` (trusted-device lifecycle),
  `founder-round5.spec.ts` (approval integrity + dashboard bucket),
  `explicit-throttler.spec.ts` (guard behavior), `error-log-suppression.spec.ts`.
- `attendance-selfheal.spec.ts` is a known environmental flake near IST
  midnight — verify against a clean tree before chasing.
- Web has no test suite: gate is typecheck + production build + live
  verification (headless Chromium available in this environment).

## 9. Open follow-ups (deliberate, not forgotten)

1. Redis socket.io adapter + Redis-backed throttler defaults when the API
   goes multi-instance.
2. `@Roles` / payload-scoping pass on `GET /dashboard/admin/overview`
   (leave/reg names currently visible to non-admin roles — predates round 5).
3. "Manage devices / sign out of this device" UI on top of
   `trusted_devices` (revocation already downgrades rotation to 7d).
4. crm/reports native month input → shared picker.
5. `crm_email` / `crm_automation` remain feature-flagged OFF
   (`apps/web/lib/feature-flags.ts`) — backend + tests intact.
6. Verify the Better Stack monitor targets `/readyz` (30s, 2 failures) and
   a Railway log alert exists for "OUTBOX STALLED".
7. Rotate/confirm revocation of the GitHub PATs that leaked in an earlier
   session (three `github_pat_11BDDDFHY0…` tokens — the founder was
   instructed to revoke them; never print tokens in logs — pipe git output
   through the redaction sed in §1 of `Global_Tenancy_Holidays_Handoff.md`).

## 10. Production env deltas this session

- `TRUSTED_SESSION_EXPIRY_DAYS` (optional, default 180, max 365) — trusted
  session length; documented block in `apps/api/.env.production.example`.
- `TRUSTED_DEVICE_EXPIRY_DAYS` default changed 30 → 180 (device-consent
  window tracks the session window).
- No other new required vars. Railway healthcheck path stays `/healthz`.
