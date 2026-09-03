'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../client'

/** Platform billing hooks (PRD v4 §8B, D18–D20). */

export interface BillingState {
  plan: {
    code: string
    price_rupees: number
    display_usd: number
    currency: string
    interval: string
  }
  status: 'trialing' | 'active' | 'past_due' | 'canceled' | 'paused' | 'unpaid'
  seats: number
  monthly_total_rupees: number
  trial_ends_at: string | null
  grace_ends_at: string | null
  current_period_start: string | null
  current_period_end: string | null
  cancel_at_period_end: boolean
  authorization_url: string | null
  has_razorpay_subscription: boolean
  coupon: { code: string; months: number; redeemed_at: string } | null
  locked: boolean
  locked_reason: 'trial_expired' | 'past_due' | 'canceled' | 'halted' | null
  payments_configured: boolean
  history: Array<{
    id: string
    event_type: string
    metadata: Record<string, unknown> | null
    created_at: string
  }>
}

export function useBilling(opts?: { poll?: boolean; enabled?: boolean }) {
  return useQuery({
    queryKey: ['billing'],
    queryFn: () => api.get<{ data: BillingState }>('/api/v1/billing'),
    staleTime: 30_000,
    // Round H: the host workspace's billing state is not a guest's to see —
    // the API refuses guests, so the shell doesn't ask.
    enabled: opts?.enabled ?? true,
    // D20: poll for the webhook flip to active while a checkout is pending —
    // either because this page just opened one (opts.poll) or because the
    // server says one exists (survives navigation/reload; the local flag
    // doesn't). Keep ticking while the user is off in the Razorpay tab.
    refetchInterval: (query) => {
      const d = query.state.data?.data
      const pendingCheckout =
        !!d && d.has_razorpay_subscription && d.status !== 'active' && !!d.authorization_url
      return opts?.poll || pendingCheckout ? 5_000 : false
    },
    refetchIntervalInBackground: true,
  })
}

export function useSubscribe() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () =>
      api.post<{ data: { authorization_url: string | null } }>('/api/v1/billing/subscribe', {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['billing'] }),
  })
}

export function useRedeemCoupon() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (code: string) =>
      api.post<{ data: { months: number; trial_ends_at: string | null } }>(
        '/api/v1/billing/coupon/redeem',
        { code },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['billing'] }),
  })
}

export function useCancelPlan() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.post('/api/v1/billing/cancel', {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['billing'] }),
  })
}

export function useResumePlan() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.post('/api/v1/billing/resume', {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['billing'] }),
  })
}
