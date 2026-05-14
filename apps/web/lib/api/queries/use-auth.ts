'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../client'
import {
  useAuthStore,
  type CurrentUser,
  type CurrentTenant,
  type UserRole,
} from '@/lib/stores/auth.store'

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

// ─── API response shapes ───────────────────────────────────────────────────
// The API (auth.service.ts) returns these two distinct shapes for the auth
// endpoints. We adapt them into the flat { CurrentUser, CurrentTenant } shape
// the rest of the web app expects.

interface ApiUser {
  id: string
  email: string
  fullName: string
  avatarUrl?: string | null
}

interface ApiMembership {
  id: string
  tenantId: string
  tenantName: string
  tenantSlug: string
  tenantStatus?: string
  role: string
  status: string
  employeeId?: string | null
}

// Returned by /verify-otp and /magic-link
interface VerifyAuthResponse {
  requiresTenantSelection: false
  accessToken: string
  refreshToken: string
  expiresIn: number
  user: ApiUser
}

// Returned by /me
interface MeResponse extends ApiUser {
  currentMembership: ApiMembership | null
  memberships: ApiMembership[]
}

function normaliseRole(role: string | undefined | null): UserRole {
  switch ((role ?? '').toLowerCase()) {
    case 'super_admin':
      return 'SUPER_ADMIN'
    case 'owner':
      return 'OWNER'
    case 'admin':
      return 'HR_ADMIN'
    case 'manager':
      return 'MANAGER'
    case 'finance':
      return 'HR_ADMIN'
    default:
      return 'EMPLOYEE'
  }
}

function adaptUser(
  user: ApiUser,
  membership: ApiMembership | null | undefined,
): CurrentUser {
  return {
    id: user.id,
    name: user.fullName || user.email,
    email: user.email,
    role: normaliseRole(membership?.role),
    avatarUrl: user.avatarUrl ?? undefined,
    tenantId: membership?.tenantId ?? '',
    employeeId: membership?.employeeId ?? undefined,
  }
}

function adaptTenant(
  membership: ApiMembership | null | undefined,
): CurrentTenant | null {
  if (!membership) return null
  return {
    id: membership.tenantId,
    name: membership.tenantName,
    slug: membership.tenantSlug,
    logoUrl: undefined,
    plan: 'free',
  }
}

// ──────────────────────────────────────────────────────────────────────────

export function useCurrentUser() {
  const { setUser, setTenant } = useAuthStore()

  return useQuery({
    queryKey: ['auth', 'me'],
    queryFn: async () => {
      const data = await api.get<MeResponse>('/api/v1/auth/me')
      const membership = data.currentMembership ?? data.memberships?.[0] ?? null
      setUser(adaptUser(data, membership))
      const tenant = adaptTenant(membership)
      if (tenant) setTenant(tenant)
      return data
    },
    retry: false,
    staleTime: 5 * 60 * 1000,
  })
}

export function useRequestOtp() {
  return useMutation({
    mutationFn: (payload: RequestOtpPayload) =>
      api.post<{ success: true; message: string }>(
        '/api/v1/auth/request-otp',
        payload,
      ),
  })
}

export function useVerifyOtp() {
  const { setUser } = useAuthStore()

  return useMutation({
    mutationFn: (payload: VerifyOtpPayload) =>
      api.post<VerifyAuthResponse>('/api/v1/auth/verify-otp', payload),
    onSuccess: (data) => {
      // verify-otp doesn't return membership/tenant; we set a partial user so
      // the persisted store has a name & email for first paint. /me fills in
      // role + tenant after the layout mounts.
      setUser(adaptUser(data.user, null))
    },
  })
}

export function useVerifyMagicLink() {
  const { setUser } = useAuthStore()

  return useMutation({
    mutationFn: (payload: VerifyMagicLinkPayload) =>
      api.get<VerifyAuthResponse>(
        `/api/v1/auth/magic-link?token=${encodeURIComponent(payload.token)}`,
      ),
    onSuccess: (data) => {
      setUser(adaptUser(data.user, null))
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
  const { setUser } = useAuthStore()

  return useQuery({
    queryKey: ['auth', 'verify-magic-link', token],
    queryFn: async () => {
      // API exposes this as GET /api/v1/auth/magic-link?token=…
      const data = await api.get<VerifyAuthResponse>(
        `/api/v1/auth/magic-link?token=${encodeURIComponent(token ?? '')}`,
      )
      setUser(adaptUser(data.user, null))
      return data
    },
    enabled: !!token,
    retry: false,
    staleTime: Infinity,
    // One-shot query: never refetch in the background. Without these flags
    // a dev-mode StrictMode mount cycle, a window focus, or a network
    // reconnect would fire the GET a second time and the backend's
    // idempotency window has to catch it.
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })
}
