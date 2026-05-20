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

// ─── Tenants list ─────────────────────────────────────────────────────────

export interface FamTenantRow {
  id: string
  name: string
  slug: string
  status: 'trialing' | 'active' | 'past_due' | 'canceled' | 'suspended'
  createdAt: string
  trialEndsAt: string | null
  plan: string | null
  subStatus: string | null
  mrr: number
  userCount: number
  memberCount: number
  signal: 'healthy' | 'at_risk' | 'churning' | 'expanding' | 'new' | null
  healthScore: number | null
}

export interface FamTenantsQuery {
  status?: string
  signal?: string
  search?: string
  page?: number
  limit?: number
}

export function useFamTenants(q: FamTenantsQuery = {}) {
  return useQuery({
    queryKey: ['fam', 'tenants', q],
    queryFn: () => {
      const p = new URLSearchParams()
      if (q.status) p.set('status', q.status)
      if (q.signal) p.set('signal', q.signal)
      if (q.search) p.set('search', q.search)
      if (q.page) p.set('page', String(q.page))
      if (q.limit) p.set('limit', String(q.limit))
      const qs = p.toString()
      return api.get<{
        data: FamTenantRow[]
        pagination: { page: number; limit: number; total: number }
      }>(`/api/v1/fam/tenants${qs ? `?${qs}` : ''}`)
    },
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  })
}

// ─── Tenant detail ─────────────────────────────────────────────────────────

export interface FamTenantDetail {
  id: string
  name: string
  slug: string
  status: FamTenantRow['status']
  legalName: string | null
  industry: string | null
  sizeBand: string | null
  city: string | null
  stateCode: string | null
  country: string
  currency: string
  timezone: string
  logoUrl: string | null
  trialEndsAt: string | null
  verifiedAt: string | null
  createdAt: string
  memberCount: number
  employeeCount: number
  subscription: null | {
    planCode: string
    status: string
    mrr: number
    perUserPrice: number
    userCount: number
    billingCycle: string
    currentPeriodStart: string | null
    currentPeriodEnd: string | null
    cancelAtPeriodEnd: boolean
  }
  health: null | {
    score: number | null
    signal: FamTenantRow['signal']
    activeUsers7d: number
    activeUsers30d: number
    attendanceCompliance: number | null
    featureAdoptionScore: number | null
    snapshotDate: string
  }
}

export function useFamTenant(id: string | null) {
  return useQuery({
    queryKey: ['fam', 'tenant', id],
    queryFn: () => api.get<FamTenantDetail>(`/api/v1/fam/tenants/${id}`),
    enabled: !!id,
    staleTime: 30_000,
  })
}

// ─── Tenant members ────────────────────────────────────────────────────────

export interface FamTenantMember {
  membershipId: string
  userId: string
  email: string | null
  fullName: string | null
  role: string
  status: string
  invitedAt: string | null
  acceptedAt: string | null
}

export function useFamTenantMembers(id: string | null) {
  return useQuery({
    queryKey: ['fam', 'tenant-members', id],
    queryFn: () =>
      api.get<{ data: FamTenantMember[] }>(`/api/v1/fam/tenants/${id}/members`),
    enabled: !!id,
    staleTime: 30_000,
  })
}
