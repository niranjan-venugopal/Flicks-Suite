# V1 Security Update — Row-Level Security Hardening (June 2026)

> Handoff / memory document. Captures **everything changed** in the RLS
> hardening effort so the work is recoverable even if chat context or a local
> clone is lost. Status: **COMPLETE & VERIFIED** on Supabase. Merged to `main`
> via PR #2 and PR #3.

---

## 1. TL;DR

- **Goal:** enforce Row-Level Security (RLS) on **every** table — "no bypass or
  leak from day 1" — not just the 23 tenant business tables.
- **Result:** **40/40 tables RLS-protected**, login works, multi-tenant
  isolation suite green (23/23). All on `main`.
- **Headline fixes:** (a) closed a real cross-tenant isolation gap on
  `memberships`; (b) fixed services that queried tenant tables **without**
  setting tenant context (would return zero rows / break under the NOBYPASSRLS
  app role); (c) locked down identity/auth tables; (d) corrected the
  out-of-band `auth_otps` RLS that was 500-ing login.

---

## 2. Why this was needed (root cause)

1. **Login was 500-ing:** `new row violates row-level security policy for table
   "auth_otps"`. RLS had been enabled on `auth_otps` **out-of-band** (Supabase
   dashboard) with **no policy**, so the NOBYPASSRLS `flicks_app` connection was
   default-denied. The old privileged `postgres` connection had masked it.
2. **Only 23 of 42 tables had RLS.** Worse, several services queried
   RLS-protected tables on the **tenant connection without setting
   `app.tenant_id`** (no `withTenant` wrapper) — they had been relying on the
   app connecting as a privileged/RLS-bypassing role, with isolation enforced
   only by `WHERE tenant_id = …` clauses. Under a true NOBYPASSRLS role those
   queries return **zero rows** — so `employees`, `timesheet`, and `onboarding`
   were effectively broken the moment the app used `flicks_app`.

This was proven empirically: a tenant-connection query against `employees`
**without** `app.tenant_id` returned 0 rows; **with** it, the row appeared.

---

## 3. Connection / RLS model (how it works)

- **`DATABASE_URL` → `flicks_app`** role: `NOSUPERUSER NOBYPASSRLS`. RLS applies.
  This is what the API uses for tenant-scoped work.
- **`DATABASE_SERVICE_ROLE_URL` → `postgres`** (BYPASSRLS): platform/admin work
  (FAM), cross-tenant/identity lookups, provisioning. Bypasses RLS by design.
- **`withTenant(tenantId, cb)`** (`packages/db/src/client.ts`, exposed via
  `DatabaseService.withTenant`): runs the callback in a transaction with
  `SELECT set_config('app.tenant_id', …, true)`. Tenant RLS policies key off
  `current_setting('app.tenant_id', true)`.
- **Rule going forward:** any query against an RLS-protected tenant table on the
  tenant connection **must** run inside `withTenant`. Cross-tenant / pre-tenant /
  identity work uses the service-role connection (`dbAdmin`).

---

## 4. What changed, by phase

Delivered in 4 staged commits (PR #2), then tooling (PR #3).

### Phase 1 — Make tenant context consistent
Services that touched RLS tables via the tenant connection without context were
fixed to use `withTenant`; provisioning moved to the service role.
- `apps/api/src/modules/employees/employees.service.ts` — every tenant-table
  read/write wrapped in `databaseService.withTenant(tenantId, …)`. External
  email/audit calls kept outside the transaction.
- `apps/api/src/modules/timesheet/timesheet.service.ts` — same; the
  `resolveCaller` / `getLatestRework` helpers now take the transaction; `dbAdmin`
  retained only for notification identity lookups.
- `apps/api/src/modules/onboarding/onboarding.service.ts` — routed to the
  service-role connection (it provisions a brand-new tenant and seeds its tables
  before any tenant context exists; slug uniqueness is a global check).

### Phase 2 — RLS on `memberships` + remaining tenant-scoped tables
- **Migration `packages/db/drizzle/0009_rls_bucket_b.sql`** — `ENABLE`+`FORCE`
  RLS + tenant-isolation policy on: `memberships` (the **real** gap),
  `subscriptions`, `subscription_events`, `tenant_health_snapshots`,
  `account_deletion_requests` (all keyed on `tenant_id`) and
  `impersonation_sessions` (keyed on `target_tenant_id`).
- `apps/api/src/modules/auth/auth.service.ts` — the `db` handle repointed to the
  **service-role** connection. Auth is cross-/pre-tenant (look up users by email
  before any tenant exists, enumerate a user's memberships for the tenant
  picker, issue/rotate tokens, trusted devices, impersonation) — none of which
  fits a single-tenant RLS context. Without this, `0009`'s `memberships` RLS
  would have broken login/tenant-selection.

### Phase 3 — Scoped RLS on `users` + `tenants`
- **Migration `packages/db/drizzle/0010_rls_users_tenants.sql`**:
  - `users`: visible to a tenant connection **only for users who are members of
    the current tenant** (`EXISTS (SELECT 1 FROM memberships m WHERE
    m.user_id = users.id AND m.tenant_id = current_setting('app.tenant_id',
    true)::uuid)`). Keeps employee list/detail/org-chart joins working; hides
    cross-tenant users.
  - `tenants`: a tenant connection sees only its own row (`id = app.tenant_id`).
- `employees.service.ts` — the invite flow's **find-or-create-user-by-email**
  runs on the service role (a person may already exist in another tenant and
  would be invisible under the `users` policy); the rest of invite stays in
  `withTenant`.

### Phase 4 — Lock down identity / platform tables (deny-all)
- **Migration `packages/db/drizzle/0011_rls_identity_lockdown.sql`** — `ENABLE`+
  `FORCE` RLS with a **deny-all** policy (`USING (false) WITH CHECK (false)`) on
  the 9 tables that have no tenant dimension and are touched only by the service
  role: `auth_otps`, `refresh_tokens`, `trusted_devices`, `auth_events`,
  `notification_preferences`, `notifications`, `feature_flags`,
  `tenant_cohorts`, `audit_log_platform`. The service role bypasses RLS and keeps
  working; the app role can never read/write them. This also **re-locks
  `auth_otps` the correct way** (replacing the dashboard drift that 500'd login).

All migrations are **idempotent** (`ENABLE`/`FORCE` are no-ops if set; policies
use `DROP POLICY IF EXISTS` before `CREATE`), so re-running setup is safe.

---

## 5. New tooling (scripts)

- **`scripts/apply-rls-hardening.sh`** — applies `0009`–`0011` idempotently to an
  existing DB, re-asserts grants, and verifies posture. Requires `--yes`.
- **`scripts/setup-database.sh`** (alias: `pnpm setup:database`) — **one command**
  for the full setup + hardening:
  - **default:** extensions → schema `0001` → **all** migrations (incl.
    `0009`–`0011`) → app role + grants → seed tenant → verify → **40/40 tables**.
    Use with the new API code deployed.
  - **`--unblock-login`:** same base setup but **skips** `0009`–`0011` and
    disables `auth_otps` RLS (the Step 0 one-liner) — unblocks login on the
    OLD code before the new code is deployed.

---

## 6. Tests

- `apps/api/src/__tests__/multi-tenant.spec.ts` extended from 10 → **15** cases:
  added cross-tenant isolation for `subscriptions`, `impersonation_sessions`
  (target_tenant_id), `users` (member-scoped visibility), `tenants` (self), and a
  deny-all check on `auth_otps`.
- Full API suite: **23/23** green (multi-tenant 15 + roles guard 8).
- Run: `pnpm -F api test` with `DATABASE_URL`/`DATABASE_SERVICE_ROLE_URL` set.

---

## 7. Table inventory (40 total)

- **Tenant business data (RLS by `tenant_id`, from `0001` + `0009`):**
  `employees`, `attendance_records`, `attendance_punches`,
  `attendance_regularizations`, `leave_types`, `leave_requests`,
  `leave_balances`, `timesheet_periods`, `timesheet_entries`,
  `timesheet_rework_requests`, `departments`, `designations`, `locations`,
  `holidays`, `calendar_events`, `audit_log`, `data_consents`, `shift_templates`,
  `employee_shifts`, `employee_documents`, `employee_invitations`,
  `emergency_contacts`, `employment_history`, `memberships`, `subscriptions`,
  `subscription_events`, `tenant_health_snapshots`, `account_deletion_requests`,
  `impersonation_sessions` (by `target_tenant_id`).
- **Scoped identity (`0010`):** `users` (member-of-tenant), `tenants` (self).
- **Deny-all / service-role-only (`0011`):** `auth_otps`, `refresh_tokens`,
  `trusted_devices`, `auth_events`, `notification_preferences`, `notifications`,
  `feature_flags`, `tenant_cohorts`, `audit_log_platform`.

---

## 8. Operational runbook

**Deploy ordering (critical):** the migrations are **coupled** to the new API
code (auth/onboarding on the service role; employees/timesheet wrapped in
`withTenant`). Ship the code and apply the migrations **together**. Applying the
migrations against the OLD code breaks login + employees/timesheet.

- **Full setup / harden (new code):** `bash scripts/setup-database.sh`
- **Login unblock (old code, transitional):** `bash scripts/setup-database.sh
  --unblock-login`  (or `ALTER TABLE auth_otps DISABLE ROW LEVEL SECURITY;`)
- **Verify posture:** `bash scripts/diagnose-rls.sh` → expect
  `connected_as = flicks_app`, `rolbypassrls = f`, `leak_with_bogus_context = 0`.
- **Coverage check:**
  `SELECT count(*) FILTER (WHERE relrowsecurity) || '/' || count(*) FROM pg_class
   WHERE relkind='r' AND relnamespace='public'::regnamespace;` → `40/40`.

**Failure signals:** empty employees list / login 500 ⇒ wrong role on
`DATABASE_URL`, old code, or migrations not applied. `leak_with_bogus_context >
0` ⇒ `DATABASE_URL` points at a bypass role.

---

## 9. Known follow-ups (not part of this work)

- **FAM login is TOTP-gated** (`users.totp_secret`) — FAM users may need TOTP
  enrolment before signing in.
- The `--unblock-login` mode leaves `auth_otps` RLS off intentionally for old
  code; re-enable (`ALTER TABLE auth_otps ENABLE ROW LEVEL SECURITY;`) once the
  new code is live to return to 40/40.

---

## 10. References

- **PR #2** — RLS tenant-context fixes + migrations `0009`–`0011` (4 phases).
- **PR #3** — one-command `scripts/setup-database.sh` + `pnpm setup:database`.
- Key files: `packages/db/src/client.ts`,
  `apps/api/src/core/database/database.service.ts`,
  `apps/api/src/modules/{auth,employees,timesheet,onboarding}/*.service.ts`,
  `packages/db/drizzle/0009_*`, `0010_*`, `0011_*`,
  `scripts/{setup-database,apply-rls-hardening,diagnose-rls}.sh`,
  `apps/api/src/__tests__/multi-tenant.spec.ts`.
