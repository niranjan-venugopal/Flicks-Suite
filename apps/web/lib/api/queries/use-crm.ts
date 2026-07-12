'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
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
