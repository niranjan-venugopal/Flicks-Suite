# Flicks Suite — HRMS Module

## Product Requirements Document v1.0

**Specflicks Private Limited**
Niranjan V — CEO  •  Venugopal Ramachandran — CFO
Document version: 1.0  •  April 27, 2026
Status: **Approved for Implementation**
Audience: Founders, Engineers (Claude Code), Designers, Future Interns

---

## Document Control & Reading Guide

### Purpose

This Product Requirements Document specifies the HRMS module of Flicks Suite — an all-in-one B2B SaaS for Indian startups (10–75 employees). It is the single source of truth for what gets built, in what order, and to what quality bar. Engineers and Claude Code use this document section-by-section as build instructions. The PRD is binding for Phase 1; later phases (Project Management, Invoicing) have their own PRDs that reference this one for shared concepts.

### How to Read This Document

- Sections 1–3 are foundational: read these before writing any code. They define the architecture, security model, and authentication system that every other section assumes.
- Sections 4–10 are the seven build steps from Niranjan's plan, in order. Build them sequentially. Do not start step N+1 until step N is feature-complete and tested.
- Section 11 is the FAM platform admin panel, built last (week 5–6) once customer data exists.
- Each module section follows the same structure: Goals → User Stories → Database Schema → API Endpoints → UI Specifications → Acceptance Criteria → Out-of-Scope-for-MVP.
- Code blocks are reference patterns, not literal copy-paste. Claude Code adapts them to the actual repo state.

### Document Conventions

- **MUST** = non-negotiable. Skipping breaks security, compliance, or core UX.
- **SHOULD** = strong recommendation. Skip only with founder approval.
- **MAY** = optional / nice-to-have for MVP.
- **DEFER** = explicitly out of MVP scope; ship in Phase 2.

### Build Sequence (Niranjan's 7-Step Plan)

1. Database & multi-tenant architecture (Section 2)
2. Customer onboarding + Employee onboarding (Sections 4–5)
3. Clock-in/out & attendance (Section 6)
4. Leave management & calendar (Section 7)
5. Customer Admin Dashboard + FAM platform admin (Sections 10–11)
6. First customer onboarding test (validation milestone)
7. Timesheet management (Section 8)

Estimated build duration: 4–6 weeks for Niranjan + Claude Code, with Venugopal handling QA, GST/compliance acceptance tests, customer success, and documentation.

---

## 1. System Architecture & Technology Decisions

### 1.1 Technology Stack (Locked)

| Layer | Technology | Rationale |
|---|---|---|
| Frontend | Next.js 15 (App Router) + TypeScript | Vercel-native, easy intern adoption, RSC option for future |
| UI library | shadcn/ui + Tailwind CSS | Code ownership, accessibility, theming; not a vendor dependency |
| State (server) | TanStack Query v5 | Cache, optimistic updates, automatic refetch |
| State (client) | Zustand | 1KB; no boilerplate; module-scoped stores |
| Forms | react-hook-form + Zod | Type-safe validation shared between client and server |
| Backend | NestJS 11 + TypeScript (modular monolith) | Module isolation, DI, guards, interceptors, OpenAPI built-in |
| Database | PostgreSQL 17 on Supabase | RLS-native, managed pooler (Supavisor), realtime, Mumbai region |
| ORM | Drizzle ORM | Type-safe SQL, native RLS support, fastest cold starts |
| Auth | Custom: Passport.js + JWT + email-OTP | Owned auth surface; Resend for email delivery |
| Email | Resend + React Email | ₹0 free tier (3K/mo); best deliverability for transactional in 2026 |
| File storage | Cloudflare R2 (S3-compatible) | Zero egress fees; ~₹1.6/GB/month vs S3 ₹2.1/GB |
| Cache & queues | Upstash Redis (serverless) | Pay-per-request; BullMQ for background jobs |
| Background jobs | BullMQ via @nestjs/bullmq | Email send, PDF generation, scheduled reminders |
| Realtime | Socket.IO (NestJS Gateway) | Notifications, live attendance updates |
| Hosting (frontend) | Vercel | Global CDN; Pro at ₹1,700/mo when commercial |
| Hosting (backend) | Railway | Zero-config NestJS deploy, ~₹400–800/mo at MVP scale |
| Monitoring | Sentry + PostHog + Better Stack | All have generous free tiers |
| API docs | Swagger via @nestjs/swagger | Auto-generated from decorators; published at `/api/docs` |

### 1.2 Architecture Pattern: Modular Monolith (NOT Microservices)

This is a deliberate architectural decision documented here so future contributors understand why. We chose a modular monolith over true microservices for Specflicks at the current team size. The decision will hold until the team exceeds ~20 engineers OR a single module's scaling profile diverges sharply from the rest.

**Why modular monolith for Specflicks:**

- **Team size:** 2 founders + 5 future interns. Microservices were designed for organizations with hundreds of engineers (Amazon, Netflix). The "two-pizza team" rule (one team per service) requires 6–10 engineers per service. With 7 people across 6+ services, you have <1.2 people per service — worse than the monolith problem.
- **Operational cost:** a true microservices setup needs Kubernetes, service mesh, message broker (NATS/RabbitMQ), distributed tracing, centralized logging, API gateway, and per-service CI/CD. Real cost: ₹15–25K/month vs ₹3–5K/month for one Railway service. Total team time spent on infrastructure instead of features: ~30%.
- **Cross-cutting features:** every important Specflicks feature (employee onboarding, leave approval, payroll later, AI Jarvis briefing) spans multiple modules. In microservices, this requires designing distributed transactions (saga pattern), eventual consistency, retries, circuit breakers — weeks of additional work per feature.
- **Local development:** interns running 5+ services locally to test one feature is friction. With a monolith, one `pnpm dev` command starts everything.
- **Debugging:** a single bug-traced user request spans 4 services in microservices. With a monolith, it's one stack trace.
- **Real-world precedent:** Shopify (5,000+ engineers) still runs largely as a modular Rails monolith. Stripe ran as a Ruby monolith for years. Cal.com (open source, your reference) is a Next.js monolith.

**What "modular monolith" means concretely:**

Specflicks is one NestJS application, deployed as one process, talking to one database. But the code is structured as strictly separated modules. Each module has its own controllers, services, schemas (in code), guards, and DTOs. Modules MUST NOT directly import code from other modules' internals — they communicate through well-defined service interfaces or events.

```
apps/api/src/
├── modules/                    ← Feature modules ("almost a microservice" each)
│   ├── auth/                   ← Login, OTP, sessions, JWT
│   ├── tenants/                ← Organization, plan, subscription
│   ├── users/                  ← User accounts (across all tenants)
│   ├── employees/              ← Employee records, profiles, transfers
│   ├── attendance/             ← Clock-in/out, shifts, geofence
│   ├── leave/                  ← Leave types, requests, balances
│   ├── timesheet/              ← Timesheet entries, submissions
│   ├── settings/               ← Org settings, RBAC config
│   ├── notifications/          ← Email, push, in-app
│   ├── audit/                  ← Audit log writer + reader
│   └── fam/                    ← Specflicks platform admin
├── core/                       ← Shared infrastructure
│   ├── database/               ← Drizzle client, RLS context
│   ├── auth/                   ← @Public(), @Roles(), guards
│   ├── tenant/                 ← Tenant context middleware
│   ├── common/                 ← DTOs, exception filters, pipes
│   └── config/                 ← env validation, feature flags
└── main.ts                     ← Bootstrap, Swagger, CORS
```

**Module boundary enforcement:**

- ESLint rule `import/no-restricted-paths` blocks any module from importing another module's internals. Modules can only import from other modules' `public` index files (e.g., `employees/index.ts`).
- Cross-module communication uses NestJS `EventEmitter2` for fire-and-forget events (`employee.created`, `leave.approved`) and explicit service injection for synchronous calls.
- Each module exposes a Public Module Service Interface in `module/index.ts`. Other modules depend on this interface, not the implementation.
- Database tables are owned per module (employees module owns `employees`, `employee_documents`; attendance module owns `attendance_records`). Cross-table joins happen at the service layer, not by directly querying another module's tables.

**Migration path to microservices (if/when needed):**

If a specific module ever needs to be extracted to a microservice, the work is 2–3 days because boundaries are already clean:

1. Move the module's code to a new NestJS project.
2. Move its database tables to a new schema or new database.
3. Replace `EventEmitter2` calls with HTTP/gRPC calls or NATS messages.
4. Add the new service URL to the monolith's environment config.
5. Deploy the new service; the monolith calls it instead of the local module.

Most likely first extraction: the Notifications module when email volume exceeds 100K/month. Second most likely: AI Jarvis briefing service (Phase 2) because Claude API call patterns are different from CRUD workloads.

---

## 2. Multi-Tenant Database Architecture

### 2.1 The Decision: Shared Schema + Row-Level Security

Specflicks uses a shared PostgreSQL schema with Row-Level Security (RLS) policies enforcing tenant isolation. Every tenant-scoped table has a `tenant_id` column with a uniform RLS policy that restricts access to the current tenant. This decision is documented here because it will be questioned by every new engineer who joins.

**Why not schema-per-tenant:**

Schema-per-tenant feels intuitively safer because data sits in physically separate schemas. But the costs at scale are real and well-documented:

| Concern | Schema-per-tenant | Shared schema + RLS |
|---|---|---|
| Cost at 500 tenants (Supabase Pro) | ~₹80K–1.1L/month | ~₹4K–5K/month |
| Migration time at 500 tenants | 15–60 min, with locks | ~200ms, atomic |
| Migration at 100K tenants | Operationally impossible | ~200ms, atomic |
| PgBouncer transaction-mode pooling | Breaks (search_path lost) | Works (SET LOCAL persists) |
| Catalog bloat at 1K tenants | 30K+ pg_class entries; slow planner | None |
| Cross-tenant analytics for FAM | Painful UNION across schemas | Trivial single SELECT |
| Per-tenant backup | Native pg_dump per schema | Filtered exports needed |
| Security mechanism | App code switches search_path | Postgres engine enforces below app code |
| Bug surface for cross-tenant leak | Application middleware | Requires bypassing Postgres itself |

**The published evidence consensus:**
- Influitive's public postmortem hit the wall at ~100 tenants and migrated to RLS.
- Neon's official multi-tenancy docs explicitly recommend RLS over schema-per-tenant.
- AWS RDS, Azure Postgres, and Supabase all document RLS as the default pattern.
- GitLab uses RLS. Stripe uses tenant_id-based isolation. Linear uses RLS.

> RLS is not "less secure" than schema-per-tenant. It is enforced one layer deeper — by Postgres itself, below your application code. Application bugs cannot leak data because the database refuses to return rows that don't match the active tenant's policy.

**How RLS is enforced at request time:**

1. Every authenticated request carries a JWT containing `tenant_id` and `user_id`.
2. NestJS `TenantContextMiddleware` extracts `tenant_id` from the JWT and stores it in `nestjs-cls` (continuation-local storage).
3. Drizzle wraps each query in a transaction that runs `SET LOCAL app.tenant_id = '<uuid>'` before the SELECT/INSERT.
4. Postgres applies the RLS policy `USING (tenant_id = current_setting('app.tenant_id')::uuid)` to every tenant-scoped table.
5. Cross-tenant SELECTs return zero rows. INSERTs with the wrong `tenant_id` are rejected. Postgres makes this physically impossible to bypass from app code.

### 2.2 Database Schema Foundation

The platform has three categories of tables:

- **Platform tables** (no tenant_id): `tenants`, `users`, `subscriptions`, `audit_log_platform`, `feature_flags`, `system_metrics`. Owned by FAM. Accessed only via service-role bypass.
- **Tenant-scoped tables** (have tenant_id, RLS-enforced): `employees`, `attendance_records`, `leave_requests`, `timesheets`, etc. The vast majority of tables.
- **Shared reference tables** (no tenant_id, read-only for tenants): `holidays_master` (per-state Indian holidays), `currencies`. Seeded by Specflicks.

**Core platform schema (foundation tables):**

```sql
-- Tenants: every customer company is a tenant
CREATE TABLE tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(200) NOT NULL,
  slug VARCHAR(80) UNIQUE NOT NULL,        -- specflicks.flicks.app
  legal_name VARCHAR(255),                  -- "Specflicks Private Limited"
  gstin VARCHAR(15),                        -- 27ABCDE1234F1Z5 (validated)
  pan VARCHAR(10),
  cin VARCHAR(21),                          -- Company Identification Number
  industry VARCHAR(80),
  size_band VARCHAR(20),                    -- '1-10', '11-25', '26-50', '51-100'
  country_code CHAR(2) DEFAULT 'IN',
  state_code CHAR(2),                       -- ISO 3166-2:IN code, e.g. 'KA'
  city VARCHAR(100),
  address_line1 VARCHAR(255),
  address_line2 VARCHAR(255),
  postal_code VARCHAR(15),
  timezone VARCHAR(60) DEFAULT 'Asia/Kolkata',
  currency CHAR(3) DEFAULT 'INR',
  fiscal_year_start_month SMALLINT DEFAULT 4,    -- April for India
  date_format VARCHAR(20) DEFAULT 'DD/MM/YYYY',
  working_days SMALLINT[] DEFAULT '{1,2,3,4,5}', -- Mon-Fri (ISO weekday)
  default_work_start TIME DEFAULT '09:00',
  default_work_end TIME DEFAULT '18:00',
  logo_url TEXT,
  brand_color VARCHAR(7),                   -- '#1F3864'
  status VARCHAR(20) DEFAULT 'trialing',    -- trialing|active|past_due|canceled|suspended
  trial_ends_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ,                  -- FAM-set after KYC
  verified_by_user_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deleted_at TIMESTAMPTZ                    -- soft delete
);

CREATE INDEX idx_tenants_slug ON tenants(slug) WHERE deleted_at IS NULL;
CREATE INDEX idx_tenants_status ON tenants(status);

-- Users: cross-tenant identity (one user can belong to multiple tenants)
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email CITEXT UNIQUE NOT NULL,             -- case-insensitive
  email_verified_at TIMESTAMPTZ,
  full_name VARCHAR(200),
  avatar_url TEXT,
  phone VARCHAR(20),
  phone_verified_at TIMESTAMPTZ,
  locale VARCHAR(10) DEFAULT 'en-IN',
  timezone VARCHAR(60),
  is_platform_admin BOOLEAN DEFAULT FALSE,  -- Specflicks team (FAM access)
  status VARCHAR(20) DEFAULT 'active',      -- active|suspended|deleted
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_platform_admin ON users(is_platform_admin) WHERE is_platform_admin = TRUE;

-- Memberships: many-to-many between users and tenants
CREATE TABLE memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  employee_id UUID,                          -- FK added later (employees table)
  role VARCHAR(40) NOT NULL,                 -- 'super_admin'|'admin'|'manager'|'finance'|'employee'
  status VARCHAR(20) DEFAULT 'active',       -- pending|active|suspended
  invited_by UUID REFERENCES users(id),
  invited_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (tenant_id, user_id)
);
CREATE INDEX idx_memberships_user ON memberships(user_id);
CREATE INDEX idx_memberships_tenant ON memberships(tenant_id);

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_memberships ON memberships
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
```

**RLS policy template (apply to every tenant-scoped table):**

```sql
ALTER TABLE <table_name> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <table_name> FORCE ROW LEVEL SECURITY;  -- Applies even to table owners

CREATE POLICY tenant_isolation_<table> ON <table_name>
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Critical: composite indexes leading with tenant_id
CREATE INDEX idx_<table>_tenant ON <table_name>(tenant_id);
CREATE INDEX idx_<table>_tenant_<col> ON <table_name>(tenant_id, <important_col>);
```

**Tenant context middleware (NestJS):**

```typescript
// core/tenant/tenant.middleware.ts
import { Injectable, NestMiddleware } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';

@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  constructor(private readonly cls: ClsService) {}

  use(req: Request, res: Response, next: NextFunction) {
    const tenantId = req['user']?.tenantId; // set by JWT auth guard
    if (tenantId) {
      this.cls.set('tenantId', tenantId);
      this.cls.set('userId', req['user'].sub);
    }
    next();
  }
}

// core/database/db.service.ts
async runQuery<T>(callback: (tx) => Promise<T>): Promise<T> {
  const tenantId = this.cls.get('tenantId');
  return await this.db.transaction(async (tx) => {
    if (tenantId) {
      await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
    }
    return callback(tx);
  });
}
```

### 2.3 Cross-Tenant Test Suite (CI-Required)

Every PR runs a 10-test integration suite that creates two tenants, seeds distinct data in each, and asserts that no query from tenant A can access tenant B's data. Any failure blocks the PR. This is the single most important security control in the codebase.

```typescript
describe('multi-tenant isolation', () => {
  let tenantA: string, tenantB: string;
  beforeAll(async () => {
    tenantA = (await createTenant({ name: 'A' })).id;
    tenantB = (await createTenant({ name: 'B' })).id;
    await seedEmployee(tenantA, { email: 'alice@a.com' });
    await seedEmployee(tenantB, { email: 'bob@b.com' });
  });

  it('SELECT from tenant A returns 0 rows from tenant B', async () => {
    setActiveTenant(tenantA);
    const employees = await db.select().from(schema.employees);
    expect(employees.every(e => e.tenantId === tenantA)).toBe(true);
    expect(employees.find(e => e.email === 'bob@b.com')).toBeUndefined();
  });

  it('INSERT with foreign tenant_id is rejected by RLS', async () => {
    setActiveTenant(tenantA);
    await expect(
      db.insert(schema.employees).values({ tenantId: tenantB, email: 'evil@a.com' })
    ).rejects.toThrow();
  });

  // ... 8 more tests covering UPDATE, DELETE, JOINs, subqueries, etc.
});
```

### 2.4 Service-Role Bypass (FAM Only)

Specflicks platform admins (FAM) need cross-tenant visibility. Implemented via a separate service-role connection that uses a Postgres role with `BYPASSRLS` privilege. This connection is only available inside the FAM module's service layer and never exposed to tenant-facing controllers.

```sql
-- Create the service role
CREATE ROLE flicks_service_role WITH LOGIN PASSWORD '...';
GRANT BYPASSRLS TO flicks_service_role;
GRANT USAGE ON SCHEMA public TO flicks_service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO flicks_service_role;
```

```typescript
// In NestJS, FamService uses a separate Drizzle client
@Injectable()
export class FamService {
  constructor(@Inject('DB_SERVICE_ROLE') private readonly dbAdmin: DrizzleClient) {}

  async listAllTenants(): Promise<Tenant[]> {
    // No tenant_id filter; sees everything
    return this.dbAdmin.select().from(schema.tenants);
  }
}
```

### 2.5 Backups, Disaster Recovery, Compliance

- Supabase provides daily automated backups with 7-day retention on Pro plan; configure Point-in-Time Recovery (PITR) for granular restore.
- Weekly logical backup via `pg_dump` to Cloudflare R2, retained for 90 days. Automated via GitHub Actions cron.
- Per-tenant export available on demand via FAM (DPDP Article 13 — right to data portability).
- Per-tenant deletion: soft-delete sets `deleted_at`; hard-delete after 90 days via scheduled job. DPDP compliance for data principal erasure requests.
- All connection strings, service role keys, JWT secrets stored in Doppler (not Vercel env vars). Rotated quarterly.
- Database in `ap-south-1` (Mumbai) — DPDP best practice for Indian customer data; reduces latency for Indian users.

---

## 3. Authentication & Authorization

### 3.1 The Auth Strategy: Passwordless Email-OTP + Magic Link

Specflicks uses passwordless authentication. No passwords are stored. Login is via 6-digit OTP sent to email, with magic link as the primary one-tap alternative. This decision balances security (no passwords to leak), UX (no password reset flows — the #2 source of B2B SaaS support tickets), and developer effort (no bcrypt cost-factor calibration, no password strength meters).

**The login flow:**

1. User enters email.
2. Backend generates a 6-digit OTP, hashes it with SHA-256, stores `(otp_hash, expires_at, user_id)` in `auth_otps`.
3. Backend sends two things via Resend in one email: the 6-digit code and a magic link URL `https://app.flickssuite.com/auth/verify?token=<jwt>`.
4. User can either (a) click the magic link → instant login on that device, OR (b) enter the 6-digit code in the app on any device.
5. On success, backend issues an access token (JWT, 15 min) and a refresh token (opaque random string, 30 days, stored in `refresh_tokens` table).
6. Both tokens stored in HttpOnly Secure SameSite=Lax cookies.
7. Browser is marked as a "trusted device" via a long-lived `device_id` cookie (180 days). Future logins from the same device bypass OTP for a 30-day session.

**Why this design vs alternatives:**

- Magic link only (no OTP code): fails when user wants to log in on phone after clicking the link on desktop. Fixed by also showing the code.
- OTP only (no magic link): more friction on mobile. The link is one-tap; the code is six characters.
- Email/password: requires bcrypt, password reset flow, password strength UI, "forgot password" email, "change password" page. ~5–7 days of work + a permanent attack surface.
- OAuth only (Google): excludes users without Google accounts; OK to add as supplementary, but not as the only path.

### 3.2 Database Schema (Auth Tables)

```sql
-- One-time passwords
CREATE TABLE auth_otps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email CITEXT NOT NULL,                    -- denormalized for rate limiting
  user_id UUID REFERENCES users(id),         -- null if user doesn't exist yet
  otp_hash CHAR(64) NOT NULL,                -- SHA-256 of 6-digit code
  magic_link_token CHAR(64) NOT NULL,        -- random 32-byte hex
  attempt_count SMALLINT DEFAULT 0,
  ip_address INET,
  user_agent TEXT,
  expires_at TIMESTAMPTZ NOT NULL,           -- now() + 10 min
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_otps_email_active ON auth_otps(email, expires_at) WHERE consumed_at IS NULL;
CREATE INDEX idx_otps_magic_link ON auth_otps(magic_link_token) WHERE consumed_at IS NULL;

-- Refresh tokens (opaque, random; rotate on use)
CREATE TABLE refresh_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id UUID REFERENCES tenants(id),     -- null until tenant chosen
  token_hash CHAR(64) NOT NULL UNIQUE,        -- SHA-256 of opaque token
  device_id UUID NOT NULL,                    -- ties refresh to device
  ip_address INET,
  user_agent TEXT,
  expires_at TIMESTAMPTZ NOT NULL,            -- now() + 30 days
  revoked_at TIMESTAMPTZ,
  rotated_to UUID REFERENCES refresh_tokens(id),  -- audit trail
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);
CREATE INDEX idx_refresh_user ON refresh_tokens(user_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_refresh_token ON refresh_tokens(token_hash);

-- Trusted devices (skip OTP for known devices)
CREATE TABLE trusted_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id UUID NOT NULL,
  device_name VARCHAR(200),                   -- "MacBook Pro · Chrome"
  ip_address INET,
  user_agent TEXT,
  last_used_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,            -- now() + 180 days
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, device_id)
);

-- Login audit (every successful and failed login attempt)
CREATE TABLE auth_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email CITEXT NOT NULL,
  user_id UUID REFERENCES users(id),
  event_type VARCHAR(40) NOT NULL,
    -- 'otp_requested'|'otp_verified'|'otp_failed'|'magic_link_used'|'token_refreshed'|'logout'
  ip_address INET,
  user_agent TEXT,
  device_id UUID,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_auth_events_email ON auth_events(email, created_at DESC);
CREATE INDEX idx_auth_events_user ON auth_events(user_id, created_at DESC);
```

### 3.3 API Endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/auth/request-otp` | Request OTP + magic link for an email |
| POST | `/auth/verify-otp` | Verify 6-digit OTP, issue tokens |
| GET | `/auth/magic-link` | Verify magic link token, issue tokens, redirect |
| POST | `/auth/refresh` | Rotate refresh token, issue new access token |
| POST | `/auth/logout` | Revoke current session |
| POST | `/auth/logout-all` | Revoke all sessions for user |
| GET | `/auth/me` | Current user + active tenant memberships |
| POST | `/auth/select-tenant` | Switch active tenant for current session |
| GET | `/auth/sessions` | List user's active sessions/devices |
| DELETE | `/auth/sessions/:id` | Revoke a specific session |

### 3.4 JWT Payload Structure

```json
// Access token (JWT, 15-minute expiry)
{
  "sub": "user-uuid",                  // user.id
  "email": "niranjan@specflicks.com",
  "tenantId": "tenant-uuid",           // active tenant
  "membershipId": "membership-uuid",
  "role": "super_admin",               // role within active tenant
  "isPlatformAdmin": false,            // FAM access flag
  "deviceId": "device-uuid",
  "iat": 1714200000,
  "exp": 1714200900,
  "iss": "flickssuite.com",
  "aud": "flicks-app"
}

// Refresh token: opaque random 32-byte hex, NOT a JWT
// Stored as SHA-256 hash in refresh_tokens table
```

### 3.5 Security Controls

- **Rate limiting:** max 5 OTP requests per email per hour, max 10 per IP per hour. Implemented via `@nestjs/throttler` with Redis backend.
- **OTP expiry:** 10 minutes. After 5 wrong attempts, OTP is invalidated and email throttled for 15 minutes.
- **Refresh token rotation:** every refresh consumes the old token (sets `revoked_at`) and issues a new one. Detection of token reuse triggers full session revocation for that user (likely token theft).
- **HttpOnly cookies** for tokens; Secure flag in production; SameSite=Lax; Domain=`.flickssuite.com` for subdomain sharing.
- **CSRF protection:** SameSite=Lax cookies + CSRF token on state-changing requests (double-submit pattern).
- **Audit log entry** written for every auth event (success and failure). Used by FAM for security monitoring and DPDP compliance.
- **Magic link single-use:** token is consumed on first click; reuse fails with "link expired" message.
- **Email enumeration mitigation:** `/auth/request-otp` returns the same response (200 OK with generic message) whether the email exists or not. The OTP is only sent if the email matches a real user OR a pending invite.
- **Password-based login is not implemented.** There is no `/auth/login` endpoint with password fields. Reject any PR that adds one.

### 3.6 Authorization (RBAC)

Five roles within a tenant, defined in `memberships.role`:

| Role | Description | Key permissions |
|---|---|---|
| `super_admin` | Founder/owner; full control | All actions including billing, tenant settings, RBAC config, member management |
| `admin` | HR head, COO; org-wide HR control | All HRMS actions; manage employees, settings, approve any leave; cannot modify billing |
| `manager` | Reporting manager | View/approve leave + timesheet for direct reports; view team attendance |
| `finance` | Finance / Venugopal-type | Invoicing module access; view (not edit) employee compensation; export GST reports |
| `employee` | Default for all employees | Self-service: own attendance, leave, timesheet, profile. Cannot see others' data. |

RBAC is implemented via NestJS guards and decorators:

```typescript
@Controller('employees')
@UseGuards(JwtAuthGuard, RolesGuard)
export class EmployeesController {
  @Get()
  @Roles('super_admin', 'admin', 'manager')   // managers see only their reports
  list() { ... }

  @Post()
  @Roles('super_admin', 'admin')
  create(@Body() dto: CreateEmployeeDto) { ... }

  @Get(':id')
  @Roles('super_admin', 'admin', 'manager', 'employee')
  // Service layer enforces: employee can only fetch their own; manager only direct reports
  findOne(@Param('id') id: string, @Req() req) { ... }
}
```

### 3.7 Resend Email Configuration

- **Domain setup:** SPF, DKIM, DMARC records on `flickssuite.com` (Resend provides exact values). Mandatory for inbox deliverability.
- **From address:** `auth@flickssuite.com` for OTP/login; `notifications@flickssuite.com` for product notifications. Reply-to: `support@flickssuite.com`.
- **Email templates** built with React Email. Template `login-otp` includes: branded header, 6-digit code in large monospace, magic link button, security notice ("You're receiving this because someone tried to log in..."), expiry note ("Code expires in 10 minutes"), footer with company address and unsubscribe (mandatory under DPDP).
- **Template versioning:** all templates committed to git, rendered to HTML at build time, sent via Resend SDK.
- **Webhook for delivery events:** bounces and complaints written to `email_events` table for FAM dashboard.
- **Free tier:** 3,000 emails/month, 100/day. Sufficient for beta. Upgrade to ₹1,650/month at 50K/month when needed.

---

## 4. Customer Onboarding (Tenant Sign-Up)

### 4.1 Goals & Success Metrics

Customer onboarding is when a new company (tenant) signs up. The goal: get from "first click on landing page" to "logged into a working dashboard" in under 90 seconds, then complete tenant configuration in under 5 minutes. Every additional field reduces conversion by 3–5%. Every additional step compounds drop-off.

- Primary metric: Sign-up completion rate >70% (industry top quartile)
- Time-to-first-meaningful-action <5 minutes
- First employee invited within first session: >40%
- Drop-off rate per step <15%

### 4.2 Competitive Patterns Studied

| Product | Steps | Field count | Insight worth copying |
|---|---|---|---|
| Linear | 3 | 4 | Workspace name → URL slug → invite team in one screen. Beautiful URL preview as user types. |
| Notion | 4 | 6 | Persona question ("What do you do?") routes to relevant template gallery. |
| Rippling | 5 | 12+ | EIN-equivalent verified live during signup; auto-fills company address. |
| Keka | 5 | 15+ | India-specific: GSTIN lookup, PAN, state collected upfront. Slower but compliant. |
| BambooHR | 6 | 10 | "Tell us about your company" is conversational; feels less like a form. |
| HubSpot | 4 | 5 | Email-only first step; everything else after first login. |

**Synthesis: the Flicks approach.** Combine HubSpot's email-only first step (low friction) with Keka's India-specific compliance (GSTIN, state) but DEFER the compliance fields to a Day 1 onboarding checklist instead of blocking signup. Linear's slug-as-you-type for the workspace URL is delightful and we copy it directly. Notion's persona question is overkill for B2B SaaS — skip.

### 4.3 The Sign-Up Flow (3 Steps + Post-Signup Checklist)

**Step 1: Email (one field, ~10 seconds)**

Landing page CTA → modal or full-page form with one field: business email.

- Validation: must be a valid email; warn if free email (gmail.com, yahoo.com) but don't block — many founders use personal emails.
- On submit: send OTP + magic link via Resend (same flow as Section 3 login). Show "Check your email" state.
- If email is recognized as belonging to an existing tenant member: redirect to login flow instead of signup.

**Step 2: Verify email + Create workspace (post-OTP, ~30 seconds)**

After OTP verification, present a single screen with three fields:

- Workspace name (e.g., "Acme Corp") — pre-filled with email domain converted to title case.
- Workspace URL slug (e.g., `acme-corp.flicks.app`) — auto-generated from name, editable, validated unique server-side as user types (Linear pattern).
- Your name — pre-filled with the part of email before "@", editable.

On submit: backend creates `tenants` row, `users` row (if new email), `memberships` row with role=`super_admin`, issues access+refresh tokens, redirects to dashboard with onboarding checklist visible.

**Step 3: Plan selection (DEFERRED — show after value)**

Do NOT show pricing in the signup flow. Users land in a 14-day free trial automatically. Plan selection appears on day 12 of trial via banner, OR when they hit a feature gate (e.g., adding 6th employee on free plan). This follows the 2026 finding that opt-in (no-card) trials produce 2x better 90-day retention than card-required trials.

### 4.4 Post-Signup Onboarding Checklist (Day 1, ~5 min total)

After sign-up the user lands on the dashboard. A persistent checklist widget on the right side guides them through six tasks. Each task is optional but the dashboard is mostly empty until they complete them. Inspired by Linear's onboarding checklist (64% completion rate, vs ~20% industry average for traditional product tours).

| # | Task | Time | Why it's first / why it matters |
|---|---|---|---|
| 1 | Add company details (legal name, GSTIN, PAN, address) | 60s | Required for invoice generation in Phase 1; GSTIN format validated; state auto-derived from GSTIN's first 2 digits |
| 2 | Set up working hours & calendar | 45s | Default Mon–Fri, 9–6, IST; one-click to confirm or customize. Drives attendance & leave logic. |
| 3 | Add departments & designations | 60s | Five defaults pre-populated (Engineering, Sales, Marketing, Operations, HR); user can add/remove. |
| 4 | Create your own employee record | 30s | Founder is the first employee; pre-filled from signup data; just confirm fields. |
| 5 | Invite your first team member | 60s | Most powerful "aha moment" — sends invite email, employee onboards via self-service. |
| 6 | Upload company logo & set brand color | 30s | Cosmetic but increases ownership feel; visible on payslips, invoices, employee dashboard. |

The checklist persists across sessions until completed. Each task expands inline; user doesn't navigate away. Completion of all 6 tasks shows a celebration (subtle confetti animation via canvas-confetti) and unlocks the "Advanced Setup" panel (custom roles, locations, leave policies, integrations).

### 4.5 GSTIN Validation

GSTIN is 15 characters: `<2-digit state code><10-char PAN><1-digit entity><1 char Z><1 char checksum>`. Validation rules:

- Format regex: `/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/`
- State code (positions 1-2) must be valid ISO state code (01–37, plus 97 for Other Territory)
- Auto-derive state from first 2 digits → pre-fill state in tenant record
- PAN substring (positions 3-12) must match the company's PAN if both provided
- Optional: live verification via GSTN API (Setu, Sandbox, Karza) — DEFER to Phase 2; for MVP, format validation is sufficient

### 4.6 API Endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/onboarding/check-slug` | Validate workspace slug uniqueness (debounced) |
| POST | `/onboarding/create-tenant` | Create tenant + first super_admin user |
| PUT | `/onboarding/tenant-details` | Update GSTIN, PAN, address, fiscal year |
| POST | `/onboarding/departments` | Bulk create departments + designations |
| GET | `/onboarding/checklist` | Return current checklist state |
| PATCH | `/onboarding/checklist/:taskId` | Mark task complete |

### 4.7 UI Specifications

- All onboarding screens centered with max-width 480px, generous whitespace, single CTA per screen.
- Progress indicator only on the post-signup checklist, NOT on signup steps (prevents "I'm going to abandon at step 2" anchoring).
- Default tenant data created with Indian-friendly defaults: timezone Asia/Kolkata, currency INR, fiscal year April–March, working days Mon–Fri, week start Monday, date format DD/MM/YYYY.
- Mobile responsive: signup works on a phone in <90 seconds. Test with throttled 3G.

### 4.8 Acceptance Criteria

- New user signs up with only their email → receives OTP within 30 seconds → enters code → lands on dashboard with their name and a default workspace, all in under 90 seconds total.
- Workspace slug uniqueness validated server-side as user types (300ms debounce).
- Sign-up does not require: phone number, credit card, password, GSTIN, PAN, or company address.
- Post-signup checklist persists across sessions; partially completed tenants resume where they left off.
- GSTIN validation prevents save with malformed input but does NOT call external API in MVP.
- All onboarding events written to `audit_log_platform` for FAM funnel analysis.

### 4.9 Out of Scope for MVP

- DEFER: GSTN live API verification.
- DEFER: SSO during signup (Google OAuth).
- DEFER: Bulk import of existing employees from CSV during signup (available post-signup in Settings).
- DEFER: Migration tooling from Keka/greytHR/Excel (Phase 2).
- DEFER: Localized onboarding flows for non-Indian markets (Phase 3).

---

## 5. Employee Management & Self-Onboarding

### 5.1 Goals

The employee module is the foundational data primitive for everything else. Every other module (attendance, leave, timesheet, payroll, project management) references `employees`. Get this right and the platform compounds; get it wrong and every module inherits the bug.

### 5.2 The Self-Onboarding Flow (Industry Best Practice)

BambooHR is the gold standard for onboarding UX. The pattern: admin enters minimum data (name, email, role, joining date), system sends an invite link, employee completes the rest themselves. This split saves admin time and improves data accuracy (employees know their own bank details better than HR does).

**Phase A: Admin Invites Employee (~30 seconds per employee)**

Admin clicks "Add Employee" from the Employees screen. Modal opens with the bare minimum fields:

- First name, Last name (required)
- Work email (required, unique within tenant)
- Personal email (optional, used for pre-boarding before they have a work email)
- Mobile number (optional but strongly recommended for WhatsApp delivery later)
- Designation (free text or pick from designations master)
- Department (dropdown from departments master)
- Reporting manager (employee picker)
- Date of joining (date picker; can be future date for pre-boarding)
- Employment type (Full-time / Part-time / Contractor / Intern / Consultant)
- Location (dropdown from locations master)
- Send invite immediately checkbox (default: yes)

On submit: backend creates `employees` row with status=`pending_onboarding`, creates a `users` row if email is new, creates `memberships` row with role=`employee` and status=`pending`. Generates an `employee_invitations` row with a single-use token. Sends invite email via Resend.

**Phase B: Employee Self-Onboarding (~10 minutes for the employee)**

Employee clicks the invite link → magic-link auth (no password) → lands on a 5-step wizard:

**Step 1: Personal information**
- Confirm name (pre-filled, editable)
- Date of birth (date picker, validated 18+)
- Gender (Male/Female/Non-binary/Prefer not to say)
- Marital status (Single/Married/Divorced/Widowed/Prefer not to say) — required for some payroll/insurance contexts
- Nationality (default Indian)
- Blood group (optional, used for emergency)
- Personal mobile, personal email
- Profile photo upload (drag-and-drop, max 2MB, auto-resize via sharp on backend)

**Step 2: Address**
- Current address: line 1, line 2, city, state (dropdown), postal code, country
- Permanent address: "Same as current" checkbox; otherwise full fields

**Step 3: Emergency contact**
- Name, relationship (Spouse/Parent/Sibling/Friend/Other), phone (required), email (optional)
- Option to add a second emergency contact

**Step 4: Identity & Banking (DPDP-sensitive)**

This step contains personal sensitive data. Show a clear consent notice at the top: "These details are required for payroll, statutory compliance (PF, ESI, TDS), and verification. Stored encrypted; visible only to you, HR, and finance." Save consent record with timestamp.

- PAN number (format-validated, masked in display except last 4)
- Aadhaar — store ONLY last 4 digits (DPDP best practice; never store full Aadhaar)
- Bank account holder name (auto-filled from full name)
- Bank account number
- IFSC code (auto-fetches bank name + branch via Razorpay's free public API: `razorpay.com/ifsc/{IFSC}`)
- Account type (Savings / Current)
- UAN (PF Universal Account Number, optional for now)
- ESIC number (optional)

**Step 5: Documents**
- Upload: signed offer letter (PDF), ID proof (Aadhaar/Passport/Driver's License — auto-redact full Aadhaar number), address proof, education certificates (multiple), previous employer relieving letter, experience certificate
- Each document tagged with type; stored in Cloudflare R2 with tenant-scoped key prefix
- File types: PDF, JPG, PNG (max 10MB each)
- Documents marked as "Pending review" until admin approves

**Phase C: Admin Reviews & Activates (~2 minutes per employee)**

Admin gets notified (email + in-app + WhatsApp digest in Phase 2) that employee X completed onboarding. Admin reviews the submission in a side panel:

- Verify all sections were completed
- Spot-check documents (especially PAN, bank details)
- Optional: edit any field before approval
- **Approve** → `employees.status` changes from `pending_onboarding` to `active`; `memberships.status` changes from `pending` to `active`; employee gets a "You're all set" email; employee dashboard becomes fully functional
- **Reject** → admin enters reason; employee gets email to fix and resubmit

### 5.3 Database Schema

```sql
-- Departments (master data per tenant)
CREATE TABLE departments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  code VARCHAR(20),
  parent_id UUID REFERENCES departments(id),    -- nested orgs
  head_employee_id UUID,                         -- FK added later
  description TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (tenant_id, name)
);

-- Designations
CREATE TABLE designations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title VARCHAR(150) NOT NULL,
  level SMALLINT,                                -- L1, L2, etc.
  department_id UUID REFERENCES departments(id), -- optional link
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Locations / Branches
CREATE TABLE locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,                    -- "Bangalore HQ"
  address_line1 VARCHAR(255),
  address_line2 VARCHAR(255),
  city VARCHAR(100),
  state_code CHAR(2),
  postal_code VARCHAR(15),
  country_code CHAR(2) DEFAULT 'IN',
  timezone VARCHAR(60) DEFAULT 'Asia/Kolkata',
  geofence_lat NUMERIC(9,6),                     -- for clock-in
  geofence_lng NUMERIC(9,6),
  geofence_radius_m INTEGER DEFAULT 200,
  ip_allowlist CIDR[],                           -- office WiFi/VPN
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Employees (the central table)
CREATE TABLE employees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id),              -- null until invite accepted
  employee_code VARCHAR(40) NOT NULL,             -- "EMP001", configurable format

  -- Names & basic
  first_name VARCHAR(100) NOT NULL,
  middle_name VARCHAR(100),
  last_name VARCHAR(100) NOT NULL,
  preferred_name VARCHAR(100),
  full_name VARCHAR(300) GENERATED ALWAYS AS (
    TRIM(BOTH FROM first_name || ' ' || COALESCE(middle_name||' ','') || last_name)
  ) STORED,

  -- Contact
  work_email CITEXT NOT NULL,
  personal_email CITEXT,
  work_phone VARCHAR(20),
  personal_phone VARCHAR(20),

  -- Job details
  department_id UUID REFERENCES departments(id),
  designation_id UUID REFERENCES designations(id),
  location_id UUID REFERENCES locations(id),
  reporting_manager_id UUID REFERENCES employees(id),
  employment_type VARCHAR(30) NOT NULL,
    -- full_time|part_time|contractor|intern|consultant
  date_of_joining DATE NOT NULL,
  date_of_confirmation DATE,                       -- post-probation
  probation_end_date DATE,
  date_of_exit DATE,
  exit_reason VARCHAR(40),
    -- resignation|termination|retirement|absconded
  notice_period_days INTEGER DEFAULT 30,

  -- Personal (DPDP: encrypted at column level for sensitive)
  date_of_birth DATE,
  gender VARCHAR(20),
  marital_status VARCHAR(20),
  nationality VARCHAR(50) DEFAULT 'Indian',
  blood_group VARCHAR(5),

  -- Addresses
  current_address JSONB,                           -- {line1,line2,city,state,postal,country}
  permanent_address JSONB,

  -- Identity (sensitive — encrypted)
  pan_encrypted BYTEA,                             -- pgcrypto pgp_sym_encrypt
  aadhaar_last4 CHAR(4),                           -- ONLY last 4 digits
  passport_number_encrypted BYTEA,

  -- Banking (sensitive — encrypted)
  bank_account_holder VARCHAR(200),
  bank_account_number_encrypted BYTEA,
  bank_ifsc CHAR(11),
  bank_name VARCHAR(150),                          -- denormalized from IFSC lookup
  bank_branch VARCHAR(150),
  bank_account_type VARCHAR(20),

  -- Statutory (Phase 2 payroll)
  pf_uan VARCHAR(12),
  esic_number VARCHAR(20),
  pt_state CHAR(2),
  pf_applicable BOOLEAN DEFAULT TRUE,
  esi_applicable BOOLEAN DEFAULT FALSE,

  -- Status
  status VARCHAR(30) DEFAULT 'pending_onboarding',
    -- pending_onboarding|onboarding_in_progress|active|on_leave|notice_period|terminated|relieved|absconded

  -- Profile
  avatar_url TEXT,

  -- Custom fields (per-tenant extension)
  custom_fields JSONB DEFAULT '{}',

  -- Audit
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_by UUID REFERENCES users(id),

  UNIQUE (tenant_id, employee_code),
  UNIQUE (tenant_id, work_email)
);

CREATE INDEX idx_employees_tenant ON employees(tenant_id);
CREATE INDEX idx_employees_tenant_status ON employees(tenant_id, status);
CREATE INDEX idx_employees_tenant_dept ON employees(tenant_id, department_id);
CREATE INDEX idx_employees_tenant_manager ON employees(tenant_id, reporting_manager_id);

ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE employees FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_employees ON employees
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Emergency contacts
CREATE TABLE emergency_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,
  relationship VARCHAR(50),
  phone VARCHAR(20) NOT NULL,
  email CITEXT,
  is_primary BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Employee documents
CREATE TABLE employee_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  document_type VARCHAR(50) NOT NULL,
    -- offer_letter|id_proof|address_proof|education|experience|relieving|other
  file_name VARCHAR(255) NOT NULL,
  file_size_bytes BIGINT,
  mime_type VARCHAR(100),
  r2_key TEXT NOT NULL,                            -- Cloudflare R2 object key
  uploaded_by UUID REFERENCES users(id),
  status VARCHAR(20) DEFAULT 'pending_review',     -- pending_review|approved|rejected
  reviewed_by UUID REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  rejection_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Employee invitations
CREATE TABLE employee_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  email CITEXT NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,                 -- now() + 14 days
  consumed_at TIMESTAMPTZ,
  resent_count SMALLINT DEFAULT 0,
  invited_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Employment history (audit trail of role/dept/manager changes)
CREATE TABLE employment_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  change_type VARCHAR(40) NOT NULL,
    -- joined|promoted|transferred|manager_changed|location_changed|salary_revised|terminated
  previous_value JSONB,
  new_value JSONB,
  effective_from DATE NOT NULL,
  reason TEXT,
  changed_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Consent records (DPDP)
CREATE TABLE data_consents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  consent_type VARCHAR(60) NOT NULL,
    -- personal_info|sensitive_personal_info|location|biometric|marketing|third_party_share
  purpose TEXT NOT NULL,
  granted BOOLEAN NOT NULL,
  consent_version VARCHAR(20),
  ip_address INET,
  user_agent TEXT,
  granted_at TIMESTAMPTZ DEFAULT NOW(),
  withdrawn_at TIMESTAMPTZ
);
```

### 5.4 Employee Transfer Flow

When an employee changes department, manager, or location, this is NOT a simple field update — it's a workflow with cascading effects. Implementation:

1. Admin clicks "Transfer Employee" on the employee profile.
2. Modal asks: new department, new designation (optional), new manager, new location, effective date, reason (free text).
3. Preview screen shows what will change: "Reporting line: A → B", "Approval routing for pending leave requests will move from A to B", "Active timesheet approvals stay with A until current week ends."
4. On confirm: write `employment_history` row with `effective_from`; update `employees` table; reroute open approval workflows to new manager (with notification to both); log to audit.
5. Old manager gets email summarizing what was transferred.
6. Employee gets email confirming the change.

### 5.5 API Endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/employees` | List employees (paginated, filtered) |
| POST | `/employees/invite` | Admin invites a new employee |
| GET | `/employees/:id` | Employee profile (RBAC-filtered) |
| PUT | `/employees/:id` | Update employee (admin/HR) |
| POST | `/employees/:id/transfer` | Department/manager/location change |
| POST | `/employees/:id/terminate` | Initiate exit workflow |
| GET | `/employees/:id/history` | Employment history audit trail |
| GET | `/employees/me` | Current employee's full record |
| PUT | `/employees/me` | Self-update profile (limited fields) |
| POST | `/employees/me/onboarding/:step` | Submit onboarding step |
| POST | `/employees/:id/approve-onboarding` | Admin approves submission |
| POST | `/employees/:id/documents` | Upload document |
| GET | `/employees/:id/documents/:docId/url` | Generate signed R2 URL |
| GET | `/employees/org-chart` | Tree structure for org chart UI |
| POST | `/employees/import` | Bulk CSV import (admin only) |

### 5.6 UI Specifications

- **Employee directory:** grid view (default) + list view toggle. Search by name/email/designation. Filter by department/location/status.
- **Employee profile page:** tabs for Personal, Job, Documents, Time-off, Activity. RBAC determines tab visibility (employee sees only their own; manager sees direct reports' Time-off; admin sees all).
- **Org chart:** visual tree using `dagre` + `react-flow` or `orgchart-js` library. Clickable nodes; collapsible branches; export as PNG.
- **Self-onboarding wizard:** full-screen modal with progress indicator (1/5 → 5/5). Save-as-draft on every step (so employee can complete over multiple sessions). Auto-saves every 30 seconds.
- **Employee invitation email:** branded, includes manager's name, joining date, the magic link (one-click), expiry note (14 days), reply-to `support@flickssuite.com`.

### 5.7 Acceptance Criteria

- Admin can invite an employee in <30 seconds (filling 8 fields).
- Employee receives invite email within 30 seconds; magic link in email works on first click.
- Employee completes self-onboarding in <10 minutes (measured from first click of invite link to submission).
- DPDP consent screens shown for sensitive data; consent records persisted with timestamp + IP.
- PAN, Aadhaar (last 4), bank account number stored encrypted; visible in plaintext only to employee themselves and admin/finance roles.
- Admin can reject onboarding submission with reason; employee gets email and can resubmit specific sections.
- Employee transfer creates audit history; pending approvals route to new manager.
- Org chart renders correctly with up to 200 employees without performance degradation.

### 5.8 Out of Scope for MVP

- DEFER: e-Aadhaar OTP-based identity verification.
- DEFER: Background verification integrations (AuthBridge, BetterPlace).
- DEFER: Salary structure / CTC fields (Phase 2 with payroll).
- DEFER: Custom fields editor for tenants (use `custom_fields` JSONB but UI for managing it ships Phase 2).
- DEFER: Birthday/anniversary automation and Slack/WhatsApp birthday wishes (Phase 2).

---

## 6. Attendance Management (Clock-In / Clock-Out)

### 6.1 Goals

Clock-in/out is web-based for MVP (mobile app deferred to Month 4+). The system must handle the messy reality of Indian startups: hybrid teams, employees in multiple time zones, 5-day vs 6-day work weeks, varying shifts per team, late arrivals, half-days, comp-offs, work-from-home, and the occasional "I forgot to clock out yesterday" regularization.

### 6.2 Competitive Patterns Studied

- **Keka:** web + mobile, GPS-required, manager approval queue. Strong on shifts but UI feels dated.
- **Jibble:** free, GPS + selfie, geofence radius configurable, offline mode (mobile only). Best mobile clock-in UX.
- **HiBob:** simple click-to-start-day, no GPS by default — trust-based for office workers. Slack/Teams integration.
- **greytHR:** biometric integration heavy (older market), web fallback exists. Strong compliance reports.
- **Hubstaff/Toggl:** timer-based time tracking, not designed for HR attendance — different use case.

**Synthesis:** HiBob's trust-based UX for office workers + Keka's exception/approval flow + Jibble's geofence configurability. Defer biometric and selfie verification to Phase 2 (not needed for 30-employee beta).

### 6.3 Shift Configuration (Per Employee or Per Group)

Different employees can have different working hours. The schema supports per-employee shifts (default) and shift templates (group assignments).

**Shift template examples:**

| Template name | Start | End | Break | Days |
|---|---|---|---|---|
| General (default) | 09:00 | 18:00 | 60 min flexible | Mon–Fri |
| Early shift | 07:00 | 16:00 | 60 min | Mon–Fri |
| Late shift | 14:00 | 23:00 | 60 min | Mon–Fri |
| Night shift | 22:00 | 07:00 | 60 min | Mon–Fri (overnight) |
| Sales (6-day) | 10:00 | 19:00 | 60 min | Mon–Sat |
| WFH flexible | 10:00 | 19:00 | Self-managed | Mon–Fri |

**Shift database schema:**

```sql
-- Shift templates (master per tenant)
CREATE TABLE shift_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  start_time TIME NOT NULL,                -- in template's timezone
  end_time TIME NOT NULL,
  is_overnight BOOLEAN DEFAULT FALSE,       -- end_time < start_time
  break_minutes INTEGER DEFAULT 60,
  break_paid BOOLEAN DEFAULT FALSE,
  working_days SMALLINT[] NOT NULL,         -- ISO weekday: {1,2,3,4,5} = Mon-Fri
  timezone VARCHAR(60) DEFAULT 'Asia/Kolkata',
  grace_period_minutes INTEGER DEFAULT 15,  -- "late" only after this
  half_day_threshold_minutes INTEGER DEFAULT 240,  -- worked < 4h = half day
  full_day_threshold_minutes INTEGER DEFAULT 480,  -- worked >= 8h = full day
  is_default BOOLEAN DEFAULT FALSE,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Employee shift assignments (effective dating)
CREATE TABLE employee_shifts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  shift_template_id UUID NOT NULL REFERENCES shift_templates(id),
  effective_from DATE NOT NULL,
  effective_to DATE,                        -- null = ongoing
  created_at TIMESTAMPTZ DEFAULT NOW(),
  created_by UUID REFERENCES users(id)
);
CREATE INDEX idx_emp_shifts_active ON employee_shifts(tenant_id, employee_id, effective_from DESC);

-- Attendance records (the source of truth)
CREATE TABLE attendance_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  attendance_date DATE NOT NULL,            -- date in employee's timezone
  shift_template_id UUID REFERENCES shift_templates(id),

  -- Punches
  first_punch_in_at TIMESTAMPTZ,
  last_punch_out_at TIMESTAMPTZ,
  total_break_minutes INTEGER DEFAULT 0,
  total_worked_minutes INTEGER DEFAULT 0,   -- computed: out-in - break

  -- Computed flags
  is_late BOOLEAN DEFAULT FALSE,
  late_by_minutes INTEGER DEFAULT 0,
  is_early_departure BOOLEAN DEFAULT FALSE,
  early_by_minutes INTEGER DEFAULT 0,
  is_overtime BOOLEAN DEFAULT FALSE,
  overtime_minutes INTEGER DEFAULT 0,

  -- Status
  attendance_status VARCHAR(30) NOT NULL,
    -- present|absent|half_day|holiday|weekend|leave|on_duty|comp_off

  -- Metadata
  source VARCHAR(20) DEFAULT 'web',         -- web|mobile|manual|imported|biometric
  notes TEXT,
  is_regularized BOOLEAN DEFAULT FALSE,
  regularization_request_id UUID,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE (tenant_id, employee_id, attendance_date)
);
CREATE INDEX idx_attendance_emp_date ON attendance_records(tenant_id, employee_id, attendance_date DESC);
CREATE INDEX idx_attendance_status ON attendance_records(tenant_id, attendance_status, attendance_date);

-- Punches (audit log of every clock-in/out event)
CREATE TABLE attendance_punches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  attendance_record_id UUID NOT NULL REFERENCES attendance_records(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  punch_type VARCHAR(20) NOT NULL,          -- in|out|break_start|break_end
  punched_at TIMESTAMPTZ NOT NULL,
  source VARCHAR(20) DEFAULT 'web',
  ip_address INET,
  user_agent TEXT,
  geo_lat NUMERIC(9,6),
  geo_lng NUMERIC(9,6),
  geo_accuracy_m INTEGER,
  location_id UUID REFERENCES locations(id),
  is_within_geofence BOOLEAN,
  is_within_ip_allowlist BOOLEAN,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Regularization requests
CREATE TABLE attendance_regularizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  attendance_date DATE NOT NULL,
  request_type VARCHAR(40) NOT NULL,
    -- missed_punch|wrong_punch|forgot_to_clock_in|wfh|on_duty
  proposed_in_time TIMESTAMPTZ,
  proposed_out_time TIMESTAMPTZ,
  reason TEXT NOT NULL,
  status VARCHAR(20) DEFAULT 'pending',     -- pending|approved|rejected|withdrawn
  approver_id UUID REFERENCES employees(id),
  approver_comment TEXT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 6.4 Clock-In Logic (Web-Based)

Employee dashboard has a prominent "Clock In" button at the top. The button state cycles: Clock In → Clock Out (with running timer). Optional "Take a break" / "Resume" for break tracking.

**Clock-in flow:**

1. Employee clicks "Clock In". Browser requests `navigator.geolocation.getCurrentPosition()` if location is enabled for that tenant.
2. Frontend POSTs to `/attendance/punch-in` with `{ lat, lng, accuracy, timestamp }`.
3. Backend computes: today's date in employee's shift timezone, distance from any of tenant's office geofences (Haversine formula), whether request IP matches tenant's office IP allowlist.
4. Backend creates `attendance_records` row for today (if not exists) and `attendance_punches` row with type=`in`.
5. Backend computes `is_late` based on shift start time + grace period.
6. Backend returns the updated record. Frontend shows running timer.
7. If employee is outside geofence and outside IP allowlist: backend marks the punch as `pending_approval`. Manager gets notified.

**Clock-out flow:**

1. Employee clicks "Clock Out". Same geo capture.
2. Backend creates `attendance_punches` row with type=`out` linked to today's `attendance_records`.
3. Backend computes `total_worked_minutes` = sum of (out punches − in punches − breaks).
4. Backend determines `attendance_status`: full_day (>= full_day_threshold), half_day (between half and full), absent (< half).
5. Backend updates `attendance_records.last_punch_out_at` and `worked_minutes`.

**Multi-timezone handling:**

Each location has a timezone. Each employee is assigned to a location (and inherits its timezone). Each shift template has its own timezone (defaults to location). Attendance records store `attendance_date` as a DATE in the employee's shift timezone. UTC timestamps are stored for `punch_in_at` and `punch_out_at`.

Computation: when an employee clocks in at 23:30 IST, it's 18:00 UTC. The `attendance_date` is set to today's date in IST. When an employee in San Francisco clocks in at 18:00 PT (which is next day's 02:30 IST in UTC), the `attendance_date` is set to today's date in PT (their shift timezone), not IST.

### 6.5 Daily/Weekly/Monthly Views

**Employee view:**
- Today: clock-in time, current worked hours (live timer), break time, expected logout time.
- This week: 7-day grid showing each day's status + hours.
- This month: calendar heatmap (green=full, yellow=half, red=absent, gray=weekend, blue=leave).
- Regularization request: if a day is missing a punch, employee can request regularization with reason.

**Manager view:**
- Team today: list of direct reports with current status (clocked in / not yet / out / on leave).
- Pending approvals queue: regularization requests, exceptions, late arrivals to approve.
- Attendance summary: weekly aggregate per employee.

**Admin view:**
- All employees today: filterable by department, location, status.
- Attendance reports: by date range, by employee, by department; export to CSV/PDF.
- Anomaly alerts: 3+ consecutive late arrivals, frequent regularization requests, 0-hour days.

### 6.6 API Endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/attendance/punch-in` | Clock in (with optional geo) |
| POST | `/attendance/punch-out` | Clock out |
| POST | `/attendance/break-start` | Start break |
| POST | `/attendance/break-end` | End break |
| GET | `/attendance/today` | Current employee's today record + status |
| GET | `/attendance/me?from=&to=` | Date range for current employee |
| GET | `/attendance/team?date=` | Manager: team status today |
| GET | `/attendance/employees/:id?from=&to=` | Manager/admin view |
| POST | `/attendance/regularize` | Request regularization |
| POST | `/attendance/regularize/:id/approve` | Manager approves |
| POST | `/attendance/regularize/:id/reject` | Manager rejects |
| GET | `/attendance/reports/summary` | Aggregated reports |
| GET | `/shift-templates` | List shift templates |
| POST | `/shift-templates` | Create shift template |
| PUT | `/shift-templates/:id` | Update shift template |
| POST | `/employees/:id/assign-shift` | Assign shift to employee |

### 6.7 Acceptance Criteria

- Employee can clock in from web within 2 seconds of clicking the button.
- If geolocation permission is denied or unavailable, clock-in still works but is flagged for manager review.
- Multi-timezone: an employee in IST and an employee in EST in the same tenant see correct local times in their respective dashboards.
- Different employees can have different shifts; admin can change shift assignment effective from a future date.
- Late arrival is computed correctly relative to the employee's assigned shift, not the org default.
- Regularization request flows to the employee's reporting manager; approval updates attendance record and notifies employee.
- Reports run in <2 seconds for a 100-employee tenant for a 30-day range.
- Holiday on the calendar: attendance status auto-set to 'holiday'; no clock-in needed.

### 6.8 Out of Scope for MVP

- DEFER: Selfie capture (camera permission + liveness detection); add Phase 2.
- DEFER: Biometric device integration (eSSL, Mantra, Realtime); not needed for 30-employee beta.
- DEFER: Mobile app clock-in (Capacitor wrap, Month 4+).
- DEFER: Auto-clock-in via geofence enter/exit (mobile-only feature anyway).
- DEFER: WhatsApp clock-in via bot.
- DEFER: Overtime auto-calculation policies (basic OT minutes computed; complex policy engine in Phase 2).

---

## 7. Leave Management & Calendar

### 7.1 Goals

Leave management in India is non-trivial: multiple leave types with different rules, state-specific holidays, sandwich rules, partial-day support, manager-routing for approval, and integration with attendance and payroll. The MVP must handle the standard Indian leave taxonomy correctly and flexibly enough that admins don't need to build their own workarounds.

### 7.2 Indian Leave Taxonomy (Standard, Pre-Seeded on Tenant Creation)

| Type | Code | Typical Quota | Encashable | Carry Forward | Notes |
|---|---|---|---|---|---|
| Casual Leave | CL | 7–12 / yr | No | Usually no | Short-notice personal |
| Sick Leave | SL | 7–12 / yr | Sometimes | Limited | Medical cert if >2 days |
| Earned/Privilege Leave | EL/PL | 15–21 / yr | Yes | Yes (cap) | Accrued monthly |
| Maternity Leave | ML | 26 weeks | N/A | N/A | Statutory (Maternity Benefit Act 1961, amended 2017) |
| Paternity Leave | PL2 | 5–15 days | N/A | N/A | Company policy |
| Bereavement Leave | BL | 3–5 days | No | No | Per occasion |
| Compensatory Off | CO | Earned 1:1 | No | Limited window | Worked weekend → comp |
| Loss of Pay | LOP | Unlimited | No | N/A | When other balances exhausted |
| Marriage Leave | MR | 5–7 days | No | No | Once in tenure |
| Restricted Holiday | RH | 2 / yr | No | No | Pick from optional list |
| Work From Home | WFH | Tracked separately | N/A | N/A | Not technically a leave |

### 7.3 Database Schema

```sql
-- Leave types (master per tenant; pre-seeded with Indian defaults on tenant creation)
CREATE TABLE leave_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,                       -- "Casual Leave"
  code VARCHAR(10) NOT NULL,                        -- "CL"
  description TEXT,

  -- Quota
  default_quota_days NUMERIC(5,2),                  -- per leave year, eg 12.00
  prorate_for_new_joiners BOOLEAN DEFAULT TRUE,
  prorate_basis VARCHAR(20) DEFAULT 'monthly',      -- monthly|daily

  -- Accrual
  accrual_method VARCHAR(20) DEFAULT 'lump_sum',    -- lump_sum|monthly|quarterly
  accrual_day_of_month SMALLINT,                    -- if monthly, day of month to credit

  -- Carry forward
  carry_forward_allowed BOOLEAN DEFAULT FALSE,
  max_carry_forward_days NUMERIC(5,2),

  -- Encashment (Phase 2 payroll)
  encashable BOOLEAN DEFAULT FALSE,
  encashment_basis VARCHAR(20),                     -- basic|gross

  -- Application rules
  min_notice_days INTEGER DEFAULT 0,
  max_consecutive_days INTEGER,
  allow_half_day BOOLEAN DEFAULT TRUE,
  allow_quarter_day BOOLEAN DEFAULT FALSE,
  requires_attachment BOOLEAN DEFAULT FALSE,        -- true for ML, sometimes SL >2 days
  attachment_after_days INTEGER,                    -- e.g., SL >2 days requires medical cert

  -- Approval
  auto_approve_below_days NUMERIC(5,2),

  -- Sandwich rule
  count_weekend_in_between BOOLEAN DEFAULT FALSE,

  -- Eligibility
  applicable_employment_types VARCHAR(30)[] DEFAULT '{full_time,part_time}',
  applicable_genders VARCHAR(20)[],                 -- e.g. ML only female
  min_tenure_days INTEGER DEFAULT 0,                -- ML often requires 80 days tenure

  -- Status
  is_active BOOLEAN DEFAULT TRUE,
  is_paid BOOLEAN DEFAULT TRUE,
  is_lop BOOLEAN DEFAULT FALSE,                     -- LOP is a special unpaid type

  display_order SMALLINT,
  color VARCHAR(7),                                 -- '#FFB400' for calendar

  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (tenant_id, code)
);

-- Leave balances per employee per leave type per year
CREATE TABLE leave_balances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  leave_type_id UUID NOT NULL REFERENCES leave_types(id),
  leave_year INTEGER NOT NULL,                      -- 2026 = year starting Jan or Apr

  opening_balance NUMERIC(6,2) DEFAULT 0,
  accrued NUMERIC(6,2) DEFAULT 0,
  used NUMERIC(6,2) DEFAULT 0,
  pending NUMERIC(6,2) DEFAULT 0,                   -- requested but not approved
  carry_forward_in NUMERIC(6,2) DEFAULT 0,
  carry_forward_out NUMERIC(6,2) DEFAULT 0,
  encashed NUMERIC(6,2) DEFAULT 0,

  available NUMERIC(6,2) GENERATED ALWAYS AS (
    opening_balance + accrued + carry_forward_in - used - pending - encashed
  ) STORED,

  last_accrued_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE (tenant_id, employee_id, leave_type_id, leave_year)
);
CREATE INDEX idx_leave_balances_emp ON leave_balances(tenant_id, employee_id, leave_year);

-- Leave requests
CREATE TABLE leave_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  leave_type_id UUID NOT NULL REFERENCES leave_types(id),

  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  is_half_day BOOLEAN DEFAULT FALSE,
  half_day_session VARCHAR(10),                     -- 'first_half'|'second_half'

  total_days NUMERIC(5,2) NOT NULL,                 -- computed including/excluding weekends

  reason TEXT NOT NULL,
  attachment_url TEXT,                              -- medical cert etc

  cover_employee_id UUID REFERENCES employees(id),  -- handover

  status VARCHAR(20) DEFAULT 'pending',
    -- draft|pending|approved|rejected|cancelled|withdrawn

  approver_id UUID REFERENCES employees(id),        -- usually reporting manager
  approver_comment TEXT,
  approved_at TIMESTAMPTZ,
  rejected_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,

  applied_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_leave_req_emp ON leave_requests(tenant_id, employee_id, start_date DESC);
CREATE INDEX idx_leave_req_approver ON leave_requests(tenant_id, approver_id, status);
CREATE INDEX idx_leave_req_status ON leave_requests(tenant_id, status, start_date);

-- Holidays (per location, per year)
CREATE TABLE holidays (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  location_id UUID REFERENCES locations(id),        -- null = all locations
  holiday_date DATE NOT NULL,
  name VARCHAR(150) NOT NULL,                       -- "Diwali", "Republic Day"
  type VARCHAR(20) DEFAULT 'mandatory',             -- mandatory|optional|restricted
  description TEXT,
  is_recurring BOOLEAN DEFAULT FALSE,               -- annual same date (Republic Day)
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_holidays_date ON holidays(tenant_id, holiday_date);

-- Calendar events (for the team availability calendar)
-- Combines: leave_requests (approved), holidays, meetings, OOO, custom events
CREATE TABLE calendar_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_type VARCHAR(30) NOT NULL,
    -- leave|holiday|meeting|company_event|training|out_of_office
  source_id UUID,                                   -- FK to source table
  employee_id UUID REFERENCES employees(id),        -- null for org-wide events
  title VARCHAR(255) NOT NULL,
  description TEXT,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  is_all_day BOOLEAN DEFAULT TRUE,
  visibility VARCHAR(20) DEFAULT 'team',            -- private|team|department|company
  color VARCHAR(7),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_cal_events_range ON calendar_events(tenant_id, start_at, end_at);
```

### 7.4 Leave Application Flow

**Calendar-first UI (BambooHR / HiBob pattern):**

1. Employee opens "Apply for Leave".
2. First view: full calendar showing existing approved leaves of teammates (so employee sees who's already out before requesting).
3. Click and drag dates on the calendar to select range, OR use date pickers.
4. Side panel updates: leave type dropdown, half-day toggle, reason textarea, cover person picker.
5. Live calculation: "You're requesting 3 working days (excluding weekend). 5 EL remaining after this."
6. Sandwich rule warning if applicable: "Friday + Monday request will count Saturday/Sunday as leave per company policy. Total: 4 days."
7. Conflict warning: "Heads up: 2 of 8 team members are already on leave on these dates."
8. On submit: `leave_request` created with status=`pending`; `balance.pending` incremented; manager notified via email + in-app.

**Approval flow:**

1. Manager gets email + WhatsApp digest (Phase 2) + in-app notification.
2. Manager can approve directly from the email (one-click magic link to `/leave/approve/:id`).
3. Or from in-app approvals queue: see request details, employee's leave balance, team availability for those dates, comment.
4. **On approve:** `leave_request.status` = `approved`; `balance.used` incremented; `balance.pending` decremented; `calendar_event` created; `attendance_records` for those dates pre-set to `leave`; employee notified.
5. **On reject:** `balance.pending` decremented; employee notified with reason.

**Auto-approval rule:** If `leave_type.auto_approve_below_days` is set (e.g., 0.5 for half-day CL), requests under that threshold skip approval and apply immediately. Saves manager-time on routine half-days.

### 7.5 Calendar Module (Team Availability)

A unified calendar combining: company holidays, approved leaves of all teammates (visible to manager), employee's own pending requests, scheduled meetings (Phase 2 — calendar integration), company events. Implementation via `react-big-calendar` v1.19+ (MIT, 800K weekly downloads, supports month/week/day/agenda views, drag-and-drop addon).

**Admin calendar features:**
- Bulk-add holidays for a year (CSV import or manual add).
- Pre-seed Indian national holidays (Republic Day, Independence Day, Gandhi Jayanti) automatically on tenant creation.
- State-wise regional holidays seeded for Karnataka, Maharashtra, Tamil Nadu, Delhi, Telangana (covers ~85% of Indian startup employees).
- Add custom company events: town halls, all-hands, offsites — all employees see these on their calendar.

**Employee calendar features:**
- View own approved/pending leaves.
- View team availability for the next 30 days (defaults visible) — see who's out before scheduling something.
- Subscribe via iCal feed (read-only) so employee can sync their leaves to Google Calendar / Outlook.

### 7.6 API Endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/leave-types` | List leave types (tenant scoped) |
| POST | `/leave-types` | Admin create custom leave type |
| GET | `/leave/balances/me` | My current leave balances |
| GET | `/leave/balances/employee/:id` | Manager/admin view |
| POST | `/leave/requests` | Apply for leave |
| GET | `/leave/requests/me` | My leave history |
| GET | `/leave/requests/pending-approval` | Manager: queue |
| POST | `/leave/requests/:id/approve` | Approve |
| POST | `/leave/requests/:id/reject` | Reject |
| POST | `/leave/requests/:id/cancel` | Employee cancels (if pending) |
| POST | `/leave/requests/:id/withdraw` | After-the-fact withdrawal |
| GET | `/calendar/events?from=&to=` | Unified calendar feed |
| GET | `/calendar/team?from=&to=` | Team availability |
| GET | `/holidays?location_id=` | List holidays |
| POST | `/holidays/bulk` | Admin: bulk add holidays |
| GET | `/calendar/me.ics` | iCal feed for personal sync |

### 7.7 Acceptance Criteria

- Tenant created → 11 default Indian leave types pre-seeded with conservative quotas.
- Employee can apply for leave from a calendar UI in <30 seconds.
- Sandwich rule honored if configured; weekend days included/excluded correctly.
- Manager receives notification within 60 seconds of request; can approve via email link in 1 click.
- Leave balance displayed accurately and updates in real-time on approval.
- Balance computation correct for: new joiner pro-ration, mid-year carry forward, half-day deductions, cancellations.
- Approved leave automatically creates attendance records with status=`leave` so reports show correctly.
- Holiday on a leave date does not double-count: leave for Mon–Fri including Republic Day on Wed = 4 days, not 5.
- iCal subscription works: employee adds the URL to Google Calendar and sees their leaves.

### 7.8 Out of Scope for MVP

- DEFER: Comp-off auto-creation from weekend work (manual creation in MVP).
- DEFER: Multi-level leave approval (only single-level for MVP).
- DEFER: Probation-based leave eligibility (some companies block leave during probation — defer).
- DEFER: Leave encashment workflow (Phase 2 with payroll).
- DEFER: Slack/WhatsApp leave application bot.
- DEFER: Leave policies that vary by location/department/role (use single org-wide policies in MVP).

---

## 8. Timesheet Management

### 8.1 Goals

Timesheets serve two purposes: (1) compliance and accountability for time-tracked work, and (2) input data for the Project Management module's invoicing pipeline (Phase 1, Module 3). The MVP timesheet is intentionally simple — a weekly grid where employees enter hours per day. Project association is optional in HRMS; mandatory in PM. This section specifies the standalone HRMS timesheet.

### 8.2 Database Schema

```sql
-- Timesheet periods (a week is the standard unit)
CREATE TABLE timesheet_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  period_start DATE NOT NULL,                       -- always a Monday
  period_end DATE NOT NULL,                         -- always Sunday (period_start + 6)

  total_hours NUMERIC(6,2) DEFAULT 0,
  total_billable_hours NUMERIC(6,2) DEFAULT 0,
  total_non_billable_hours NUMERIC(6,2) DEFAULT 0,

  status VARCHAR(20) DEFAULT 'draft',
    -- draft|submitted|approved|rejected|locked

  submitted_at TIMESTAMPTZ,
  approver_id UUID REFERENCES employees(id),
  approved_at TIMESTAMPTZ,
  rejected_at TIMESTAMPTZ,
  rejection_comment TEXT,
  locked_at TIMESTAMPTZ,                            -- after approval, no further edits

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE (tenant_id, employee_id, period_start)
);
CREATE INDEX idx_ts_period_emp ON timesheet_periods(tenant_id, employee_id, period_start DESC);
CREATE INDEX idx_ts_period_approver ON timesheet_periods(tenant_id, approver_id, status);

-- Individual day-level entries within a timesheet period
CREATE TABLE timesheet_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  timesheet_period_id UUID NOT NULL REFERENCES timesheet_periods(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  entry_date DATE NOT NULL,

  hours NUMERIC(5,2) NOT NULL,                      -- e.g., 7.50

  -- Project linkage (nullable in HRMS-only MVP; required when PM module is live)
  project_id UUID,                                  -- FK added when PM module ships
  task_id UUID,

  category VARCHAR(40),                             -- 'development'|'meetings'|'admin'|'other'
  is_billable BOOLEAN DEFAULT FALSE,
  hourly_rate_snapshot NUMERIC(10,2),               -- snapshot for invoicing

  description TEXT,                                 -- what was worked on

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_ts_entries_period ON timesheet_entries(timesheet_period_id);
CREATE INDEX idx_ts_entries_emp_date ON timesheet_entries(tenant_id, employee_id, entry_date);

-- Re-work requests (manager asks employee to fix specific entries)
CREATE TABLE timesheet_rework_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  timesheet_period_id UUID NOT NULL REFERENCES timesheet_periods(id) ON DELETE CASCADE,
  requested_by UUID NOT NULL REFERENCES employees(id),     -- manager
  affected_entry_ids UUID[],                                -- specific entries to fix
  comment TEXT NOT NULL,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 8.3 Weekly Grid UI

The primary UI is a weekly grid: rows are categories (or projects when PM is live), columns are Mon–Sun, cells are decimal hours. Total row at the bottom. Submit button at the top right.

**Entry methods:**
- **Manual cell entry:** click cell → number input → type hours → Tab to next cell. Spreadsheet-like.
- **Copy from previous week:** one button at top of grid copies last week's structure (categories + projects) into this week, leaving hours empty.
- **Quick-add common entries:** "Add row" dropdown with recently-used categories/projects.
- **Cross-check with attendance:** tooltip shows "You clocked in 8h12m on Mon; logged 7h on timesheet. 1h12m unaccounted." Non-blocking, advisory.

**Submit flow:**
1. Employee fills in week.
2. Click "Submit for approval".
3. Validation: each weekday has > 0 hours OR a leave/holiday on that date OR a written exception in description. Total hours <= shift's expected weekly hours × 1.5 (sanity check; OT separate).
4. Status changes to `submitted`. Manager notified via email + in-app.
5. Employee cannot edit further unless manager rejects or requests rework.

**Approval flow:**
1. Manager opens timesheet in side panel.
2. Sees grid + summary + employee's attendance for that week side-by-side.
3. Three actions: Approve / Reject / Request rework. Rework can be scoped to specific entries (manager checks specific cells, adds comment "These hours look wrong, please clarify").
4. **Approve** → status=`approved` → entries lock → if PM module is live and entries have `project_id`, they become eligible for invoicing.
5. **Reject** → status=`rejected` → employee gets notification with reason, can edit and resubmit.

### 8.4 API Endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/timesheets/me?period=` | Current employee's timesheet for a period |
| GET | `/timesheets/employee/:id?period=` | Manager view |
| POST | `/timesheets/me/entries` | Bulk save entries |
| POST | `/timesheets/me/copy-previous` | Copy structure from prev week |
| POST | `/timesheets/me/submit` | Submit for approval |
| GET | `/timesheets/pending-approval` | Manager queue |
| POST | `/timesheets/:id/approve` | Approve |
| POST | `/timesheets/:id/reject` | Reject (with comment) |
| POST | `/timesheets/:id/request-rework` | Specific cell rework |
| GET | `/timesheets/reports/utilization` | Utilization report |

### 8.5 Acceptance Criteria

- Employee can fill a 5-day timesheet in <90 seconds (5 categories × 5 days = 25 cells).
- Tab navigation works across grid cells; no need to click each.
- Copy-from-previous-week button works, brings forward category/project rows but not hours.
- Submitted timesheet locks for the employee; rejected timesheet unlocks with rejection comment visible.
- Manager approval queue shows all direct reports' pending timesheets.
- Manager-requested rework correctly highlights the specific entries that need attention.
- Approved entries cannot be edited; appear in PM module's invoicing pipeline (when PM module is built).
- Cross-check with attendance is informational only — discrepancy does not block submission.

### 8.6 Out of Scope for MVP

- DEFER: Timer-based time tracking (start/stop).
- DEFER: Calendar event auto-import (Google/Outlook integration).
- DEFER: AI-powered time entry suggestions.
- DEFER: Mobile timesheet entry (web-only for MVP).
- DEFER: Multi-level approval workflows.
- DEFER: Per-project timesheet locking deadlines.

---

## 9. Settings (Organization Configuration)

### 9.1 Goals

Settings is where customer admins configure their tenant. The principle: every default works for a typical 10-employee Indian startup; settings are progressive disclosure for the 20% of tenants who need customization. Don't make every tenant configure 50 things on day one — they'll abandon.

### 9.2 Settings Sections (Tabbed Layout)

| Section | Who can edit | What's there |
|---|---|---|
| Organization | super_admin | Name, GSTIN, PAN, address, branding |
| Locations | super_admin, admin | Office addresses, geofences, IP allowlist, timezones |
| Departments | super_admin, admin | List CRUD |
| Designations | super_admin, admin | List CRUD with optional level |
| Working hours | super_admin, admin | Default shift, working days, holidays |
| Holidays | super_admin, admin | Per-location holiday calendar, bulk import |
| Shift templates | super_admin, admin | CRUD for shift definitions |
| Leave policies | super_admin, admin | Per leave type: quota, accrual, carry forward, rules |
| Roles & permissions | super_admin | Built-in roles + custom permissions (Phase 2) |
| Members | super_admin, admin | Invite admin/manager/finance users; revoke access |
| Notifications | any user (own) | Email/in-app/WhatsApp toggles per event type |
| Integrations | super_admin | Slack, Google Workspace, Microsoft, WhatsApp Business (Phase 2) |
| Data & privacy | super_admin | Data export, data deletion, retention, DPDP grievance officer |
| Billing | super_admin | Plan, payment method, invoice history, upgrade/downgrade |
| API & webhooks | super_admin | API keys, webhook endpoints (Phase 2) |
| Audit log | super_admin | Who did what when, with filters |

### 9.3 Notification Preferences (Granular Control)

Each user can set notification preference per event type, per channel. Default: in-app on, email on for important events, WhatsApp on (Phase 2).

| Event | In-app | Email | WhatsApp |
|---|---|---|---|
| Leave request submitted (manager) | On | On | Digest |
| Leave request approved/rejected (employee) | On | On | Off |
| Timesheet submitted (manager) | On | On | Digest |
| Timesheet approved/rejected (employee) | On | Off | Off |
| Attendance regularization (manager) | On | On | Digest |
| New employee invitation (employee) | — | On | On |
| Employee onboarding submitted (admin) | On | On | Off |
| Birthday wishes (team) | On | Off | Off |
| Work anniversary (team) | On | Off | Off |
| Weekly summary (employee) | — | On | Off |
| Monthly attendance report (admin) | — | On | Off |

### 9.4 Audit Log

Every significant action writes to the audit log. The audit log is searchable and exportable by `super_admin`. Required for DPDP compliance, security incident investigation, and customer trust.

```sql
CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES users(id),
  actor_employee_id UUID REFERENCES employees(id),
  action VARCHAR(80) NOT NULL,
    -- e.g., 'employee.invited', 'leave.approved', 'tenant.gstin.updated'
  resource_type VARCHAR(40),
  resource_id UUID,
  before_state JSONB,
  after_state JSONB,
  ip_address INET,
  user_agent TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_audit_tenant_created ON audit_log(tenant_id, created_at DESC);
CREATE INDEX idx_audit_actor ON audit_log(tenant_id, actor_user_id, created_at DESC);
CREATE INDEX idx_audit_resource ON audit_log(tenant_id, resource_type, resource_id);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_audit ON audit_log FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
-- INSERT goes through service role; tenants cannot insert their own audit entries
```

**Events that MUST be audited:**
- All authentication events (login success/failure, logout, magic link used).
- All employee record changes (create, update, delete, transfer).
- All financial actions (subscription changes, payment recorded).
- All RBAC changes (role assigned, permission granted).
- All exports (CSV download, PDF download, API key issued).
- All settings changes (tenant config, shift template edits, leave policy edits).
- All FAM impersonations (when a Specflicks employee logs in as a tenant).

---

## 10. Customer Admin Dashboard

### 10.1 The Daily-Driver Dashboard

This is what an HR head, operations manager, or founder sees when they log in. The principle: surface what needs attention, hide what doesn't. A good dashboard answers three questions in under 5 seconds: (1) what needs my approval right now? (2) is anything broken? (3) how is the team doing this week?

### 10.2 Layout

**Top: Greeting & Quick Actions**
- "Good morning, Niranjan" with the date in tenant's locale format.
- Quick action buttons: Invite Employee, Approve Pending (badge with count), View Reports.

**Row 1: Pending Actions Card (most important)**

A single unified card listing pending approvals across all modules:
- 3 leave requests (Alice, Bob, Charlie — click to expand)
- 2 timesheet submissions (Last week period)
- 1 employee onboarding pending review (David Kumar)
- 4 attendance regularization requests

Each item is one-click expandable inline. No need to navigate to separate pages for routine approvals.

**Row 2: Today's Snapshot**
- Headcount: 28 active, 2 on leave today, 1 on notice period.
- Attendance today: 18 clocked in, 6 yet to clock in, 2 on leave, 2 holidays/WFH (filtered to working employees).
- Upcoming this week: Alice's birthday Wednesday, Quarterly all-hands Friday, 3 employees on leave.

**Row 3: Trends (Last 30 Days)**
- Attendance compliance: 94% (target 95%) — sparkline.
- Leave consumption: 12 days taken, 142 days remaining across team.
- New joiners: 2; exits: 0; net change +2.
- Average working hours: 8h12m / day.

**Row 4: Recent Activity Feed**

Streaming list of significant events: "Bob applied for 2 days CL", "Charlie's onboarding approved", "Diwali holiday added to October calendar". Each item links to the relevant page.

### 10.3 Reports Module

Standard reports accessible from the dashboard. All reports support date range, department/location filter, export to CSV and PDF.

- **Attendance summary:** per-employee, per-day matrix with colored cells (green=full, yellow=half, red=absent).
- **Late arrivals report:** who's chronically late.
- **Leave utilization:** by employee, by leave type, with balances.
- **Headcount:** current, by department, by location, trend over time.
- **Onboarding status:** who's stuck where in onboarding.
- **Audit log search:** filter by user, action, date range.

### 10.4 Sidebar Navigation (Customer Admin View)

Two-level sidebar, collapsible:
- Dashboard (home)
- People → Employees, Org Chart, Onboarding, Documents
- Time → Attendance, Leave, Timesheets, Calendar
- Reports → All standard reports
- Settings → All sections from Section 9
- Bottom: Help, Support (Crisp chat), Logout

### 10.5 Sidebar Navigation (Employee View)

- Home (personal dashboard: today's status, quick clock-in, upcoming leaves, balances)
- Attendance (my history)
- Leave (apply, history, balances)
- Timesheet (current week, history)
- Calendar (team availability + my events)
- Profile (personal details, documents, settings)
- Bottom: Help, Logout

### 10.6 Acceptance Criteria

- Dashboard loads in <1.5 seconds for a tenant with 50 employees.
- Pending Actions card always shows count badges; numbers match actual pending items in DB.
- All charts render correctly with empty data (no employees yet → graceful empty states).
- Mobile responsive: dashboard usable on phone for one-tap approval workflows.
- Reports export CSV in <5 seconds for 30-day, 50-employee data range.

---

## 11. FAM (Flicks Account Manager) — Platform Admin

### 11.1 What FAM Is

FAM is Specflicks' internal admin panel — the platform-of-platforms. It is used by Specflicks employees only. From FAM, the team manages all tenant companies, verifies their registrations, monitors revenue, investigates support tickets, and operates the platform. Inspired by Stripe Dashboard's tenant view, Linear's internal admin, and Vercel's team admin.

**Critical security model:**
- FAM is accessed only by users where `users.is_platform_admin = TRUE`.
- FAM lives at a separate URL: `admin.flickssuite.com` (different from `app.flickssuite.com`).
- FAM authentication requires email-OTP PLUS a hardware second factor (TOTP via authenticator app) — distinct from tenant auth which is OTP-only.
- All FAM actions write to `audit_log_platform` (separate from tenant audit logs).
- FAM uses the service-role database connection (BYPASSRLS) — clearly delineated in code.
- Impersonation (logging in as a tenant user) is logged in BOTH platform audit log AND that tenant's audit log.

### 11.2 FAM Pages

**11.2.1 Tenants (the homepage of FAM)**

List view of all customer companies. Filterable by status, plan, region; sortable by signup date, MRR, employee count, last login.

Each row shows: tenant name, slug, status badge (Trial / Active / Past Due / Canceled / Suspended), employee count, plan, MRR, last login (relative time), health indicator (green/yellow/red).

**11.2.2 Tenant Detail**

Click a tenant → detail page with tabs:

*Overview tab:*
- Company info: name, GSTIN, PAN, address, signup date, plan, MRR.
- Verification status: GSTIN verified / pending / failed; option to manually mark verified by FAM agent.
- Quick stats: employees, active users last 7 days, avg attendance compliance, leave utilization.
- Health score breakdown: based on activation %, weekly active rate, NPS, support ticket count.

*Members tab:*
- List of users in this tenant. Click any user to view their activity timeline.
- Impersonate button (with confirmation modal: "You're about to log in as <email>. This will be audited and the user will be notified.").

*Activity tab:*
- Stream of events from this tenant's audit log.
- Filter by action type, user, date range.

*Subscription & Billing tab:*
- Plan history: changes over time.
- Invoices: list of all charges, paid/failed status.
- Manual actions: extend trial, comp account, refund, suspend, cancel.

*Support tab:*
- Linked support tickets (Phase 2 — Crisp / Intercom integration).
- Ad-hoc notes from FAM agents (sales handover, special arrangements).

*Compliance & Data tab:*
- Data export request status.
- Data deletion request status (DPDP).
- Manual data dump trigger.

**11.2.3 Verification Queue**

List of tenants where verification is pending: GSTIN format-validated but not API-verified, or manually flagged for review. FAM agent can mark verified, request more info, or suspend.

**11.2.4 Revenue Dashboard**

- MRR (this month, last month, % change), MRR breakdown by plan.
- ARR (annualized current MRR).
- New MRR / Expansion MRR / Churned MRR.
- Churn rate (logo and revenue) — monthly cohort view.
- LTV (using current churn rate as denominator) and CAC (manual entry from spreadsheet for now; Stripe integration Phase 2).
- Active customers, trial customers, paying customers.
- Cohort retention: Jan 2026 cohort, what % paying after 1/2/3 months.

**11.2.5 Funnel Analytics**

- Signup funnel: visited landing page → entered email → verified OTP → completed workspace setup → invited first employee → activated.
- Drop-off rate at each step.
- Time-to-activation distribution.

**11.2.6 Feature Usage**

- Which features are most used per tenant.
- Attendance: % of tenants using clock-in vs not.
- Leave: most-used leave types.
- Timesheets: % of tenants with timesheets enabled.
- Heatmap of feature adoption across tenant base.

**11.2.7 System Health**

- API error rate (Sentry integration via webhooks).
- Database query performance (slow queries from Supabase logs).
- Email delivery: bounces, complaints (from Resend webhooks).
- Background job queue depth (BullMQ stats).
- Recent deploys.

**11.2.8 Feature Flags**

- Per-feature flags: percentage rollout, allowlist by tenant_id, killswitch.
- Examples: `enable_whatsapp_notifications`, `enable_ai_briefing`, `new_dashboard_v2`.
- Implementation: Unleash open-source or simple Postgres-based flags table.

**11.2.9 Beta Cohort Management**

- Group tenants into cohorts (Beta Wave 1, Wave 2, GA).
- Send announcements to specific cohorts.
- Track per-cohort metrics.

### 11.3 Database Schema

```sql
-- Platform-level audit log (separate from tenant audit logs)
CREATE TABLE audit_log_platform (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID NOT NULL REFERENCES users(id),
  action VARCHAR(80) NOT NULL,
  target_tenant_id UUID REFERENCES tenants(id),
  target_user_id UUID REFERENCES users(id),
  metadata JSONB,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Subscriptions (one row per tenant)
CREATE TABLE subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE UNIQUE,
  plan_code VARCHAR(40) NOT NULL,                   -- 'trial'|'starter'|'growth'|'scale'|'enterprise'
  status VARCHAR(20) NOT NULL,                      -- 'trialing'|'active'|'past_due'|'canceled'
  per_user_price NUMERIC(10,2),                     -- in INR
  user_count INTEGER NOT NULL,
  mrr_amount NUMERIC(12,2) NOT NULL,
  billing_cycle VARCHAR(20) DEFAULT 'monthly',      -- 'monthly'|'annual'
  trial_ends_at TIMESTAMPTZ,
  current_period_start DATE,
  current_period_end DATE,
  razorpay_subscription_id VARCHAR(50),
  razorpay_customer_id VARCHAR(50),
  cancel_at_period_end BOOLEAN DEFAULT FALSE,
  canceled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Subscription events (history)
CREATE TABLE subscription_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subscription_id UUID NOT NULL REFERENCES subscriptions(id),
  event_type VARCHAR(40) NOT NULL,
    -- created|trial_started|trial_extended|activated|plan_changed|users_changed|payment_succeeded|payment_failed|canceled
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Tenant health snapshots (computed daily by cron)
CREATE TABLE tenant_health_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  snapshot_date DATE NOT NULL,
  health_score SMALLINT,                            -- 0-100
  active_users_7d INTEGER,
  active_users_30d INTEGER,
  attendance_compliance NUMERIC(5,2),
  feature_adoption_score NUMERIC(5,2),
  support_tickets_open INTEGER,
  signal VARCHAR(20),                               -- 'green'|'yellow'|'red'
  computed_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (tenant_id, snapshot_date)
);

-- Feature flags
CREATE TABLE feature_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flag_key VARCHAR(80) NOT NULL UNIQUE,
  description TEXT,
  is_enabled_globally BOOLEAN DEFAULT FALSE,
  enabled_tenant_ids UUID[],
  rollout_percentage SMALLINT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Tenant cohorts
CREATE TABLE tenant_cohorts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(80) NOT NULL UNIQUE,
  description TEXT,
  tenant_ids UUID[],
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 11.4 API Endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/fam/tenants` | List all tenants |
| GET | `/fam/tenants/:id` | Tenant detail |
| POST | `/fam/tenants/:id/verify` | Mark verified |
| POST | `/fam/tenants/:id/suspend` | Suspend tenant |
| POST | `/fam/tenants/:id/extend-trial` | Extend trial |
| POST | `/fam/tenants/:id/comp` | Comp account |
| POST | `/fam/tenants/:id/impersonate` | Generate impersonation token |
| GET | `/fam/revenue/mrr` | MRR breakdown |
| GET | `/fam/revenue/cohorts` | Cohort retention |
| GET | `/fam/funnel/signup` | Signup funnel |
| GET | `/fam/health/system` | API errors, queue depth, etc |
| GET | `/fam/feature-flags` | List flags |
| PUT | `/fam/feature-flags/:key` | Update flag |
| GET | `/fam/audit-log` | Platform audit log |

### 11.5 Impersonation (with Strict Audit)

Sometimes Specflicks support needs to log in as a customer to debug an issue. This is a powerful and dangerous capability — done wrong, it's a privacy and trust disaster. Done right, it accelerates support.

**Implementation pattern:**

1. FAM agent clicks "Impersonate" on a member of a tenant.
2. Modal: "You're about to log in as Alice (alice@acme.com). Reason required:" — agent enters reason.
3. Backend writes `audit_log_platform` entry AND the target tenant's `audit_log` entry.
4. Backend issues a special impersonation JWT with claim `impersonator_user_id` = FAM agent's user ID.
5. In the app, a persistent banner is shown: "Impersonating Alice — Stop". Banner cannot be dismissed.
6. Every action taken under impersonation is double-tagged in audit log: `actor_user_id` = the impersonated user, `impersonator_user_id` = FAM agent.
7. Impersonation session is hard-capped at 30 minutes; auto-terminates.
8. Optional: target tenant gets an email notification "A Specflicks support agent accessed your account at [time] for [reason]". (Make this optional per-tenant for VIPs who don't want the noise; default ON.)

**What impersonation CANNOT do:**
- Cannot view or change billing details (the tenant must do this themselves).
- Cannot change role assignments (must be done by tenant's super_admin).
- Cannot delete the tenant or any user.
- Cannot access masked sensitive PII (PAN, full Aadhaar, bank details remain hidden under impersonation; FAM has separate flow with extra audit if absolutely needed).

### 11.6 Acceptance Criteria

- FAM is at `admin.flickssuite.com`, only accessible to users with `is_platform_admin=true`.
- FAM auth requires email-OTP + TOTP.
- Tenant list filters and sorts work; loads in <2 seconds at 1000 tenants.
- Impersonation works; banner is unmissable; audit logs are dual-written.
- MRR dashboard accurately shows current and historical revenue from `subscriptions` table.
- Health snapshots computed daily by cron job.
- Feature flags can be toggled per tenant or by percentage rollout.

---

## 12. Build Sequence & Acceptance Gates

### 12.1 Niranjan's 7-Step Plan, Mapped to PRD Sections

| Step | Niranjan's plan | PRD sections | Estimated time |
|---|---|---|---|
| 1 | Database + multi-tenant + Supabase setup | 1, 2 | 3 days |
| 2 | Customer onboarding + Employee onboarding | 3, 4, 5 | 5 days |
| 3 | Clock-in/out + attendance | 6 | 3 days |
| 4 | Leave + calendar | 7 | 4 days |
| 5 | Customer Admin Dashboard + FAM | 10, 11 | 5 days |
| 6 | Onboard first user (validation) | All above | 1 day |
| 7 | Timesheets | 8 | 2 days |

Total estimated: ~23 working days = ~5 weeks calendar time for Niranjan + Claude Code, with Venugopal handling QA, customer success, and PRD acceptance testing in parallel.

### 12.2 Acceptance Gates (Don't Move to Next Step Until)

**Gate 1 (after Step 1):**
- Multi-tenant cross-isolation test suite (10 tests) all pass.
- Two test tenants seeded with distinct data; impossible to cross-read.
- Migration scripts run cleanly on a fresh Supabase instance.
- Service-role connection separated from tenant connection.

**Gate 2 (after Step 2):**
- New tenant signs up via web, completes onboarding checklist, invites first employee.
- Employee receives invite email, completes self-onboarding, admin approves.
- All onboarding events written to audit logs.
- DPDP consent flows present and stored.

**Gate 3 (after Step 3):**
- Employee can clock in/out; data correctly stored with timezone awareness.
- Late/early calculations correct against shift template.
- Manager regularization queue functional.
- Two employees in different time zones (IST + EST) clock in correctly.

**Gate 4 (after Step 4):**
- Default 11 leave types pre-seeded.
- Employee applies for leave from calendar; manager approves; balance updates.
- Holiday calendar pre-seeded with 2026 Indian national + 5-state regional holidays.
- iCal feed works in Google Calendar.

**Gate 5 (after Step 5):**
- Customer admin dashboard loads in <1.5s with all widgets.
- FAM accessible at `admin.flickssuite.com` with TOTP.
- Impersonation works with audit double-write.
- MRR dashboard renders even with zero paying customers (graceful empty state).

**Gate 6 (Step 6 — the validation milestone):**
- Niranjan personally onboards Specflicks (himself + Venugopal) as the first tenant.
- Venugopal personally onboards as an employee, completes self-onboarding.
- Both clock in for one full day; submit a leave request; submit a timesheet.
- Run through the entire customer admin experience — find every paper-cut bug.
- Fix all P0/P1 bugs before onboarding the two real beta customers.

**Gate 7 (after Step 7):**
- Employee submits weekly timesheet; manager approves; data ready for PM module's invoicing pipeline.
- Re-work flow tested end-to-end.

### 12.3 Definition of MVP-Complete

All of Gates 1–7 passed AND the following platform-level criteria:

- Sentry: 0 unhandled exceptions in last 48 hours of QA.
- PostHog: events firing for all critical user actions.
- Better Stack: 99.5%+ uptime over last 7 days of QA.
- Cross-tenant isolation: 10/10 automated tests passing in CI.
- DPDP compliance: privacy policy, consent flows, data export, data deletion all functional.
- Documentation: README + ARCHITECTURE.md + RUNBOOK.md committed.
- Backups: daily backup + weekly R2 snapshot + restore procedure tested.
- Two beta customers' admin contacts have been walked through onboarding via Loom and signed MSA.

---

## Appendix A: Glossary

| Term | Definition |
|---|---|
| Tenant | A customer company on Flicks Suite. Has its own data isolated by RLS. |
| Multi-tenant | Single Flicks Suite instance serves many tenants. Each tenant's data is invisible to others. |
| RLS (Row-Level Security) | PostgreSQL feature that restricts which rows a query can return based on a session variable. Used here to enforce tenant isolation. |
| FAM | Flicks Account Manager — Specflicks's internal admin panel for managing all tenant companies. |
| Customer Admin | A super_admin or admin user within a tenant. Manages that company's HR, settings, employees. |
| Modular monolith | Architecture pattern where one application is structured into strictly isolated modules. Compromise between monolith simplicity and microservice independence. |
| DPDP | Digital Personal Data Protection Act 2023, India's primary data privacy law. Rules notified November 2025; enforcement by May 2027. |
| GSTIN | Goods and Services Tax Identification Number — 15-character alphanumeric ID for businesses registered under GST in India. |
| Magic link | URL that, when clicked, logs a user in without a password. Used here as primary auth method alongside OTP. |
| RBAC | Role-Based Access Control. Users are assigned roles; roles have permissions; permissions gate access. |
| Audit log | Append-only record of all significant actions in the system. Used for security investigation, compliance, and customer trust. |
| Impersonation | FAM feature where a Specflicks employee can log in as a tenant user (with their consent and full audit) to debug issues. |
| Schema-per-tenant | Multi-tenancy pattern where each tenant has its own Postgres schema with duplicated tables. Rejected for Specflicks due to scaling and operational issues at >500 tenants. |
| Soft delete | Marking a row as deleted (`deleted_at` timestamp) instead of removing it from DB. Allows recovery and audit history. |
| Geofence | Geographic boundary defined by lat/lng + radius. Used here to validate clock-in is from an office location. |
| IFSC | Indian Financial System Code — 11-character alphanumeric identifying a bank branch for fund transfers. |
| Aadhaar | 12-digit Indian government ID. We store ONLY the last 4 digits per DPDP best practice. |
| Sandwich rule | Leave policy where weekend days falling between leave days are counted as leave. Configurable per leave type. |
| Pro-ration | Calculating a partial leave quota for an employee who joined mid-year. E.g., joining July 1 with annual quota 12 → pro-rated to 6. |
| Comp-off | Compensatory off — leave granted in exchange for working on a holiday or weekend. |
| LOP | Loss of Pay — leave taken when other balances are exhausted; salary is deducted proportionally. |

---

## Appendix B: Indian Compliance Checklist

### DPDP (Digital Personal Data Protection Act 2023, Rules 2025)

- Privacy policy at `/privacy` with purpose specification per data category.
- Consent flows for sensitive data (PAN, Aadhaar last-4, bank, location) — explicit, granular, revocable.
- Grievance officer (GO) appointed: Niranjan V. Contact email visible in `/privacy`.
- Data principal rights: Right to access (`/me/export`), right to correction (`/me/edit`), right to erasure (`/me/delete-account`), right to grievance (`/contact`).
- Breach notification playbook: 72-hour DPB notification + affected principals.
- Data retention: employee records 8 years post-exit, attendance 3 years, audit logs 1 year minimum.
- Data localization: Indian customer data in Mumbai region (ap-south-1).
- Aadhaar handling: store ONLY last 4 digits. Never store full Aadhaar.

### Labor Law

- Maternity Benefit Act 1961 (amended 2017): 26 weeks paid leave. Pre-seeded as a default leave type.
- Paid leave statutory minimum varies by state (Karnataka: 18 days/year, Maharashtra: 21 days/year, etc). Defaults set conservatively to maximum likely.
- Working hours: Factories Act 1948 limits to 48 hours/week. Defaults respect this.
- National holidays: Republic Day (Jan 26), Independence Day (Aug 15), Gandhi Jayanti (Oct 2). Pre-seeded mandatory.

### GST (when Invoicing module ships in Phase 2)

- Rule 46 mandatory fields on every tax invoice (16 fields).
- CGST/SGST vs IGST determined by Place of Supply.
- HSN/SAC codes; defaults: 998314 for IT design/development at 18%.
- Invoice numbering reset annually on 1 April (Indian financial year).
- Credit/debit notes per Section 34 with original invoice reference.

---

## Appendix C: Email Templates Inventory

- `login-otp`: 6-digit code + magic link (Section 3).
- `welcome-tenant`: After signup, welcomes admin and links to onboarding checklist.
- `welcome-employee`: Magic link to start self-onboarding.
- `onboarding-submitted`: Notify admin that employee finished self-onboarding.
- `onboarding-approved`: Notify employee that admin approved them.
- `onboarding-rejected`: Notify employee with reason.
- `leave-requested`: Notify approver (with one-click approve link).
- `leave-approved` / `leave-rejected`: Notify employee.
- `timesheet-submitted`: Notify approver.
- `timesheet-approved` / `timesheet-rejected` / `timesheet-rework`: Notify employee.
- `attendance-regularization-requested`: Notify approver.
- `attendance-regularization-approved`/`rejected`: Notify employee.
- `data-export-ready`: User's data export is ready to download.
- `account-deletion-confirmation`: User's deletion request is confirmed.
- `weekly-summary`: Optional opt-in weekly digest for employees.
- `birthday-wish`: Auto-sent on employee birthday (Phase 2).
- `subscription-payment-success` / `failed`: Tenant billing notifications.
- `trial-ending-soon`: 3 days before trial ends.

---

## Appendix D: Open Questions & Decisions Pending

- Pricing tiers and prices — pending Venugopal's financial model finalization (target: locked before beta sign Day 1).
- Razorpay subscription integration vs manual invoicing for first 10 customers — leaning manual for control; auto-bill from customer 11.
- Whether to seed Indian state holidays for all 28 states + 8 UTs at MVP, or just the top 5 (KA, MH, TN, DL, TS) — leaning top 5 for MVP, expand on customer request.
- WhatsApp Business API integration: free tier vs paid via AiSensy/MSG91 — pending volume estimates.
- ESOPs for interns: not yet decided. Discuss after first paying customer (Month 3).

---

## End of Document

This PRD is version 1.0, dated April 27, 2026. Signed off for implementation by:

**Niranjan V** — CEO, Specflicks Pvt Ltd
**Venugopal Ramachandran** — CFO, Specflicks Pvt Ltd

Changes to this document require approval from both founders. All deviations during implementation must be documented in a CHANGELOG.md within the codebase.
