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
  bank_account_id?: string
  document_type?: 'INVOICE' | 'QUOTE'
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
  params: { page?: number; q?: string; status?: string; customer_id?: string; document_type?: string } = {},
) {
  const qs = new URLSearchParams()
  if (params.page) qs.set('page', String(params.page))
  if (params.q) qs.set('q', params.q)
  if (params.status) qs.set('status', params.status)
  if (params.customer_id) qs.set('customer_id', params.customer_id)
  if (params.document_type) qs.set('document_type', params.document_type)
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
      action: 'duplicate' | 'cancel' | 'void' | 'write-off' | 'convert-to-invoice'
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
    bank_transfer: {
      beneficiary_name: string
      account_number: string
      account_type: string | null
      bank_name: string
      branch: string | null
      ifsc: string | null
      swift_bic: string | null
      bank_address: string | null
    } | null
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

// ─── Organization → Financial + bank accounts (Sprint 5) ───────────────────

export interface OrgFinancial {
  name: string
  legal_name: string | null
  gstin: string | null
  pan: string | null
  cin: string | null
  fiscal_year_start_month: number
  currency: string
  address_line1: string | null
  address_line2: string | null
  city: string | null
  state_code: string | null
  postal_code: string | null
}

export interface BankAccount {
  id: string
  beneficiary_name: string
  account_number: string
  account_type: string
  bank_name: string
  branch: string | null
  ifsc: string | null
  swift_bic: string | null
  bank_address: string | null
  is_default: boolean
  is_active: boolean
}

export type BankAccountInput = Partial<Omit<BankAccount, 'id'>> & {
  beneficiary_name: string
  account_number: string
  bank_name: string
}

export function useOrgFinancial() {
  return useQuery({
    queryKey: ['org-financial'],
    queryFn: () => api.get<{ data: OrgFinancial }>('/api/v1/org/financial'),
  })
}

export function useUpdateOrgFinancial() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data: Partial<OrgFinancial>) =>
      api.patch<{ data: OrgFinancial }>('/api/v1/org/financial', data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['org-financial'] }),
  })
}

export function useBankAccounts() {
  return useQuery({
    queryKey: ['org-financial', 'bank-accounts'],
    queryFn: () =>
      api.get<{ data: BankAccount[]; meta: { currency_defaults: Record<string, string> } }>(
        '/api/v1/org/financial/bank-accounts',
      ),
  })
}

export function useSaveBankAccount() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...data }: BankAccountInput & { id?: string }) =>
      id
        ? api.patch<{ data: BankAccount; warning?: string }>(`/api/v1/org/financial/bank-accounts/${id}`, data)
        : api.post<{ data: BankAccount; warning?: string }>('/api/v1/org/financial/bank-accounts', data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['org-financial'] }),
  })
}

export function useBankAccountAction() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'set-default' | 'delete' }) =>
      action === 'delete'
        ? api.delete(`/api/v1/org/financial/bank-accounts/${id}`)
        : api.post(`/api/v1/org/financial/bank-accounts/${id}/set-default`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['org-financial'] }),
  })
}

export function useSetCurrencyDefault() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { currency: string; bank_account_id: string }) =>
      api.put('/api/v1/org/financial/currency-default', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['org-financial'] }),
  })
}

// ─── Notes / payments / reports (Sprint 6) ──────────────────────────────────

export interface NoteRow {
  id: string
  number: string
  date: string
  reason: string
  status: string
  currency: string
  total_amount: string
  customer_name: string | null
  invoice_number: string | null
}

export function useNotes() {
  return useQuery({
    queryKey: ['invoicing', 'notes'],
    queryFn: () => api.get<{ data: { credit: NoteRow[]; debit: NoteRow[] } }>('/api/v1/credit-notes'),
  })
}

export function useIssueNote() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ kind, ...data }: { kind: 'credit' | 'debit'; invoice_id?: string; reason: string; amount: string }) =>
      api.post<{ data: NoteRow }>(`/api/v1/${kind}-notes`, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['invoicing'] }),
  })
}

export interface PaymentRow {
  id: string
  payment_number: string
  payment_date: string
  amount: string
  currency: string
  payment_method: string
  reference_number: string | null
  source: string
  invoice_id: string | null
  invoice_number: string | null
  customer_name: string | null
}

export function usePayments() {
  return useQuery({
    queryKey: ['invoicing', 'payments'],
    queryFn: () => api.get<Paginated<PaymentRow>>('/api/v1/payments'),
  })
}

export interface AgingData {
  buckets: { bucket: string; amount: string }[]
  total: string
}

export function useAging() {
  return useQuery({
    queryKey: ['invoicing', 'reports', 'aging'],
    queryFn: () => api.get<{ data: AgingData }>('/api/v1/invoicing/reports/aging'),
  })
}

export function useInvDashboard() {
  return useQuery({
    queryKey: ['invoicing', 'reports', 'dashboard'],
    queryFn: () =>
      api.get<{ data: { total: number; open: number; overdue: number; paid: number; outstanding: string; collected: string; tds: string } }>(
        '/api/v1/invoicing/reports/dashboard',
      ),
  })
}

export function useTdsReceivable() {
  return useQuery({
    queryKey: ['invoicing', 'reports', 'tds'],
    queryFn: () =>
      api.get<{ data: unknown[]; meta: { total: string; count: number } }>('/api/v1/invoicing/reports/tds-receivable'),
  })
}

export interface Gstr1Summary {
  b2b: { count: number; taxable: string; tax: string }
  b2cl: { count: number; taxable: string; tax: string }
  b2cs: { count: number; taxable: string; tax: string }
  exp: { count: number; taxable: string; tax: string }
  cdnr: { count: number; taxable: string }
}

export function useGenerateGstr1() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { period_month: number; period_year: number }) =>
      api.post<{ data: { export: { id: string; file_hash: string }; payload: unknown; summary: Gstr1Summary } }>(
        '/api/v1/invoicing/reports/gstr1/generate',
        input,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['invoicing', 'reports'] }),
  })
}

// ─── Subscriptions (Sprint 7) ───────────────────────────────────────────────

export interface SubscriptionRow {
  id: string
  name: string
  status: string
  pricing_model: string
  currency: string
  flat_amount: string | null
  seat_rate: string | null
  seat_count: number | null
  billing_period: string
  next_billing_date: string | null
  total_cycles_billed: number | null
  failed_charge_count: number | null
  mandate_authorized_at: string | null
  customer_name: string | null
  customer_id: string
}

export interface SubscriptionInput {
  customer_id: string
  name: string
  pricing_model: 'flat_rate' | 'per_seat'
  flat_amount?: string
  seat_rate?: string
  seat_count?: number
  billing_period: 'monthly' | 'quarterly' | 'annually'
  start_date: string
  trial_days?: number
}

export function useSubscriptions() {
  return useQuery({
    queryKey: ['invoicing', 'subscriptions'],
    queryFn: () => api.get<{ data: SubscriptionRow[]; meta: { mrr: string } }>('/api/v1/subscriptions'),
  })
}

export function useCreateSubscription() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: SubscriptionInput) =>
      api.post<{ data: SubscriptionRow }>('/api/v1/subscriptions', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['invoicing', 'subscriptions'] }),
  })
}

export function useSubscriptionAction() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'activate' | 'pause' | 'resume' | 'cancel' }) =>
      api.post<{ data: SubscriptionRow }>(`/api/v1/subscriptions/${id}/${action}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['invoicing', 'subscriptions'] }),
  })
}

export function useUpdateSeats() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, seat_count }: { id: string; seat_count: number }) =>
      api.post<{ data: SubscriptionRow; meta: { proration: { amount: string } | null } }>(
        `/api/v1/subscriptions/${id}/update-seats`,
        { seat_count },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['invoicing', 'subscriptions'] }),
  })
}
