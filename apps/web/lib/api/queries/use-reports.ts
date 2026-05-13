'use client'

import { useQuery } from '@tanstack/react-query'
import { api } from '../client'

// ─── Attendance report ──────────────────────────────────────────────────────

export interface AttendanceReportTotals {
  total: number
  present: number
  late: number
  absent: number
  onLeave: number
  workFromHome: number
  holiday: number
  weekend: number
}

export interface AttendanceComplianceStats {
  presentRate: number   // 0..1
  lateRate: number      // 0..1
  avgLateMinutes: number
}

export interface AttendanceDailyRow {
  date: string
  present: number
  late: number
  onLeave: number
  absent: number
  wfh: number
}

export interface AttendanceEmployeeRow {
  employeeId: string
  employeeCode: string | null
  name: string | null
  avatarUrl: string | null
  departmentName: string | null
  recordCount: number
  presentCount: number
  lateCount: number
  avgLateMinutes: number
  hoursWorked: number
  complianceRate: number  // 0..1
}

export interface AttendanceReport {
  range: { from: string; to: string; daysInRange: number }
  totals: AttendanceReportTotals
  compliance: AttendanceComplianceStats
  dailyTrend: AttendanceDailyRow[]
  byEmployee: AttendanceEmployeeRow[]
}

interface ReportFilters {
  from?: string
  to?: string
}

function qs(p: ReportFilters): string {
  const parts: string[] = []
  if (p.from) parts.push(`from=${encodeURIComponent(p.from)}`)
  if (p.to) parts.push(`to=${encodeURIComponent(p.to)}`)
  return parts.length ? `?${parts.join('&')}` : ''
}

export function useAttendanceReport(filters: ReportFilters = {}) {
  return useQuery({
    queryKey: ['reports', 'attendance', filters],
    queryFn: () =>
      api.get<AttendanceReport>(`/api/v1/reports/attendance${qs(filters)}`),
    staleTime: 60_000,
  })
}

// ─── Leave report ────────────────────────────────────────────────────────────

export interface LeaveReportTotals {
  requests: number
  pending: number
  approved: number
  rejected: number
  cancelled: number
  approvedDays: number
}

export interface LeaveTypeRow {
  leaveTypeId: string
  name: string
  code: string
  color: string | null
  approvedRequests: number
  approvedDays: number
  pendingRequests: number
}

export interface LeaveMonthlyRow {
  month: string  // 'YYYY-MM'
  days: number
}

export interface LeaveConsumerRow {
  employeeId: string
  name: string | null
  employeeCode: string | null
  avatarUrl: string | null
  departmentName: string | null
  approvedDays: number
  requestCount: number
}

export interface LeaveReport {
  range: { from: string; to: string }
  totals: LeaveReportTotals
  byType: LeaveTypeRow[]
  monthlyTrend: LeaveMonthlyRow[]
  topConsumers: LeaveConsumerRow[]
}

export function useLeaveReport(filters: ReportFilters = {}) {
  return useQuery({
    queryKey: ['reports', 'leave', filters],
    queryFn: () => api.get<LeaveReport>(`/api/v1/reports/leave${qs(filters)}`),
    staleTime: 60_000,
  })
}
