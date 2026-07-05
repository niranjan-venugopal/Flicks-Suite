'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../client'

/**
 * Consent ledger hooks (PRD v4 §3) + the fs_consent cookie helpers the geo
 * banner uses pre-login. Cookie shape: {v, analytics, region} — ledgered on
 * the first authenticated session via /consents/banner-sync.
 */

export type ConsentType = 'terms_privacy' | 'analytics' | 'marketing_email'

export interface ConsentState {
  latest: Partial<
    Record<ConsentType, { granted: boolean; policy_version: string; occurred_at: string }>
  >
  requires_reacceptance: boolean
  terms_version: string
  privacy_version: string
  consent_version: string
}

export function useMyConsents(enabled = true) {
  return useQuery({
    queryKey: ['consents', 'me'],
    queryFn: () => api.get<{ data: ConsentState }>('/api/v1/me/consents'),
    staleTime: 60_000,
    enabled,
  })
}

export function useRecordConsents() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: {
      consents: Array<{ type: ConsentType; granted: boolean }>
      region_code?: string
    }) => api.post('/api/v1/consents', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['consents'] }),
  })
}

export function useBannerSync() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { analytics: boolean; region_code?: string }) =>
      api.post('/api/v1/consents/banner-sync', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['consents'] }),
  })
}

export function useRequestMyExport() {
  return useMutation({
    mutationFn: () => api.post('/api/v1/me/data-export', {}),
  })
}

export function useRequestOrgExport() {
  return useMutation({
    mutationFn: () => api.post('/api/v1/org/data-export', {}),
  })
}

// ─── fs_consent cookie (pre-login banner memory, §3.3) ────────────────────────

export interface FsConsentCookie {
  v: number
  analytics: boolean
  region: string
}

const COOKIE = 'fs_consent'
const COOKIE_VERSION = 1

export function readConsentCookie(): FsConsentCookie | null {
  if (typeof document === 'undefined') return null
  const m = document.cookie.match(new RegExp(`(?:^|; )${COOKIE}=([^;]*)`))
  if (!m) return null
  try {
    const parsed = JSON.parse(decodeURIComponent(m[1])) as FsConsentCookie
    if (parsed.v !== COOKIE_VERSION) return null // CONSENT_VERSION bump → re-prompt
    return parsed
  } catch {
    return null
  }
}

export function writeConsentCookie(analytics: boolean, region: string) {
  if (typeof document === 'undefined') return
  const value = encodeURIComponent(
    JSON.stringify({ v: COOKIE_VERSION, analytics, region } satisfies FsConsentCookie),
  )
  // 12 months; SameSite=Lax so it also rides the OAuth-style redirects.
  document.cookie = `${COOKIE}=${value}; path=/; max-age=${60 * 60 * 24 * 365}; SameSite=Lax`
}

/** Region default when the visitor never touches the banner (§3.3). */
export function analyticsDefaultFor(region: string): boolean {
  const r = region.toUpperCase()
  const EU = [
    'AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT',
    'LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE','GB','IS','LI','NO',
  ]
  if (r === 'IN' || EU.includes(r)) return false // opt-in regions
  return true // US/rest: on-with-notice + opt-out
}

export function bannerVariantFor(region: string): 'india' | 'eu' | 'us' {
  const r = region.toUpperCase()
  if (r === 'IN') return 'india'
  return analyticsDefaultFor(r) ? 'us' : 'eu'
}
