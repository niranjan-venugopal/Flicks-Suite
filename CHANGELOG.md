# Changelog

All deviations from PRD v1.0 must be documented here with founder approval.

## [Unreleased]

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
