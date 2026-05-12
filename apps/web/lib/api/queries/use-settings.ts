'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../client'

// ─── Organization (tenant profile) ───────────────────────────────────────────

export interface OrganizationCounts {
  locations: number
  departments: number
  activeMembers: number
}

export interface Organization {
  id: string
  name: string
  slug: string
  legalName: string | null
  gstin: string | null
  pan: string | null
  cin: string | null
  industry: string | null
  sizeBand: string | null
  countryCode: string
  stateCode: string | null
  city: string | null
  addressLine1: string | null
  addressLine2: string | null
  postalCode: string | null
  timezone: string
  currency: string
  fiscalYearStartMonth: number
  dateFormat: string
  logoUrl: string | null
  brandColor: string | null
  status: 'trialing' | 'active' | 'suspended' | 'cancelled'
  trialEndsAt: string | null
  verifiedAt: string | null
  createdAt: string
  counts: OrganizationCounts
}

export interface UpdateOrganizationPayload {
  name?: string
  legalName?: string
  gstin?: string
  pan?: string
  cin?: string
  industry?: string
  sizeBand?: string
  addressLine1?: string
  addressLine2?: string
  city?: string
  stateCode?: string
  postalCode?: string
}

export function useOrganization() {
  return useQuery({
    queryKey: ['settings', 'organization'],
    queryFn: () => api.get<Organization>('/api/v1/settings/organization'),
    staleTime: 60_000,
  })
}

export function useUpdateOrganization() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (payload: UpdateOrganizationPayload) =>
      api.patch<Organization>('/api/v1/settings/organization', payload),
    onSuccess: (data) => {
      queryClient.setQueryData(['settings', 'organization'], data)
      // The Topbar workspace pill reads tenant name from auth/me, refresh it too.
      queryClient.invalidateQueries({ queryKey: ['auth', 'me'] })
    },
  })
}
