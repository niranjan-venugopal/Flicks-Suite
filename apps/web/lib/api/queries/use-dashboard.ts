'use client'

import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { api } from '../client'

// ─── Round L (B) — approval routing / escalation ─────────────────────────────
// Shared by the pending leave / regularization / timesheet rows here and by
// the Team → Leave / Team → Timesheets hooks. `null` = still with the
// reporting manager (level 0).
export type EscalationReason = 'sla' | 'reviewer_on_leave' | 'no_manager' | 'no_skip_manager'
export interface ApprovalEscalation {
  /** 0 = reporting manager · 1 = manager's manager · 2 = Owner + HR Admins */
  level: 0 | 1 | 2
  reason: EscalationReason | null
  /** ISO instant the item reached this level (the level-1 clock anchor). */
  at: string | null
  /** The level-1 manager it was escalated to, when known. */
  toName: string | null
}
/** `o.pending.timesheets[]` — the Inbox → Approvals timesheet kind. */
export interface PendingTimesheetRow {
  id: string
  employeeId: string
  userId: string | null
  employeeName: string
  employeeCode: string | null
  periodStart: string
  periodEnd: string
  totalHours: number
  totalBillableHours: number
  submittedAt: string | null
  avatarUrl: string | null
  escalation: ApprovalEscalation | null
}

export interface AdminOverview {
  generatedAt: string
  /**
   * Round I — `team`: every number is narrowed to the caller's direct
   * reports (managers). `org`: workspace-wide (owner / HR admin / finance).
   */
  scope?: 'org' | 'team'
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
  /**
   * Round L — from the day resolver on the tenant's "today". `present`
   * INCLUDES late arrivals (`late` is the subset); `yetToClockIn` =
   * expected ∧ no record ∧ no pending leave.
   */
  attendanceToday: {
    present: number
    late: number
    onLeave: number
    yetToClockIn: number
    holiday: number
    /** On their shift's non-working day. */
    weekend: number
    /** Expected, no record, a pending leave request covers today. */
    pendingLeave: number
    /** Everyone whose day is a working day (half-day leave included). */
    expectedToday: number
  }
  pending: {
    leaveCount: number
    regularizationCount: number
    // Admin+-only (empty for lower roles); never includes the caller's own row
    onboardingCount: number
    onboarding: Array<{
      employeeId: string
      userId: string | null
      employeeName: string
      employeeCode: string | null
      designationTitle: string | null
      avatarUrl: string | null
      submittedAt: string | null
    }>
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
      avatarUrl: string | null
      /** Round L (B) — absent until the dashboard integration lands. */
      escalation?: ApprovalEscalation | null
    }>
    regularizations: Array<{
      id: string
      employeeId: string
      userId: string | null
      employeeName: string
      employeeCode: string | null
      attendanceDate: string
      requestType: string
      /** Round K — ISO instants the reviewer is about to write into the day. */
      proposedInTime: string | null
      proposedOutTime: string | null
      reason: string
      requestedAt: string
      avatarUrl: string | null
      /** Round L (B) — absent until the dashboard integration lands. */
      escalation?: ApprovalEscalation | null
    }>
    // Round L (B) — timesheets join the queue (status 'submitted', routed to
    // the caller). Optional until the dashboard integration lands.
    timesheetCount?: number
    timesheets?: PendingTimesheetRow[]
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

/**
 * `pendingLimit` — how many pending leaves / regularizations the API LISTS
 * (counts are unaffected; the API clamps to 1..50, default 5). The dashboard
 * card keeps the default; the Inbox asks for 50 so every request it can act
 * on is reachable. Part of the query key so the two never share a cache row.
 */
export function useAdminOverview(enabled = true, opts?: { pendingLimit?: number }) {
  const pendingLimit = opts?.pendingLimit
  return useQuery({
    queryKey: ['dashboard', 'admin', 'overview', pendingLimit ?? null],
    // The route answers with `Cache-Control: private, max-age=15`. The Inbox
    // variant deep-links to requests that were filed seconds ago, so its
    // fetches carry a cache-buster and always reach the API (a request
    // header would force a CORS preflight on every read).
    queryFn: () =>
      api.get<AdminOverview>(
        `/api/v1/dashboard/admin/overview${pendingLimit ? `?pendingLimit=${pendingLimit}&_=${Date.now()}` : ''}`,
      ),
    staleTime: 30_000,
    // Round H: callers pass their role gate — guests (project-scoped seats)
    // are refused this route by the API's GuestScopeGuard, so don't ask.
    enabled,
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
