'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../client'
import { track, EVENTS } from '@/lib/analytics/posthog'

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
  | 'on_duty'
  | 'comp_off'

export type PunchType = 'in' | 'out' | 'break_start' | 'break_end'

/** Where the day was worked — orthogonal to AttendanceStatus. */
export type WorkMode = 'office' | 'remote' | 'field'

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
  workMode: WorkMode | null
  /** Assigned office + its geofence (null when unassigned / no geofence set). */
  location: {
    id: string
    name: string | null
    geofenceLat: number | null
    geofenceLng: number | null
    geofenceRadiusM: number | null
  } | null
  /** The clock-in position, for the geofence strip. */
  lastPunchGeo: {
    lat: number
    lng: number
    accuracyM: number | null
    isWithinGeofence: boolean | null
  } | null
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
  isWithinGeofence: boolean | null
  workMode: WorkMode | null
  locationName: string | null
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
  workMode: WorkMode | null
  firstPunchInAt: string | null
  lastPunchOutAt: string | null
  totalWorkedMinutes: number | null
  isLate: boolean | null
  locationName: string | null
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

export function useMyAttendanceRange(
  query?: {
    fromDate?: string
    toDate?: string
    limit?: number
    page?: number
    status?: AttendanceStatus
  },
  opts?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: ['attendance', 'me', 'range', query],
    enabled: opts?.enabled ?? true,
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
    // The page bills itself as a live view — keep it fresh without a remount.
    refetchInterval: 60_000,
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

// Awaitable so mutations don't resolve until the today snapshot has been
// refetched — otherwise the calling component may re-render with the stale
// cached state before React Query's background refetch lands, leaving the
// Clock-In button on the wrong label even though the punch went through.
function invalidateAttendance(qc: ReturnType<typeof useQueryClient>) {
  return qc.invalidateQueries({ queryKey: ['attendance'] })
}

export function usePunchIn() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: PunchPayload = {}) =>
      api.post<PunchInResponse>('/api/v1/attendance/punch-in', payload),
    // Optimistic update — flip the today snapshot to 'clocked in' immediately
    // so the button label changes before the server round-trip completes.
    // Refetch in onSuccess reconciles with authoritative server state.
    //
    // Important: do NOT clear lastPunchOutAt. If the day is already complete
    // the backend will reject with 409, and we don't want the UI to flash a
    // false 'Clocked in' state in the meantime.
    onMutate: () => {
      const key = ['attendance', 'me', 'today']
      const prev = qc.getQueryData<TodayAttendance>(key)
      if (prev && !prev.lastPunchOutAt) {
        qc.setQueryData<TodayAttendance>(key, {
          ...prev,
          firstPunchInAt: prev.firstPunchInAt ?? new Date().toISOString(),
          attendanceStatus:
            prev.attendanceStatus === 'absent' ? 'present' : prev.attendanceStatus,
        })
      }
      return { prev }
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(['attendance', 'me', 'today'], ctx.prev)
    },
    onSuccess: async () => {
      track(EVENTS.ATTENDANCE_CLOCKED_IN)
      await invalidateAttendance(qc)
    },
  })
}

export function usePunchOut() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: PunchPayload = {}) =>
      api.post<PunchOutResponse>('/api/v1/attendance/punch-out', payload),
    onMutate: () => {
      const key = ['attendance', 'me', 'today']
      const prev = qc.getQueryData<TodayAttendance>(key)
      if (prev) {
        qc.setQueryData<TodayAttendance>(key, {
          ...prev,
          lastPunchOutAt: new Date().toISOString(),
        })
      }
      return { prev }
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(['attendance', 'me', 'today'], ctx.prev)
    },
    onSuccess: async () => {
      track(EVENTS.ATTENDANCE_CLOCKED_OUT)
      await invalidateAttendance(qc)
    },
  })
}

export function useBreakStart() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () =>
      api.post<{ id: string; punchedAt: string; type: 'break_start' }>(
        '/api/v1/attendance/break-start',
      ),
    onSuccess: async () => {
      await invalidateAttendance(qc)
    },
  })
}

export function useBreakEnd() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () =>
      api.post<{ id: string; punchedAt: string; type: 'break_end' }>(
        '/api/v1/attendance/break-end',
      ),
    onSuccess: async () => {
      await invalidateAttendance(qc)
    },
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
    onSuccess: async () => {
      await invalidateAttendance(qc)
    },
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
    onSuccess: async () => {
      await invalidateAttendance(qc)
    },
  })
}

// ─── Unified month view (calendar redesign) ────────────────────────────────

export interface AttendanceMonthDay {
  date: string
  attendanceStatus: AttendanceStatus | null
  isWeekend: boolean
  isHoliday: boolean
  holidayName: string | null
  firstPunchInAt: string | null
  lastPunchOutAt: string | null
  totalWorkedMinutes: number
  totalBreakMinutes: number
  isLate: boolean
  isRegularized: boolean
  regularization: { id: string; status: 'pending' | 'approved' | 'rejected' | 'cancelled'; requestType: string } | null
  punches: Array<{ id: string; punchType: string; punchedAt: string }>
}

export interface AttendanceMonthPayload {
  month: string
  days: AttendanceMonthDay[]
}

export function useMyAttendanceMonth(month: string) {
  return useQuery({
    queryKey: ['attendance', 'month', month],
    queryFn: () => api.get<AttendanceMonthPayload>(`/api/v1/attendance/me/month?month=${month}`),
    staleTime: 30_000,
  })
}
