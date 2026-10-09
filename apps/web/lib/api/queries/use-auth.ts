'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, APIError, setConfirmedTenant } from '../client'
import { resetAnalytics } from '@/lib/analytics/posthog'
import { destroyAllPmDbs } from '@/lib/pm/idb'
import { useToast } from '@/components/ui/use-toast'
import {
  applyPreference,
  readMirror,
  syncThemeFromServer,
  type ThemePreference,
} from '@/lib/theme/theme'
import {
  useAuthStore,
  type CurrentUser,
  type CurrentTenant,
  type UserRole,
} from '@/lib/stores/auth.store'
import { planLabel, type TenantBilling } from '@/lib/plan-label'
import { broadcastSignedOut } from '@/lib/tenant-sync'

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
  // Round O — users.theme. Carried by /me AND the login / tenant-switch
  // payloads so the device mirror is right before the post-login reload
  // paints. Absent on a pre-0065 API (→ the theme helpers no-op).
  theme?: ThemePreference
}

interface ApiMembership {
  // Round R R2: the suspended-workspace screen shows the company logo.
  tenantLogoUrl?: string | null
  id: string
  tenantId: string
  tenantName: string
  tenantSlug: string
  tenantStatus?: string
  role: string
  status: string
  employeeId?: string | null
  designationTitle?: string | null
  /** Round R: subscription summary for the workspace-card label (absent on older APIs). */
  billing?: TenantBilling | null
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
  // Round R R2: companies skipped at sign-in because Specflicks suspended them.
  suspendedTenants?: string[]
}

export type ModuleAccessLevel = 'none' | 'view' | 'edit'
// Round P R3 — `policies` joins the managed set (Owner/Admin by role,
// anyone else via Settings → Module access). An API older than 0067 omits the
// key, so readers treat a missing entry as 'none'.
export type ModuleAccessMap = Record<'crm' | 'invoicing' | 'pm' | 'policies', ModuleAccessLevel>

// Returned by /me
interface MeResponse extends ApiUser {
  // User-level platform-admin flag (users.is_platform_admin) — independent
  // of which workspace is currently active.
  isPlatformAdmin?: boolean
  // Whether this browser is a consented trusted device (drives the
  // post-login "stay signed in for 180 days?" prompt).
  deviceTrusted?: boolean
  // users.last_login_at — the profile's Security card shows it (round K).
  lastLoginAt?: string | null
  // Round R R2 — FAM second factor: enforced for this account, enrolled, and
  // whether THIS session cleared it (the console refuses it otherwise).
  totp?: { enforced: boolean; enrolled: boolean; satisfied: boolean }
  locale?: string
  timezone?: string
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
    // Round R: the real plan / trial state, never a constant.
    plan: planLabel(membership.billing, membership.tenantStatus),
    status: membership.tenantStatus,
    billing: membership.billing ?? null,
  }
}

/**
 * Round O — the login responses carry users.theme. Pre-login the page follows
 * the device, so a returning dark user on a light OS would otherwise flip
 * only after /me; writing the mirror here (before the full reload the login
 * pages do) makes the post-login paint right from the first frame.
 */
function applyLoginTheme(data: { user?: { theme?: ThemePreference } }): void {
  if (data.user?.theme) applyPreference(data.user.theme)
}

// ──────────────────────────────────────────────────────────────────────────

export function useCurrentUser() {
  const { setUser, setTenant } = useAuthStore()

  return useQuery({
    queryKey: ['auth', 'me'],
    queryFn: async () => {
      const data = await api.get<MeResponse>('/api/v1/auth/me')
      const membership = data.currentMembership ?? data.memberships?.[0] ?? null
      // Round R: from here on every call carries this company (X-Flicks-
      // Tenant) and the API refuses a tab that drifted to another one.
      setConfirmedTenant(data.currentMembership?.tenantId ?? null)
      setUser(adaptUser(data, membership))
      const tenant = adaptTenant(membership)
      if (tenant) setTenant(tenant)
      // Round O — reconcile the device mirror with the server (server wins;
      // no-op when the API doesn't send theme yet or it already matches).
      syncThemeFromServer(data.theme)
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
      applyLoginTheme(data)
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
      applyLoginTheme(data)
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

/**
 * Round O — Appearance (System / Light / Dark). Optimistic: the theme flips
 * the moment the person clicks (applyPreference writes the mirror + <html
 * data-theme>), the /me cache is patched so every reader agrees, and a failed
 * PATCH reverts both and says so. onSettled re-fetches /me, whose queryFn
 * reconciles with the server either way (the useTrustDevice pattern).
 */
export function useUpdateTheme() {
  const qc = useQueryClient()
  const { toast } = useToast()
  return useMutation({
    mutationFn: (theme: ThemePreference) =>
      api.patch<{ theme: ThemePreference }>('/api/v1/auth/me/preferences', { theme }),
    onMutate: async (theme) => {
      await qc.cancelQueries({ queryKey: ['auth', 'me'] })
      const previous = qc.getQueryData<MeResponse>(['auth', 'me'])
      const previousPref: ThemePreference = readMirror() ?? previous?.theme ?? 'system'
      applyPreference(theme)
      qc.setQueryData<MeResponse>(['auth', 'me'], (old) => (old ? { ...old, theme } : old))
      return { previous, previousPref }
    },
    onError: (err, _theme, ctx) => {
      if (ctx) {
        applyPreference(ctx.previousPref)
        if (ctx.previous) qc.setQueryData(['auth', 'me'], ctx.previous)
      }
      toast({
        title: 'Could not save appearance',
        description: err instanceof Error ? err.message : 'Please try again in a moment.',
        variant: 'destructive',
      })
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['auth', 'me'] }),
  })
}

export function useLogout() {
  const { logout, currentUser } = useAuthStore()

  return useMutation({
    mutationFn: () => api.post<void>('/api/v1/auth/logout'),
    // onSettled (not onSuccess) so we still tear down the session even if the
    // network call fails. We clear the persisted store, then hard-navigate to
    // /login. A full-page reload destroys the entire React Query cache and the
    // mounted /me observer with it, so there's no chance of a post-logout /me
    // refetch silently re-authenticating the user (the original bug). We
    // deliberately do NOT call queryClient.clear() here — that was what
    // triggered the re-auth refetch; the hard reload handles cache teardown.
    onSettled: async () => {
      // Security audit 2026-10-06: wipe the offline Projects databases before
      // leaving, so the next person on a shared PC finds nothing in IndexedDB.
      // Bounded (1.5 s) and best-effort — logout always completes.
      const fallback = currentUser ? [{ tenantId: currentUser.tenantId, userId: currentUser.id }] : []
      await destroyAllPmDbs(1500, fallback).catch(() => undefined)
      logout()
      resetAnalytics()
      // Round R: every other open tab of this browser goes to /login too.
      broadcastSignedOut()
      window.location.assign('/login')
    },
  })
}

/**
 * "Sign out other devices" (round K) — revokes every other live session;
 * this device keeps its cookies. Nothing to invalidate: the current session
 * is untouched by design.
 */
export function useLogoutOthers() {
  return useMutation({
    mutationFn: () =>
      api.post<{ revokedDevices: number }>('/api/v1/auth/logout-others', {}),
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
      applyLoginTheme(data)
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

/**
 * Round R R2 — step-up: an enrolled platform admin whose session was issued
 * without the second factor proves the code in place; the server re-issues
 * the session with the mfa claim (no sign-out, no redirect).
 */
export function useStepUpTotp() {
  return useMutation({
    mutationFn: (code: string) => api.post<{ ok: true }>('/api/v1/auth/totp/step-up', { code }),
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
