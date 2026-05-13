'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../client'

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

export interface SubmitOnboardingStepPayload {
  step: number
  personalInfo?: PersonalInfoData
  emergencyContact?: EmergencyContactData
  identity?: IdentityData
  bank?: BankData
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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['employee', 'onboarding-status'] })
      qc.invalidateQueries({ queryKey: ['employees', 'me'] })
    },
  })
}
