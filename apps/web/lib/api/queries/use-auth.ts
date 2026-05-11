'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../client'
import { useAuthStore } from '@/lib/stores/auth.store'

interface RequestOtpPayload {
  email: string
}

interface VerifyOtpPayload {
  email: string
  code: string
}

interface VerifyMagicLinkPayload {
  token: string
}

interface LoginResponse {
  user: {
    id: string
    name: string
    email: string
    role: string
    avatarUrl?: string
    tenantId: string
    employeeId?: string
  }
  tenant: {
    id: string
    name: string
    slug: string
    logoUrl?: string
    plan: string
  }
}

export function useCurrentUser() {
  const { setUser, setTenant } = useAuthStore()

  return useQuery({
    queryKey: ['auth', 'me'],
    queryFn: async () => {
      const data = await api.get<LoginResponse>('/api/v1/auth/me')
      setUser(data.user as any)
      setTenant(data.tenant as any)
      return data
    },
    retry: false,
    staleTime: 5 * 60 * 1000,
  })
}

export function useRequestOtp() {
  return useMutation({
    mutationFn: (payload: RequestOtpPayload) =>
      api.post<{ success: true; message: string }>('/api/v1/auth/request-otp', payload),
  })
}

export function useVerifyOtp() {
  const { setUser, setTenant } = useAuthStore()

  return useMutation({
    mutationFn: (payload: VerifyOtpPayload) =>
      api.post<LoginResponse>('/api/v1/auth/verify-otp', payload),
    onSuccess: (data) => {
      setUser(data.user as any)
      setTenant(data.tenant as any)
    },
  })
}

export function useVerifyMagicLink() {
  const { setUser, setTenant } = useAuthStore()

  return useMutation({
    mutationFn: (payload: VerifyMagicLinkPayload) =>
      api.get<LoginResponse>(`/api/v1/auth/magic-link?token=${encodeURIComponent(payload.token)}`),
    onSuccess: (data) => {
      setUser(data.user as any)
      setTenant(data.tenant as any)
    },
  })
}

export function useLogout() {
  const queryClient = useQueryClient()
  const { logout } = useAuthStore()

  return useMutation({
    mutationFn: () => api.post<void>('/api/v1/auth/logout'),
    onSettled: () => {
      logout()
      queryClient.clear()
    },
  })
}

/**
 * Verify magic link via React Query useQuery (auto-runs when token is non-null).
 * Use from the /verify page where the token comes from the URL search params.
 *
 * Note: a separate useVerifyMagicLink mutation exists above; this query-style
 * hook is suffixed with `Query` so it can coexist.
 */
export function useVerifyMagicLinkQuery(token: string | null) {
  const { setUser, setTenant } = useAuthStore()

  return useQuery({
    queryKey: ['auth', 'verify-magic-link', token],
    queryFn: async () => {
      // API exposes this as GET /api/v1/auth/magic-link?token=…
      const data = await api.get<LoginResponse>(
        `/api/v1/auth/magic-link?token=${encodeURIComponent(token ?? '')}`,
      )
      setUser(data.user as any)
      setTenant(data.tenant as any)
      return data
    },
    enabled: !!token,
    retry: false,
    staleTime: Infinity,
  })
}
