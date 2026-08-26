'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../client'
import { track, EVENTS } from '@/lib/analytics/posthog'

export interface Employee {
  id: string
  name: string
  email: string
  phone?: string
  designation?: string
  department?: string
  location?: string
  status: 'active' | 'inactive' | 'on_leave' | 'invited' | 'on_notice'
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
}

function adaptEmployee(row: ApiEmployeeRow): Employee {
  return {
    id: row.id,
    name: row.fullName ?? row.email ?? row.employeeCode ?? 'Unknown',
    email: row.email ?? '',
    status: (row.status as Employee['status']) ?? 'active',
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
  employmentType?: string
  joiningDate?: string
  personalPhone?: string
  dateOfBirth?: string
}

interface EmployeesFilters {
  search?: string
  department?: string
  location?: string
  status?: string
  page?: number
  limit?: number
}

export function useEmployees(filters?: EmployeesFilters) {
  return useQuery({
    queryKey: ['employees', filters],
    queryFn: async () => {
      const params = new URLSearchParams()
      if (filters?.department) params.set('departmentId', filters.department)
      if (filters?.location) params.set('locationId', filters.location)
      if (filters?.status) params.set('status', filters.status)
      if (filters?.page) params.set('page', String(filters.page))
      if (filters?.limit) params.set('limit', String(filters.limit))
      const res = await api.get<{
        data: ApiEmployeeRow[]
        pagination: { page: number; limit: number; total: number }
      }>(`/api/v1/employees${params.toString() ? `?${params.toString()}` : ''}`)
      return {
        employees: res.data.map(adaptEmployee),
        total: res.pagination.total,
      }
    },
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
  avatarUrl: string | null
  userFullName: string | null
  userEmail: string | null
  // Sibling collections
  thisMonth: {
    daysPresent: number
    lateArrivals: number
    hoursWorked: number
    leaveTaken: number
  }
  emergencyContacts: EmergencyContact[]
  leaveBalances: EmployeeLeaveBalance[]
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

export function useInviteEmployee() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (payload: InviteEmployeePayload) =>
      api.post<Employee>('/api/v1/employees/invite', payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['employees'] })
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
  reportingManagerId?: string
  employmentType?: string
  dateOfJoining?: string
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
  submittedAt: string | null
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
