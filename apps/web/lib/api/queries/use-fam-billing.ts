'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../client'

/** FAM coupon console + billing overview hooks (PRD v4 D21/D22, Sprint 22). */

export interface FamCoupon {
  id: string
  code: string
  campaign: string
  months: number
  max_redemptions: number
  redemption_count: number
  expires_at: string | null
  active: boolean
  created_at: string
}

export interface FamCouponRedemption {
  id: string
  tenant_id: string
  tenant_name: string
  tenant_slug: string
  redeemed_by_name: string | null
  months: number
  redeemed_at: string
}

export function useFamCoupons(filters: { campaign?: string; active?: string }) {
  const params = new URLSearchParams()
  if (filters.campaign) params.set('campaign', filters.campaign)
  if (filters.active) params.set('active', filters.active)
  const qs = params.toString()
  return useQuery({
    queryKey: ['fam', 'coupons', qs],
    queryFn: () =>
      api.get<{ data: FamCoupon[]; meta: { campaigns: Array<{ campaign: string; n: number }> } }>(
        `/api/v1/fam/coupons${qs ? `?${qs}` : ''}`,
      ),
    staleTime: 15_000,
  })
}

export function useFamCouponBatch() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: {
      prefix: string
      mode: 'random' | 'sequential'
      count: number
      months: number
      campaign: string
      max_redemptions?: number
      expires_at?: string
    }) =>
      api.post<{ data: { minted: number; requested: number; codes: string[] } }>(
        '/api/v1/fam/coupons/batch',
        input,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['fam', 'coupons'] }),
  })
}

export function useFamCouponUpdate() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      api.patch<{ data: FamCoupon }>(`/api/v1/fam/coupons/${id}`, { active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['fam', 'coupons'] }),
  })
}

export function useFamCouponDelete() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/fam/coupons/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['fam', 'coupons'] }),
  })
}

export function useFamCouponRedemptions(id: string | null) {
  return useQuery({
    queryKey: ['fam', 'coupons', 'redemptions', id],
    queryFn: () =>
      api.get<{ data: FamCouponRedemption[]; meta: { code: string; campaign: string } }>(
        `/api/v1/fam/coupons/${id}/redemptions`,
      ),
    enabled: !!id,
  })
}

export function useFamBillingOverview() {
  return useQuery({
    queryKey: ['fam', 'billing', 'overview'],
    queryFn: () =>
      api.get<{
        data: {
          platform_mrr: number
          active_subscriptions: number
          trialing: number
          past_due: number
          trial_to_paid_pct: number
          coupons_redeemed: number
        }
      }>('/api/v1/fam/billing/overview'),
    staleTime: 30_000,
  })
}

/**
 * Download the coupon CSV through the api client (cookie auth + 401 redirect
 * + JSON error surfacing) — a plain <a href> would navigate the console to a
 * raw error body on an expired token or a 403.
 */
export async function downloadCouponCsv(campaign?: string): Promise<void> {
  const path = `/api/v1/fam/coupons/export.csv${campaign ? `?campaign=${encodeURIComponent(campaign)}` : ''}`
  const { blob, filename } = await api.download(path)
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename ?? 'coupons.csv'
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
