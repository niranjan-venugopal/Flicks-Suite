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
    onSuccess: async () => {
      // The server has set fresh cookies with tenantId baked in; force /me
      // to refetch so the auth store picks up the Owner role + tenant
      // BEFORE the wizard redirects. Without the await, the dashboard's
      // initial queries fire against a stale auth-store snapshot (role
      // still EMPLOYEE) and the Topbar pill flashes the wrong label for a
      // moment.
      await qc.invalidateQueries({ queryKey: ['auth', 'me'] })
      await qc.refetchQueries({ queryKey: ['auth', 'me'] })
    },
  })
}
