'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../client'
import { track, EVENTS } from '@/lib/analytics/posthog'
import type { ApprovalEscalation } from './use-dashboard'

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
  /**
   * Round L — null while the period is still with the reporting manager.
   * Employee-facing rows (me/current, me, entries) carry the level only;
   * reviewer rows (pending) carry reason / at / toName too.
   */
  escalation?: (Pick<ApprovalEscalation, 'level'> & Partial<ApprovalEscalation>) | null
  /** Round L — employee-facing: who the week is with ('hr' = no reporting manager). */
  withLabel?: 'manager' | 'hr'
  /** Round L — GET /timesheet/pending rows are always routed to the caller. */
  routedToMe?: boolean
}

/** Round L — POST /timesheet/submit. */
export interface SubmitTimesheetResponse {
  id: string
  status: 'submitted'
  submittedAt: string
  escalation: { level: 0 | 1 | 2 } | null
  withLabel: 'manager' | 'hr'
}

export interface TimesheetEntryRow {
  id: string
  entryDate: string
  hours: number
  category: string
  isBillable: boolean
  description: string | null
  projectId: string | null
  taskId: string | null
}

export interface BulkSaveEntriesPayload {
  timesheetPeriodId: string
  entries: Array<{
    entryDate: string
    hours: number
    category: string
    isBillable?: boolean
    description?: string
    projectId?: string
    taskId?: string
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

// ─── Round I — Team → Timesheets (Pending review | All periods) ───────────────
export interface TeamTimesheetPeriod {
  id: string
  employeeId: string
  employeeUserId: string | null
  employeeCode: string | null
  employeeName: string
  periodStart: string
  periodEnd: string
  status: 'draft' | 'submitted' | 'approved' | 'rejected' | 'locked'
  totalHours: number
  totalBillableHours: number
  submittedAt: string | null
  approverId: string | null
  approverName: string | null
  approvedAt: string | null
  rejectedAt: string | null
  rejectionComment: string | null
  updatedAt: string
  // Round L — Team → Timesheets stays workspace-wide for owner/admin (the
  // "open directly" surface); `routedToMe` says whether the row is in THEIR
  // queue, `managerName` feeds the "With <manager>" chip.
  routedToMe: boolean
  managerName: string | null
  escalation: ApprovalEscalation | null
}
export interface TeamTimesheetParams {
  status?: 'draft' | 'submitted' | 'approved' | 'rejected' | 'locked' | 'all'
  page?: number
  limit?: number
}
export function useTeamTimesheets(params: TeamTimesheetParams, enabled = true) {
  return useQuery({
    queryKey: ['timesheet', 'team', params],
    queryFn: () => {
      const qs = new URLSearchParams()
      if (params.status) qs.set('status', params.status)
      if (params.page) qs.set('page', String(params.page))
      if (params.limit) qs.set('limit', String(params.limit))
      const s = qs.toString()
      return api.get<{
        data: TeamTimesheetPeriod[]
        pagination: { page: number; limit: number; total: number; totalPages: number }
        scope: 'org' | 'team'
      }>(`/api/v1/timesheet/team${s ? `?${s}` : ''}`)
    },
    enabled,
    placeholderData: (prev) => prev,
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
      api.post<SubmitTimesheetResponse>('/api/v1/timesheet/submit', { timesheetPeriodId }),
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
