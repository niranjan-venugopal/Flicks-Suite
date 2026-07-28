'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../client'
import { track, EVENTS } from '@/lib/analytics/posthog'

// ─── Wire types — match the API responses exactly ─────────────────────────────

export interface LeaveType {
  id: string
  name: string
  code: string
  description: string | null
  defaultQuotaDays: number
  isPaid: boolean
  allowHalfDay: boolean
  color: string | null
  displayOrder: number
}

export interface LeaveBalance {
  leaveTypeId: string
  leaveTypeName: string
  code: string
  color: string | null
  opening: number
  accrued: number
  used: number
  pending: number
  available: number
}

export interface LeaveBalancesResponse {
  leaveYear: number
  balances: LeaveBalance[]
}

export interface LeaveRequest {
  id: string
  leaveTypeId: string
  startDate: string
  endDate: string
  isHalfDay: boolean
  totalDays: number
  status: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'draft' | 'revoked'
  reason: string | null
  appliedAt: string
  leaveTypeName: string | null
  leaveTypeColor: string | null
}

export interface PendingLeaveRequest {
  id: string
  employeeId: string
  leaveTypeId: string
  startDate: string
  endDate: string
  totalDays: number
  reason: string | null
  appliedAt: string
  employeeName: string
  employeeCode: string
  leaveTypeName: string | null
  leaveTypeCode: string | null
}

export interface ApplyLeavePayload {
  leaveTypeId: string
  startDate: string
  endDate: string
  isHalfDay?: boolean
  halfDaySession?: 'first_half' | 'second_half'
  reason: string
  coverEmployeeId?: string
}

export interface PaginatedResponse<T> {
  data: T[]
  pagination: { page: number; limit: number; total: number }
}

// ─── Hooks ───────────────────────────────────────────────────────────────────

export function useLeaveTypes() {
  return useQuery({
    queryKey: ['leave', 'types'],
    queryFn: () =>
      api.get<{ data: LeaveType[]; total: number }>('/api/v1/leave/types'),
  })
}

export function useMyLeaveBalances() {
  return useQuery({
    queryKey: ['leave', 'me', 'balances'],
    queryFn: () =>
      api.get<LeaveBalancesResponse>('/api/v1/leave/me/balances'),
  })
}

export function useMyLeaveRequests(query?: { status?: string; page?: number }) {
  return useQuery({
    queryKey: ['leave', 'me', query],
    queryFn: () => {
      const params = new URLSearchParams()
      if (query?.status) params.set('status', query.status)
      if (query?.page) params.set('page', String(query.page))
      const qs = params.toString()
      return api.get<PaginatedResponse<LeaveRequest>>(
        `/api/v1/leave/me${qs ? `?${qs}` : ''}`,
      )
    },
  })
}

export function usePendingLeaveRequests() {
  return useQuery({
    queryKey: ['leave', 'pending'],
    queryFn: () =>
      api.get<PaginatedResponse<PendingLeaveRequest>>(
        '/api/v1/leave/pending',
      ),
  })
}

export function useHolidays(year?: number) {
  return useQuery({
    queryKey: ['leave', 'holidays', year ?? 'current'],
    queryFn: () =>
      api.get<{
        year: number
        holidays: Array<{
          id: string
          date: string
          name: string
          type: string
          description: string | null
        }>
      }>(`/api/v1/leave/holidays${year ? `?year=${year}` : ''}`),
  })
}

export function useApplyLeave() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: ApplyLeavePayload) =>
      api.post<LeaveRequest>('/api/v1/leave/apply', payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['leave'] })
      track(EVENTS.LEAVE_SUBMITTED)
    },
  })
}

export function useReviewLeave() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      id,
      action,
      comment,
    }: {
      id: string
      action: 'approve' | 'reject'
      comment?: string
    }) =>
      api.post<{ id: string; status: string; reviewedAt: string | null }>(
        `/api/v1/leave/${id}/review`,
        { action, comment },
      ),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['leave'] })
      track(EVENTS.LEAVE_REVIEWED, { action: vars.action })
    },
  })
}

export function useCancelLeave() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      api.post<{ id: string; status: string; cancelledAt: string | null }>(
        `/api/v1/leave/${id}/cancel`,
        { reason },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['leave'] })
    },
  })
}
