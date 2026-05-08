'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../client'

export interface LeaveBalance {
  leaveType: string
  leaveTypeId: string
  total: number
  used: number
  pending: number
  available: number
}

export interface LeaveRequest {
  id: string
  leaveType: string
  startDate: string
  endDate: string
  days: number
  halfDay?: 'first_half' | 'second_half'
  reason?: string
  status: 'pending' | 'approved' | 'rejected' | 'cancelled'
  appliedAt: string
  approvedBy?: { id: string; name: string }
  coverPerson?: { id: string; name: string }
}

export interface ApplyLeavePayload {
  leaveTypeId: string
  startDate: string
  endDate: string
  halfDay?: 'first_half' | 'second_half'
  reason?: string
  coverPersonId?: string
}

export function useLeaveBalances(employeeId?: string) {
  return useQuery({
    queryKey: ['leave', 'balances', employeeId ?? 'me'],
    queryFn: () =>
      api.get<LeaveBalance[]>(
        employeeId ? `/api/leave/balances/${employeeId}` : '/api/leave/balances'
      ),
  })
}

export function useLeaveRequests(filters?: {
  status?: string
  startDate?: string
  endDate?: string
  employeeId?: string
}) {
  return useQuery({
    queryKey: ['leave', 'requests', filters],
    queryFn: () => {
      const params = new URLSearchParams()
      if (filters?.status) params.set('status', filters.status)
      if (filters?.startDate) params.set('startDate', filters.startDate)
      if (filters?.endDate) params.set('endDate', filters.endDate)
      if (filters?.employeeId) params.set('employeeId', filters.employeeId)
      return api.get<LeaveRequest[]>(`/api/leave/requests?${params.toString()}`)
    },
  })
}

export function useTeamLeaveCalendar(month: number, year: number) {
  return useQuery({
    queryKey: ['leave', 'team-calendar', year, month],
    queryFn: () =>
      api.get<LeaveRequest[]>(`/api/leave/team-calendar?month=${month}&year=${year}`),
  })
}

export function useApplyLeave() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (payload: ApplyLeavePayload) =>
      api.post<LeaveRequest>('/api/leave/apply', payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['leave'] })
    },
  })
}

export function useApproveLeave() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ id, action, comment }: { id: string; action: 'approve' | 'reject'; comment?: string }) =>
      api.post<LeaveRequest>(`/api/leave/requests/${id}/${action}`, { comment }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['leave'] })
    },
  })
}
