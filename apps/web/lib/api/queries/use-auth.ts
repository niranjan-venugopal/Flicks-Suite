'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../client'
import { resetAnalytics } from '@/lib/analytics/posthog'
import {
  useAuthStore,
  type CurrentUser,
  type CurrentTenant,
  type UserRole,
} from '@/lib/stores/auth.store'

interface RequestOtpPayload {
  email: string
  intent?: 'signin' | 'signup'
}

interface VerifyOtpPayload {
  email: string
  code: string
  /** Signup clickwrap (PRD v4 §3.4) — required when this creates a NEW account. */
  consents?: Array<{
    type: 'terms_privacy' | 'analytics' | 'marketing_email'
    granted: boolean
  }>
  regionCode?: string
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
  accessToken?: string
  refreshToken?: string
  expiresIn?: number
  user: ApiUser
  // FAM second factor (PRD §11.6). When the user is an enrolled platform
  // admin, no session is issued yet — the client must complete the TOTP step.
  requiresTotp?: boolean
  challengeToken?: string
  // Platform admin who hasn't enrolled TOTP yet — session is issued, but the
  // FAM shell routes them to /totp-setup.
  requiresTotpEnrollment?: boolean
}

// Returned by /me
interface MeResponse extends ApiUser {
  currentMembership: ApiMembership | null
  memberships: ApiMembership[]
  // PRD v6 — effective runtime flags for the current tenant (e.g.
  // 'pm_sync_engine'); the PM data-source facade picks its transport off this.
  effectiveFlags?: string[]
  // Set only when the current session is a FAM impersonation. The web
  // app shows the ImpersonationBanner whenever this is present.
  impersonatorUserId?: string
  impersonation?: {
    sessionId: string
    startedAt: string
    endsAt: string
    impersonatorEmail: string | null
    impersonatorName: string | null
  } | null
}

function normaliseRole(role: string | undefined | null): UserRole {
  switch ((role ?? '').toLowerCase()) {
    case 'fam':
    case 'super_admin': // legacy alias — pre-0004 migration rows still resolve
      return 'FAM'
    case 'owner':
      return 'OWNER'
    case 'admin':
      return 'HR_ADMIN'
    case 'manager':
      return 'MANAGER'
    case 'finance':
      return 'FINANCE'
    case 'auditor':
      return 'AUDITOR'
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
    // §4 media pipeline: /me serves a signed URL from tenants.logo_key with a
    // legacy logo_url fallback.
    logoUrl: (membership as { tenantLogoUrl?: string | null }).tenantLogoUrl ?? undefined,
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
    // Intentionally NOT gated on isAuthenticated: the persisted auth store
    // rehydrates asynchronously after a hard navigation (login does a full
    // reload), so isAuthenticated is briefly false on first paint. Gating the
    // query there left isLoading=false during that window and the layout
    // redirected to /login before hydration finished. Keeping /me always-on
    // means isLoading stays true until it resolves, so the guard waits. Logout
    // safety is handled by useLogout doing a hard teardown instead.
    retry: false,
    staleTime: 5 * 60 * 1000,
  })
}

/**
 * Effective runtime flags from /me (PRD v6). Rides useCurrentUser — same
 * queryKey + queryFn as the app layout, so it dedupes against the layout's
 * fetch (staleTime 5m) instead of observing the cache with enabled:false,
 * which errors ("No queryFn was passed") whenever the entry isn't already
 * there (hard navigation, cache clear/GC) and left consumers stuck loading.
 */
export function useEffectiveFlags(): { flags: string[]; loaded: boolean; failed: boolean } {
  const { data, isError } = useCurrentUser()
  return { flags: data?.effectiveFlags ?? [], loaded: data !== undefined, failed: isError }
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
  const { logout } = useAuthStore()

  return useMutation({
    mutationFn: () => api.post<void>('/api/v1/auth/logout'),
    // onSettled (not onSuccess) so we still tear down the session even if the
    // network call fails. We clear the persisted store, then hard-navigate to
    // /login. A full-page reload destroys the entire React Query cache and the
    // mounted /me observer with it, so there's no chance of a post-logout /me
    // refetch silently re-authenticating the user (the original bug). We
    // deliberately do NOT call queryClient.clear() here — that was what
    // triggered the re-auth refetch; the hard reload handles cache teardown.
    onSettled: () => {
      logout()
      resetAnalytics()
      window.location.assign('/login')
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

// ─── FAM TOTP (PRD §11.6) ──────────────────────────────────────────────────

/** Complete a FAM login challenge: exchange challengeToken + code for a session. */
export function useCompleteTotp() {
  const { setUser } = useAuthStore()
  return useMutation({
    mutationFn: (payload: { challengeToken: string; code: string }) =>
      api.post<VerifyAuthResponse>('/api/v1/auth/totp/verify', payload),
    onSuccess: (data) => {
      setUser(adaptUser(data.user, null))
    },
  })
}

/** Begin FAM TOTP enrolment — returns the secret + otpauth URL for a QR. */
export function useEnrollTotp() {
  return useMutation({
    mutationFn: () =>
      api.post<{ secret: string; otpauthUrl: string }>(
        '/api/v1/auth/totp/enroll',
        {},
      ),
  })
}

/** Confirm enrolment with the first code from the authenticator app. */
export function useConfirmTotp() {
  return useMutation({
    mutationFn: (code: string) =>
      api.post<{ ok: true }>('/api/v1/auth/totp/confirm', { code }),
  })
}

// ─── DPDP self-service (D2) ────────────────────────────────────────────────

export interface DeletionRequest {
  id: string
  status: string
  requestedAt: string
  scheduledFor: string
  reason: string | null
}

/** Right to access — fetches the full data export and triggers a download. */
export function useExportMyData() {
  return useMutation({
    mutationFn: async () => {
      const data = await api.get<Record<string, unknown>>('/api/v1/auth/me/export')
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: 'application/json',
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `flicks-data-export-${new Date().toISOString().slice(0, 10)}.json`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      return data
    },
  })
}

export function useDeletionRequest() {
  return useQuery({
    queryKey: ['me', 'deletion-request'],
    queryFn: () =>
      api.get<{ request: DeletionRequest | null }>('/api/v1/auth/me/delete-account'),
    staleTime: 30_000,
  })
}

export function useRequestDeletion() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (reason?: string) =>
      api.post<{ id: string; status: string; scheduledFor: string }>(
        '/api/v1/auth/me/delete-account',
        { reason },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me', 'deletion-request'] }),
  })
}

export function useCancelDeletion() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.post<{ ok: boolean }>('/api/v1/auth/me/delete-account/cancel', {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me', 'deletion-request'] }),
  })
}
