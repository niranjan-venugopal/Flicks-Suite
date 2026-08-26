'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../client'

// ─── Organization (tenant profile) ───────────────────────────────────────────

export interface OrganizationCounts {
  locations: number
  departments: number
  activeMembers: number
}

export interface Organization {
  id: string
  name: string
  slug: string
  legalName: string | null
  gstin: string | null
  pan: string | null
  cin: string | null
  industry: string | null
  sizeBand: string | null
  countryCode: string
  stateCode: string | null
  city: string | null
  addressLine1: string | null
  addressLine2: string | null
  postalCode: string | null
  timezone: string
  currency: string
  fiscalYearStartMonth: number
  dateFormat: string
  logoUrl: string | null
  brandColor: string | null
  status: 'trialing' | 'active' | 'suspended' | 'cancelled'
  trialEndsAt: string | null
  verifiedAt: string | null
  createdAt: string
  counts: OrganizationCounts
}

export interface UpdateOrganizationPayload {
  name?: string
  legalName?: string
  gstin?: string
  pan?: string
  cin?: string
  industry?: string
  sizeBand?: string
  addressLine1?: string
  addressLine2?: string
  city?: string
  countryCode?: string
  stateCode?: string
  postalCode?: string
}

export function useOrganization() {
  return useQuery({
    queryKey: ['settings', 'organization'],
    queryFn: () => api.get<Organization>('/api/v1/settings/organization'),
    staleTime: 60_000,
  })
}

export function useUpdateOrganization() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (payload: UpdateOrganizationPayload) =>
      api.patch<Organization>('/api/v1/settings/organization', payload),
    onSuccess: (data) => {
      queryClient.setQueryData(['settings', 'organization'], data)
      // The Topbar workspace pill reads tenant name from auth/me, refresh it too.
      queryClient.invalidateQueries({ queryKey: ['auth', 'me'] })
    },
  })
}

// ─── Departments ─────────────────────────────────────────────────────────────

export interface Department {
  id: string
  name: string
  code: string | null
  parentId: string | null
  headEmployeeId: string | null
  description: string | null
  isActive: boolean
  createdAt: string
  headcount: number
}

export interface CreateDepartmentPayload {
  name: string
  code?: string
  parentId?: string
  headEmployeeId?: string
  description?: string
}

export interface UpdateDepartmentPayload {
  name?: string
  headEmployeeId?: string
  description?: string
  isActive?: boolean
}

export function useDepartments() {
  return useQuery({
    queryKey: ['settings', 'departments'],
    queryFn: () =>
      api.get<{ data: Department[]; total: number }>(
        '/api/v1/settings/departments',
      ),
    staleTime: 30_000,
  })
}

export function useCreateDepartment() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: CreateDepartmentPayload) =>
      api.post<Department>('/api/v1/settings/departments', payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['settings', 'departments'] })
      qc.invalidateQueries({ queryKey: ['settings', 'organization'] })
    },
  })
}

export function useUpdateDepartment() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      id,
      payload,
    }: {
      id: string
      payload: UpdateDepartmentPayload
    }) =>
      api.put<Department>(`/api/v1/settings/departments/${id}`, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['settings', 'departments'] })
      qc.invalidateQueries({ queryKey: ['settings', 'organization'] })
    },
  })
}

// ─── Locations ───────────────────────────────────────────────────────────────

export interface Location {
  id: string
  name: string
  addressLine1: string | null
  addressLine2: string | null
  city: string | null
  stateCode: string | null
  postalCode: string | null
  countryCode: string
  timezone: string
  geofenceLat: string | null
  geofenceLng: string | null
  geofenceRadiusM: number | null
  ipAllowlist: string[] | null
  isActive: boolean
  createdAt: string
  headcount: number
}

export interface CreateLocationPayload {
  name: string
  addressLine1?: string
  addressLine2?: string
  city?: string
  stateCode?: string
  postalCode?: string
  countryCode?: string
  timezone?: string
}

export interface UpdateLocationPayload {
  name?: string
  addressLine1?: string
  addressLine2?: string
  city?: string
  // '' clears the stored state (country switches)
  stateCode?: string
  countryCode?: string
  timezone?: string
  postalCode?: string
  isActive?: boolean
}

export function useLocations() {
  return useQuery({
    queryKey: ['settings', 'locations'],
    queryFn: () =>
      api.get<{ data: Location[]; total: number }>(
        '/api/v1/settings/locations',
      ),
    staleTime: 30_000,
  })
}

export function useCreateLocation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: CreateLocationPayload) =>
      api.post<Location>('/api/v1/settings/locations', payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['settings', 'locations'] })
      qc.invalidateQueries({ queryKey: ['settings', 'organization'] })
    },
  })
}

export function useUpdateLocation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      id,
      payload,
    }: {
      id: string
      payload: UpdateLocationPayload
    }) => api.put<Location>(`/api/v1/settings/locations/${id}`, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['settings', 'locations'] })
      qc.invalidateQueries({ queryKey: ['settings', 'organization'] })
    },
  })
}

export interface LocationDeletePreview {
  id: string
  name: string
  isActive: boolean
  employees: number
  holidays: number
  otherLocations: Array<{ id: string; name: string; city: string | null }>
}

// Impact preview for the delete dialog — fetched when the dialog opens.
export function useLocationDeletePreview(id: string | null) {
  return useQuery({
    queryKey: ['settings', 'locations', 'delete-preview', id],
    queryFn: () =>
      api.get<LocationDeletePreview>(
        `/api/v1/settings/locations/${id}/delete-preview`,
      ),
    enabled: !!id,
    staleTime: 0,
  })
}

export function useDeleteLocation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, transferTo }: { id: string; transferTo?: string }) =>
      api.delete<{ deleted: boolean; movedEmployees: number; deletedHolidays: number }>(
        `/api/v1/settings/locations/${id}${transferTo ? `?transferTo=${transferTo}` : ''}`,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['settings', 'locations'] })
      qc.invalidateQueries({ queryKey: ['settings', 'organization'] })
      // Transferred employees + removed holidays change these trees too.
      qc.invalidateQueries({ queryKey: ['leave', 'holidays'] })
      qc.invalidateQueries({ queryKey: ['employees'] })
    },
  })
}

// ─── Designations ────────────────────────────────────────────────────────────

export interface Designation {
  id: string
  title: string
  level: number | null
  departmentId: string | null
  departmentName: string | null
  isActive: boolean
  createdAt: string
  headcount: number
}

export interface CreateDesignationPayload {
  title: string
  level?: number
  departmentId?: string
}

export interface UpdateDesignationPayload {
  title?: string
  level?: number
  departmentId?: string
  isActive?: boolean
}

export function useDesignations() {
  return useQuery({
    queryKey: ['settings', 'designations'],
    queryFn: () =>
      api.get<{ data: Designation[]; total: number }>(
        '/api/v1/settings/designations',
      ),
    staleTime: 30_000,
  })
}

export function useCreateDesignation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: CreateDesignationPayload) =>
      api.post<Designation>('/api/v1/settings/designations', payload),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['settings', 'designations'] }),
  })
}

export function useUpdateDesignation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      id,
      payload,
    }: {
      id: string
      payload: UpdateDesignationPayload
    }) =>
      api.put<Designation>(`/api/v1/settings/designations/${id}`, payload),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['settings', 'designations'] }),
  })
}

// ─── Shift templates (working hours) ─────────────────────────────────────────

export interface ShiftTemplate {
  id: string
  name: string
  description: string | null
  startTime: string  // 'HH:MM'
  endTime: string    // 'HH:MM'
  isOvernight: boolean
  breakMinutes: number
  breakPaid: boolean
  workingDays: number[]  // 0=Sun..6=Sat
  timezone: string
  gracePeriodMinutes: number
  halfDayThresholdMinutes: number
  fullDayThresholdMinutes: number
  isDefault: boolean
  isActive: boolean
  createdAt: string
  assigned: number
}

export interface CreateShiftTemplatePayload {
  name: string
  description?: string
  startTime: string
  endTime: string
  isOvernight?: boolean
  breakMinutes?: number
  breakPaid?: boolean
  workingDays: number[]
  timezone?: string
  gracePeriodMinutes?: number
  isDefault?: boolean
}

export interface UpdateShiftTemplatePayload {
  name?: string
  description?: string
  startTime?: string
  endTime?: string
  breakMinutes?: number
  workingDays?: number[]
  gracePeriodMinutes?: number
  isDefault?: boolean
  isActive?: boolean
}

export function useShifts() {
  return useQuery({
    queryKey: ['settings', 'shifts'],
    queryFn: () =>
      api.get<{ data: ShiftTemplate[]; total: number }>('/api/v1/settings/shifts'),
    staleTime: 30_000,
  })
}

export function useCreateShift() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: CreateShiftTemplatePayload) =>
      api.post<ShiftTemplate>('/api/v1/settings/shifts', payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings', 'shifts'] }),
  })
}

export function useUpdateShift() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      id,
      payload,
    }: {
      id: string
      payload: UpdateShiftTemplatePayload
    }) => api.put<ShiftTemplate>(`/api/v1/settings/shifts/${id}`, payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings', 'shifts'] }),
  })
}

// ─── Leave policies ──────────────────────────────────────────────────────────

export type LeaveAccrualMethod =
  | 'none'
  | 'monthly'
  | 'quarterly'
  | 'annually'
  | 'per_working_day'

export interface LeavePolicy {
  id: string
  name: string
  code: string
  description: string | null
  defaultQuotaDays: number
  accrualMethod: LeaveAccrualMethod
  carryForwardAllowed: boolean
  maxCarryForwardDays: number
  encashable: boolean
  isPaid: boolean
  isLop: boolean
  allowHalfDay: boolean
  minNoticeDays: number
  color: string | null
  displayOrder: number
  isActive: boolean
  approvedYtd: number
}

export interface CreateLeavePolicyPayload {
  name: string
  code: string
  description?: string
  defaultQuotaDays: number
  accrualMethod?: LeaveAccrualMethod
  carryForwardAllowed?: boolean
  maxCarryForwardDays?: number
  encashable?: boolean
  isPaid?: boolean
  isLop?: boolean
  allowHalfDay?: boolean
  minNoticeDays?: number
  color?: string
}

export interface UpdateLeavePolicyPayload {
  name?: string
  description?: string
  defaultQuotaDays?: number
  accrualMethod?: LeaveAccrualMethod
  carryForwardAllowed?: boolean
  maxCarryForwardDays?: number
  encashable?: boolean
  isPaid?: boolean
  allowHalfDay?: boolean
  minNoticeDays?: number
  color?: string
  isActive?: boolean
}

export function useLeavePolicies() {
  return useQuery({
    queryKey: ['settings', 'leave-policies'],
    queryFn: () =>
      api.get<{ data: LeavePolicy[]; total: number }>(
        '/api/v1/settings/leave-policies',
      ),
    staleTime: 30_000,
  })
}

export function useCreateLeavePolicy() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: CreateLeavePolicyPayload) =>
      api.post<LeavePolicy>('/api/v1/settings/leave-policies', payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['settings', 'leave-policies'] })
      // The Apply Leave dialog reads from leave types; refresh too.
      qc.invalidateQueries({ queryKey: ['leave', 'types'] })
    },
  })
}

export function useUpdateLeavePolicy() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      id,
      payload,
    }: {
      id: string
      payload: UpdateLeavePolicyPayload
    }) =>
      api.put<LeavePolicy>(`/api/v1/settings/leave-policies/${id}`, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['settings', 'leave-policies'] })
      qc.invalidateQueries({ queryKey: ['leave', 'types'] })
    },
  })
}

// ─── Members (memberships / workspace access) ────────────────────────────────

export type MembershipRole =
  | 'fam'
  | 'super_admin' // legacy alias for pre-0004 rows
  | 'owner'
  | 'admin'
  | 'manager'
  | 'finance'
  | 'employee'
  | 'auditor'
  // Round 7 project-scoped external seat. Guests DO appear in the members
  // list, so the union has to admit them.
  | 'guest'

export type MembershipStatus = 'invited' | 'active' | 'deactivated'

export interface Member {
  id: string
  userId: string
  employeeId: string | null
  role: MembershipRole
  status: MembershipStatus
  // Auditor metadata (Invoicing v3 Sprint 8)
  isExternal: boolean
  accessExpiresAt: string | null
  grants: { module: string; access_level: string; capabilities: Record<string, boolean> }[]
  invitedAt: string | null
  acceptedAt: string | null
  createdAt: string
  email: string | null
  fullName: string | null
  avatarUrl: string | null
  employeeCode: string | null
  firstName: string | null
  lastName: string | null
  departmentId: string | null
  departmentName: string | null
  designationTitle: string | null
}

export function useMembers() {
  return useQuery({
    queryKey: ['settings', 'members'],
    queryFn: () =>
      api.get<{ data: Member[]; total: number }>('/api/v1/settings/members'),
    staleTime: 30_000,
  })
}

export function useUpdateMemberRole() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, role }: { id: string; role: MembershipRole }) =>
      api.patch<Member>(`/api/v1/settings/members/${id}/role`, { role }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['settings', 'members'] })
      qc.invalidateQueries({ queryKey: ['auth', 'me'] })
    },
  })
}

export function useDeactivateMember() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      api.post<Member>(`/api/v1/settings/members/${id}/deactivate`),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['settings', 'members'] }),
  })
}

export function useReactivateMember() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      api.post<Member>(`/api/v1/settings/members/${id}/reactivate`),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['settings', 'members'] }),
  })
}
