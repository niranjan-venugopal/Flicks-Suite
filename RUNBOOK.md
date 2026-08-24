# Flicks Suite — Operations Runbook

Operational reference for running Flicks Suite in production. For local
setup see [README.md](./README.md); for system design see
[ARCHITECTURE.md](./ARCHITECTURE.md).

| | |
|---|---|
| **Web** | Vercel — auto-deploy on `main` |
| **API** | Railway — `apps/api/Dockerfile`, auto-deploy on `main` |
| **Database** | Supabase Postgres (ap-south-1, Mumbai) |
| **Cache / queues** | Redis (BullMQ jobs) |
| **Secrets** | Doppler — rotated quarterly |
| **Email** | Resend |
| **Errors** | Sentry (api + web) |
| **Product analytics** | PostHog |
| **Uptime** | Better Stack → `https://status.flickssuite.com` |

---

## 1. Health & monitoring

### Liveness / readiness probe

```
GET https://api.flickssuite.com/healthz      # LIVENESS — public, no auth, no api/v1 prefix
GET https://api.flickssuite.com/readyz       # READINESS — public, DB-probing
```

- `/healthz` — **liveness only**: 200 `{ status: "ok", uptimeSeconds, timestamp }`
  whenever the Node process is up. It deliberately does NOT touch the DB —
  this is Railway's deploy health check, and gating deploys on the DB meant
  a Supabase outage blocked every rollout (2026-08-24 incident: new code
  could not ship while the old container kept serving 500s).
- `/readyz` — **readiness**: 200 `{ status: "ready", database: "up", dbLatencyMs }`
  when Postgres answers `SELECT 1` within 3s; 503
  `{ status: "not-ready", database: "down" }` otherwise. The probe is capped
  at 3s so it never hangs.

Better Stack must monitor **`/readyz`** (not `/healthz`) every 30s and page on
2 consecutive failures. Keep the interval ≥ 30s — `/readyz` runs a real
`SELECT 1`.

### Dashboards

| What | Where |
|---|---|
| API errors / traces | Sentry → `flicks-suite-api` project |
| Web errors | Sentry → `flicks-suite-web` project |
| Funnel / critical events | PostHog (`tenant_signup_completed`, `impersonation_started`, etc.) |
| Uptime + status page | Better Stack |

---

## 2. Deploy

Both apps auto-deploy from `main`. Normal flow:

```bash
# 1. Merge to main (CI must be green: typecheck + lint + multi-tenant tests + build)
# 2. Vercel builds web; Railway builds apps/api/Dockerfile — both watch main
# 3. Verify after deploy:
curl -fsS https://api.flickssuite.com/healthz        # expect 200
#    open https://app.flickssuite.com  → log in → /dashboard renders
```

### Database migrations

Migrations are hand-written SQL in `packages/db/drizzle/NNNN_*.sql` and are
**not** auto-applied on deploy. Apply them explicitly, before the code that
depends on them ships:

```bash
# Against production (use the DIRECT connection, not the pooler, for DDL)
psql "$DATABASE_DIRECT_URL" -f packages/db/drizzle/000X_<name>.sql
```

`scripts/setup-demo.sh` carries idempotent guards for every migration and can
re-sync a fresh/lagging database to the current schema in one run.

> Order matters: apply the migration **first**, confirm it succeeded, then let
> the new code roll out. Additive (new table/column/enum value) migrations are
> safe to apply ahead of the code. Avoid destructive DDL during a deploy.

### Rollback

- **Web:** Vercel dashboard → Deployments → previous build → **Promote to Production** (instant).
- **API:** Railway dashboard → Deployments → previous → **Redeploy** (or `railway rollback`).
- **Always roll code back before reverting a migration.** A forward-only
  additive migration usually does not need reverting; if a deploy is rolled
  back, the extra column/table is harmless dead weight until the next attempt.

---

## 3. Common incidents

### `/readyz` returns 503 (`/healthz` still 200)

Process is up, Postgres is not reachable.
0. Supabase dashboard → is the project **PAUSED**? The free tier pauses after
   ~1 week of database inactivity — click **Restore** and wait a few minutes.
   (The 30s uptime monitor on `/readyz` is also what keeps the project from
   pausing.)
1. Supabase status: https://status.supabase.com and the project dashboard.
2. Connection cap — Supabase pooler exhausted? Check active connections in the
   Supabase dashboard. The API uses the **session-mode pooler**; a leaked
   connection or a traffic spike can exhaust it.
3. Rotate/refresh `DATABASE_URL` in Doppler if credentials changed.
4. Pooler hostname drift: Supabase has been migrating poolers off the legacy
   `aws-0-<region>.pooler.supabase.com` hosts (newer projects use
   `aws-1-…`). If the dashboard's connection-string host differs from what
   Railway's `DATABASE_URL` / `DATABASE_SERVICE_ROLE_URL` hold, update both
   vars (ports/users unchanged) — a stale host presents as
   `write CONNECT_TIMEOUT` on both :5432 and :6543 at once.
5. If Supabase itself is down, post to the Better Stack status page and wait;
   there is no app-side fix. Deploys still work during the outage —
   `/healthz` is liveness-only.

### Login OTP / magic link not arriving

1. Resend dashboard → Logs: was the send accepted, bounced, or rejected?
2. Domain auth: `flickssuite.com` SPF/DKIM/DMARC still verified in Resend?
3. Sender: `EMAIL_FROM` must be on the verified domain (not the
   `onboarding@resend.dev` sandbox, which only delivers to the account owner).
4. Confirm `RESEND_API_KEY` in Doppler is the production key.

### "role flicks_app does not exist" / RLS errors in API logs

The API must connect as `flicks_app` (`NOBYPASSRLS`). If you see
`new row violates row-level security policy`, a service is querying outside a
tenant context — search for `this.db.insert(`/`this.db.select(` not wrapped in
`withTenant()`. See README → Troubleshooting.

### High error rate in Sentry after a deploy

1. Identify the release in Sentry; check the introducing commit.
2. Roll the affected app back (§2 Rollback).
3. If it's a migration mismatch (code expects a column that isn't there), apply
   the pending migration rather than rolling back.

### Redis / background jobs not running

BullMQ jobs (leave accrual, trial expiry, daily snapshots) need Redis.
1. Confirm `REDIS_HOST`/`REDIS_PORT`/`REDIS_PASSWORD` in Doppler.
2. Jobs are scheduled via `@nestjs/schedule`; a crash-looping API means no
   cron fires — fix the boot error first (`/healthz`, Sentry, Railway logs).

### Impersonation stuck / FAM admin can't exit

Impersonation sessions hard-cap at 15 minutes (enforced in the refresh
handler against `impersonation_sessions`). If a session looks stuck, the user
can log out (clears cookies); the row in `impersonation_sessions` expires on
its own. Both sides are audit-logged (`audit_log_platform` + tenant `audit_log`).

---

## 4. Backup & restore

Scripts live in `scripts/`:

| Script | What | Cadence |
|---|---|---|
| `backup-daily.sh` | `pg_dump` → gzip, local/object storage | Daily (cron) |
| `backup-weekly-r2.sh` | Push weekly snapshot to Cloudflare R2 | Weekly |
| `restore-drill.sh` | Restore latest dump into staging Supabase | Monthly drill |

Supabase also takes its own daily automated backups (Point-in-Time Recovery on
paid tiers) — our scripts are a second, off-provider copy.

### Restore drill (run monthly — do NOT restore into prod casually)

```bash
bash scripts/backup-daily.sh            # produce a fresh dump
bash scripts/restore-drill.sh           # restore it into the staging project
# Verify: row counts for tenants/users/employees match; log in to staging.
```

A restore that has never been tested is not a backup. Record each drill's date
+ outcome in the team log.

---

## 5. Secrets & rotation

- All secrets live in **Doppler**, not in Vercel/Railway env panels directly.
- Rotate quarterly: `JWT_SECRET`, `RESEND_API_KEY`, DB credentials, `TOTP_SECRET`.
- Rotating `JWT_SECRET` invalidates all active sessions (everyone re-logs-in) —
  schedule it for a low-traffic window and announce it.
- Never commit `.env`; `.env.example` documents the full key set.

---

## 6. Contact tree

| Role | Who | Reach |
|---|---|---|
| On-call / Eng lead | Niranjan V | (internal) |
| Grievance Officer (DPDP) | Niranjan V | privacy@flickssuite.com |
| Security disclosures | — | security@flickssuite.com |
| Product support | — | support@flickssuite.com |

**Escalation:** `/healthz` red or Sentry error spike → check Supabase + Railway
status → roll back the last deploy if it correlates → if infra-side (Supabase
/ Vercel / Railway outage), update the Better Stack status page and wait on the
provider.
