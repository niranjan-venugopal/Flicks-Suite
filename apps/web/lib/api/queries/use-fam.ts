'use client'

import { useQuery } from '@tanstack/react-query'
import { api } from '../client'

export interface FamOverview {
  totalTenants: number
  activeTenants: number
  tenantsByStatus: Record<string, number>
  tenantsByPlan: Record<string, number>
  signupsThisWeek: number
  signupsTrend7d: Array<{ date: string; count: number }>
  mrr: { amount: number; currency: string }
  health: {
    healthy: number
    at_risk: number
    churning: number
    expanding: number
    new: number
  }
  recentSignups: Array<{
    id: string
    name: string
    slug: string
    status: string
    createdAt: string
  }>
}

export function useFamOverview() {
  return useQuery({
    queryKey: ['fam', 'overview'],
    queryFn: () => api.get<FamOverview>('/api/v1/fam/overview'),
    staleTime: 60_000,
  })
}
