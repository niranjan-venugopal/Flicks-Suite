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
  city?: string
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
