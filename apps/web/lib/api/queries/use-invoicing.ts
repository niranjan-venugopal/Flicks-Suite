'use client'

import { useQuery } from '@tanstack/react-query'
import { api } from '../client'

/**
 * Invoicing React Query hooks (scaffold). Type contracts + wiring to the API
 * envelope { data, meta }. Concrete list/detail/mutation hooks are fleshed out
 * per resource in Sprints 2–3; these establish the shape the pages will consume.
 */

export interface Paginated<T> {
  data: T[]
  meta: { page: number; limit: number; total: number }
}

export interface CustomerRow {
  id: string
  customer_code: string
  display_name: string
  email?: string | null
  status: string
}

export interface ItemRow {
  id: string
  item_code: string
  name: string
  default_rate: string
  status: string
}

export interface InvoiceRow {
  id: string
  invoice_number: string
  status: string
  total_amount: string
  currency: string
  due_date: string
}

export function useCustomers(params: { page?: number; q?: string } = {}) {
  const qs = new URLSearchParams()
  if (params.page) qs.set('page', String(params.page))
  if (params.q) qs.set('q', params.q)
  return useQuery({
    queryKey: ['invoicing', 'customers', params],
    queryFn: () =>
      api.get<Paginated<CustomerRow>>(`/api/v1/customers?${qs.toString()}`),
    enabled: false, // Sprint 2 turns these on
  })
}

export function useItems(params: { page?: number; q?: string } = {}) {
  const qs = new URLSearchParams()
  if (params.page) qs.set('page', String(params.page))
  if (params.q) qs.set('q', params.q)
  return useQuery({
    queryKey: ['invoicing', 'items', params],
    queryFn: () =>
      api.get<Paginated<ItemRow>>(`/api/v1/items?${qs.toString()}`),
    enabled: false,
  })
}

export function useInvoices(params: { page?: number; status?: string } = {}) {
  const qs = new URLSearchParams()
  if (params.page) qs.set('page', String(params.page))
  if (params.status) qs.set('status', params.status)
  return useQuery({
    queryKey: ['invoicing', 'invoices', params],
    queryFn: () =>
      api.get<Paginated<InvoiceRow>>(`/api/v1/invoices?${qs.toString()}`),
    enabled: false,
  })
}
