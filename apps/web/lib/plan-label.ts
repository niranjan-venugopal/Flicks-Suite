/**
 * Round R — the line under the company name in the sidebar (was a hard-coded
 * "free"). Built from /auth/me's `currentMembership.billing` (the same
 * subscription row the paywall reads) plus the tenant status: a trial — free
 * or given with a code — says how long is left; a paying company shows the
 * plan name; a suspended company says so.
 */
export interface TenantBilling {
  status: 'trialing' | 'active' | 'past_due' | 'canceled' | 'unpaid' | 'paused' | 'platform'
  trialEndsAt: string | null
  trialDaysLeft: number | null
  planName: string | null
  hasCoupon: boolean
}

export function planLabel(billing: TenantBilling | null | undefined, tenantStatus?: string | null): string {
  if (tenantStatus === 'suspended') return 'Suspended'
  if (!billing) return 'Workspace'
  switch (billing.status) {
    case 'platform':
      return 'Platform'
    case 'active':
      return `${billing.planName ?? 'Pro'} Plan`
    case 'past_due':
    case 'unpaid':
      return 'Payment due'
    case 'canceled':
      return 'Canceled'
    case 'paused':
      return 'Paused'
    case 'trialing': {
      const d = billing.trialDaysLeft
      if (d === null || d === undefined) return 'Trial'
      if (d < 0) return 'Trial ended'
      if (d === 0) return 'Trial · ends today'
      return `Trial · ${d} day${d === 1 ? '' : 's'} left`
    }
    default:
      return 'Workspace'
  }
}
