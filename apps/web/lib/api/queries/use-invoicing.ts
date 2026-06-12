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

// ─── Invoices (Sprint 3) ────────────────────────────────────────────────────

export interface InvoiceLineInput {
  item_id?: string
  item_name: string
  description?: string
  hsn_sac_code?: string
  quantity: string
  unit?: string
  rate: string
  gst_rate?: string
  cess_rate?: string
}

export interface InvoiceInput {
  customer_id: string
  invoice_date: string
  due_date: string
  currency?: string
  reference?: string
  place_of_supply?: string
  tax_treatment?: string
  discount_type?: 'percent' | 'fixed'
  discount_value?: string
  tds_section?: string
  tds_payment_code?: string
  tds_rate?: string
  notes?: string
  terms_and_conditions?: string
  line_items: InvoiceLineInput[]
}

export interface InvoiceRow {
  id: string
  invoice_number: string
  document_type: string
  status: string
  invoice_date: string
  due_date: string
  currency: string
  total_amount: string
  tds_amount: string
  net_receivable: string | null
  amount_paid: string | null
  amount_outstanding: string | null
  customer_id: string
  customer_name: string | null
  created_at: string
}

export interface InvoiceDetail extends InvoiceRow {
  subtotal: string
  discount_type: string | null
  discount_value: string | null
  discount_amount: string | null
  taxable_amount: string
  cgst_amount: string | null
  sgst_amount: string | null
  igst_amount: string | null
  cess_amount: string | null
  tds_section: string | null
  tds_payment_code: string | null
  tds_rate: string | null
  place_of_supply: string | null
  tax_treatment: string | null
  reference: string | null
  notes: string | null
  terms_and_conditions: string | null
  line_items: Array<
    InvoiceLineInput & {
      id: string
      line_number: number
      taxable_amount: string
      line_total: string
    }
  >
  customer?: Customer
}

export function useInvoices(
  params: { page?: number; q?: string; status?: string; customer_id?: string } = {},
) {
  const qs = new URLSearchParams()
  if (params.page) qs.set('page', String(params.page))
  if (params.q) qs.set('q', params.q)
  if (params.status) qs.set('status', params.status)
  if (params.customer_id) qs.set('customer_id', params.customer_id)
  return useQuery({
    queryKey: ['invoicing', 'invoices', params],
    queryFn: () => api.get<Paginated<InvoiceRow>>(`/api/v1/invoices?${qs.toString()}`),
  })
}

export function useInvoice(id: string | undefined) {
  return useQuery({
    queryKey: ['invoicing', 'invoice', id],
    queryFn: () => api.get<{ data: InvoiceDetail }>(`/api/v1/invoices/${id}`),
    enabled: !!id,
  })
}

export function useSaveInvoice() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...data }: InvoiceInput & { id?: string }) =>
      id
        ? api.patch<{ data: InvoiceDetail }>(`/api/v1/invoices/${id}`, data)
        : api.post<{ data: InvoiceDetail }>('/api/v1/invoices', data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['invoicing'] }),
  })
}

export function useInvoiceAction() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      id,
      action,
      body,
    }: {
      id: string
      action: 'duplicate' | 'cancel' | 'void' | 'write-off'
      body?: Record<string, unknown>
    }) => api.post<{ data: InvoiceDetail }>(`/api/v1/invoices/${id}/${action}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['invoicing'] }),
  })
}

// ─── Send / payments / public (Sprint 4) ────────────────────────────────────

export function useSendInvoice() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ data: InvoiceDetail; meta: { public_url: string } }>(`/api/v1/invoices/${id}/send`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['invoicing'] }),
  })
}

export interface RecordPaymentInput {
  id: string
  amount: string
  payment_date?: string
  payment_method: string
  reference_number?: string
  notes?: string
}

export function useRecordPayment() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...data }: RecordPaymentInput) =>
      api.post<{ data: { payment_number: string }; meta: { invoice_status: string; overpaid: string } }>(
        `/api/v1/invoices/${id}/record-payment`,
        data,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['invoicing'] }),
  })
}

// ─── Public hosted invoice (no auth) ────────────────────────────────────────

export interface PublicInvoicePayload {
  invoice: {
    invoice_number: string
    status: string
    invoice_date: string
    due_date: string
    currency: string
    subtotal: string
    discount_amount: string | null
    taxable_amount: string
    cgst_amount: string | null
    sgst_amount: string | null
    igst_amount: string | null
    cess_amount: string | null
    total_amount: string
    tds_section: string | null
    tds_rate: string | null
    tds_amount: string | null
    net_receivable: string | null
    amount_paid: string | null
    amount_outstanding: string | null
    tax_treatment: string | null
    place_of_supply: string | null
    reference: string | null
    notes: string | null
    terms_and_conditions: string | null
  }
  line_items: Array<{
    line_number: number
    item_name: string
    description: string | null
    hsn_sac_code: string | null
    quantity: string
    unit: string | null
    rate: string
    gst_rate: string | null
    taxable_amount: string | null
    line_total: string | null
  }>
  customer: {
    display_name: string
    legal_name: string | null
    gstin: string | null
    billing_address_line1: string | null
    billing_address_line2: string | null
    billing_city: string | null
    billing_state: string | null
    billing_postal_code: string | null
    billing_country: string | null
  } | null
  seller: {
    name: string
    legal_name: string | null
    gstin: string | null
    address_line1: string | null
    address_line2: string | null
    city: string | null
    state_code: string | null
    postal_code: string | null
    logo_url: string | null
    brand_color: string | null
  } | null
  payment_options: {
    upi: { upi_id: string; display_name: string | null } | null
    razorpay: { key_id: string } | null
    bank_transfer: null
    allow_partial: boolean
  }
  show_powered_by: boolean
}

export function usePublicInvoice(token: string | undefined) {
  return useQuery({
    queryKey: ['public-invoice', token],
    queryFn: () => api.get<{ data: PublicInvoicePayload }>(`/api/v1/public/inv/${token}`),
    enabled: !!token,
    retry: 1,
  })
}

export function trackPublicView(token: string) {
  // Fire-and-forget view pixel; failures must never break the page.
  api.post(`/api/v1/public/inv/${token}/track`).catch(() => {})
}
