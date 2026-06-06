# Changelog

All deviations from PRD v1.0 must be documented here with founder approval.

## [Unreleased]

### RLS hardening — security (2026-06-06)

**Added / Changed:**
- Row-Level Security now enforced on **all 40 tables** (was 23). New migrations
  `0009_rls_bucket_b.sql` (memberships + tenant-scoped tables),
  `0010_rls_users_tenants.sql` (scoped users/tenants), `0011_rls_identity_lockdown.sql`
  (deny-all on identity/auth tables; re-locks `auth_otps`).
- Services that queried tenant tables without tenant context fixed to use
  `withTenant` (`employees`, `timesheet`); `auth`/`onboarding` routed to the
  service-role connection. Multi-tenant test suite extended 10 → 15 (full 23/23).
- New `scripts/setup-database.sh` (one-command setup + harden, `--unblock-login`
  mode) and `scripts/apply-rls-hardening.sh`.
- **Full write-up:** see [`RLS_HARDENING.md`](./RLS_HARDENING.md). PRs #2, #3.

### Initial scaffold (2026-05-07)

**Added:**
- Monorepo scaffold with pnpm workspaces + Turborepo
- `packages/db` — Drizzle ORM schema for all PRD tables
- `packages/emails` — React Email templates (18 templates)
- `packages/shared` — shared Zod validators and TypeScript types
- `apps/api` — NestJS 11 modular monolith (11 modules)
- `apps/web` — Next.js 15 App Router frontend

**Decisions logged:**
- None yet — all implementations follow PRD v1.0 exactly

---

_Format: [CHANGE_TYPE] Description — Approved by: [Name], Date: [Date]_
_Change types: DEVIATION (PRD change), DEFERRAL (moved to Phase 2), CLARIFICATION (PRD ambiguity resolved)_
