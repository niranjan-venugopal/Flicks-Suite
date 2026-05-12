'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../client'

export interface Employee {
  id: string
  name: string
  email: string
  phone?: string
  designation?: string
  department?: string
  location?: string
  status: 'active' | 'inactive' | 'on_leave' | 'invited' | 'on_notice'
  avatarUrl?: string
  employeeCode?: string
  joinDate?: string
  reportingManager?: {
    id: string
    name: string
  }
  pan?: string
  bankAccount?: string
}

interface ApiEmployeeRow {
  id: string
  employeeCode: string | null
  status: string
  employmentType: string | null
  dateOfJoining: string | null
  departmentId: string | null
  departmentName: string | null
  locationId: string | null
  locationName: string | null
  reportingManagerId: string | null
  designationId: string | null
  userId: string | null
  fullName: string | null
  email: string | null
  avatarUrl: string | null
  createdAt: string
}

function adaptEmployee(row: ApiEmployeeRow): Employee {
  return {
    id: row.id,
    name: row.fullName ?? row.email ?? row.employeeCode ?? 'Unknown',
    email: row.email ?? '',
    status: (row.status as Employee['status']) ?? 'active',
    avatarUrl: row.avatarUrl ?? undefined,
    employeeCode: row.employeeCode ?? undefined,
    joinDate: row.dateOfJoining ?? undefined,
    department: row.departmentName ?? undefined,
    location: row.locationName ?? undefined,
  }
}

// Matches the server's InviteEmployeeDto exactly. fullName / email /
// employeeCode are required; the rest are filled in later via the employee's
// self-onboarding wizard (Sprint 2 #7).
export interface InviteEmployeePayload {
  fullName: string
  email: string
  employeeCode: string
  designationId?: string
  departmentId?: string
  locationId?: string
  managerId?: string
  employmentType?: string
  joiningDate?: string
}

interface EmployeesFilters {
  search?: string
  department?: string
  location?: string
  status?: string
  page?: number
  limit?: number
}

export function useEmployees(filters?: EmployeesFilters) {
  return useQuery({
    queryKey: ['employees', filters],
    queryFn: async () => {
      const params = new URLSearchParams()
      if (filters?.department) params.set('departmentId', filters.department)
      if (filters?.location) params.set('locationId', filters.location)
      if (filters?.status) params.set('status', filters.status)
      if (filters?.page) params.set('page', String(filters.page))
      if (filters?.limit) params.set('limit', String(filters.limit))
      const res = await api.get<{
        data: ApiEmployeeRow[]
        pagination: { page: number; limit: number; total: number }
      }>(`/api/v1/employees${params.toString() ? `?${params.toString()}` : ''}`)
      return {
        employees: res.data.map(adaptEmployee),
        total: res.pagination.total,
      }
    },
  })
}

export function useEmployee(id: string) {
  return useQuery({
    queryKey: ['employees', id],
    queryFn: () => api.get<Employee>(`/api/v1/employees/${id}`),
    enabled: !!id,
  })
}

export function useInviteEmployee() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (payload: InviteEmployeePayload) =>
      api.post<Employee>('/api/v1/employees/invite', payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['employees'] })
    },
  })
}

export function useUpdateEmployee() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ id, ...data }: Partial<Employee> & { id: string }) =>
      api.patch<Employee>(`/api/v1/employees/${id}`, data),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['employees', variables.id] })
      queryClient.invalidateQueries({ queryKey: ['employees'] })
    },
  })
}
