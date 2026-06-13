'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../client'
import { useToast } from '@/components/ui/use-toast'
import { useAuthStore } from '@/lib/stores/auth.store'

/**
 * Auditor role hooks (Sprint 8, PRD §3/§4.4): My Companies + company switch,
 * auditor invites, grants and seat counts. Member list/role/deactivate hooks
 * stay in use-settings.ts.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type GrantModule = 'invoicing' | 'reports' | 'org_financial' | 'payroll' | 'expenses'
export type GrantLevel = 'none' | 'view' | 'edit'

export interface ModuleGrant {
  module: GrantModule
  access_level: GrantLevel
  capabilities: Record<string, boolean>
}

export interface MyCompany {
  membershipId: string
  tenantId: string
  name: string
  slug: string
  logoUrl: string | null
  gstin: string | null
  city: string | null
  role: string
  status: 'active' | 'invited'
  isExternal: boolean
  accessExpiresAt: string | null
  grants: ModuleGrant[]
  stats: {
    overdueCount: number
    outstanding: string // INR decimal string
    currency: string
  }
}

export interface SeatCounts {
  billable: number
  auditors: number
  pendingInvites: number
}

export interface InviteAuditorPayload {
  email: string
  full_name?: string
  grants?: { module: GrantModule; access_level: GrantLevel; capabilities?: Record<string, boolean> }[]
  access_expires_at?: string
  note?: string
}

// ─── Queries ─────────────────────────────────────────────────────────────────

export function useMyCompanies(enabled = true) {
  return useQuery({
    queryKey: ['me', 'companies'],
    queryFn: () => api.get<{ data: MyCompany[] }>('/api/v1/me/companies'),
    staleTime: 60_000,
    enabled,
  })
}

export function useSeats() {
  return useQuery({
    queryKey: ['settings', 'members', 'seats'],
    queryFn: () => api.get<{ data: SeatCounts }>('/api/v1/settings/members/seats'),
    staleTime: 30_000,
  })
}

// ─── Mutations ───────────────────────────────────────────────────────────────

/**
 * Switch the active company. The API re-verifies the membership server-side
 * (pending invites are accepted on switch) and re-issues the JWT cookies for
 * the chosen tenant. On success we hard-navigate: a full reload tears down
 * every cached query from the previous tenant in one stroke.
 *
 * On failure we surface the server's reason (e.g. "Your access to this company
 * has been revoked") via a toast instead of a silent console 400 — the
 * previous version swallowed the error, so a rejected switch looked like
 * nothing happened.
 */
export function useSwitchCompany() {
  const { toast } = useToast()
  return useMutation({
    mutationFn: ({ tenantId }: { tenantId: string; redirectTo?: string }) =>
      api.post<{ expiresIn: number }>('/api/v1/auth/switch-company', { tenantId }),
    onSuccess: (_data, vars) => {
      window.location.assign(vars.redirectTo ?? '/dashboard')
    },
    onError: (err) => {
      toast({
        title: 'Could not switch company',
        description:
          err instanceof Error ? err.message : 'Please try again in a moment.',
        variant: 'destructive',
      })
    },
  })
}

export function useInviteAuditor() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: InviteAuditorPayload) =>
      api.post('/api/v1/settings/members/invite-auditor', payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['settings', 'members'] })
      qc.invalidateQueries({ queryKey: ['settings', 'members', 'seats'] })
    },
  })
}

/**
 * Effective invoicing access for the current user in the active company,
 * mirroring the server-side InvoicingGrantGuard so the UI only offers actions
 * the API will actually allow:
 *  - Owner/Admin/Finance: full (FULL_ACCESS_ROLES).
 *  - Auditor/Manager/Employee: from membership_grants on the active company
 *    (invoicing access_level + capabilities; reports separately).
 * Capability keys match the backend @RequireGrant decorators exactly
 * (`send`, `record_payment`, `manage_customers`).
 */
export function useInvoicingAccess() {
  const { currentUser } = useAuthStore()
  const role = currentUser?.role
  const full = role === 'OWNER' || role === 'HR_ADMIN' || role === 'FINANCE'
  const grantDriven = role === 'AUDITOR' || role === 'MANAGER' || role === 'EMPLOYEE'
  const companies = useMyCompanies(grantDriven)

  const grants =
    companies.data?.data.find((c) => c.tenantId === currentUser?.tenantId)?.grants ?? []
  const inv = grants.find((g) => g.module === 'invoicing')
  const reports = grants.find((g) => g.module === 'reports')
  const caps = inv?.capabilities ?? {}
  const level = full ? 'edit' : (inv?.access_level ?? 'none')
  const canEdit = level === 'edit'

  return {
    isLoading: grantDriven && companies.isLoading,
    canView: full || level === 'view' || level === 'edit',
    canEdit,
    canSend: canEdit && (full || caps.send === true),
    canRecordPayments: canEdit && (full || caps.record_payment === true),
    canManageCustomers: full || (canEdit && caps.manage_customers === true),
    canViewReports: full || (!!reports && reports.access_level !== 'none'),
  }
}

export function useUpdateGrants() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ membershipId, grants }: { membershipId: string; grants: InviteAuditorPayload['grants'] }) =>
      api.patch(`/api/v1/settings/members/${membershipId}/grants`, { grants }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['settings', 'members'] })
      qc.invalidateQueries({ queryKey: ['me', 'companies'] })
    },
  })
}
