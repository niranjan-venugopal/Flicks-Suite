'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
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
  gstin: string | null
  pan: string | null
  cin: string | null
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

// ─── Tenant usage (C4) ────────────────────────────────────────────────────

export interface FamTenantUsage {
  windowDays: number
  attendancePunches: number
  leaveRequests: number
  timesheetsSubmitted: number
  activeEmployees: number
  activeUsers7d: number
  activeUsers30d: number
  attendanceCompliance: number | null
  featureAdoptionScore: number | null
  healthScore: number | null
}

export function useFamTenantUsage(id: string | null) {
  return useQuery({
    queryKey: ['fam', 'tenant-usage', id],
    queryFn: () =>
      api.get<FamTenantUsage>(`/api/v1/fam/tenants/${id}/usage`),
    enabled: !!id,
    staleTime: 60_000,
  })
}

// ─── Tenant billing (C4) ──────────────────────────────────────────────────

export interface FamSubscriptionEvent {
  id: string
  eventType: string
  metadata: Record<string, unknown> | null
  createdAt: string
}

export interface FamTenantBilling {
  subscription: null | {
    id: string
    planCode: string
    status: string
    perUserPrice: number
    userCount: number
    mrr: number
    billingCycle: string
    trialEndsAt: string | null
    currentPeriodStart: string | null
    currentPeriodEnd: string | null
    cancelAtPeriodEnd: boolean
    canceledAt: string | null
    razorpaySubscriptionId: string | null
    createdAt: string
  }
  events: FamSubscriptionEvent[]
}

export function useFamTenantBilling(id: string | null) {
  return useQuery({
    queryKey: ['fam', 'tenant-billing', id],
    queryFn: () =>
      api.get<FamTenantBilling>(`/api/v1/fam/tenants/${id}/billing`),
    enabled: !!id,
    staleTime: 60_000,
  })
}

// ─── Tenant audit (C4) ────────────────────────────────────────────────────

export interface FamPlatformAuditEntry {
  id: string
  action: string
  actor: string
  actorEmail: string | null
  actorUserId: string | null
  targetUserId: string | null
  metadata: Record<string, unknown> | null
  ipAddress: string | null
  createdAt: string
}

export function useFamTenantAudit(id: string | null, page = 1, limit = 50) {
  return useQuery({
    queryKey: ['fam', 'tenant-audit', id, page, limit],
    queryFn: () =>
      api.get<{
        data: FamPlatformAuditEntry[]
        pagination: { page: number; limit: number; total: number }
      }>(`/api/v1/fam/tenants/${id}/audit?page=${page}&limit=${limit}`),
    enabled: !!id,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  })
}

// ─── Tenant lifecycle mutations (C4 Settings) ─────────────────────────────

export function useSuspendTenant() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api.post<{ id: string; status: string }>(
        `/api/v1/fam/tenants/${id}/suspend`,
        { reason },
      ),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: ['fam', 'tenant', id] })
      qc.invalidateQueries({ queryKey: ['fam', 'tenant-audit', id] })
      qc.invalidateQueries({ queryKey: ['fam', 'tenants'] })
      qc.invalidateQueries({ queryKey: ['fam', 'overview'] })
    },
  })
}

export function useReactivateTenant() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ id: string; status: string }>(
        `/api/v1/fam/tenants/${id}/reactivate`,
        {},
      ),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ['fam', 'tenant', id] })
      qc.invalidateQueries({ queryKey: ['fam', 'tenant-audit', id] })
      qc.invalidateQueries({ queryKey: ['fam', 'tenants'] })
      qc.invalidateQueries({ queryKey: ['fam', 'overview'] })
    },
  })
}

export function useExtendTrial() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, days, reason }: { id: string; days: number; reason?: string }) =>
      api.post<{ id: string; trialEndsAt: string; extendedByDays: number }>(
        `/api/v1/fam/tenants/${id}/extend-trial`,
        { days, reason },
      ),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: ['fam', 'tenant', id] })
      qc.invalidateQueries({ queryKey: ['fam', 'tenant-billing', id] })
      qc.invalidateQueries({ queryKey: ['fam', 'tenant-audit', id] })
      qc.invalidateQueries({ queryKey: ['fam', 'tenants'] })
    },
  })
}

// ─── C5: Revenue ──────────────────────────────────────────────────────────

export interface FamRevenue {
  mrr: { amount: number; currency: string }
  arr: { amount: number; currency: string }
  byPlan: Array<{ plan: string; tenants: number; mrr: number }>
  byStatus: Array<{ status: string; n: number }>
  topPaying: Array<{
    tenantId: string
    tenantName: string
    slug: string
    planCode: string
    mrr: number
    userCount: number
    status: string
  }>
}

export function useFamRevenue() {
  return useQuery({
    queryKey: ['fam', 'revenue'],
    queryFn: () => api.get<FamRevenue>('/api/v1/fam/revenue'),
    staleTime: 60_000,
  })
}

// ─── C5: Signup funnel ────────────────────────────────────────────────────

export interface FamFunnel {
  total: number
  stages: Array<{ id: string; label: string; count: number; rate: number }>
}

export function useFamFunnel() {
  return useQuery({
    queryKey: ['fam', 'funnel'],
    queryFn: () => api.get<FamFunnel>('/api/v1/fam/funnel'),
    staleTime: 60_000,
  })
}

// ─── C5: Feature usage ────────────────────────────────────────────────────

export interface FamFeatureUsage {
  windowDays: number
  tenants: Array<{
    tenantId: string
    tenantName: string
    slug: string
    employeeCount: number
    attendance: { users: number; adoption: number }
    leave: { users: number; adoption: number }
    timesheet: { users: number; adoption: number }
  }>
}

export function useFamFeatureUsage() {
  return useQuery({
    queryKey: ['fam', 'feature-usage'],
    queryFn: () => api.get<FamFeatureUsage>('/api/v1/fam/feature-usage'),
    staleTime: 60_000,
  })
}

// ─── C5: System health ────────────────────────────────────────────────────

export interface FamSystemHealth {
  buckets: {
    healthy: number
    at_risk: number
    churning: number
    expanding: number
    new: number
  }
  atRiskTenants: Array<{
    tenantId: string
    tenantName: string
    slug: string
    signal: string
    healthScore: number | null
    supportTicketsOpen: number
  }>
}

export function useFamSystemHealth() {
  return useQuery({
    queryKey: ['fam', 'health'],
    queryFn: () => api.get<FamSystemHealth>('/api/v1/fam/health'),
    staleTime: 60_000,
  })
}

// ─── C5: Verification queue ───────────────────────────────────────────────

export interface FamVerificationTenant {
  id: string
  name: string
  slug: string
  legalName: string | null
  gstin: string | null
  pan: string | null
  cin: string | null
  industry: string | null
  sizeBand: string | null
  createdAt: string
}

export function useFamVerificationQueue() {
  return useQuery({
    queryKey: ['fam', 'verify'],
    queryFn: () =>
      api.get<{ data: FamVerificationTenant[]; total: number }>(
        '/api/v1/fam/verify',
      ),
    staleTime: 30_000,
  })
}

export function useVerifyTenant() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ id: string; verifiedAt: string | null }>(
        `/api/v1/fam/tenants/${id}/verify`,
        {},
      ),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ['fam', 'verify'] })
      qc.invalidateQueries({ queryKey: ['fam', 'tenant', id] })
      qc.invalidateQueries({ queryKey: ['fam', 'audit-platform'] })
    },
  })
}

// ─── C5: Platform audit log ───────────────────────────────────────────────

export interface FamPlatformAuditRow {
  id: string
  action: string
  actor: string
  actorEmail: string | null
  targetTenantId: string | null
  targetTenantName: string | null
  targetUserId: string | null
  metadata: Record<string, unknown> | null
  createdAt: string
}

export function useFamPlatformAudit(page = 1, limit = 50) {
  return useQuery({
    queryKey: ['fam', 'audit-platform', page, limit],
    queryFn: () =>
      api.get<{
        data: FamPlatformAuditRow[]
        pagination: { page: number; limit: number; total: number }
      }>(`/api/v1/fam/audit?page=${page}&limit=${limit}`),
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  })
}

// ─── C5: Feature flags ────────────────────────────────────────────────────

export interface FamFeatureFlag {
  id: string
  flagKey: string
  description: string | null
  isEnabledGlobally: boolean
  enabledTenantIds: string[]
  rolloutPercentage: number
  updatedAt: string
}

export function useFamFeatureFlags() {
  return useQuery({
    queryKey: ['fam', 'feature-flags'],
    queryFn: () =>
      api.get<{ data: FamFeatureFlag[]; total: number }>('/api/v1/fam/feature-flags'),
    staleTime: 30_000,
  })
}

export function useUpsertFeatureFlag() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (dto: {
      flagKey: string
      description?: string | null
      isEnabledGlobally?: boolean
      enabledTenantIds?: string[]
      rolloutPercentage?: number
    }) => api.put<FamFeatureFlag>('/api/v1/fam/feature-flags', dto),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['fam', 'feature-flags'] })
      qc.invalidateQueries({ queryKey: ['fam', 'audit-platform'] })
    },
  })
}

// ─── C5: Cohorts ──────────────────────────────────────────────────────────

export interface FamCohort {
  id: string
  name: string
  description: string | null
  tenantIds: string[]
  tenantCount: number
  createdAt: string
}

export function useFamCohorts() {
  return useQuery({
    queryKey: ['fam', 'cohorts'],
    queryFn: () =>
      api.get<{ data: FamCohort[]; total: number }>('/api/v1/fam/cohorts'),
    staleTime: 30_000,
  })
}

export function useUpsertCohort() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (dto: { name: string; description?: string; tenantIds: string[] }) =>
      api.put<FamCohort>('/api/v1/fam/cohorts', dto),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['fam', 'cohorts'] })
      qc.invalidateQueries({ queryKey: ['fam', 'audit-platform'] })
    },
  })
}

// ─── C6: Impersonation ────────────────────────────────────────────────────

// Either membershipId or targetUserId is required. We send membershipId
// because it's the rock-solid PK of the row the FAM admin clicked; that
// dodges every shape of "what if the user_id projection in the response
// came back wrong" bug class.
export interface StartImpersonationPayload {
  membershipId?: string
  targetUserId?: string
  reason: string
}

export function useStartImpersonation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (dto: StartImpersonationPayload) =>
      api.post<{
        targetUserId: string
        targetEmail: string
        tenantId: string
        expiresIn: number
      }>('/api/v1/fam/impersonate', dto),
    // impersonation_started is captured server-side (analytics.service.ts)
    // where it can be reliably attributed to the FAM admin.
    onSuccess: () => {
      // Cookies have been swapped server-side. Clear every query so the
      // next paint reflects the target user, not the cached FAM context.
      qc.clear()
    },
  })
}

export function useEndImpersonation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.post<{ ok: boolean }>('/api/v1/fam/impersonate/end', {}),
    onSuccess: () => {
      qc.clear()
    },
  })
}
