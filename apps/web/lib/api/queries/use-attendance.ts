'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../client'

// ─── Wire types — match the API exactly ──────────────────────────────────────

export type AttendanceStatus =
  | 'present'
  | 'absent'
  | 'half_day'
  | 'late'
  | 'on_leave'
  | 'holiday'
  | 'weekend'
  | 'work_from_home'

export type PunchType = 'in' | 'out' | 'break_start' | 'break_end'

export interface AttendanceRecord {
  id: string
  attendanceDate: string
  attendanceStatus: AttendanceStatus
  firstPunchInAt: string | null
  lastPunchOutAt: string | null
  totalWorkedMinutes: number
  totalBreakMinutes: number
  isLate: boolean
  lateByMinutes: number
  isRegularized: boolean
}

export interface TodayAttendance {
  employeeId: string
  attendanceDate: string
  attendanceStatus: AttendanceStatus
  firstPunchInAt: string | null
  lastPunchOutAt: string | null
  totalWorkedMinutes: number
  totalBreakMinutes: number
  isLate: boolean
  lateByMinutes: number
  isOnBreak: boolean
  lastPunchType: PunchType | null
  shift: {
    id: string
    name: string
    startTime: string
    endTime: string
    timezone: string
    gracePeriodMinutes: number
  }
  isWorkingDay: boolean
  /** Server's now() — use for timer reconciliation rather than client clock. */
  now: string
}

export interface PunchPayload {
  lat?: number
  lng?: number
  accuracy?: number
  locationId?: string
  notes?: string
}

export interface PunchInResponse {
  id: string
  attendanceRecordId: string
  attendanceDate: string
  punchedAt: string
  type: 'in'
  isLate: boolean
  lateByMinutes: number
  shiftStart: string
  shiftTimezone: string
}

export interface PunchOutResponse {
  id: string
  attendanceRecordId: string
  attendanceDate: string
  punchedAt: string
  type: 'out'
  totalWorkedMinutes: number
  totalBreakMinutes: number
  attendanceStatus: AttendanceStatus
  isEarlyDeparture: boolean
  earlyByMinutes: number
}

export interface TeamMemberToday {
  employeeId: string
  employeeName: string
  employeeCode: string
  recordId: string | null
  attendanceStatus: AttendanceStatus | null
  firstPunchInAt: string | null
  lastPunchOutAt: string | null
  totalWorkedMinutes: number | null
  isLate: boolean | null
}

export type RegularizationType =
  | 'missing_punch'
  | 'wrong_time'
  | 'wfh_request'
  | 'on_duty'
  | 'manual_override'

export interface RegularizationRequest {
  id: string
  attendanceDate: string
  requestType: RegularizationType
  status: 'pending' | 'approved' | 'rejected' | 'cancelled'
  reason: string
  proposedInTime: string | null
  proposedOutTime: string | null
}

export interface PendingRegularization {
  id: string
  employeeId: string
  attendanceDate: string
  requestType: RegularizationType
  proposedInTime: string | null
  proposedOutTime: string | null
  reason: string
  createdAt: string
  employeeName: string
  employeeCode: string
}

export interface PaginatedResponse<T> {
  data: T[]
  pagination: { page: number; limit: number; total: number }
}

// ─── Hooks ───────────────────────────────────────────────────────────────────

export function useMyAttendanceToday() {
  return useQuery({
    queryKey: ['attendance', 'me', 'today'],
    queryFn: () => api.get<TodayAttendance>('/api/v1/attendance/me/today'),
    // Refetch every 60s so the running timer stays accurate even if the
    // tab was backgrounded.
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  })
}

export function useMyAttendanceRange(query?: {
  fromDate?: string
  toDate?: string
  limit?: number
  page?: number
  status?: AttendanceStatus
}) {
  return useQuery({
    queryKey: ['attendance', 'me', 'range', query],
    queryFn: () => {
      const params = new URLSearchParams()
      if (query?.fromDate) params.set('fromDate', query.fromDate)
      if (query?.toDate) params.set('toDate', query.toDate)
      if (query?.limit) params.set('limit', String(query.limit))
      if (query?.page) params.set('page', String(query.page))
      if (query?.status) params.set('status', query.status)
      const qs = params.toString()
      return api.get<PaginatedResponse<AttendanceRecord>>(
        `/api/v1/attendance/me${qs ? `?${qs}` : ''}`,
      )
    },
  })
}

export function useTeamToday() {
  return useQuery({
    queryKey: ['attendance', 'team', 'today'],
    queryFn: () =>
      api.get<TeamMemberToday[]>('/api/v1/attendance/team/today'),
  })
}

export function usePendingRegularizations() {
  return useQuery({
    queryKey: ['attendance', 'regularizations', 'pending'],
    queryFn: () =>
      api.get<PaginatedResponse<PendingRegularization>>(
        '/api/v1/attendance/regularizations/pending',
      ),
  })
}

// ─── Mutations ───────────────────────────────────────────────────────────────

function invalidateAttendance(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ['attendance'] })
}

export function usePunchIn() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: PunchPayload = {}) =>
      api.post<PunchInResponse>('/api/v1/attendance/punch-in', payload),
    onSuccess: () => invalidateAttendance(qc),
  })
}

export function usePunchOut() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: PunchPayload = {}) =>
      api.post<PunchOutResponse>('/api/v1/attendance/punch-out', payload),
    onSuccess: () => invalidateAttendance(qc),
  })
}

export function useBreakStart() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () =>
      api.post<{ id: string; punchedAt: string; type: 'break_start' }>(
        '/api/v1/attendance/break-start',
      ),
    onSuccess: () => invalidateAttendance(qc),
  })
}

export function useBreakEnd() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () =>
      api.post<{ id: string; punchedAt: string; type: 'break_end' }>(
        '/api/v1/attendance/break-end',
      ),
    onSuccess: () => invalidateAttendance(qc),
  })
}

export function useRequestRegularization() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: {
      attendanceDate: string
      requestType: RegularizationType
      proposedInTime?: string
      proposedOutTime?: string
      reason: string
    }) =>
      api.post<RegularizationRequest>(
        '/api/v1/attendance/regularizations',
        payload,
      ),
    onSuccess: () => invalidateAttendance(qc),
  })
}

export function useReviewRegularization() {
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
        `/api/v1/attendance/regularizations/${id}/review`,
        { action, comment },
      ),
    onSuccess: () => invalidateAttendance(qc),
  })
}
