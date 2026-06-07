'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../client'

/**
 * Invoicing React Query hooks (Sprint 2: customers, items, HSN/SAC, numbering).
 * All responses use the API envelope { data, pagination? | meta? }.
 */

export interface Paginated<T> {
  data: T[]
  pagination?: { page: number; limit: number; total: number }
}
interface Wrapped<T> {
  data: T
  warning?: string
  sample?: string
}

// ─── Customers ──────────────────────────────────────────────────────────────

export interface Customer {
  id: string
  customer_code: string
  display_name: string
  legal_name?: string | null
  email?: string | null
  phone?: string | null
  gstin?: string | null
  state_code?: string | null
  default_currency: string
  status: string
}
export type CustomerInput = Partial<Omit<Customer, 'id' | 'customer_code' | 'status'>> & {
  display_name: string
  customer_code?: string
}

export function useCustomers(params: { page?: number; q?: string; status?: string } = {}) {
  const qs = new URLSearchParams()
  if (params.page) qs.set('page', String(params.page))
  if (params.q) qs.set('q', params.q)
  if (params.status) qs.set('status', params.status)
  return useQuery({
    queryKey: ['invoicing', 'customers', params],
    queryFn: () => api.get<Paginated<Customer>>(`/api/v1/customers?${qs.toString()}`),
  })
}

export function useSaveCustomer() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...data }: CustomerInput & { id?: string }) =>
      id
        ? api.patch<Wrapped<Customer>>(`/api/v1/customers/${id}`, data)
        : api.post<Wrapped<Customer>>('/api/v1/customers', data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['invoicing', 'customers'] }),
  })
}

export function useArchiveCustomer() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) =>
      api.post(`/api/v1/customers/${id}/${archived ? 'archive' : 'unarchive'}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['invoicing', 'customers'] }),
  })
}

// ─── Items ──────────────────────────────────────────────────────────────────

export interface Item {
  id: string
  item_code: string
  name: string
  description?: string | null
  default_rate: string
  currency: string
  unit: string
  hsn_sac_code?: string | null
  default_gst_rate?: string | null
  status: string
}
export type ItemInput = Partial<Omit<Item, 'id' | 'item_code' | 'status'>> & {
  name: string
  default_rate: string
  item_code?: string
}

export function useItems(params: { page?: number; q?: string; status?: string } = {}) {
  const qs = new URLSearchParams()
  if (params.page) qs.set('page', String(params.page))
  if (params.q) qs.set('q', params.q)
  if (params.status) qs.set('status', params.status)
  return useQuery({
    queryKey: ['invoicing', 'items', params],
    queryFn: () => api.get<Paginated<Item>>(`/api/v1/items?${qs.toString()}`),
  })
}

export function useSaveItem() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...data }: ItemInput & { id?: string }) =>
      id
        ? api.patch<Wrapped<Item>>(`/api/v1/items/${id}`, data)
        : api.post<Wrapped<Item>>('/api/v1/items', data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['invoicing', 'items'] }),
  })
}

export function useArchiveItem() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) =>
      api.post(`/api/v1/items/${id}/${archived ? 'archive' : 'unarchive'}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['invoicing', 'items'] }),
  })
}

// ─── HSN/SAC ────────────────────────────────────────────────────────────────

export interface HsnSacResult {
  code: string
  type: string
  description: string
  default_gst_rate?: string | null
  category?: string | null
  source: string
}
export function useHsnSacSearch(q: string, type?: string) {
  const qs = new URLSearchParams({ q })
  if (type) qs.set('type', type)
  return useQuery({
    queryKey: ['invoicing', 'hsn-sac', q, type],
    queryFn: () => api.get<{ data: HsnSacResult[] }>(`/api/v1/hsn-sac/search?${qs.toString()}`),
    enabled: q.trim().length >= 2,
  })
}

// ─── Numbering ──────────────────────────────────────────────────────────────

export interface Sequence {
  id: string | null
  document_type: string
  fy_label: string
  prefix: string
  separator: string
  fy_format: string
  zero_padding: number
  starting_number: number
  current_number: number
  branch_code: string
  next_number_preview: string
}
export interface PreviewResult {
  document_type: string
  fy_label: string
  next_number_preview: string
  valid: boolean
  errors: string[]
  sample: string
}
export interface SequenceInput {
  document_type: string
  prefix?: string
  separator?: string
  fy_format?: string
  zero_padding?: number
  starting_number?: number
  branch_code?: string
}

export function useSequences() {
  return useQuery({
    queryKey: ['invoicing', 'sequences'],
    queryFn: () => api.get<{ data: Sequence[] }>('/api/v1/invoice-sequences'),
  })
}

export function usePreviewNumber() {
  return useMutation({
    mutationFn: (input: SequenceInput) =>
      api.post<{ data: PreviewResult }>('/api/v1/invoice-sequences/preview', input),
  })
}

export function useUpsertSequence() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: SequenceInput) =>
      api.put<Wrapped<Sequence>>('/api/v1/invoice-sequences', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['invoicing', 'sequences'] }),
  })
}
