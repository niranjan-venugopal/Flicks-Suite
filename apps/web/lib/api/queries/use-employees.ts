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
  status: 'active' | 'inactive' | 'on_leave'
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

export interface InviteEmployeePayload {
  name: string
  email: string
  phone?: string
  designation: string
  department: string
  location: string
  employeeType: string
  joinDate: string
  reportingManagerId?: string
  salary?: number
  role: string
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
    queryFn: () => {
      const params = new URLSearchParams()
      if (filters?.search) params.set('search', filters.search)
      if (filters?.department) params.set('department', filters.department)
      if (filters?.location) params.set('location', filters.location)
      if (filters?.status) params.set('status', filters.status)
      if (filters?.page) params.set('page', String(filters.page))
      if (filters?.limit) params.set('limit', String(filters.limit))
      return api.get<{ employees: Employee[]; total: number }>(
        `/api/employees?${params.toString()}`
      )
    },
  })
}

export function useEmployee(id: string) {
  return useQuery({
    queryKey: ['employees', id],
    queryFn: () => api.get<Employee>(`/api/employees/${id}`),
    enabled: !!id,
  })
}

export function useInviteEmployee() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (payload: InviteEmployeePayload) =>
      api.post<Employee>('/api/employees/invite', payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['employees'] })
    },
  })
}

export function useUpdateEmployee() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ id, ...data }: Partial<Employee> & { id: string }) =>
      api.patch<Employee>(`/api/employees/${id}`, data),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['employees', variables.id] })
      queryClient.invalidateQueries({ queryKey: ['employees'] })
    },
  })
}
