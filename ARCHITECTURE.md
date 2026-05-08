# Flicks Suite — Architecture Guide

## Overview

Flicks Suite is a multi-tenant B2B SaaS HRMS built for Indian startups (10–75 employees). This document describes the technical architecture for engineers joining the project.

**Read the PRD first:** `Flicks_Suite_HRMS_PRD_v1.md` is the single source of truth for product requirements.

---

## Monorepo Structure

```
flicks-suite/
├── apps/
│   ├── web/          # Next.js 15 App Router — frontend (app.flickssuite.com)
│   └── api/          # NestJS 11 — backend API (api.flickssuite.com)
├── packages/
│   ├── db/           # Drizzle ORM schema + migrations
│   ├── emails/       # React Email templates (18 templates)
│   └── shared/       # Shared TypeScript types, Zod validators, constants
├── package.json      # pnpm workspace root
├── pnpm-workspace.yaml
├── turbo.json        # Turborepo build pipeline
└── .env.example      # All required environment variables
```

---

## Technology Stack

| Layer | Technology | Why |
|---|---|---|
| Frontend | Next.js 15 App Router + TypeScript | Vercel-native, RSC-ready |
| UI | shadcn/ui + Tailwind CSS | Code ownership, accessibility |
| Server state | TanStack Query v5 | Cache + optimistic updates |
| Client state | Zustand | Lightweight, no boilerplate |
| Forms | react-hook-form + Zod | Type-safe validation |
| Backend | NestJS 11 (modular monolith) | Module isolation, DI, Swagger |
| Database | PostgreSQL 17 on Supabase | RLS-native, Mumbai region |
| ORM | Drizzle ORM | Type-safe SQL, RLS support |
| Auth | Custom Passport.js + JWT + OTP | No passwords, owned surface |
| Email | Resend + React Email | Best deliverability |
| Files | Cloudflare R2 | Zero egress fees |
| Cache/Queue | Upstash Redis + BullMQ | Serverless, pay-per-request |
| Realtime | Socket.IO | Live attendance, notifications |

---

## Multi-Tenancy Model

**Shared schema + Row-Level Security (RLS)** — not schema-per-tenant.

Every tenant-scoped table has:
- `tenant_id UUID NOT NULL` column
- RLS policy: `USING (tenant_id = current_setting('app.tenant_id', true)::uuid)`

Every authenticated API request:
1. JWT carries `tenant_id`
2. `TenantContextMiddleware` extracts it into `nestjs-cls`
3. Every Drizzle query runs inside `withTenant(tenantId, callback)` which executes `SET LOCAL app.tenant_id = '...'` before the query
4. Postgres RLS enforces isolation — no app-level bug can leak cross-tenant data

**Service-role bypass** (FAM only): `DB_SERVICE_ROLE_URL` uses a Postgres role with `BYPASSRLS` privilege. Only the FAM module's service layer can use this connection.

**Cross-tenant test suite**: 10 automated integration tests (in `apps/api/test/multi-tenant.spec.ts`) must pass in CI before any PR merges. This is the single most important security control.

---

## Authentication

**No passwords.** Login via:
1. Email → OTP (6-digit code, 10-minute expiry) + magic link (same email, same expiry)
2. Magic link: one-click login via URL token
3. Trusted devices: first login from new device requires OTP; subsequent logins on same device skip OTP for 30 days

**Tokens:**
- Access token: JWT, 15-minute expiry, HttpOnly Secure SameSite=Lax cookie
- Refresh token: opaque 32-byte random hex, stored as SHA-256 hash in DB, 30-day expiry, rotates on use

**FAM extra security:** email-OTP + TOTP (authenticator app) required for platform admins.

---

## RBAC

Five roles per tenant:
- `super_admin`: full control including billing
- `admin`: all HR actions, no billing
- `manager`: direct reports only
- `finance`: read compensation, invoicing access
- `employee`: self-service only

Implemented via NestJS `@Roles()` decorator + `RolesGuard`. Service layer adds additional row-level filtering (managers see only direct reports).

---

## Module Boundaries

Modules **MUST NOT** import each other's internals. Cross-module communication via:
- `EventEmitter2` for fire-and-forget (`employee.created`, `leave.approved`)
- Explicit service injection via public interfaces (`module/index.ts`)

ESLint rule `import/no-restricted-paths` enforces this.

---

## Database

All migrations in `packages/db/drizzle/`. Run with `pnpm db:migrate`.

Key schema files:
- `packages/db/src/schema/platform.ts` — tenants, users, memberships
- `packages/db/src/schema/auth.ts` — OTPs, refresh tokens, devices
- `packages/db/src/schema/employees.ts` — employees + related tables
- `packages/db/src/schema/attendance.ts` — clock-in/out records
- `packages/db/src/schema/leave.ts` — leave types, balances, requests
- `packages/db/src/schema/timesheet.ts` — timesheet periods + entries
- `packages/db/src/schema/fam.ts` — platform admin tables

---

## DPDP Compliance

Indian Digital Personal Data Protection Act 2023 requirements:
- Sensitive data (PAN, bank account) stored encrypted via pgcrypto
- Aadhaar: store ONLY last 4 digits — never store full Aadhaar
- Consent records stored in `data_consents` table with timestamp + IP
- Data export: `GET /me/export` — available to every employee
- Data deletion: 90-day soft-delete before hard delete
- Data in Mumbai region (ap-south-1)
- Privacy policy at `/privacy`

---

## Development Setup

```bash
# Prerequisites: Node 22+, pnpm 9+, Docker (for local Postgres)

# Install dependencies
pnpm install

# Copy environment variables
cp .env.example .env.local
# Fill in your Supabase URL, Resend key, etc.

# Generate database client
pnpm db:generate

# Run migrations
pnpm db:migrate

# Seed default data (leave types, holidays)
pnpm db:seed

# Start all services
pnpm dev
# → web: http://localhost:3000
# → api: http://localhost:4000
# → api docs: http://localhost:4000/api/docs
# → email preview: http://localhost:3002
```

---

## Deployment

- **Frontend:** Vercel (connected to this repo, auto-deploy on main)
- **Backend:** Railway (Dockerfile in apps/api/, auto-deploy)
- **Database:** Supabase (Mumbai region)
- **Secrets:** Doppler (not Vercel env vars) — rotated quarterly

**CI:** GitHub Actions runs on every PR:
1. TypeScript typecheck (all packages)
2. ESLint lint
3. Multi-tenant isolation tests (10 tests must pass)
4. Build check

---

## Build Sequence (from PRD)

Build in this order — do not start Step N+1 until Step N is tested:

1. Database + multi-tenant RLS (`packages/db`)
2. Auth + Customer onboarding + Employee onboarding
3. Clock-in/out + Attendance
4. Leave management + Calendar
5. Dashboard + FAM admin
6. First customer onboarding validation (Specflicks themselves)
7. Timesheets

Each step has explicit acceptance gates in PRD Section 12.2.
