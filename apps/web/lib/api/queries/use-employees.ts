'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../client'
import { track, EVENTS } from '@/lib/analytics/posthog'

/** The `employees.status` enum exactly as the API stores it. */
export type EmployeeRawStatus =
  | 'active'
  | 'inactive'
  | 'on_leave'
  | 'notice_period'
  | 'separated'
  | 'absconded'

/** Workspace seat state (memberships.status) — null when no seat exists. */
export type MembershipStatus = 'invited' | 'active' | 'deactivated' | null

/**
 * Round P (R1.3) — what the directory actually shows. `inactive` on its own
 * says nothing useful: it covers "never opened the invite", "stopped halfway
 * through the wizard", "submitted and waiting on HR" and "seat deactivated".
 * Derived on the client from the three fields the API now carries
 * (membershipStatus / onboardingStep / onboardingSubmitted) so the list, the
 * 360 header and the filters all agree.
 */
export type EmployeeUiStatus =
  | 'invited'
  | 'onboarding'
  | 'submitted'
  | 'active'
  | 'on_leave'
  | 'notice_period'
  | 'separated'
  | 'absconded'
  | 'no_access'

export const UI_STATUS_LABELS: Record<EmployeeUiStatus, string> = {
  invited: 'Invited',
  onboarding: 'Onboarding',
  submitted: 'Awaiting approval',
  active: 'Active',
  on_leave: 'On leave',
  notice_period: 'Notice period',
  separated: 'Separated',
  absconded: 'Absconded',
  no_access: 'No access',
}

/** Rows that still owe us an accepted invite — the only ones Resend applies to. */
export function isPendingInvite(uiStatus: EmployeeUiStatus): boolean {
  return uiStatus === 'invited' || uiStatus === 'onboarding'
}

/**
 * Plan R1.3 order, exactly: inactive + submitted → Awaiting approval;
 * inactive + (seat active OR step > 0) → Onboarding; inactive + seat
 * deactivated → No access; inactive otherwise → Invited; every other enum
 * value maps 1:1. Tolerates an older API that doesn't send the three fields
 * yet (they read as null/0/false → Invited), so nothing breaks mid-deploy.
 */
export function deriveUiStatus(row: {
  status: string | null | undefined
  membershipStatus?: MembershipStatus | undefined
  onboardingStep?: number | null | undefined
  onboardingSubmitted?: boolean | null | undefined
}): EmployeeUiStatus {
  const raw = (row.status ?? 'active') as EmployeeRawStatus
  if (raw !== 'inactive') {
    return (raw in UI_STATUS_LABELS ? raw : 'active') as EmployeeUiStatus
  }
  if (row.onboardingSubmitted) return 'submitted'
  if (row.membershipStatus === 'active' || (row.onboardingStep ?? 0) > 0) return 'onboarding'
  if (row.membershipStatus === 'deactivated') return 'no_access'
  return 'invited'
}

export interface Employee {
  id: string
  name: string
  email: string
  phone?: string
  designation?: string
  department?: string
  location?: string
  /** The API's own enum (same as `rawStatus`) — kept for existing callers. */
  status: EmployeeRawStatus
  rawStatus: EmployeeRawStatus
  /** What the directory shows — see deriveUiStatus. */
  uiStatus: EmployeeUiStatus
  membershipStatus: MembershipStatus
  onboardingStep: number
  onboardingSubmitted: boolean
  avatarUrl?: string
  userId?: string | null
  employeeCode?: string
  joinDate?: string
  reportingManager?: {
    id: string
    name: string
  }
  pan?: string
  bankAccount?: string
}

interface ApiEmployeeRow {
  id: string
  employeeCode: string | null
  status: string
  employmentType: string | null
  dateOfJoining: string | null
  departmentId: string | null
  departmentName: string | null
  locationId: string | null
  locationName: string | null
  reportingManagerId: string | null
  designationId: string | null
  userId: string | null
  fullName: string | null
  email: string | null
  avatarUrl: string | null
  createdAt: string
  // Round P (R1.3 / contract C4) — optional only so an API that predates the
  // fields still adapts cleanly.
  membershipStatus?: MembershipStatus
  onboardingStep?: number | null
  onboardingSubmitted?: boolean | null
}

function adaptEmployee(row: ApiEmployeeRow): Employee {
  const rawStatus = (row.status as EmployeeRawStatus) ?? 'active'
  return {
    id: row.id,
    name: row.fullName ?? row.email ?? row.employeeCode ?? 'Unknown',
    email: row.email ?? '',
    status: rawStatus,
    rawStatus,
    uiStatus: deriveUiStatus(row),
    membershipStatus: row.membershipStatus ?? null,
    onboardingStep: row.onboardingStep ?? 0,
    onboardingSubmitted: row.onboardingSubmitted ?? false,
    avatarUrl: row.avatarUrl ?? undefined,
    userId: row.userId,
    employeeCode: row.employeeCode ?? undefined,
    joinDate: row.dateOfJoining ?? undefined,
    department: row.departmentName ?? undefined,
    location: row.locationName ?? undefined,
  }
}

// Matches the server's InviteEmployeeDto exactly. fullName / email /
// employeeCode are required; the rest are filled in later via the employee's
// self-onboarding wizard (Sprint 2 #7), though the admin can pre-fill
// personal phone / DOB / job title here too so the invitee doesn't have
// to retype them.
export interface InviteEmployeePayload {
  fullName: string
  email: string
  employeeCode: string
  jobTitle?: string
  designationId?: string
  departmentId?: string
  locationId?: string
  managerId?: string
  shiftTemplateId?: string
  employmentType?: string
  joiningDate?: string
  personalPhone?: string
  dateOfBirth?: string
  probationEndDate?: string
  noticePeriodDays?: number
}

interface EmployeesFilters {
  search?: string
  department?: string
  location?: string
  status?: string
  /** true = the directory's Removed view (round 21). */
  removed?: boolean
  page?: number
  /** Defaults to 100 — the API's hard cap (contract C4). */
  limit?: number
}

/** The API caps page size here; asking for more silently returns 100. */
export const EMPLOYEES_PAGE_MAX = 100

/**
 * GET /employees is manager-or-above; a page that only needs the roster to
 * power an admin-only action passes `enabled: false` for other viewers so
 * they don't collect a 403 (and an authz.denied audit row) just for opening it.
 */
export function useEmployees(filters?: EmployeesFilters, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ['employees', filters],
    enabled: options?.enabled ?? true,
    queryFn: async () => {
      const params = new URLSearchParams()
      if (filters?.department) params.set('departmentId', filters.department)
      if (filters?.location) params.set('locationId', filters.location)
      if (filters?.status) params.set('status', filters.status)
      if (filters?.removed) params.set('removed', 'true')
      if (filters?.page) params.set('page', String(filters.page))
      params.set('limit', String(Math.min(filters?.limit ?? EMPLOYEES_PAGE_MAX, EMPLOYEES_PAGE_MAX)))
      const res = await api.get<{
        data: ApiEmployeeRow[]
        pagination: { page: number; limit: number; total: number }
      }>(`/api/v1/employees?${params.toString()}`)
      return {
        employees: res.data.map(adaptEmployee),
        /** A real count across every page (contract C4), not `rows.length`. */
        total: res.pagination.total,
        pagination: res.pagination,
      }
    },
  })
}

// ─── Round P (R1.1): resend invites ──────────────────────────────────────────

export interface ResendInviteResult {
  employeeId: string
  email: string
  resentCount: number
  /** false = the ledger row was written but the provider refused the email. */
  emailSent: boolean
}

export interface ResendInvitesBulkResult {
  sent: number
  skipped: Array<{ employeeId: string; email: string; reason: string }>
}

/** Both resend paths touch the directory pills AND the Settings → Members seats. */
function invalidateInviteScopes(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: ['employees'] })
  queryClient.invalidateQueries({ queryKey: ['settings', 'members'] })
}

/**
 * POST /employees/:id/resend-invite (contract C1). Throws APIError with the
 * server's own copy on 409 (ALREADY_ONBOARDED / SEAT_DEACTIVATED /
 * EMPLOYEE_REMOVED) and 429 (RESEND_TOO_SOON) — show `err.message` as-is.
 */
export function useResendInvite() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await api.post<{ data: ResendInviteResult }>(
        `/api/v1/employees/${id}/resend-invite`,
        {},
      )
      return res.data
    },
    onSuccess: () => invalidateInviteScopes(queryClient),
  })
}

/**
 * POST /employees/resend-invites (contract C2). `ids` omitted = every
 * employee still waiting on their invite; the server decides eligibility
 * per row and never fails the whole call.
 */
export function useResendAllInvites() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (ids?: string[]) => {
      const res = await api.post<{ data: ResendInvitesBulkResult }>(
        '/api/v1/employees/resend-invites',
        ids && ids.length > 0 ? { employeeIds: ids } : {},
      )
      return res.data
    },
    onSuccess: () => invalidateInviteScopes(queryClient),
  })
}

/**
 * GET /employees/next-code (contract C6) — the next free code over EVERY row,
 * removed ones included (they still hold the unique index). Always fresh:
 * the add page is the only reader and a stale suggestion is a 409 waiting
 * to happen.
 */
export function useNextEmployeeCode() {
  return useQuery({
    queryKey: ['employees', 'next-code'],
    queryFn: async () => {
      const res = await api.get<{ data: { suggested: string } }>('/api/v1/employees/next-code')
      return res.data
    },
    staleTime: 0,
    gcTime: 0,
    retry: 1,
  })
}

// ─── Rich employee detail (returned by GET /employees/:id) ──────────────────

export interface EmergencyContact {
  id: string
  name: string
  relationship: string
  phone: string
  email: string | null
  isPrimary: boolean
}

export interface EmployeeLeaveBalance {
  leaveTypeId: string
  leaveTypeName: string
  code: string
  color: string | null
  opening: number
  accrued: number
  used: number
  pending: number
  available: number
}

export interface EmployeeDetail {
  // Identity
  id: string
  employeeCode: string
  firstName: string
  middleName: string | null
  lastName: string
  preferredName: string | null
  // Email / phone
  workEmail: string
  personalEmail: string | null
  workPhone: string | null
  personalPhone: string | null
  // FKs + joined names
  userId: string | null
  departmentId: string | null
  departmentName: string | null
  designationId: string | null
  designationTitle: string | null
  designationLevel: number | null
  locationId: string | null
  locationName: string | null
  locationCity: string | null
  locationTimezone: string | null
  locationCountryCode: string | null
  reportingManagerId: string | null
  reportingManagerName: string | null
  reportingManagerEmail: string | null
  // Employment
  employmentType: 'full_time' | 'part_time' | 'contract' | 'intern' | 'consultant' | 'probation'
  dateOfJoining: string
  dateOfConfirmation: string | null
  probationEndDate: string | null
  dateOfExit: string | null
  noticePeriodDays: number | null
  // Personal
  dateOfBirth: string | null
  gender: 'male' | 'female' | 'other' | 'prefer_not_to_say' | null
  maritalStatus: string | null
  nationality: string | null
  bloodGroup: string | null
  currentAddress: { line1?: string; line2?: string; city?: string; state?: string; postal_code?: string; country?: string } | null
  permanentAddress: { line1?: string; line2?: string; city?: string; state?: string; postal_code?: string; country?: string } | null
  // Statutory
  hasPan: boolean
  hasPassport: boolean
  aadhaarLast4: string | null
  pfUan: string | null
  esicNumber: string | null
  pfApplicable: boolean
  esiApplicable: boolean
  // Banking
  bankName: string | null
  bankBranch: string | null
  bankIfsc: string | null
  bankAccountType: string | null
  bankAccountHolder: string | null
  hasBankAccount: boolean
  // Status + identity
  status: 'active' | 'inactive' | 'on_leave' | 'notice_period' | 'separated' | 'absconded'
  // Round P (contract C5) — same three fields as the list rows, so the 360
  // header shows the same pill as the row that opened it. Optional so an
  // API that predates them still types.
  membershipStatus?: MembershipStatus
  onboardingStep?: number | null
  onboardingSubmitted?: boolean | null
  avatarUrl: string | null
  userFullName: string | null
  userEmail: string | null
  // Sibling collections
  thisMonth: {
    daysPresent: number
    lateArrivals: number
    hoursWorked: number
    leaveTaken: number
  } | null // null when the API redacted it for this viewer (round K)
  emergencyContacts: EmergencyContact[]
  leaveBalances: EmployeeLeaveBalance[]
  // Shift effective today; null = the tenant default shift applies.
  currentShift: {
    shiftTemplateId: string
    name: string
    startTime: string
    endTime: string
    effectiveFrom: string
  } | null
}

export function useEmployee(id: string) {
  return useQuery({
    queryKey: ['employees', id],
    queryFn: () => api.get<EmployeeDetail>(`/api/v1/employees/${id}`),
    enabled: !!id,
  })
}

// My own employee record — the onboarding wizard reads the assigned location's
// country from here to decide which statutory fields (PAN/UAN vs passport)
// apply. 404s quietly for users without an employee bridge (e.g. guests).
export function useMyEmployeeRecord() {
  return useQuery({
    queryKey: ['employees', 'me'],
    queryFn: () => api.get<EmployeeDetail>('/api/v1/employees/me'),
    staleTime: 60_000,
    retry: false,
  })
}

// ─── Self-service profile edit (round K) ─────────────────────────────────────
// Mirrors the API's SelfUpdateEmployeeDto: contact details only. Send just
// the sections the user touched; '' clears a scalar; emergencyContact: null
// removes the primary contact.

export interface SelfUpdateEmployeePayload {
  personalPhone?: string
  personalEmail?: string
  currentAddress?: {
    line1?: string
    line2?: string
    city?: string
    stateCode?: string
    postalCode?: string
  }
  emergencyContact?: {
    name: string
    relationship: string
    phone: string
    email?: string
  } | null
}

export function useSelfUpdateEmployee() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (payload: SelfUpdateEmployeePayload) =>
      api.put<EmployeeDetail>('/api/v1/employees/me', payload),
    onSuccess: (record) => {
      // The API returns the full record — paint it straight away, then let
      // the other employee views and /me (designation chip) catch up.
      queryClient.setQueryData(['employees', 'me'], record)
      queryClient.invalidateQueries({ queryKey: ['employees'] })
      queryClient.invalidateQueries({ queryKey: ['auth', 'me'] })
    },
  })
}

/**
 * POST /employees/invite (contract C3). A live, not-yet-submitted employee
 * with the same work email is UPDATED and re-invited (`reinvited: true`); an
 * archived one is re-hired in place. 409 codes ALREADY_EMPLOYEE /
 * EXTERNAL_SEAT / DUPLICATE (and the employee-code ones) carry a message
 * meant for the user — show it as-is.
 */
export interface InviteEmployeeResponse {
  id: string
  employeeCode: string | null
  designationId: string | null
  userId: string | null
  email: string
  fullName: string
  status: string
  joiningDate: string | null
  reinvited?: boolean
  rehired?: boolean
  /** false = the row was saved but the welcome email could not be delivered. */
  emailSent: boolean
}

export function useInviteEmployee() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (payload: InviteEmployeePayload) =>
      api.post<InviteEmployeeResponse>('/api/v1/employees/invite', payload),
    onSuccess: () => {
      // A re-invite / re-hire also moves a seat, so Settings → Members must
      // refetch too.
      invalidateInviteScopes(queryClient)
      track(EVENTS.EMPLOYEE_INVITED)
    },
  })
}

export interface UpdateEmployeePayload {
  id: string
  fullName?: string
  workPhone?: string
  personalPhone?: string
  designationId?: string
  avatarUrl?: string
  // Admin-editable org/employment fields (owner/HR profile editing)
  employeeCode?: string
  departmentId?: string
  locationId?: string
  // null clears the reporting line.
  reportingManagerId?: string | null
  // Shift effective today; null reverts to the tenant default shift.
  shiftTemplateId?: string | null
  employmentType?: string
  dateOfJoining?: string
  probationEndDate?: string
  dateOfConfirmation?: string
  noticePeriodDays?: number
}

export function useUpdateEmployee() {
  const queryClient = useQueryClient()

  return useMutation({
    // Backend route is PUT /api/v1/employees/:id (HR/Owner only).
    mutationFn: ({ id, ...data }: UpdateEmployeePayload) =>
      api.put<Employee>(`/api/v1/employees/${id}`, data),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['employees', variables.id] })
      queryClient.invalidateQueries({ queryKey: ['employees'] })
    },
  })
}

// ─── Offboarding + removal (round 21) ────────────────────────────────────────

export interface RemovalPreview {
  /** delete = no history, the row goes for good; archive = kept and hidden. */
  mode: 'delete' | 'archive'
  name: string
  attendance: number
  punches: number
  leave: number
  timesheets: number
  documents: number
  historyRows: number
  total: number
  /**
   * Round P R4 — every asset assignment the person ever had (open or
   * returned); counts toward `total` so anyone with equipment history is
   * archived, never hard-deleted. Optional: tolerates an API that predates it.
   */
  assets?: number
  /** Equipment still out with the person — removal is refused (409 ASSETS_ASSIGNED) until these are returned. */
  openAssets?: Array<{ asset_tag: string; name: string }>
}

export function useRemovalPreview(id: string, enabled: boolean) {
  return useQuery({
    queryKey: ['employees', id, 'removal-preview'],
    queryFn: () => api.get<{ data: RemovalPreview }>(`/api/v1/employees/${id}/removal-preview`),
    enabled: enabled && !!id,
    staleTime: 0,
  })
}

export function useRemoveEmployee() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.delete<{ data: { removed: true } }>(`/api/v1/employees/${id}`),
    onSuccess: () => invalidateOffboarding(queryClient),
  })
}

export function useRestoreEmployee() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/employees/${id}/restore`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['employees'] }),
  })
}

export interface TerminatePayload {
  id: string
  reason: string
  lastWorkingDate?: string
  separationType?: 'resigned' | 'terminated' | 'absconded' | 'retired' | 'end_of_contract'
  /** Round Q: true → off-boarded and signed out now; false → the notice period starts. */
  immediate?: boolean
}

export interface TerminateResult {
  employeeId: string
  status: 'separated' | 'notice_period'
  lastWorkingDate: string
  immediate: boolean
}

// Off-boarding changes the person's pill, the approvals inbox (Round Q: an
// off-boarded person must never linger there) and their Members seat.
function invalidateOffboarding(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: ['employees'] })
  queryClient.invalidateQueries({ queryKey: ['dashboard'] })
  queryClient.invalidateQueries({ queryKey: ['settings', 'members'] })
}

export function useTerminateEmployee() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...data }: TerminatePayload) =>
      api.post<TerminateResult>(`/api/v1/employees/${id}/terminate`, data),
    onSuccess: () => invalidateOffboarding(queryClient),
  })
}

/** Round Q: cancel a notice period, or reinstate a separated employee. */
export function useCancelOffboarding() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ data: { id: string; status: 'active'; seat: string | null } }>(
        `/api/v1/employees/${id}/cancel-offboarding`,
        {},
      ),
    onSuccess: () => invalidateOffboarding(queryClient),
  })
}

// ─── Bulk CSV import ───────────────────────────────────────────────────────────

export interface ImportEmployeeRow {
  fullName: string
  email: string
  employeeCode: string
  department?: string
  designation?: string
  location?: string
  employmentType?: string
  joiningDate?: string
  jobTitle?: string
}

export interface ImportResult {
  total: number
  created: number
  failed: Array<{ row: number; email: string; error: string }>
  /**
   * Round P (contract C3): rows matching someone already invited are skipped
   * ("already invited — use Resend invite") rather than re-mailed. Optional
   * for an API that predates it.
   */
  skipped?: Array<{ row: number; email: string; reason: string }>
}

export function useImportEmployees() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (rows: ImportEmployeeRow[]) =>
      api.post<ImportResult>('/api/v1/employees/import', { rows }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['employees'] })
    },
  })
}

// ─── Org chart ───────────────────────────────────────────────────────────────

export interface OrgNode {
  id: string
  employeeCode: string | null
  fullName: string | null
  email: string | null
  avatarUrl: string | null
  userId: string | null
  designationTitle: string | null
  departmentName: string | null
  managerId: string | null
  status: string
  children: OrgNode[]
}

export function useOrgChart() {
  return useQuery({
    queryKey: ['employees', 'org-chart'],
    queryFn: () =>
      api.get<{ tree: OrgNode[]; total: number }>('/api/v1/employees/org-chart'),
    staleTime: 60_000,
  })
}

// ─── Onboarding approval queue ─────────────────────────────────────────────────

export interface OnboardingQueueRow {
  id: string
  employeeCode: string | null
  fullName: string | null
  email: string | null
  avatarUrl: string | null
  designationTitle: string | null
  departmentName: string | null
  status: string
  /** Membership role of the pending hire — 'admin'/'owner' rows are shown to
   *  owners only (round 18), so this is what the "Owner approval" badge keys on. */
  memberRole: string | null
  submittedAt: string | null
  /** Round Q: set once it has waited over 24 hours and been escalated. */
  escalatedAt?: string | null
}

export function useOnboardingQueue() {
  return useQuery({
    queryKey: ['employees', 'onboarding-queue'],
    queryFn: () =>
      api.get<{ data: OnboardingQueueRow[]; total: number }>(
        '/api/v1/employees/onboarding-queue',
      ),
    staleTime: 30_000,
  })
}

/**
 * An onboarding decision touches more than the employee list: the Inbox badge
 * + approvals bucket (dashboard), the reviewer's bell (notifications), and —
 * when the approved person has this tab open — their own session state
 * (auth/me + onboarding-status). The socket 'employees_changed' broadcast
 * covers other users' tabs; this is the approver's own-tab backstop.
 */
function invalidateOnboardingScopes(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: ['employees'] })
  queryClient.invalidateQueries({ queryKey: ['dashboard'] })
  queryClient.invalidateQueries({ queryKey: ['notifications'] })
  queryClient.invalidateQueries({ queryKey: ['auth', 'me'] })
  queryClient.invalidateQueries({ queryKey: ['employee', 'onboarding-status'] })
}

export function useApproveOnboarding() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ employeeId: string; status: string }>(
        `/api/v1/employees/${id}/approve-onboarding`,
        {},
      ),
    onSuccess: () => invalidateOnboardingScopes(queryClient),
  })
}

export function useRejectOnboarding() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      api.post<{ employeeId: string; status: string }>(
        `/api/v1/employees/${id}/reject-onboarding`,
        { reason },
      ),
    onSuccess: () => invalidateOnboardingScopes(queryClient),
  })
}

// ─── Manager: my direct reports ──────────────────────────────────────────────

export interface TeamMember {
  id: string
  employeeCode: string | null
  firstName: string
  lastName: string
  fullName: string
  workEmail: string
  status: string
  employmentType: string
  dateOfJoining: string
  departmentId: string | null
  departmentName: string | null
  designationId: string | null
  designationTitle: string | null
  locationId: string | null
  locationName: string | null
  avatarUrl: string | null
  userId: string | null
  onboardingComplete: boolean | null
}

export interface MyTeamResponse {
  managerEmployeeId: string
  data: TeamMember[]
  total: number
}

export function useMyTeam() {
  return useQuery({
    queryKey: ['employees', 'team', 'me'],
    queryFn: () => api.get<MyTeamResponse>('/api/v1/employees/team/me'),
    staleTime: 30_000,
  })
}
