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
      api.get<Paged<DirectoryCompany>>(`/crm/companies${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  })
}

export function useCompany(id: string | null) {
  return useQuery({
    queryKey: ['crm', 'company', id],
    queryFn: () => api.get<{ data: DirectoryCompany }>(`/crm/companies/${id}`),
    enabled: !!id,
  })
}

export function useCreateCompany() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.post<{ data: DirectoryCompany; meta: { warnings: unknown[] } }>('/crm/companies', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crm', 'companies'] }),
  })
}

export function useUpdateCompany() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api.patch<{ data: DirectoryCompany }>(`/crm/companies/${id}`, body),
    onSuccess: (_r, { id }) => {
      qc.invalidateQueries({ queryKey: ['crm', 'companies'] })
      qc.invalidateQueries({ queryKey: ['crm', 'company', id] })
    },
  })
}

export function useDeleteCompany() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.delete(`/crm/companies/${id}`),
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
    queryFn: () => api.get<Paged<DirectoryPerson>>(`/crm/contacts${qs ? `?${qs}` : ''}`),
  })
}

export function useContact(id: string | null) {
  return useQuery({
    queryKey: ['crm', 'contact', id],
    queryFn: () => api.get<{ data: DirectoryPerson }>(`/crm/contacts/${id}`),
    enabled: !!id,
  })
}

export function useCreateContact() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.post<{ data: DirectoryPerson }>('/crm/contacts', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crm', 'contacts'] }),
  })
}

export function useUpdateContact() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api.patch<{ data: DirectoryPerson }>(`/crm/contacts/${id}`, body),
    onSuccess: (_r, { id }) => {
      qc.invalidateQueries({ queryKey: ['crm', 'contacts'] })
      qc.invalidateQueries({ queryKey: ['crm', 'contact', id] })
    },
  })
}

export function useDeleteContact() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.delete(`/crm/contacts/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crm', 'contacts'] }),
  })
}

// ─── Deals / board (PRD v5 §4) ────────────────────────────────────────────────
export interface DealCard {
  id: string
  title: string
  company_id: string | null
  primary_person_id: string | null
  owner_user_id: string
  value_amount: string
  currency: string
  value_base_amount: string
  expected_close_date: string | null
  status: string
  stage_id: string
  idle_days: number
  rot_state: 'amber' | 'red' | null
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
  return useQuery({ queryKey: ['crm', 'pipelines'], queryFn: () => api.get<{ data: Pipeline[] }>('/crm/pipelines') })
}

export function useLostReasons() {
  return useQuery({ queryKey: ['crm', 'lost-reasons'], queryFn: () => api.get<{ data: Array<{ id: string; label: string }> }>('/crm/lost-reasons') })
}

export function useBoard(pipelineId?: string) {
  const qc = useQueryClient()
  const query = useQuery({
    queryKey: ['crm', 'board', pipelineId ?? 'default'],
    queryFn: () => api.get<{ data: Board }>(`/crm/board${pipelineId ? `?pipeline_id=${pipelineId}` : ''}`),
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
    queryFn: () => api.get<{ data: { base_currency: string; open_count: number; open_value: number; weighted_value: number; won_value: number } }>(`/crm/forecast${pipelineId ? `?pipeline_id=${pipelineId}` : ''}`),
  })
}

export function useDeal(id: string | null) {
  return useQuery({
    queryKey: ['crm', 'deal', id],
    queryFn: () => api.get<{ data: DealCard & { stage_history: unknown[] } }>(`/crm/deals/${id}`),
    enabled: !!id,
  })
}

export function useCreateDeal() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post<{ data: DealCard }>('/crm/deals', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crm', 'board'] }),
  })
}

export function useMoveDeal() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: { stage_id: string; lost_reason_id?: string; lost_reason_note?: string } }) =>
      api.post<{ data: DealCard }>(`/crm/deals/${id}/move`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crm', 'board'] }),
  })
}

export function useUpdateDeal() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => api.patch<{ data: DealCard }>(`/crm/deals/${id}`, body),
    onSuccess: (_r, { id }) => {
      qc.invalidateQueries({ queryKey: ['crm', 'board'] })
      qc.invalidateQueries({ queryKey: ['crm', 'deal', id] })
    },
  })
}

export function useCreateInvoiceFromDeal() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (dealId: string) => api.post<{ data: { invoice_id: string; customer_id: string } }>(`/crm/deals/${dealId}/create-invoice`, {}),
    onSuccess: (_r, dealId) => {
      qc.invalidateQueries({ queryKey: ['crm', 'deal', dealId] })
      qc.invalidateQueries({ queryKey: ['crm', 'board'] })
    },
  })
}

export function useCreateQuoteFromDeal() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (dealId: string) => api.post<{ data: { quote_id: string; customer_id: string } }>(`/crm/deals/${dealId}/create-quote`, {}),
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
    queryFn: () => api.get<{ data: CustomFieldDef[] }>(`/crm/custom-fields${objectType ? `?object_type=${objectType}` : ''}`),
  })
}

export function useCreateCustomField() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post<{ data: CustomFieldDef }>('/crm/custom-fields', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crm', 'custom-fields'] }),
  })
}

export function useUpdateCustomField() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => api.patch<{ data: CustomFieldDef }>(`/crm/custom-fields/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crm', 'custom-fields'] }),
  })
}

export function useArchiveCustomField() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.delete(`/crm/custom-fields/${id}`),
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
    queryFn: () => api.get<{ data: SavedView[] }>(`/crm/views${objectType ? `?object_type=${objectType}` : ''}`),
  })
}

export function useCreateSavedView() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post<{ data: SavedView }>('/crm/views', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crm', 'views'] }),
  })
}

export function useUpdateSavedView() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => api.patch<{ data: SavedView }>(`/crm/views/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crm', 'views'] }),
  })
}

export function useDeleteSavedView() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.delete(`/crm/views/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crm', 'views'] }),
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
    queryFn: () => api.get<{ data: CrmSearchResults }>(`/crm/search?q=${encodeURIComponent(query)}`),
    enabled: query.length >= 2,
  })
}
