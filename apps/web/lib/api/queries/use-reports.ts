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

// ─── Headcount report ────────────────────────────────────────────────────────

export interface HeadcountTotals {
  totalEverHired: number
  active: number
  onLeave: number
  noticePeriod: number
  separated: number
  joinedYtd: number
  exitedYtd: number
  netChangeYtd: number
}

export interface HeadcountMonthRow {
  month: string  // 'YYYY-MM'
  joined: number
  exited: number
  headcount: number
}

export interface HeadcountDeptRow {
  departmentId: string
  name: string
  headcount: number
}

export interface HeadcountLocationRow {
  locationId: string | null
  name: string
  headcount: number
}

export interface HeadcountEmpTypeRow {
  type: string
  headcount: number
}

export interface HeadcountReport {
  asOf: string
  year: number
  totals: HeadcountTotals
  monthlyTrend: HeadcountMonthRow[]
  byDepartment: HeadcountDeptRow[]
  byLocation: HeadcountLocationRow[]
  byEmploymentType: HeadcountEmpTypeRow[]
}

export function useHeadcountReport() {
  return useQuery({
    queryKey: ['reports', 'headcount'],
    queryFn: () => api.get<HeadcountReport>('/api/v1/reports/headcount'),
    staleTime: 60_000,
  })
}

// ─── Audit log ───────────────────────────────────────────────────────────────

export interface AuditLogEntry {
  id: string
  actorUserId: string | null
  actorName: string | null
  actorEmail: string | null
  action: string
  resourceType: string
  resourceId: string | null
  beforeState: Record<string, unknown> | null
  afterState: Record<string, unknown> | null
  ipAddress: string | null
  userAgent: string | null
  createdAt: string
}

export interface AuditSearchFilters {
  page?: number
  limit?: number
  resourceType?: string
  action?: string
  from?: string
  to?: string
}

export interface AuditSearchResult {
  data: AuditLogEntry[]
  pagination: {
    page: number
    limit: number
    total: number
  }
}

function auditQs(p: AuditSearchFilters): string {
  const parts: string[] = []
  if (p.page) parts.push(`page=${p.page}`)
  if (p.limit) parts.push(`limit=${p.limit}`)
  if (p.resourceType) parts.push(`resourceType=${encodeURIComponent(p.resourceType)}`)
  if (p.action) parts.push(`action=${encodeURIComponent(p.action)}`)
  if (p.from) parts.push(`from=${encodeURIComponent(p.from)}`)
  if (p.to) parts.push(`to=${encodeURIComponent(p.to)}`)
  return parts.length ? `?${parts.join('&')}` : ''
}

export function useAuditLog(filters: AuditSearchFilters = {}) {
  return useQuery({
    queryKey: ['audit', 'logs', filters],
    queryFn: () =>
      api.get<AuditSearchResult>(`/api/v1/audit/logs${auditQs(filters)}`),
    staleTime: 30_000,
  })
}
