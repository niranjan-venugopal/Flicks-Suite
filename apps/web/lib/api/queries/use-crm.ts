'use client'

import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { io } from 'socket.io-client'
import { api } from '../client'

// ─── Types (mirror the directory kernel, PRD v5 §3) ──────────────────────────
export interface DirectoryCompany {
  id: string
  name: string
  domain: string | null
  website: string | null
  industry: string | null
  size_band: string | null
  phone: string | null
  city: string | null
  state: string | null
  country_code: string | null
  owner_user_id: string | null
  source: string | null
  last_activity_at: string | null
  created_at: string
}

export interface DirectoryPerson {
  id: string
  first_name: string | null
  last_name: string | null
  display_name: string | null
  email: string | null
  phone: string | null
  title: string | null
  company_id: string | null
  owner_user_id: string | null
  source: string | null
  last_activity_at: string | null
  created_at: string
  email_do_not_contact?: boolean
  email_do_not_contact_reason?: string | null
}

interface Paged<T> {
  data: T[]
  pagination: { page: number; limit: number; total: number }
}

// ─── Companies ────────────────────────────────────────────────────────────────
export function useCompanies(q?: string) {
  return useQuery({
    queryKey: ['crm', 'companies', q ?? ''],
    queryFn: () =>
      api.get<Paged<DirectoryCompany>>(`/api/v1/crm/companies${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  })
}

export function useCompany(id: string | null) {
  return useQuery({
    queryKey: ['crm', 'company', id],
    queryFn: () => api.get<{ data: DirectoryCompany }>(`/api/v1/crm/companies/${id}`),
    enabled: !!id,
  })
}

export function useCreateCompany() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.post<{ data: DirectoryCompany; meta: { warnings: unknown[] } }>('/api/v1/crm/companies', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crm', 'companies'] }),
  })
}

export function useUpdateCompany() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api.patch<{ data: DirectoryCompany }>(`/api/v1/crm/companies/${id}`, body),
    onSuccess: (_r, { id }) => {
      qc.invalidateQueries({ queryKey: ['crm', 'companies'] })
      qc.invalidateQueries({ queryKey: ['crm', 'company', id] })
    },
  })
}

export function useDeleteCompany() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/crm/companies/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crm', 'companies'] }),
  })
}

// ─── Contacts (people) ──────────────────────────────────────────────────────
export function useContacts(opts?: { q?: string; company_id?: string }) {
  const params = new URLSearchParams()
  if (opts?.q) params.set('q', opts.q)
  if (opts?.company_id) params.set('company_id', opts.company_id)
  const qs = params.toString()
  return useQuery({
    queryKey: ['crm', 'contacts', opts?.q ?? '', opts?.company_id ?? ''],
    queryFn: () => api.get<Paged<DirectoryPerson>>(`/api/v1/crm/contacts${qs ? `?${qs}` : ''}`),
  })
}

export function useContact(id: string | null) {
  return useQuery({
    queryKey: ['crm', 'contact', id],
    queryFn: () => api.get<{ data: DirectoryPerson }>(`/api/v1/crm/contacts/${id}`),
    enabled: !!id,
  })
}

export function useCreateContact() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.post<{ data: DirectoryPerson }>('/api/v1/crm/contacts', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crm', 'contacts'] }),
  })
}

export function useUpdateContact() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api.patch<{ data: DirectoryPerson }>(`/api/v1/crm/contacts/${id}`, body),
    onSuccess: (_r, { id }) => {
      qc.invalidateQueries({ queryKey: ['crm', 'contacts'] })
      qc.invalidateQueries({ queryKey: ['crm', 'contact', id] })
    },
  })
}

export function useDeleteContact() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/crm/contacts/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crm', 'contacts'] }),
  })
}

// ─── Deals / board (PRD v5 §4) ────────────────────────────────────────────────
export interface TagRef {
  id: string
  label: string
  color: string | null
}
export interface DealCard {
  id: string
  title: string
  company_id: string | null
  primary_person_id: string | null
  owner_user_id: string
  owner_name?: string | null
  value_amount: string
  currency: string
  value_base_amount: string
  expected_close_date: string | null
  status: string
  stage_id: string
  idle_days: number
  rot_state: 'amber' | 'red' | null
  next_activity_at?: string | null
  invoice_id?: string | null
  quote_id?: string | null
  tags?: TagRef[]
  custom?: Record<string, unknown>
}
export interface DealProduct {
  id: string
  item_id: string | null
  name: string
  quantity: string
  unit_price: string
  currency: string
  discount_pct: string | null
  line_total: string
}
export interface DealPerson {
  person_id: string
  role: string | null
  name: string | null
  email: string | null
  phone: string | null
  title: string | null
}
export interface LinkedDoc {
  id: string
  number: string
  status: string
  total: string
  document_type: string
  created_at: string
}
export interface StageHistoryRow {
  id: string
  from_stage_id: string | null
  to_stage_id: string
  changed_by: string | null
  changed_at: string
  seconds_in_previous_stage: number | null
}
export interface DealDetail extends DealCard {
  base_currency: string
  pipeline_id: string
  lost_reason_id: string | null
  lost_reason_note: string | null
  source: string | null
  won_at: string | null
  lost_at: string | null
  created_at: string
  company: { id: string; name: string; country_code: string | null } | null
  stage_history: StageHistoryRow[]
  products: DealProduct[]
  people: DealPerson[]
  tags: TagRef[]
  linked_invoice: LinkedDoc | null
  linked_quote: LinkedDoc | null
}
export interface BoardColumn {
  stage: { id: string; name: string; win_probability: number; rotting_days: number | null; stage_type: string }
  cards: DealCard[]
  count: number
  sum_base: number
  weighted_base: number
}
export interface Board {
  pipeline: { id: string; name: string }
  base_currency: string
  columns: BoardColumn[]
}
export interface Pipeline {
  id: string
  name: string
  is_default: boolean
  stages: Array<{ id: string; name: string; win_probability: number; rotting_days: number | null; stage_type: string; display_order: number }>
}

export function usePipelines() {
  return useQuery({ queryKey: ['crm', 'pipelines'], queryFn: () => api.get<{ data: Pipeline[] }>('/api/v1/crm/pipelines') })
}

export function useLostReasons() {
  return useQuery({ queryKey: ['crm', 'lost-reasons'], queryFn: () => api.get<{ data: Array<{ id: string; label: string }> }>('/api/v1/crm/lost-reasons') })
}

export function useBoard(pipelineId?: string) {
  const qc = useQueryClient()
  const query = useQuery({
    queryKey: ['crm', 'board', pipelineId ?? 'default'],
    queryFn: () => api.get<{ data: Board }>(`/api/v1/crm/board${pipelineId ? `?pipeline_id=${pipelineId}` : ''}`),
  })
  // Live board: any tenant member's move refreshes every open board.
  useEffect(() => {
    const base = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'
    const socket = io(`${base}/crm`, { withCredentials: true, transports: ['websocket', 'polling'] })
    socket.on('board_changed', () => qc.invalidateQueries({ queryKey: ['crm', 'board'] }))
    return () => { socket.disconnect() }
  }, [qc])
  return query
}

export function useForecast(pipelineId?: string) {
  return useQuery({
    queryKey: ['crm', 'forecast', pipelineId ?? 'default'],
    queryFn: () => api.get<{ data: { base_currency: string; open_count: number; open_value: number; weighted_value: number; won_value: number } }>(`/api/v1/crm/forecast${pipelineId ? `?pipeline_id=${pipelineId}` : ''}`),
  })
}

export function useDeal(id: string | null) {
  return useQuery({
    queryKey: ['crm', 'deal', id],
    queryFn: () => api.get<{ data: DealDetail }>(`/api/v1/crm/deals/${id}`),
    enabled: !!id,
  })
}

export function useReps() {
  return useQuery({
    queryKey: ['crm', 'reps'],
    queryFn: () => api.get<{ data: Array<{ user_id: string; name: string; role: string }> }>('/api/v1/crm/reps'),
  })
}

// ─── Tags (§19.1) ─────────────────────────────────────────────────────────────
export function useTags() {
  return useQuery({ queryKey: ['crm', 'tags'], queryFn: () => api.get<{ data: TagRef[] }>('/api/v1/crm/tags') })
}

export function useCreateTag() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { label: string; color?: string }) => api.post<{ data: TagRef }>('/api/v1/crm/tags', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crm', 'tags'] }),
  })
}

export function useAttachTag() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ type, id, tagId }: { type: string; id: string; tagId: string }) =>
      api.post(`/api/v1/crm/records/${type}/${id}/tags/${tagId}`, {}),
    onSuccess: (_r, { type, id }) => {
      qc.invalidateQueries({ queryKey: ['crm', 'board'] })
      if (type === 'deal') qc.invalidateQueries({ queryKey: ['crm', 'deal', id] })
    },
  })
}

export function useDetachTag() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ type, id, tagId }: { type: string; id: string; tagId: string }) =>
      api.delete(`/api/v1/crm/records/${type}/${id}/tags/${tagId}`),
    onSuccess: (_r, { type, id }) => {
      qc.invalidateQueries({ queryKey: ['crm', 'board'] })
      if (type === 'deal') qc.invalidateQueries({ queryKey: ['crm', 'deal', id] })
    },
  })
}

// ─── Deal products / people (C3 tabs) ─────────────────────────────────────────
export function useAddDealProduct() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ dealId, body }: { dealId: string; body: Record<string, unknown> }) =>
      api.post<{ data: DealProduct }>(`/api/v1/crm/deals/${dealId}/products`, body),
    onSuccess: (_r, { dealId }) => {
      qc.invalidateQueries({ queryKey: ['crm', 'deal', dealId] })
      qc.invalidateQueries({ queryKey: ['crm', 'board'] })
    },
  })
}

export function useRemoveDealProduct() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ dealId, productId }: { dealId: string; productId: string }) =>
      api.delete(`/api/v1/crm/deals/${dealId}/products/${productId}`),
    onSuccess: (_r, { dealId }) => {
      qc.invalidateQueries({ queryKey: ['crm', 'deal', dealId] })
      qc.invalidateQueries({ queryKey: ['crm', 'board'] })
    },
  })
}

export function useAddDealPerson() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ dealId, body }: { dealId: string; body: { person_id: string; role?: string } }) =>
      api.post(`/api/v1/crm/deals/${dealId}/people`, body),
    onSuccess: (_r, { dealId }) => qc.invalidateQueries({ queryKey: ['crm', 'deal', dealId] }),
  })
}

export function useRemoveDealPerson() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ dealId, personId }: { dealId: string; personId: string }) =>
      api.delete(`/api/v1/crm/deals/${dealId}/people/${personId}`),
    onSuccess: (_r, { dealId }) => qc.invalidateQueries({ queryKey: ['crm', 'deal', dealId] }),
  })
}

export function useCreateDeal() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post<{ data: DealCard }>('/api/v1/crm/deals', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crm', 'board'] }),
  })
}

export function useMoveDeal() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: { stage_id: string; lost_reason_id?: string; lost_reason_note?: string } }) =>
      api.post<{ data: DealCard }>(`/api/v1/crm/deals/${id}/move`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crm', 'board'] }),
  })
}

export function useUpdateDeal() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => api.patch<{ data: DealCard }>(`/api/v1/crm/deals/${id}`, body),
    onSuccess: (_r, { id }) => {
      qc.invalidateQueries({ queryKey: ['crm', 'board'] })
      qc.invalidateQueries({ queryKey: ['crm', 'deal', id] })
    },
  })
}

export function useReopenDeal() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.post<{ data: DealCard }>(`/api/v1/crm/deals/${id}/reopen`, {}),
    onSuccess: (_r, id) => {
      qc.invalidateQueries({ queryKey: ['crm', 'deal', id] })
      qc.invalidateQueries({ queryKey: ['crm', 'board'] })
    },
  })
}

export function useDeleteDeal() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/crm/deals/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crm', 'board'] }),
  })
}

export function useCreateInvoiceFromDeal() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (dealId: string) => api.post<{ data: { invoice_id: string; customer_id: string } }>(`/api/v1/crm/deals/${dealId}/create-invoice`, {}),
    onSuccess: (_r, dealId) => {
      qc.invalidateQueries({ queryKey: ['crm', 'deal', dealId] })
      qc.invalidateQueries({ queryKey: ['crm', 'board'] })
    },
  })
}

export function useCreateQuoteFromDeal() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (dealId: string) => api.post<{ data: { quote_id: string; customer_id: string } }>(`/api/v1/crm/deals/${dealId}/create-quote`, {}),
    onSuccess: (_r, dealId) => {
      qc.invalidateQueries({ queryKey: ['crm', 'deal', dealId] })
      qc.invalidateQueries({ queryKey: ['crm', 'board'] })
    },
  })
}

// ─── Custom fields (§9.1) ─────────────────────────────────────────────────────
export interface CustomFieldDef {
  id: string
  object_type: string
  key: string
  label: string
  field_type: string
  options: string[]
  is_required: boolean
  display_order: number
  archived: boolean
}

export function useCustomFields(objectType?: string) {
  return useQuery({
    queryKey: ['crm', 'custom-fields', objectType ?? 'all'],
    queryFn: () => api.get<{ data: CustomFieldDef[] }>(`/api/v1/crm/custom-fields${objectType ? `?object_type=${objectType}` : ''}`),
  })
}

export function useCreateCustomField() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post<{ data: CustomFieldDef }>('/api/v1/crm/custom-fields', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crm', 'custom-fields'] }),
  })
}

export function useUpdateCustomField() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => api.patch<{ data: CustomFieldDef }>(`/api/v1/crm/custom-fields/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crm', 'custom-fields'] }),
  })
}

export function useArchiveCustomField() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/crm/custom-fields/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crm', 'custom-fields'] }),
  })
}

// ─── Saved views (§9.2) ───────────────────────────────────────────────────────
export interface SavedView {
  id: string
  object_type: string
  name: string
  owner_user_id: string | null
  is_shared: boolean
  filters: Record<string, unknown>
  sort: Record<string, unknown>
  columns: string[]
}

export function useSavedViews(objectType?: string) {
  return useQuery({
    queryKey: ['crm', 'views', objectType ?? 'all'],
    queryFn: () => api.get<{ data: SavedView[] }>(`/api/v1/crm/views${objectType ? `?object_type=${objectType}` : ''}`),
  })
}

export function useCreateSavedView() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post<{ data: SavedView }>('/api/v1/crm/views', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crm', 'views'] }),
  })
}

export function useUpdateSavedView() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => api.patch<{ data: SavedView }>(`/api/v1/crm/views/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crm', 'views'] }),
  })
}

export function useDeleteSavedView() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/crm/views/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crm', 'views'] }),
  })
}

// ─── Activities (§6, C8) ──────────────────────────────────────────────────────
export interface Activity {
  id: string
  type: 'task' | 'call' | 'meeting' | 'note'
  subject: string
  body: string | null
  due_at: string | null
  completed_at: string | null
  outcome: string | null
  assignee_user_id?: string
  assignee_name?: string | null
  deal_id?: string | null
  deal_title?: string | null
  created_at: string
}
export interface MyActivities {
  overdue: Activity[]
  today: Activity[]
  upcoming: Activity[]
  completed: Activity[]
}

export function useMyActivities() {
  return useQuery({
    queryKey: ['crm', 'activities', 'mine'],
    queryFn: () => api.get<{ data: MyActivities }>('/api/v1/crm/activities/mine'),
  })
}

export function useDealActivities(dealId: string | null) {
  return useQuery({
    queryKey: ['crm', 'activities', 'deal', dealId],
    queryFn: () => api.get<{ data: Activity[] }>(`/api/v1/crm/deals/${dealId}/activities`),
    enabled: !!dealId,
  })
}

function invalidateActivityScopes(qc: ReturnType<typeof useQueryClient>, dealId?: string | null) {
  qc.invalidateQueries({ queryKey: ['crm', 'activities'] })
  qc.invalidateQueries({ queryKey: ['crm', 'board'] }) // next_activity_at chips
  if (dealId) qc.invalidateQueries({ queryKey: ['crm', 'deal', dealId] })
}

export function useCreateActivity() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post<{ data: Activity }>('/api/v1/crm/activities', body),
    onSuccess: (_r, body) => invalidateActivityScopes(qc, (body as { deal_id?: string }).deal_id),
  })
}

export function useCompleteActivity() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body?: { outcome?: string; note?: string }; dealId?: string | null }) =>
      api.post<{ data: Activity }>(`/api/v1/crm/activities/${id}/complete`, body ?? {}),
    onSuccess: (_r, { dealId }) => invalidateActivityScopes(qc, dealId),
  })
}

export function useDeleteActivity() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id }: { id: string; dealId?: string | null }) => api.delete(`/api/v1/crm/activities/${id}`),
    onSuccess: (_r, { dealId }) => invalidateActivityScopes(qc, dealId),
  })
}

// ─── Email Phase A (§7.1, C9–C11) ─────────────────────────────────────────────
export interface EmailMessage {
  id: string
  direction: 'out' | 'in'
  status: string
  to_email: string
  from_email: string | null
  subject: string
  open_count: number
  click_count: number
  tracking: boolean
  sender_name: string | null
  created_at: string
}

export function useDealEmails(dealId: string | null) {
  return useQuery({
    queryKey: ['crm', 'emails', 'deal', dealId],
    queryFn: () => api.get<{ data: EmailMessage[] }>(`/api/v1/crm/deals/${dealId}/emails`),
    enabled: !!dealId,
    refetchInterval: 60_000, // opens/clicks tick in near-live
  })
}

export function useSendEmail() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post<{ data: { id: string; status: string; to: string } }>('/api/v1/crm/emails', body),
    onSuccess: (_r, body) => {
      const dealId = (body as { deal_id?: string }).deal_id
      if (dealId) {
        qc.invalidateQueries({ queryKey: ['crm', 'emails', 'deal', dealId] })
        qc.invalidateQueries({ queryKey: ['crm', 'deal', dealId] })
      }
    },
  })
}

export interface EmailTemplate {
  id: string
  name: string
  subject: string
  body_html: string
}

export function useEmailTemplates() {
  return useQuery({ queryKey: ['crm', 'email-templates'], queryFn: () => api.get<{ data: EmailTemplate[] }>('/api/v1/crm/email-templates') })
}

export function useSignature() {
  return useQuery({ queryKey: ['crm', 'signature'], queryFn: () => api.get<{ data: { signature: string | null } }>('/api/v1/crm/me/signature') })
}

export function useSetSignature() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (signature: string | null) => api.put('/api/v1/crm/me/signature', { signature }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crm', 'signature'] }),
  })
}

export function useInboundAddress() {
  return useQuery({ queryKey: ['crm', 'inbound-address'], queryFn: () => api.get<{ data: { address: string } }>('/api/v1/crm/inbound-address') })
}

// ─── Sequences (§7.1, C10) ────────────────────────────────────────────────────
export interface SequenceStep {
  id: string
  step_order: number
  wait_days: number
  subject: string
  body_html: string
}
export interface Sequence {
  id: string
  name: string
  is_active: boolean
  send_window_start: string
  send_window_end: string
  timezone: string
  steps: SequenceStep[]
  active_enrollments: number
}
export interface SequenceEnrollment {
  id: string
  person_id: string
  person_name: string | null
  person_email: string | null
  deal_id: string | null
  current_step: number
  next_send_at: string | null
  status: string
  exit_reason: string | null
  created_at: string
}

export function useSequences() {
  return useQuery({ queryKey: ['crm', 'sequences'], queryFn: () => api.get<{ data: Sequence[] }>('/api/v1/crm/sequences') })
}

export function useCreateSequence() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post<{ data: Sequence }>('/api/v1/crm/sequences', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crm', 'sequences'] }),
  })
}

export function useSequenceEnrollments(sequenceId: string | null) {
  return useQuery({
    queryKey: ['crm', 'sequences', sequenceId, 'enrollments'],
    queryFn: () => api.get<{ data: SequenceEnrollment[] }>(`/api/v1/crm/sequences/${sequenceId}/enrollments`),
    enabled: !!sequenceId,
  })
}

export function useEnrollInSequence() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ sequenceId, body }: { sequenceId: string; body: { person_id: string; deal_id?: string } }) =>
      api.post<{ data: SequenceEnrollment }>(`/api/v1/crm/sequences/${sequenceId}/enroll`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crm', 'sequences'] }),
  })
}

export function useExitEnrollment() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/crm/enrollments/${id}/exit`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crm', 'sequences'] }),
  })
}

export function useCreateEmailTemplate() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { name: string; subject: string; body_html: string }) =>
      api.post<{ data: EmailTemplate }>('/api/v1/crm/email-templates', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crm', 'email-templates'] }),
  })
}

export function useArchiveEmailTemplate() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/crm/email-templates/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crm', 'email-templates'] }),
  })
}

// ─── Global search (§19.8) ────────────────────────────────────────────────────
export interface CrmSearchResults {
  query: string
  companies: Array<{ id: string; name: string; domain: string | null }>
  people: Array<{ id: string; display_name: string | null; email: string | null; company_id: string | null }>
  deals: Array<{ id: string; title: string; status: string; value_base_amount: string }>
}

export function useGlobalSearch(q: string) {
  const query = q.trim()
  return useQuery({
    queryKey: ['crm', 'search', query],
    queryFn: () => api.get<{ data: CrmSearchResults }>(`/api/v1/crm/search?q=${encodeURIComponent(query)}`),
    enabled: query.length >= 2,
  })
}

// ─── Leads (§5.1, C6) ─────────────────────────────────────────────────────────
export interface Lead {
  id: string
  first_name: string
  last_name: string | null
  company_name: string | null
  email: string | null
  phone: string | null
  note: string | null
  source: string
  score: number
  status: string
  owner_user_id: string | null
  owner_name?: string | null
  utm: Record<string, string>
  converted_deal_id: string | null
  created_at: string
  dupe_person?: { id: string; email: string | null; display_name: string | null } | null
}

export function useLeads(status: string) {
  return useQuery({
    queryKey: ['crm', 'leads', status],
    queryFn: () => api.get<{ data: Lead[]; counts: Record<string, number> }>(`/api/v1/crm/leads?status=${status}`),
  })
}

export function useCreateLead() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post<{ data: Lead }>('/api/v1/crm/leads', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crm', 'leads'] }),
  })
}

export function useDiscardLead() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/crm/leads/${id}/discard`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crm', 'leads'] }),
  })
}

export function useConvertLead() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api.post<{ data: { deal_id: string; person_id: string; company_id: string | null } }>(`/api/v1/crm/leads/${id}/convert`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['crm', 'leads'] })
      qc.invalidateQueries({ queryKey: ['crm', 'board'] })
    },
  })
}

// ─── Web forms (§5.2, C13) ────────────────────────────────────────────────────
export interface WebForm {
  id: string
  name: string
  token: string
  title: string
  intro: string | null
  fields: Array<{ key: string; label: string; type: string; required?: boolean }>
  source_tag: string
  assignment: string
  success_message: string
  active: boolean
  submission_count: number
  created_at: string
}

export function useForms() {
  return useQuery({ queryKey: ['crm', 'forms'], queryFn: () => api.get<{ data: WebForm[] }>('/api/v1/crm/forms') })
}

export function useCreateForm() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post<{ data: WebForm }>('/api/v1/crm/forms', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crm', 'forms'] }),
  })
}

export function useSetFormActive() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) => api.patch(`/api/v1/crm/forms/${id}/active`, { active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crm', 'forms'] }),
  })
}

export function useFormSubmissions(formId: string | null) {
  return useQuery({
    queryKey: ['crm', 'forms', formId, 'submissions'],
    queryFn: () => api.get<{ data: Array<{ id: string; payload: Record<string, string>; utm: Record<string, string>; lead_id: string | null; lead_status: string | null; created_at: string }> }>(`/api/v1/crm/forms/${formId}/submissions`),
    enabled: !!formId,
  })
}

// ─── Workflows (§8, C12) ──────────────────────────────────────────────────────
export interface Workflow {
  id: string
  name: string
  trigger: string
  conditions: Array<{ field: string; op: string; value?: string | number }>
  actions: Array<Record<string, unknown> & { type: string }>
  active: boolean
  runs_count: number
  last_run_at: string | null
  created_at: string
}

export interface WorkflowRun {
  id: string
  workflow_id: string
  workflow_name: string
  subject_type: string | null
  subject_id: string | null
  status: string
  steps: Array<{ label: string; status: string; error?: string }>
  created_at: string
}

export function useWorkflows() {
  return useQuery({
    queryKey: ['crm', 'workflows'],
    queryFn: () => api.get<{ data: Workflow[]; limits: { max_active: number; runs_per_day: number; chain_depth: number } }>('/api/v1/crm/workflows'),
  })
}

export function useWorkflowTriggers() {
  return useQuery({ queryKey: ['crm', 'workflow-triggers'], queryFn: () => api.get<{ data: string[] }>('/api/v1/crm/workflows/triggers') })
}

export function useCreateWorkflow() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post<{ data: Workflow }>('/api/v1/crm/workflows', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crm', 'workflows'] }),
  })
}

export function useSetWorkflowActive() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) => api.patch(`/api/v1/crm/workflows/${id}/active`, { active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crm', 'workflows'] }),
  })
}

export function useWorkflowRuns() {
  return useQuery({ queryKey: ['crm', 'workflow-runs'], queryFn: () => api.get<{ data: WorkflowRun[] }>('/api/v1/crm/workflow-runs') })
}

// ─── Reports & forecast & goals (§10, §19.6, C16/C17) ─────────────────────────
export interface ReportsOverview {
  pipeline: { id: string; name: string }
  window_days: number
  snapshot: Array<{ stage_id: string; stage: string; win_probability: number; count: number; raw: number; weighted: number; avg_days: number }>
  funnel: Array<{ stage: string; count: number; pct: number }>
  win_loss: {
    by_source: Array<{ key: string; won: number; lost: number; win_rate: number; avg_size: number; avg_cycle_days: number | null }>
    by_owner: Array<{ key: string; won: number; lost: number; win_rate: number; avg_size: number; avg_cycle_days: number | null }>
    overall_win_rate: number
  }
  lost_reasons: Array<{ label: string; count: number }>
  velocity: Array<{ month: string; value: number }>
  leaderboard: Array<{ user_id: string; name: string; calls: number; meetings: number; tasks: number; emails: number; goal_target: number | null; goal_pct: number | null }>
}

export function useReportsOverview(days?: number) {
  return useQuery({
    queryKey: ['crm', 'reports', 'overview', days],
    queryFn: () => api.get<{ data: ReportsOverview | null }>(`/api/v1/crm/reports/overview${days ? `?days=${days}` : ''}`),
  })
}

export interface ForecastRow {
  period: string
  weighted: number
  committed: number
  won: number
  goal: number | null
  gap_to_goal: number | null
  deals: Array<{ id: string; title: string; owner_name: string | null; value: number; probability: number }>
}

export function useForecastReport(months?: number) {
  return useQuery({
    queryKey: ['crm', 'reports', 'forecast', months],
    queryFn: () => api.get<{ data: ForecastRow[] }>(`/api/v1/crm/reports/forecast${months ? `?months=${months}` : ''}`),
  })
}

export interface SalesGoal {
  id: string
  user_id: string | null
  user_name?: string | null
  period: string
  target_base: number
}

export function useGoals() {
  return useQuery({ queryKey: ['crm', 'goals'], queryFn: () => api.get<{ data: SalesGoal[] }>('/api/v1/crm/goals') })
}

export function useSetGoal() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { period: string; user_id?: string | null; target_base: number }) => api.post('/api/v1/crm/goals', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['crm', 'goals'] })
      qc.invalidateQueries({ queryKey: ['crm', 'reports'] })
    },
  })
}

// ─── Import wizard (C14) ──────────────────────────────────────────────────────
export interface ImportParseResult {
  file_name: string | null
  rows: number
  headers: Array<{ column: string; suggested: string | null; samples: string[] }>
  targets: string[]
}

export interface ImportDryRun {
  rows_read: number
  will_create: number
  will_update: number
  will_skip: number
  errors: number
  preview: Array<{ row: number; action: string; reason?: string; values: Record<string, string> }>
}

export interface ImportBatch {
  id: string
  object_type: string
  file_name: string | null
  rows_read: number
  rows_created: number
  rows_updated: number
  rows_skipped: number
  status: string
  created_at: string
}

export function useImportParse() {
  return useMutation({
    mutationFn: (body: { object: string; csv: string; file_name?: string }) =>
      api.post<{ data: ImportParseResult }>('/api/v1/crm/import/parse', body),
  })
}

export function useImportDryRun() {
  return useMutation({
    mutationFn: (body: { object: string; csv: string; file_name?: string; mapping: Record<string, string>; strategy: string }) =>
      api.post<{ data: ImportDryRun }>('/api/v1/crm/import/dry-run', body),
  })
}

export function useImportRun() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { object: string; csv: string; file_name?: string; mapping: Record<string, string>; strategy: string }) =>
      api.post<{ data: ImportBatch }>('/api/v1/crm/import/run', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['crm'] })
    },
  })
}

export function useImportBatches() {
  return useQuery({ queryKey: ['crm', 'import-batches'], queryFn: () => api.get<{ data: ImportBatch[] }>('/api/v1/crm/import/batches') })
}

export function useImportUndo() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/crm/import/${id}/undo`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crm'] }),
  })
}

// ─── Merge & dedupe (C15) + §19.7 reassign ────────────────────────────────────
export interface MergeCandidate {
  type: 'person' | 'company'
  a: { id: string; name: string | null; email?: string | null; domain?: string | null }
  b: { id: string; name: string | null; email?: string | null; domain?: string | null }
  reason: string
  confidence: number
}

export function useMergeCandidates() {
  return useQuery({ queryKey: ['crm', 'merge-candidates'], queryFn: () => api.get<{ data: MergeCandidate[] }>('/api/v1/crm/merge/candidates') })
}

export function useMergePreview(type: string | null, winnerId?: string, loserId?: string) {
  return useQuery({
    queryKey: ['crm', 'merge-preview', type, winnerId, loserId],
    queryFn: () => api.get<{ data: Record<string, number> }>(`/api/v1/crm/merge/preview?type=${type}&winner_id=${winnerId}&loser_id=${loserId}`),
    enabled: !!type && !!winnerId && !!loserId,
  })
}

export function useMerge() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { type: 'person' | 'company'; winner_id: string; loser_id: string; patch?: Record<string, string> }) =>
      api.post('/api/v1/crm/merge', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crm'] }),
  })
}

export function useReassignPreview(fromUserId: string | null) {
  return useQuery({
    queryKey: ['crm', 'reassign-preview', fromUserId],
    queryFn: () => api.get<{ data: { open_deals: number; open_activities: number; active_leads: number } }>(`/api/v1/crm/reassign/preview?from_user_id=${fromUserId}`),
    enabled: !!fromUserId,
  })
}

export function useReassign() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { from_user_id: string; to_user_id: string }) => api.post<{ data: { deals: number; activities: number; leads: number } }>('/api/v1/crm/reassign', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crm'] }),
  })
}

// ─── Sample data toggle (C22) ─────────────────────────────────────────────────
export function useSampleDataStatus() {
  return useQuery({ queryKey: ['crm', 'sample-data'], queryFn: () => api.get<{ data: { loaded: boolean } }>('/api/v1/crm/sample-data') })
}

export function useSampleData() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (action: 'seed' | 'remove') => api.post(`/api/v1/crm/sample-data${action === 'remove' ? '/remove' : ''}`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crm'] }),
  })
}
