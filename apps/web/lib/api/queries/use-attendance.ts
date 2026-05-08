'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../client'

export interface AttendanceEntry {
  id: string
  date: string
  checkIn?: string
  checkOut?: string
  breakStart?: string
  breakEnd?: string
  totalHours?: number
  status: 'present' | 'absent' | 'late' | 'on_leave' | 'holiday' | 'weekend'
  regularizationStatus?: 'pending' | 'approved' | 'rejected'
}

export function useTodayAttendance() {
  return useQuery({
    queryKey: ['attendance', 'today'],
    queryFn: () => api.get<AttendanceEntry>('/api/attendance/today'),
    refetchInterval: 60 * 1000,
  })
}

export function useMonthAttendance(year: number, month: number) {
  return useQuery({
    queryKey: ['attendance', 'month', year, month],
    queryFn: () =>
      api.get<AttendanceEntry[]>(`/api/attendance/month?year=${year}&month=${month}`),
  })
}

export function useTeamAttendance(date?: string) {
  return useQuery({
    queryKey: ['attendance', 'team', date ?? 'today'],
    queryFn: () =>
      api.get<Array<{ employee: { id: string; name: string; avatarUrl?: string }; status: string }>>(
        `/api/attendance/team${date ? `?date=${date}` : ''}`
      ),
  })
}

export function usePunchIn() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (data?: { note?: string }) =>
      api.post<AttendanceEntry>('/api/attendance/punch-in', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['attendance', 'today'] })
    },
  })
}

export function usePunchOut() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (data?: { note?: string }) =>
      api.post<AttendanceEntry>('/api/attendance/punch-out', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['attendance', 'today'] })
    },
  })
}

export function useRequestRegularization() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (data: {
      date: string
      checkIn?: string
      checkOut?: string
      reason: string
    }) => api.post<void>('/api/attendance/regularize', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['attendance'] })
    },
  })
}
