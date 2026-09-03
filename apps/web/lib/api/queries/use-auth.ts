'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, APIError } from '../client'
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
  designationTitle?: string | null
}

// Returned by /verify-otp and /magic-link
interface VerifyAuthResponse {
  accessToken?: string
  refreshToken?: string
  expiresIn?: number
  user: ApiUser
  // True when the account has NO memberships yet (fresh signup) — the wizard
  // goes straight to workspace creation; existing users see their workspaces.
  needsOnboarding?: boolean
  // FAM second factor (PRD §11.6). When the user is an enrolled platform
  // admin, no session is issued yet — the client must complete the TOTP step.
  requiresTotp?: boolean
  challengeToken?: string
  // Platform admin who hasn't enrolled TOTP yet — session is issued, but the
  // FAM shell routes them to /totp-setup.
  requiresTotpEnrollment?: boolean
}

export type ModuleAccessLevel = 'none' | 'view' | 'edit'
export type ModuleAccessMap = Record<'crm' | 'invoicing' | 'pm', ModuleAccessLevel>

// Returned by /me
interface MeResponse extends ApiUser {
  // User-level platform-admin flag (users.is_platform_admin) — independent
  // of which workspace is currently active.
  isPlatformAdmin?: boolean
  // Whether this browser is a consented trusted device (drives the
  // post-login "stay signed in for 180 days?" prompt).
  deviceTrusted?: boolean
  currentMembership: ApiMembership | null
  memberships: ApiMembership[]
  // PRD v6 — effective runtime flags for the current tenant (e.g.
  // 'pm_sync_engine'); the PM data-source facade picks its transport off this.
  effectiveFlags?: string[]
  // Round 8 — effective module access for the active workspace, resolved by
  // the same service the API guards use. The sidebar gates CRM / Invoicing /
  // Projects on this so a granted member sees the link and a revoked one
  // doesn't (previously the nav was role-only and could disagree with the API).
  moduleAccess?: ModuleAccessMap
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
    case 'guest':
      return 'GUEST' // project-scoped PM seat — must NOT fall through to EMPLOYEE
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
    designation: membership?.designationTitle ?? undefined,
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
    //
    // Retry transient failures (429 from a rate limiter, 5xx, network blip) —
    // the app layout treats a settled /me error as "signed out", so giving up
    // on the first hiccup ejected real sessions. A 401 is definitive (the
    // silent refresh already ran inside the api client): fail fast.
    retry: (failureCount, error) => {
      if (error instanceof APIError && error.status === 401) return false
      return failureCount < 2
    },
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

/**
 * Effective module access for the active workspace. Undefined while /me is in
 * flight — callers should treat that as "don't hide anything yet" so the nav
 * doesn't flicker on every load.
 */
export function useModuleAccess(): ModuleAccessMap | undefined {
  const { data } = useCurrentUser()
  return data?.moduleAccess
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

// Round H — the magic-link flow is two-step so mail-security link scanners
// can't burn the single-use token before the invitee clicks:
//   peek (GET, never consumes) → explicit Continue → consume (POST).
// A consumed/expired link recovers into a fresh sign-in code for the same
// address instead of dead-ending.
export type MagicLinkPeek = {
  status: 'ready' | 'consumed' | 'expired' | 'invalid'
  email?: string
  // Guest invite links only (founder decision): show an explicit Continue
  // button. Everyone else signs in on load, one click from the email.
  requiresClick?: boolean
}

export function usePeekMagicLinkQuery(token: string | null) {
  return useQuery({
    queryKey: ['auth', 'peek-magic-link', token],
    queryFn: () =>
      api.get<MagicLinkPeek>(
        `/api/v1/auth/magic-link?token=${encodeURIComponent(token ?? '')}`,
      ),
    enabled: !!token,
    retry: false,
    staleTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })
}

export function useConsumeMagicLink() {
  const { setUser } = useAuthStore()
  return useMutation({
    mutationFn: (payload: VerifyMagicLinkPayload) =>
      api.post<VerifyAuthResponse>('/api/v1/auth/magic-link/consume', payload),
    onSuccess: (data) => {
      setUser(adaptUser(data.user, null))
    },
  })
}

export function useRecoverMagicLink() {
  return useMutation({
    mutationFn: (payload: VerifyMagicLinkPayload) =>
      api.post<{ email: string }>('/api/v1/auth/magic-link/recover', payload),
  })
}

// "Stay signed in on this device for 180 days" — upgrades the current
// session in place and remembers the device for future logins.
export function useTrustDevice() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () =>
      api.post<{ trusted: boolean; expiresAt: string }>(
        '/api/v1/auth/trust-device',
        {},
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['auth', 'me'] }),
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

/**
 * Begin FAM TOTP enrolment — returns the secret + otpauth URL for a QR.
 * Idempotent server-side: repeat calls return the SAME pending secret;
 * pass { regenerate: true } to explicitly mint a new one.
 */
export function useEnrollTotp() {
  return useMutation({
    mutationFn: (opts?: { regenerate?: boolean }) =>
      api.post<{ secret: string; otpauthUrl: string }>(
        '/api/v1/auth/totp/enroll',
        { regenerate: opts?.regenerate ?? false },
      ),
  })
}

/** Confirm enrolment with the first code from the authenticator app. */
export function useConfirmTotp() {
  return useMutation({
    mutationFn: (code: string) =>
      api.post<{ ok: true; backupCodes: string[] }>('/api/v1/auth/totp/confirm', { code }),
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
