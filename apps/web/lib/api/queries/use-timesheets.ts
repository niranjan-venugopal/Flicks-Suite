'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../client'

export interface TimesheetEntry {
  id?: string
  categoryId: string
  categoryName: string
  entries: Record<string, number> // date -> hours
}

export interface TimesheetPeriod {
  weekStart: string
  weekEnd: string
  entries: TimesheetEntry[]
  status: 'draft' | 'submitted' | 'approved' | 'rejected'
  totalHours: number
  submittedAt?: string
}

export interface SaveEntriesPayload {
  weekStart: string
  entries: Array<{
    categoryId: string
    date: string
    hours: number
  }>
}

export function useTimesheetPeriod(weekStart: string) {
  return useQuery({
    queryKey: ['timesheets', 'period', weekStart],
    queryFn: () => api.get<TimesheetPeriod>(`/api/timesheets?weekStart=${weekStart}`),
    enabled: !!weekStart,
  })
}

export function usePendingTimesheets() {
  return useQuery({
    queryKey: ['timesheets', 'pending'],
    queryFn: () => api.get<TimesheetPeriod[]>('/api/timesheets/pending'),
  })
}

export function useSaveEntries() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (payload: SaveEntriesPayload) =>
      api.post<void>('/api/timesheets/entries', payload),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['timesheets', 'period', variables.weekStart] })
    },
  })
}

export function useSubmitTimesheet() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (weekStart: string) =>
      api.post<void>('/api/timesheets/submit', { weekStart }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['timesheets'] })
    },
  })
}

export function useApproveTimesheet() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({
      weekStart,
      employeeId,
      action,
    }: {
      weekStart: string
      employeeId: string
      action: 'approve' | 'reject'
    }) =>
      api.post<void>(`/api/timesheets/review`, { weekStart, employeeId, action }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['timesheets'] })
    },
  })
}
