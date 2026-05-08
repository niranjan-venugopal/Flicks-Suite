'use client'

import { useQuery } from '@tanstack/react-query'
import { api } from '../client'

export interface DashboardData {
  headcount: {
    total: number
    active: number
    onLeave: number
    newThisMonth: number
  }
  attendanceToday: {
    present: number
    absent: number
    late: number
    onLeave: number
    percentage: number
  }
  upcomingEvents: Array<{
    id: string
    title: string
    date: string
    type: 'birthday' | 'anniversary' | 'holiday' | 'event'
  }>
  trends: {
    attendanceCompliance: Array<{ date: string; value: number }>
    leaveConsumption: Array<{ date: string; value: number }>
    headcountChange: Array<{ date: string; value: number }>
  }
}

export interface PendingApproval {
  id: string
  type: 'leave' | 'attendance' | 'timesheet' | 'expense'
  title: string
  description: string
  requestedBy: {
    id: string
    name: string
    avatarUrl?: string
  }
  requestedAt: string
  priority: 'high' | 'medium' | 'low'
}

export interface ActivityItem {
  id: string
  type: string
  description: string
  actor: {
    id: string
    name: string
    avatarUrl?: string
  }
  timestamp: string
  metadata?: Record<string, unknown>
}

export function useDashboardData() {
  return useQuery({
    queryKey: ['dashboard', 'data'],
    queryFn: () => api.get<DashboardData>('/api/dashboard'),
    staleTime: 5 * 60 * 1000,
  })
}

export function usePendingApprovals() {
  return useQuery({
    queryKey: ['dashboard', 'pending-approvals'],
    queryFn: () => api.get<PendingApproval[]>('/api/dashboard/pending-approvals'),
    refetchInterval: 2 * 60 * 1000,
  })
}

export function useActivityFeed(limit = 20) {
  return useQuery({
    queryKey: ['dashboard', 'activity', limit],
    queryFn: () =>
      api.get<ActivityItem[]>(`/api/dashboard/activity?limit=${limit}`),
  })
}
