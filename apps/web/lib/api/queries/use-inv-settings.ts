'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../client'

/**
 * Invoicing settings + setup-wizard hooks (Sprint 9, PRD §7.1/§11) and the FAM
 * module-toggle / auditor-registry / metrics hooks (§10).
 */

// ─── Invoicing settings ───────────────────────────────────────────────────────

export interface InvSettings {
  id: string
  default_currency: string
  default_payment_terms_days: number
  default_gst_rate: string
  default_invoice_notes: string | null
  default_terms_and_conditions: string | null
  invoice_template: string
  brand_color_override: string | null
  show_gstin_on_pdf: boolean
  show_tds_section_on_pdf: boolean
  show_upi_qr_on_pdf: boolean
  show_powered_by_footer: boolean
  email_sender_name: string | null
  email_reply_to: string | null
  email_signature: string | null
  cc_owner_on_customer_emails: boolean
  additional_cc_emails: string[] | null
  upi_id: string | null
  upi_display_name: string | null
  allow_partial_payments: boolean
  filing_frequency: string
  declared_aato: string | null
  composition_scheme: boolean
  default_tds_section: string | null
  default_tds_payment_code: string | null
  default_tds_rate: string | null
  auto_suggest_tds: boolean
  razorpay_webhook_configured: boolean
}

export type InvSettingsPatch = Partial<
  Omit<InvSettings, 'id' | 'razorpay_webhook_configured'>
>

export function useInvSettings() {
  return useQuery({
    queryKey: ['invoicing', 'settings'],
    queryFn: () => api.get<{ data: InvSettings }>('/api/v1/invoicing/settings'),
    staleTime: 60_000,
  })
}

export function useUpdateInvSettings() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (patch: InvSettingsPatch) =>
      api.patch<{ data: InvSettings }>('/api/v1/invoicing/settings', patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['invoicing', 'settings'] }),
  })
}

// ─── Setup wizard ──────────────────────────────────────────────────────────────

export interface SetupProgress {
  id: string
  current_step: string | null
  wizard_started_at: string | null
  wizard_completed_at: string | null
  business_details_confirmed: boolean
  upi_configured: boolean
  razorpay_connected: boolean
  template_chosen: boolean
  numbering_configured: boolean
  payment_terms_set: boolean
  currencies_enabled: boolean
  default_gst_set: boolean
  default_notes_set: boolean
  email_signature_set: boolean
  reminder_schedule_set: boolean
  first_invoice_sent_at: string | null
  completed_steps: number
  total_steps: number
  percent_complete: number
  is_complete: boolean
}

export type SetupStepKey =
  | 'business_details_confirmed'
  | 'upi_configured'
  | 'razorpay_connected'
  | 'template_chosen'
  | 'numbering_configured'
  | 'payment_terms_set'
  | 'currencies_enabled'
  | 'default_gst_set'
  | 'default_notes_set'
  | 'email_signature_set'
  | 'reminder_schedule_set'

export function useSetupProgress() {
  return useQuery({
    queryKey: ['invoicing', 'setup-progress'],
    queryFn: () =>
      api.get<{ data: SetupProgress }>('/api/v1/invoicing/setup-progress'),
    staleTime: 30_000,
  })
}

export function useUpdateSetupProgress() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (patch: Partial<Record<SetupStepKey | 'current_step', boolean | string>>) =>
      api.patch<{ data: SetupProgress }>('/api/v1/invoicing/setup-progress', patch),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['invoicing', 'setup-progress'] }),
  })
}

export function useCompleteWizard() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () =>
      api.post<{ data: SetupProgress }>('/api/v1/invoicing/setup-progress/complete', {}),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['invoicing', 'setup-progress'] }),
  })
}

// ─── FAM: module toggles, auditor registry, seats, metrics (§10) ────────────────

export interface TenantModule {
  module: string
  enabled: boolean
  live: boolean
  updatedAt: string | null
}

export function useTenantModules(tenantId: string | null) {
  return useQuery({
    queryKey: ['fam', 'modules', tenantId],
    queryFn: () =>
      api.get<{ data: TenantModule[] }>(`/api/v1/fam/tenants/${tenantId}/modules`),
    enabled: !!tenantId,
  })
}

export function useToggleModule(tenantId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ module, enabled }: { module: string; enabled: boolean }) =>
      api.patch(`/api/v1/fam/tenants/${tenantId}/modules/${module}`, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['fam', 'modules', tenantId] }),
  })
}

export interface AuditorRegistryEntry {
  userId: string
  email: string | null
  fullName: string | null
  companies: Array<{
    tenantId: string
    tenantName: string
    status: string
    isExternal: boolean
    accessExpiresAt: string | null
  }>
}

export function useAuditorRegistry() {
  return useQuery({
    queryKey: ['fam', 'auditors'],
    queryFn: () => api.get<{ data: AuditorRegistryEntry[] }>('/api/v1/fam/auditors'),
    staleTime: 30_000,
  })
}

export function useRevokeAuditorLink() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ userId, tenantId }: { userId: string; tenantId: string }) =>
      api.delete(`/api/v1/fam/auditors/${userId}/companies/${tenantId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['fam', 'auditors'] }),
  })
}

export interface InvoicingMetrics {
  tenantsWithAuditor: number
  multiCompanyAuditors: number
  medianCompaniesPerAuditor: number
  tenantsWithBankAccount: number
  tenantsUsingForeignCurrency: number
  tenantsWithInvoices: number
}

export function useInvoicingMetrics() {
  return useQuery({
    queryKey: ['fam', 'invoicing-metrics'],
    queryFn: () => api.get<{ data: InvoicingMetrics }>('/api/v1/fam/invoicing-metrics'),
    staleTime: 60_000,
  })
}
