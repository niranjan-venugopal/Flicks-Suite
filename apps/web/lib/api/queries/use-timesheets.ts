'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../client'
import { track, EVENTS } from '@/lib/analytics/posthog'

// ─── API shapes ────────────────────────────────────────────────────────────

export interface TimesheetPeriod {
  id: string
  employeeId?: string
  employeeCode?: string
  employeeName?: string
  periodStart: string
  periodEnd: string
  status: 'draft' | 'submitted' | 'approved' | 'rejected' | 'rework_requested'
  totalHours: number
  totalBillableHours?: number
  submittedAt?: string
  rejectedAt?: string | null
  rejectionComment?: string | null
  latestReworkAt?: string | null
  latestReworkComment?: string | null
}

export interface TimesheetEntryRow {
  id: string
  entryDate: string
  hours: number
  category: string
  isBillable: boolean
  description: string | null
}

export interface BulkSaveEntriesPayload {
  timesheetPeriodId: string
  entries: Array<{
    entryDate: string
    hours: number
    category: string
    isBillable?: boolean
    description?: string
  }>
}

// ─── Hooks ─────────────────────────────────────────────────────────────────

export function useMyCurrentTimesheet() {
  return useQuery({
    queryKey: ['timesheet', 'me', 'current'],
    queryFn: () => api.get<TimesheetPeriod>('/api/v1/timesheet/me/current'),
  })
}

export function usePreviousWeekCategories() {
  return useMutation({
    mutationFn: () =>
      api.get<{ categories: string[] }>(
        '/api/v1/timesheet/me/previous-categories',
      ),
  })
}

export function useMyTimesheetPeriods(query?: { status?: string; page?: number }) {
  return useQuery({
    queryKey: ['timesheet', 'me', query],
    queryFn: () => {
      const p = new URLSearchParams()
      if (query?.status) p.set('status', query.status)
      if (query?.page) p.set('page', String(query.page))
      const qs = p.toString()
      return api.get<{ data: TimesheetPeriod[]; pagination: { page: number; limit: number; total: number } }>(
        `/api/v1/timesheet/me${qs ? `?${qs}` : ''}`,
      )
    },
  })
}

export function useTimesheetEntries(periodId: string | null) {
  return useQuery({
    queryKey: ['timesheet', 'entries', periodId],
    queryFn: () =>
      api.get<{ timesheetPeriodId: string; entries: TimesheetEntryRow[] }>(
        `/api/v1/timesheet/${periodId}/entries`,
      ),
    enabled: !!periodId,
  })
}

export function usePendingTimesheets() {
  return useQuery({
    queryKey: ['timesheet', 'pending'],
    queryFn: () =>
      api.get<{ data: TimesheetPeriod[]; pagination: { page: number; limit: number; total: number } }>(
        '/api/v1/timesheet/pending',
      ),
  })
}

export function useSaveTimesheetEntries() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: BulkSaveEntriesPayload) =>
      api.post<{ timesheetPeriodId: string; entryCount: number; totalHours: number }>(
        '/api/v1/timesheet/entries',
        payload,
      ),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['timesheet', 'entries', vars.timesheetPeriodId] })
      qc.invalidateQueries({ queryKey: ['timesheet', 'me'] })
    },
  })
}

export function useSubmitTimesheet() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (timesheetPeriodId: string) =>
      api.post<void>('/api/v1/timesheet/submit', { timesheetPeriodId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['timesheet'] })
      track(EVENTS.TIMESHEET_SUBMITTED)
    },
  })
}

export function useReviewTimesheet() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      periodId,
      action,
      comment,
    }: {
      periodId: string
      action: 'approve' | 'reject' | 'rework'
      comment?: string
    }) =>
      api.post<void>(`/api/v1/timesheet/${periodId}/review`, { action, comment }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['timesheet'] })
      track(EVENTS.TIMESHEET_REVIEWED, { action: vars.action })
    },
  })
}
