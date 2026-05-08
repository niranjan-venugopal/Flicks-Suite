'use client'

import { useMutation } from '@tanstack/react-query'
import { api } from '../client'
import { useAuthStore } from '@/lib/stores/auth.store'

interface CheckSlugPayload {
  slug: string
}

interface CheckSlugResponse {
  available: boolean
}

interface CreateTenantPayload {
  workspaceName: string
  slug: string
  yourName: string
}

interface CreateTenantResponse {
  tenant: {
    id: string
    name: string
    slug: string
    plan: string
  }
  user: {
    id: string
    name: string
    email: string
    role: string
    tenantId: string
  }
}

export function useCheckSlug() {
  return useMutation({
    mutationFn: (payload: CheckSlugPayload) =>
      api.post<CheckSlugResponse>('/api/v1/onboarding/check-slug', payload),
  })
}

export function useCreateTenant() {
  const { setUser, setTenant } = useAuthStore()

  return useMutation({
    mutationFn: (payload: CreateTenantPayload) =>
      api.post<CreateTenantResponse>('/api/v1/onboarding/create-tenant', payload),
    onSuccess: (data) => {
      setUser(data.user as any)
      setTenant(data.tenant as any)
    },
  })
}
