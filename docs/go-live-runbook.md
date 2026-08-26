# Go-live runbook — Vercel (web) + Railway (API + Redis) + Supabase

The exact, ordered path from a green `main` to a serving production app on
your own domain. Written for the launch decisions on record: **single API
instance with the inline worker · platform billing (Razorpay) deferred —
dogfood free via a FOUNDER coupon · GitHub integration parked.**

`<domain>` below = your apex domain. The app lives at `app.<domain>`, the
API at `api.<domain>`, sending mail at `mail.<domain>`, inbound (BCC) mail
at `in.<domain>`.

Companion docs: [RUNBOOK.md](../RUNBOOK.md) (day-2 ops),
[CRM_Launch_Actions.md](handoff/CRM_Launch_Actions.md) §3–4 (DNS + Resend
detail), [pm-beta-gate.md](pm-beta-gate.md) (PM drills).

---

## Phase 0 — Accounts & secrets (~20 min, your machine)

1. Accounts: **Railway** (add a payment method — usage-billed, ~$5–15/mo),
   **Vercel** (Hobby is fine to start), **Resend**. Supabase you already
   have.
2. Generate fresh secrets and file them in a password manager:

   ```bash
   openssl rand -base64 48   # JWT_SECRET
   openssl rand -hex 32      # INVOICING_SECRET_ENC_KEY
   openssl rand -hex 32      # WEBHOOK_SECRET_ENC_KEY
   openssl rand -hex 32      # EMAIL_TOKEN_KEY
   openssl rand -hex 32      # TOTP_SECRET
   ```

3. **Rotate everything that was ever pasted into a chat or shared channel**:
   - Supabase → Settings → Database → *Reset database password*.
   - Resend → API Keys → revoke the old key, create a new one.
   - R2/S3 keys (if storage was configured) → rotate the pair.
   - The GitHub PAT used during the build → revoke it.
   - JWT_SECRET is simply the new one from step 2. Note: rotating it also
     invalidates existing consent hashes, calendar-ICS links, and CRM form
     tokens — harmless before launch, disruptive after.

## Phase 1 — Supabase production database (one command + one gate)

1. Supabase → Settings → Database → copy the **Direct connection** string
   (port **5432**, *not* the pooler) → this is `DATABASE_DIRECT_URL`.
2. Pick a strong password for the app role, then from the repo root:

   ```bash
   DATABASE_DIRECT_URL='postgres://postgres:…@db.….supabase.co:5432/postgres' \
   APP_ROLE_PASSWORD='<strong-password>' \
   pnpm sync:supabase
   ```

   This applies every numbered migration (0001–0049 at the time of writing), creates the **`flicks_app`**
   NOBYPASSRLS role with that password, and re-locks the per-table grants.

   > ⚠ **If `APP_ROLE_PASSWORD` is unset the role step is SILENTLY
   > skipped** — the schema applies but RLS will NOT isolate tenants,
   > because you'd still be connecting as `postgres`. Always set it.

3. Build the two connection strings the API will use (URL-encode passwords —
   `@` → `%40`, `#` → `%23`, …):
   - `DATABASE_URL` — **transaction pooler, port 6543**, user
     **`flicks_app`**, password = APP_ROLE_PASSWORD.
   - `DATABASE_SERVICE_ROLE_URL` — **session pooler, port 5432**, user
     `postgres`.
4. **Gate before proceeding** — RLS must prove itself on the prod DB:

   ```bash
   DATABASE_URL='<the flicks_app pooled string>' \
   DATABASE_SERVICE_ROLE_URL='<the postgres session string>' \
   bash scripts/diagnose-rls.sh
   ```

   Required output: `leak_with_bogus_context = 0` and
   `tenant_tables_no_rls = (none)`. Anything else → stop, fix, re-run.

## Phase 2 — Railway: API + Redis

1. New Railway project → **Deploy from GitHub repo** → select the repo.
   Railway detects `apps/api/Dockerfile`; make sure the build context /
   root directory is the **repo root** (the Dockerfile copies
   `packages/*`), and the Dockerfile path is `apps/api/Dockerfile`.
2. In the same project: **+ New → Database → Redis** (one click). It
   exposes `${{Redis.REDIS_URL}}` to sibling services.
3. API service → **Variables** → paste
   [`apps/api/.env.production.example`](../apps/api/.env.production.example)
   filled in with your Phase 0/1 values. Highlights:
   - `REDIS_URL=${{Redis.REDIS_URL}}?family=0` — keep the `?family=0`
     (Railway's private network is IPv6-only).
   - `CORS_ORIGINS=https://app.<domain>` — exact origin, no wildcard.
   - `MAGIC_LINK_BASE_URL=https://app.<domain>/verify` — full URL
     including the path.
   - Leave all `RAZORPAY_*` and `GITHUB_*` blank (deferred/parked).
   - Set **neither** `WORKER_MODE` nor `INLINE_WORKER` — single instance
     runs the worker inline.
4. Service → Settings → **Health check path**: `/healthz` (liveness-only —
   always 200 while the process runs, so a DB outage can never block a
   deploy; DB health is monitored separately via `/readyz`).
5. Service → Settings → Networking → **Custom domain** → `api.<domain>`.
   Railway shows a CNAME target — add it at your registrar in Phase 4.
6. First deploy will already be running; it's fine that the domain isn't
   attached yet — you can watch logs for
   `API process running on port 4000 [production]`.

## Phase 3 — Vercel: web

1. Vercel → **Add New Project** → import the repo →
   **Root Directory = `apps/web`** (Next.js auto-detected). Node 22.
2. Environment variables (Production): paste
   [`apps/web/.env.production.example`](../apps/web/.env.production.example)
   filled in — minimally `NEXT_PUBLIC_API_URL=https://api.<domain>`.

   > `NEXT_PUBLIC_*` is baked at **build time** — changing the API URL
   > later means a redeploy.
3. Deploy, then Project → Settings → **Domains** → add `app.<domain>`.
   Vercel shows the CNAME target for Phase 4.

## Phase 4 — DNS + Resend email

At your DNS provider (registrar):

| Record | Host | Type | Value |
|---|---|---|---|
| Web | `app` | CNAME | the target Vercel showed |
| API | `api` | CNAME | the target Railway showed |
| Sending SPF/DKIM | per Resend | TXT | shown when adding `mail.<domain>` |
| Inbound | `in` | MX | shown when adding `in.<domain>` |

Both platforms auto-issue TLS once their CNAME resolves (minutes to an
hour).

In **Resend**:

1. Domains → **Add domain** `mail.<domain>` (sending) → add the SPF + DKIM
   TXT records it lists → wait for *Verified*. `EMAIL_FROM` must be an
   address on this domain (`noreply@mail.<domain>`).
2. Domains → add `in.<domain>` as a **receiving/inbound** domain → add its
   MX record → enable **catch-all**. Matches
   `INBOUND_EMAIL_DOMAIN=in.<domain>` on Railway.
3. Webhooks → **Add endpoint** `https://api.<domain>/api/v1/webhooks/resend`
   (all email events) → copy the signing secret →
   `RESEND_WEBHOOK_SECRET` on Railway → redeploy the API service.
   **Unset in prod = every Resend webhook 401s** (bounces, complaints,
   inbound BCC mail all silently lost).

Full DNS/Resend background: CRM_Launch_Actions.md §3–4.

## Phase 5 — First boot: admin, workspace, coupon

1. Open `https://app.<domain>` → sign in with your ops email via the
   signup path (creates your `users` row).
2. From the repo, promote yourself to platform admin (FAM):

   ```bash
   DATABASE_SERVICE_ROLE_URL='<postgres session string>' \
   bash scripts/promote-platform-admin.sh you@<domain>
   ```

   Fails loudly if the email has no `users` row (sign up first). Re-runs
   are safe.
3. Log in again → complete **TOTP enrolment** (works because `TOTP_SECRET`
   was set in Phase 2 — if you skipped it, set it now *before* enrolling).
4. Create your dogfood workspace through the normal onboarding wizard.
5. **Kill the day-8 trial fuse** — billing is date-driven even with
   Razorpay unset, so redeem a founder coupon (pure-DB, no Razorpay):

   ```bash
   DATABASE_SERVICE_ROLE_URL='<postgres session string>' \
   bash scripts/seed-coupons.sh
   ```

   Then in-app: **Settings → Billing → Redeem coupon → `FOUNDER-001`**
   (+3 months, single-use). Round 9: this is the ONLY seeded code — the
   002…050 sequence and the FLICKS-CA set were retired as guessable
   (`scripts/supabase-editor/06-retire-coupons.sql`); mint any future codes
   from FAM → Coupons, which generates random suffixes only.

   Manual lever (FAM → tenant → *Extend trial* also works; takes ≤60s to
   surface because of the billing-state cache).

## Phase 6 — Smoke + drills

```bash
API_URL=https://api.<domain> APP_ORIGIN=https://app.<domain> \
bash scripts/prod-smoke.sh
```

Checks: `/healthz` 200 + database up · `/readyz` + DB latency ·
request-otp for a bogus email → 404 NOT_REGISTERED (API→DB wiring, zero
side effects) · CORS preflight from the app origin echoed correctly ·
`/api/docs` → 404 (Swagger gated).

Then by hand:

- A **real login on the prod domains** — proves the cross-subdomain cookie
  posture (`app.` ↔ `api.` on one eTLD+1).
- Open an invoice → **Download PDF** → eyeball the **₹ glyph** renders
  (distro-Chromium font check).
- PM drills from [pm-beta-gate.md](pm-beta-gate.md): kill-switch
  (`pm_sync_engine` flag off → same UI on REST) and **Reset local data**.

## Phase 7 — Monitoring (~10 min)

- **Sentry**: one project per app; paste `SENTRY_DSN` (Railway) and
  `NEXT_PUBLIC_SENTRY_DSN` (Vercel) and redeploy.
- **Uptime**: any free monitor (e.g. Better Stack) on
  `https://api.<domain>/readyz` every 30s (NOT `/healthz` — readyz is the
  DB-probing endpoint; it also keeps a free-tier Supabase project from
  pausing).
- **Log alert** on the literal string `OUTBOX STALLED` in Railway logs —
  the canary for a mis-set worker flag (events written but never
  dispatched). Caveat: while the DB itself is unreachable the checker only
  logs a warn (`outbox lag check failed`), so absence of this alert during
  a DB outage means nothing.

---

## Constraints & deferred items (deliberate, on record)

- **Single API instance only.** The deploy assumes one process: no
  socket.io Redis adapter, in-memory rate limiter, per-process billing
  cache, 15-connection pool ceiling, and 15 cron jobs that would
  double-fire on a second instance. Do NOT scale horizontally or split a
  worker service without the follow-up idempotency audit.
- **Razorpay** (platform + tenant track): blank = clean 503s; trial
  enforcement stays date-driven (hence the FOUNDER coupon). Add live keys
  when you start charging.
- **GitHub integration**: parked behind a Coming-soon card (per-user
  OAuth planned); leave `GITHUB_*` blank.
- **Google/Microsoft OAuth** (CRM two-way email): pending verifications;
  the Email suite stays parked.
