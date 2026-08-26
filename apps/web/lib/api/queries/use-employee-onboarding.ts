'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../client'
import { track, EVENTS } from '@/lib/analytics/posthog'

// ─── Status ──────────────────────────────────────────────────────────────────

export interface EmployeeOnboardingStatus {
  employeeId: string | null
  onboardingStep: number
  submittedAt: string | null
  submittedForReview: boolean
}

export function useEmployeeOnboardingStatus() {
  return useQuery({
    queryKey: ['employee', 'onboarding-status'],
    queryFn: () =>
      api.get<EmployeeOnboardingStatus>('/api/v1/employees/me/onboarding-status'),
    staleTime: 30_000,
  })
}

// ─── Step submission ─────────────────────────────────────────────────────────

export interface PersonalInfoData {
  dateOfBirth?: string
  gender?: 'male' | 'female' | 'other' | 'prefer_not_to_say'
  maritalStatus?: string
  bloodGroup?: string
  addressLine1?: string
  addressLine2?: string
  city?: string
  stateCode?: string
  postalCode?: string
}

export interface EmergencyContactData {
  name: string
  relationship: string
  phone: string
  email?: string
}

export interface IdentityData {
  pan?: string
  /** Client-side truncation — only the last 4 digits ever leave the browser. */
  aadhaarLast4?: string
  /** Passport / national ID for employees outside India. */
  passportNumber?: string
  personalPhone?: string
  personalEmail?: string
  nationality?: string
}

export interface BankData {
  bankName?: string
  bankBranch?: string
  bankAccountNumber?: string
  bankAccountHolder?: string
  bankIfsc?: string
  bankAccountType?: 'savings' | 'current' | 'salary'
  pfUan?: string
}

export interface OnboardingConsent {
  type:
    | 'data_processing'
    | 'marketing'
    | 'background_check'
    | 'biometric_data'
    | 'third_party_sharing'
  granted: boolean
  purpose?: string
}

export interface SubmitOnboardingStepPayload {
  step: number
  personalInfo?: PersonalInfoData
  emergencyContact?: EmergencyContactData
  identity?: IdentityData
  bank?: BankData
  consents?: OnboardingConsent[]
  submitForReview?: boolean
}

export interface OnboardingStepResponse {
  employeeId: string
  step: number
  onboardingStep: number
  allStepsComplete: boolean
}

export function useSubmitOnboardingStep() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: SubmitOnboardingStepPayload) =>
      api.post<OnboardingStepResponse>(
        `/api/v1/employees/me/onboarding/${payload.step}`,
        payload,
      ),
    onSuccess: (data, vars) => {
      if (data.allStepsComplete) {
        // Write the final state synchronously instead of refetching: the app
        // layout reads this cache the instant we land on /dashboard, and a
        // stale submittedForReview=false would bounce the user straight back
        // into the wizard.
        qc.setQueryData<EmployeeOnboardingStatus>(
          ['employee', 'onboarding-status'],
          (prev) => ({
            employeeId: data.employeeId,
            onboardingStep: data.onboardingStep,
            submittedAt: prev?.submittedAt ?? new Date().toISOString(),
            submittedForReview: true,
          }),
        )
      } else {
        qc.invalidateQueries({ queryKey: ['employee', 'onboarding-status'] })
      }
      qc.invalidateQueries({ queryKey: ['employees', 'me'] })
      if (vars.submitForReview || data.allStepsComplete) {
        track(EVENTS.EMPLOYEE_ONBOARDING_SUBMITTED)
      }
    },
  })
}

// ─── Admin variant (owner/HR) ────────────────────────────────────────────────
// Same step writer targeted at ANY employee — powers the detail page's
// "Edit personal & statutory" dialog. Review flags are self-service only.

export function useAdminSubmitEmployeeDetails() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ employeeId, ...payload }: SubmitOnboardingStepPayload & { employeeId: string }) =>
      api.post<OnboardingStepResponse & { pendingConfirmation?: boolean; requestId?: string }>(
        `/api/v1/employees/${employeeId}/onboarding/${payload.step}`,
        payload,
      ),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['employees', vars.employeeId] })
      qc.invalidateQueries({ queryKey: ['employees'] })
      qc.invalidateQueries({ queryKey: ['employee-change-requests', vars.employeeId] })
    },
  })
}

// ─── Detail change requests (employee confirms HR edits) ─────────────────────

export interface ChangeSummaryRow {
  field: string
  from: string | null
  to: string
}

export interface MyChangeRequest {
  id: string
  step: number
  summary: ChangeSummaryRow[]
  createdAt: string
  requestedByName: string | null
}

export function useMyChangeRequests() {
  return useQuery({
    queryKey: ['my-change-requests'],
    queryFn: () =>
      api.get<{ requests: MyChangeRequest[] }>('/api/v1/employees/me/change-requests'),
  })
}

export function useReviewMyChangeRequest() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      id,
      action,
      reason,
    }: {
      id: string
      action: 'confirm' | 'reject'
      reason?: string
    }) =>
      api.post<{ requestId: string; status: string }>(
        `/api/v1/employees/me/change-requests/${id}/${action}`,
        action === 'reject' ? { reason } : {},
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['my-change-requests'] })
      qc.invalidateQueries({ queryKey: ['employees'] })
      qc.invalidateQueries({ queryKey: ['auth', 'me'] })
    },
  })
}

export interface EmployeeChangeRequest extends MyChangeRequest {
  status: 'pending' | 'confirmed' | 'rejected' | 'cancelled'
  reason: string | null
  reviewedAt: string | null
}

// Admin view — powers the "awaiting confirmation" pill on Edit details.
export function useEmployeeChangeRequests(employeeId: string, enabled = true) {
  return useQuery({
    queryKey: ['employee-change-requests', employeeId],
    queryFn: () =>
      api.get<{ requests: EmployeeChangeRequest[] }>(
        `/api/v1/employees/${employeeId}/change-requests`,
      ),
    enabled,
  })
}

export function useCancelChangeRequest() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ employeeId, requestId }: { employeeId: string; requestId: string }) =>
      api.post<{ cancelled: boolean }>(
        `/api/v1/employees/${employeeId}/change-requests/${requestId}/cancel`,
        {},
      ),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['employee-change-requests', vars.employeeId] })
    },
  })
}
