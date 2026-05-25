'use client'

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../client'

// ─── Check slug ──────────────────────────────────────────────────────────────

interface CheckSlugPayload {
  slug: string
}

interface CheckSlugResponse {
  available: boolean
}

export function useCheckSlug() {
  return useMutation({
    mutationFn: (payload: CheckSlugPayload) =>
      api.post<CheckSlugResponse>('/api/v1/onboarding/check-slug', payload),
  })
}

// ─── Create tenant ───────────────────────────────────────────────────────────

export interface CreateTenantPayload {
  name: string
  slug: string
  fullName: string
  industry?: string
  sizeBand?: string
  primaryLocation: {
    name: string
    city?: string
    stateCode?: string
    timezone?: string
  }
}

export interface CreateTenantResponse {
  id: string
  name: string
  slug: string
  status: string
  trialEndsAt: string | null
  primaryLocationId: string
  defaultShiftId: string
  ownerEmployeeId: string
}

export function useCreateTenant() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: CreateTenantPayload) =>
      api.post<CreateTenantResponse>('/api/v1/onboarding/create-tenant', payload),
    // tenant_signup_completed is captured server-side (analytics.service.ts)
    // so it can't be dropped by an ad-blocker.
    onSuccess: async () => {
      // The user might have just signed up while still holding cached data
      // from a previous tenant (e.g. they had a session in another
      // workspace open in this browser). Wiping every cached query
      // guarantees the new workspace's dashboard, employee dropdowns,
      // department list, etc. all fetch fresh against the new tenantId.
      qc.clear()
      // /auth/me has to be fetched fresh before the redirect to /dashboard
      // so the auth store has the Owner role + tenantId in place.
      await qc.refetchQueries({ queryKey: ['auth', 'me'] })
    },
  })
}
