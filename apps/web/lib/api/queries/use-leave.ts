'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../client'
import { track, EVENTS } from '@/lib/analytics/posthog'
import type { ApprovalEscalation } from './use-dashboard'

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
  // Round L — employee-facing routing: the level only, never a reason or a
  // name. 'hr' when there is no reporting manager (or after two escalations).
  escalation?: { level: 0 | 1 | 2 } | null
  withLabel?: 'manager' | 'hr'
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
  /** Round L — set once GET /leave/pending is routed (Phase 2). */
  escalation?: ApprovalEscalation | null
  routedToMe?: boolean
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

// ─── Round I — Team → Leave (Pending | Upcoming | History) ────────────────────
export interface TeamLeaveRequest {
  id: string
  employeeId: string
  employeeUserId: string | null
  employeeName: string
  employeeCode: string | null
  leaveTypeId: string
  leaveTypeName: string | null
  leaveTypeCode: string | null
  startDate: string
  endDate: string
  isHalfDay: boolean
  totalDays: number
  reason: string | null
  status: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'draft' | 'revoked'
  appliedAt: string
  approverId: string | null
  approverName: string | null
  approverComment: string | null
  approvedAt: string | null
  rejectedAt: string | null
  cancelledAt: string | null
  // Round L — routing chips (Team → Leave stays workspace-wide for
  // owner/admin; `routedToMe` says whether the row is in THEIR queue). All
  // optional until the leave service integration lands (Phase 2).
  routedToMe?: boolean
  managerName?: string | null
  escalation?: ApprovalEscalation | null
}
export interface TeamLeaveParams {
  status?: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'all'
  from?: string
  to?: string
  page?: number
  limit?: number
}
export function useTeamLeave(params: TeamLeaveParams, enabled = true) {
  return useQuery({
    queryKey: ['leave', 'team', params],
    queryFn: () => {
      const qs = new URLSearchParams()
      if (params.status) qs.set('status', params.status)
      if (params.from) qs.set('from', params.from)
      if (params.to) qs.set('to', params.to)
      if (params.page) qs.set('page', String(params.page))
      if (params.limit) qs.set('limit', String(params.limit))
      const s = qs.toString()
      return api.get<{
        data: TeamLeaveRequest[]
        pagination: { page: number; limit: number; total: number; totalPages: number }
        scope: 'org' | 'team'
      }>(`/api/v1/leave/team${s ? `?${s}` : ''}`)
    },
    enabled,
    placeholderData: (prev) => prev,
  })
}

export interface Holiday {
  id: string
  date: string
  name: string
  type: string
  description: string | null
  locationId: string | null
  locationName: string | null
  isRecurring: boolean
}

// Default scope = the caller's own location (company-wide + theirs).
// locationId: 'all' → everything (admin screens), 'company' → company-wide
// only, or a location uuid.
export function useHolidays(year?: number, locationId?: string) {
  const params = new URLSearchParams()
  if (year) params.set('year', String(year))
  if (locationId) params.set('locationId', locationId)
  const qs = params.toString()
  return useQuery({
    queryKey: ['leave', 'holidays', year ?? 'current', locationId ?? 'mine'],
    queryFn: () =>
      api.get<{ year: number; holidays: Holiday[] }>(
        `/api/v1/leave/holidays${qs ? `?${qs}` : ''}`,
      ),
  })
}

// ─── Holiday admin (Owner/HR) ────────────────────────────────────────────────

export interface CreateHolidayPayload {
  date: string
  name: string
  type?: string
  description?: string
  locationId?: string
  isRecurring?: boolean
}

const invalidateHolidays = (qc: ReturnType<typeof useQueryClient>) => {
  qc.invalidateQueries({ queryKey: ['leave', 'holidays'] })
  qc.invalidateQueries({ queryKey: ['calendar'] })
  qc.invalidateQueries({ queryKey: ['attendance'] })
}

export function useCreateHoliday() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: CreateHolidayPayload) =>
      api.post<Holiday>('/api/v1/leave/holidays', payload),
    onSuccess: () => invalidateHolidays(qc),
  })
}

export function useUpdateHoliday() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      id,
      ...payload
    }: Omit<Partial<CreateHolidayPayload>, 'locationId'> & {
      id: string
      // null = make company-wide again; undefined = unchanged
      locationId?: string | null
    }) => api.patch<Holiday>(`/api/v1/leave/holidays/${id}`, payload),
    onSuccess: () => invalidateHolidays(qc),
  })
}

export function useDeleteHoliday() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      api.delete<{ deleted: boolean }>(`/api/v1/leave/holidays/${id}`),
    onSuccess: () => invalidateHolidays(qc),
  })
}

export function useImportHolidays() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: {
      holidays: Array<{ date: string; name: string; type?: string; description?: string }>
      locationId?: string
    }) =>
      api.post<{ imported: number; skipped: number }>(
        '/api/v1/leave/holidays/import',
        payload,
      ),
    onSuccess: () => invalidateHolidays(qc),
  })
}

export function useHolidayPresets(country: string, year: number, enabled = true) {
  return useQuery({
    queryKey: ['leave', 'holiday-presets', country, year],
    queryFn: () =>
      api.get<{
        country: string
        year: number
        countries: Array<{ code: string; name: string }>
        holidays: Array<{ date: string; name: string; type: string; description?: string }>
      }>(`/api/v1/leave/holidays/presets?country=${country}&year=${year}`),
    enabled: enabled && !!country && !!year,
    staleTime: Infinity,
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
