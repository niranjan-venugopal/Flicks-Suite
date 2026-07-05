'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../client'

/** Feedback + NPS hooks (PRD v4 §7). */

export function useSubmitFeedback() {
  return useMutation({
    mutationFn: (input: {
      category: 'bug' | 'idea' | 'question' | 'other'
      message: string
      contact_ok?: boolean
      page_path?: string
    }) => api.post('/api/v1/feedback', input),
  })
}

export function useNpsEligibility(enabled: boolean) {
  return useQuery({
    queryKey: ['nps', 'eligibility'],
    queryFn: () =>
      api.get<{ data: { eligible: boolean; survey_key: string } }>(
        '/api/v1/me/nps-eligibility',
      ),
    enabled,
    staleTime: 6 * 60 * 60 * 1000, // once per session is plenty
    retry: false,
  })
}

export function useNpsRespond() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { action: 'answer' | 'snooze' | 'dismiss'; score?: number; comment?: string }) =>
      api.post('/api/v1/me/nps', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['nps'] }),
  })
}

// ─── FAM (D12/D13) ─────────────────────────────────────────────────────────────

export interface FamFeedbackRow {
  id: string
  created_at: string
  tenant_id: string
  tenant_name: string
  user_id: string
  user_name: string | null
  user_email: string | null
  category: 'bug' | 'idea' | 'question' | 'other'
  message: string
  status: 'new' | 'triaged' | 'resolved' | 'closed'
  contact_ok: boolean
  page_path: string | null
  internal_note: string | null
}

export function useFamFeedback(filters: { category?: string; status?: string }) {
  const params = new URLSearchParams()
  if (filters.category) params.set('category', filters.category)
  if (filters.status) params.set('status', filters.status)
  return useQuery({
    queryKey: ['fam', 'feedback', filters],
    queryFn: () =>
      api.get<{ data: FamFeedbackRow[] }>(
        `/api/v1/fam/feedback${params.toString() ? `?${params}` : ''}`,
      ),
    staleTime: 30_000,
  })
}

export function useFamFeedbackUpdate() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: string; status?: string; internal_note?: string }) =>
      api.patch(`/api/v1/fam/feedback/${id}`, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['fam', 'feedback'] }),
  })
}

export interface FamNpsSummary {
  survey_key: string
  total: number
  promoters: number
  passives: number
  detractors: number
  score: number
}

export function useFamNpsSummary() {
  return useQuery({
    queryKey: ['fam', 'nps-summary'],
    queryFn: () => api.get<{ data: FamNpsSummary }>('/api/v1/fam/nps-summary'),
    staleTime: 60_000,
  })
}
