# Flicks Suite — HRMS for Indian Startups

Multi-tenant HRMS SaaS. Monorepo: NestJS 11 API + Next.js 15 web + Drizzle/Postgres + shared packages, with Row-Level Security enforced per tenant.

```
apps/
  api/        Nest 11 backend, modular monolith
  web/        Next.js 15 frontend (App Router, Tailwind, shadcn/ui)
packages/
  db/         Drizzle ORM schema, migrations, seed
  emails/     Resend templates
  shared/     Cross-package types, Zod validators, constants
scripts/
  setup-db.sh    Idempotent local DB setup
  setup-demo.sh  Optional demo tenant + users for browser testing
```

---

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node | **22.x** | `nvm install 22 && nvm use 22` |
| pnpm | **9.15.0** | `npm install -g pnpm@9.15.0` |
| Postgres | **16+** | Local install or use the included `docker-compose.yml` |
| Redis | **7+** | Local install or use the included `docker-compose.yml` |
| Resend API key | — | Free tier is fine: https://resend.com/api-keys |

---

## Quick start (≈ 5 minutes)

```bash
# 1. Clone & install
git clone https://github.com/niranjan-venugopal/Flicks-Suite.git
cd Flicks-Suite
pnpm install

# 2. Bring up Postgres + Redis (skip if you already run them locally)
docker compose up -d

# 3. Configure env files
cp apps/api/.env.example apps/api/.env
# Edit apps/api/.env — at minimum:
#   • set JWT_SECRET to a strong random string (try: openssl rand -hex 48)
#   • set RESEND_API_KEY to your Resend key
echo 'NEXT_PUBLIC_API_URL=http://localhost:4000' > apps/web/.env.local

# 4. Set up the database (creates flicks_app role, applies schema, seed tenant)
pnpm setup:db

# 5. Load default leave types and Indian holidays
pnpm db:seed

# 6. (optional) Create the demo tenant + users so you can log in via the browser
pnpm setup:demo

# 7. Start both servers
pnpm dev
```

Now open:
- **Web app** → http://localhost:3000 (redirects to `/login`)
- **API Swagger** → http://localhost:4000/api/docs

> [!TIP]
> If you ran `setup:demo`, log in as `alice@demo.co` (employee) or `manager@demo.co` (manager). The OTP code prints in the API server log — search for `[DEV] OTP for ...`.

---

## What `setup:db` does

The script is **idempotent** — safe to re-run. It:

1. Creates the `flicks_suite` database if missing.
2. Installs extensions: `uuid-ossp`, `citext`, `pg_trgm`, `pgcrypto`.
3. Applies `packages/db/drizzle/0001_initial.sql` (all tables, RLS policies, indexes, triggers — single transactional file).
4. **Creates the `flicks_app` role** as `NOSUPERUSER NOBYPASSRLS` and grants it CRUD on every public-schema table. **This is the security-critical part:** if the API connects as a superuser, RLS is silently bypassed and the tenancy story is theatre. The role is what makes the multi-tenant tests in `apps/api/src/__tests__/multi-tenant.spec.ts` actually mean something.
5. Inserts the default seed tenant (`00000000-0000-0000-0000-000000000001`) so `pnpm db:seed` has somewhere to put leave types and holidays.

The Postgres superuser stays in `DATABASE_SERVICE_ROLE_URL` — it's used by the FAM module (cross-tenant ops) and by auth-time membership lookups (where there's no tenant context yet).

If your local Postgres uses different credentials, override via env vars:
```bash
PGSUPERUSER=myuser PGSUPERPASSWORD=mypass PGHOST=db.local pnpm setup:db
```

---

## Demo tenant (`setup:demo`)

Creates a working tenant for browser-clicking:

| Email | Role | Purpose |
|---|---|---|
| `alice@demo.co` | employee | Apply for leave, see balances |
| `manager@demo.co` | manager | See pending queue, approve/reject |

`alice@demo.co` reports to `manager@demo.co`. One leave type pre-configured: **Casual Leave (CL, 12 days)**.

In dev mode (`NODE_ENV != production`) the API logs the plaintext OTP to the console — you don't need actual email delivery to log in.

---

## Sync the schema to Supabase (one command)

To apply all migrations — including the Invoicing module (`0012–0017`) — to a
**Supabase** database:

```bash
# 1. In apps/api/.env set your three Supabase URLs (Session pooler, port 5432):
#      DATABASE_DIRECT_URL        -> postgres user (privileged; for migrations)
#      DATABASE_SERVICE_ROLE_URL  -> postgres user (BYPASSRLS; auth/FAM)
#      DATABASE_URL               -> flicks_app role (NOBYPASSRLS; the app)
#    (URL-encode the password: '@' -> %40, etc.)

# 2. First time on a brand-new project, also create the app role:
APP_ROLE_PASSWORD='<strong-pwd>' pnpm sync:supabase

# 3. Thereafter (role already exists) just:
pnpm sync:supabase
```

`sync:supabase` is **idempotent and non-destructive**: it only adds what's
missing and re-asserts the `flicks_app` grants, so it's safe to run repeatedly on
a database that already holds V1 (HRMS) data. To back the module out cleanly
(leaving HRMS untouched): `pnpm uninstall:invoicing`.

> Supabase is database-only — to run the app (`pnpm dev`) you still need Redis,
> e.g. `docker run -d -p 6379:6379 redis:7-alpine`. Leave `hsn_sac_codes` with RLS
> **off** in the Supabase Table Editor (it's the intentional global HSN/SAC master).

## Common commands

```bash
pnpm dev            # turbo: api on :4000, web on :3000
pnpm typecheck      # tsc --noEmit across both apps
pnpm test           # PRD Gate 1 — multi-tenant isolation tests (10/10)
pnpm lint
pnpm db:studio      # drizzle-kit studio
pnpm db:seed        # idempotent — re-run any time

pnpm setup:db       # local DB bootstrap (re-run safely)
pnpm setup:demo     # demo tenant + users (re-run safely)
```

---

## Architecture

- **Multi-tenant security** — shared-schema RLS on every tenant-scoped table. The `flicks_app` role is `NOBYPASSRLS`. Service code wraps queries in `databaseService.withTenant(tenantId, async tx => ...)` which sets `app.tenant_id` for the transaction; the RLS policies use `current_setting('app.tenant_id')::uuid` to filter.
- **Auth** — passwordless email OTP + magic link, JWT access (HttpOnly cookie) + rotating refresh token, FAM TOTP guard for platform admins. Resend handles email.
- **Tenancy at runtime** — `TenantMiddleware` reads JWT, stashes tenantId in `nestjs-cls`. Services read it via the JWT payload they receive from controllers.
- **Stack** — Nest 11, Drizzle + postgres-js, BullMQ (Redis), socket.io, Tailwind, shadcn/ui, framer-motion, React Query, Zustand.

---

## Verifying RLS is actually enforced (PRD Gate 1)

```bash
pnpm setup:db          # ensure flicks_app role exists
pnpm test              # runs apps/api/src/__tests__/multi-tenant.spec.ts
```

The 10 tests create two tenants, seed distinct rows in each, and assert that no query from tenant A's context sees tenant B's data. They use `flicks_app` for the assertions and the postgres superuser only for cross-tenant setup.

If you ever see all 10 pass against the postgres superuser only, that's a false positive — confirm with `SELECT usebypassrls FROM pg_user WHERE usename=current_user;` inside the test connection.

---

## Troubleshooting

**"role flicks_app does not exist" when starting the API**
Run `pnpm setup:db`.

**API logs show "Failed to write audit log: new row violates row-level security policy"**
This means the API is connecting as `flicks_app` (good) but a service is bypassing `databaseService.withTenant()`. Search for `this.db.insert(` or `this.db.select(` outside `withTenant` callbacks.

**Login OTP never arrives in email**
Resend's free tier only delivers to the address that owns the account. In dev, the OTP code is also logged to the API console — search for `[DEV] OTP for ...`.

**Next.js says "address already in use" on port 3000**
Something else is bound to 3000. `lsof -i :3000` to find it. Or override: `PORT=3001 pnpm --filter @flicks/web dev`.

**Postgres connection refused**
If you're using the bundled Docker setup: `docker compose ps` should show `postgres` healthy. If you're using a system Postgres, check `pg_isready -h 127.0.0.1 -p 5432`.

---

## License

Proprietary — internal use only.
