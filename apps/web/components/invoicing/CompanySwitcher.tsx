'use client'

/**
 * Auditor company switcher (PRD §3.4/§3.5) — placeholder.
 *
 * In Sprint 8 this lists the signed-in user's linked companies (via
 * GET /me/companies, backed by the memberships self-visibility policy) and
 * switches the active tenant by re-issuing a JWT scoped to the chosen tenant_id
 * (POST /auth/switch-company). It renders for auditors and owners of >1 company.
 * Until then it renders nothing so the shell is unaffected.
 */
export function CompanySwitcher() {
  return null
}
