'use client'

import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { api } from '../client'

export interface AdminOverview {
  generatedAt: string
  stats: {
    totalEmployees: number
    presentToday: number
    onLeaveToday: number
    pendingApprovals: number
  }
  headcount: {
    active: number
    notice: number
    onLeave: number
    inactive: number
  }
  attendanceToday: {
    present: number
    late: number
    onLeave: number
    yetToClockIn: number
    holiday: number
  }
  pending: {
    leaveCount: number
    regularizationCount: number
    leaves: Array<{
      id: string
      employeeId: string
      userId: string | null
      employeeName: string
      employeeCode: string | null
      leaveTypeName: string | null
      leaveTypeCode: string | null
      startDate: string
      endDate: string
      totalDays: number
      reason: string | null
      appliedAt: string
    }>
    regularizations: Array<{
      id: string
      employeeId: string
      userId: string | null
      employeeName: string
      employeeCode: string | null
      attendanceDate: string
      requestType: string
      reason: string
      requestedAt: string
    }>
  }
  trends: {
    attendanceCompliancePct: number | null
    leaveDaysConsumed: number
    headcountDelta: { joiners: number; exits: number; net: number }
    avgWorkingHours: number | null
  }
}

export interface ActivityItem {
  id: string
  action: string
  resourceType: string | null
  resourceId: string | null
  actorUserId: string | null
  actorName: string | null
  metadata: Record<string, unknown> | null
  createdAt: string
}

export function useAdminOverview() {
  return useQuery({
    queryKey: ['dashboard', 'admin', 'overview'],
    queryFn: () => api.get<AdminOverview>('/api/v1/dashboard/admin/overview'),
    staleTime: 30_000,
  })
}

export function useAdminActivity(limit = 20) {
  return useInfiniteQuery({
    queryKey: ['dashboard', 'admin', 'activity', limit],
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams({ limit: String(limit) })
      if (pageParam) qs.set('before', pageParam)
      return api.get<ActivityItem[]>(
        `/api/v1/dashboard/admin/activity?${qs.toString()}`,
      )
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.length === limit ? lastPage[lastPage.length - 1]!.id : undefined,
    staleTime: 30_000,
  })
}
