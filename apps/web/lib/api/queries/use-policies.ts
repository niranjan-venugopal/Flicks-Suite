'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, APIError, handleTenantMismatch, loginHref, silentRefresh, tenantHeaders } from '../client'
import { useModuleAccess } from './use-auth'
import { useAuthStore } from '@/lib/stores/auth.store'

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'

/**
 * Company policies (Round P R3) — HR writes rich text or uploads a PDF,
 * publishes, and asks employees to agree. Every hook here rides the
 * `['policies', …]` key tree; every mutation invalidates the whole tree
 * (the list counts, the detail, the acknowledgement roster and the
 * employee's pending list all move together).
 *
 * Routes: /api/v1/policies — see apps/api/src/modules/policies.
 */

// ─── Types (mirror PoliciesService) ──────────────────────────────────────────

export type PolicyKind = 'rich_text' | 'pdf'
export type PolicyStatus = 'draft' | 'published' | 'archived'
/** The standard roles a policy can target — guest/auditor are never asked. */
export type PolicyTargetRole = 'owner' | 'admin' | 'manager' | 'finance' | 'employee'

export interface Policy {
  id: string
  title: string
  category: string | null
  kind: PolicyKind
  version: number
  status: PolicyStatus
  requires_acknowledgement: boolean
  /** null = every standard role. */
  applies_to_roles: string[] | null
  published_at: string | null
  archived_at: string | null
  updated_at: string
  file_name: string | null
  file_size_bytes: number | null
  /** Acknowledgements of the CURRENT version by applicable ACTIVE members. */
  signed_count: number
  /** Applicable ACTIVE members still to agree (archived/draft → 0). */
  pending_count: number
  /** When HR last sent a reminder (1/hour throttle marker); absent on older APIs. */
  last_reminded_at?: string | null
}

export interface PolicyDetail extends Policy {
  body_md: string | null
  /**
   * Where to open the PDF: the API's own route (`/api/v1/policies/:id/file`,
   * a signed redirect behind the sign-in — Round R); null for rich text /
   * unconfigured storage. PolicyReader resolves it against the API origin.
   */
  file_url: string | null
}

export interface PendingPolicy {
  id: string
  title: string
  category: string | null
  kind: PolicyKind
  version: number
  published_at: string | null
  body_md: string | null
  file_url: string | null
}

export interface PolicyAckMember {
  user_id: string
  name: string
  email: string
  role: string
}

export interface PolicyAcknowledgements {
  version: number
  signed: Array<PolicyAckMember & { acknowledged_at: string }>
  pending: PolicyAckMember[]
}

export interface PolicyHistoryRow {
  policy_id: string
  title: string
  version: number
  acknowledged_at: string
}

export interface CreatePolicyPayload {
  title: string
  kind: PolicyKind
  body_md?: string | null
  category?: string | null
  requires_acknowledgement?: boolean
  applies_to_roles?: PolicyTargetRole[] | null
}

export type UpdatePolicyPayload = Partial<CreatePolicyPayload>

export const POLICIES_KEY = ['policies'] as const

// ─── Access ──────────────────────────────────────────────────────────────────

/**
 * Who may open the HR side (/settings/policies), mirroring the API's
 * PoliciesGrantGuard: Owner / HR admin by role, anyone else through the
 * `policies` grant the Owner sets in Settings → Module access. `loaded` is
 * false while /me is still in flight for a grant-driven seat, so the pages
 * show a skeleton instead of a premature "no access" card. An API older
 * than 0067 sends no `policies` key, which reads as 'none'.
 */
export function usePoliciesAccess(): { loaded: boolean; canView: boolean; canEdit: boolean } {
  const { currentUser } = useAuthStore()
  const access = useModuleAccess()
  const role = currentUser?.role
  if (role === 'OWNER' || role === 'HR_ADMIN') return { loaded: true, canView: true, canEdit: true }
  if (!access) return { loaded: false, canView: false, canEdit: false }
  const level = access.policies ?? 'none'
  return { loaded: true, canView: level !== 'none', canEdit: level === 'edit' }
}

// ─── Queries ─────────────────────────────────────────────────────────────────

/** Management list (policies:view) — every policy with signed / pending counts. */
export function usePolicies(enabled = true) {
  return useQuery({
    queryKey: ['policies', 'list'],
    queryFn: () => api.get<{ data: Policy[] }>('/api/v1/policies'),
    enabled,
  })
}

/**
 * One policy. A view-grant holder gets any status; everyone else only a
 * published policy that applies to their role (else 404 → isError).
 */
export function usePolicy(id: string | null | undefined) {
  return useQuery({
    queryKey: ['policies', 'detail', id],
    queryFn: () => api.get<{ data: PolicyDetail }>(`/api/v1/policies/${id}`),
    enabled: !!id,
    retry: (count, err) => !(err instanceof APIError && (err.status === 404 || err.status === 403)) && count < 2,
  })
}

/** Signed / pending roster for the policy's CURRENT version (policies:view). */
export function usePolicyAcks(id: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['policies', 'acks', id],
    queryFn: () =>
      api.get<{ data: PolicyAcknowledgements }>(`/api/v1/policies/${id}/acknowledgements`),
    enabled: !!id && enabled,
  })
}

/**
 * Policies the caller still has to agree to (oldest first). Any tenant member
 * may call it; guests / auditors / platform admins get []. `enabled` lets the
 * gate and the onboarding wizard skip the request for seats it never applies to.
 */
export function usePendingPolicies(enabled = true) {
  return useQuery({
    queryKey: ['policies', 'pending'],
    queryFn: () => api.get<{ data: PendingPolicy[] }>('/api/v1/policies/pending'),
    enabled,
    staleTime: 60_000,
  })
}

/** Every policy version the caller acknowledged, newest first. */
export function useMyPolicyHistory(enabled = true) {
  return useQuery({
    queryKey: ['policies', 'me', 'history'],
    queryFn: () => api.get<{ data: PolicyHistoryRow[] }>('/api/v1/policies/me/history'),
    enabled,
  })
}

// ─── Mutations ───────────────────────────────────────────────────────────────

function invalidatePolicies(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: [...POLICIES_KEY] })
}

export function useCreatePolicy() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: CreatePolicyPayload) =>
      api.post<{ data: PolicyDetail }>('/api/v1/policies', payload),
    onSuccess: () => invalidatePolicies(qc),
  })
}

export function useUpdatePolicy() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: UpdatePolicyPayload }) =>
      api.patch<{ data: PolicyDetail }>(`/api/v1/policies/${id}`, payload),
    onSuccess: (res) => {
      // Seed the detail cache so the editor repaints before the refetch.
      qc.setQueryData(['policies', 'detail', res.data.id], res)
      invalidatePolicies(qc)
    },
  })
}

/**
 * Multipart PDF upload (field `file`). The JSON api client sets
 * Content-Type: application/json, which breaks FormData boundaries, so this
 * goes through a dedicated fetch — cookies ride via credentials: 'include'
 * and a lapsed 15-minute access cookie is redeemed once through the same
 * single-flight silent refresh the JSON client uses.
 */
async function uploadPolicyPdf(policyId: string, file: File): Promise<{ data: PolicyDetail }> {
  const form = new FormData()
  form.append('file', file, file.name || 'policy.pdf')
  const send = () =>
    fetch(`${BASE_URL}/api/v1/policies/${policyId}/file`, {
      method: 'POST',
      credentials: 'include',
      // Round R: company-bound like every JSON call (no Content-Type — FormData boundary)
      headers: tenantHeaders(),
      body: form,
    })
  let res = await send()
  if (res.status === 401 && (await silentRefresh())) res = await send()
  if (res.status === 401) {
    // The session really is gone — recover exactly like the JSON client:
    // back to sign-in, carrying this page as ?next= so they land back here.
    if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
      window.location.href = loginHref()
    }
    throw new APIError(401, 'Your session expired — sign in again to upload.')
  }
  const json = (await res.json().catch(() => ({}))) as {
    message?: string | string[]
    code?: string
    data?: PolicyDetail
  }
  if (res.status === 409 && json.code === 'TENANT_MISMATCH') handleTenantMismatch()
  if (!res.ok) {
    const message = Array.isArray(json.message) ? json.message.join(', ') : json.message
    // The route is @Throttle(5/min); Nest answers with a bare
    // "ThrottlerException: Too Many Requests" — say it in plain words.
    const friendly =
      res.status === 429 ? 'Too many uploads — wait a minute and try again.' : message
    throw new APIError(res.status, friendly ?? `Upload failed (${res.status})`, json)
  }
  return json as { data: PolicyDetail }
}

export function useUploadPolicyFile(policyId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (file: File) => uploadPolicyPdf(policyId, file),
    onSuccess: (res) => {
      qc.setQueryData(['policies', 'detail', policyId], res)
      invalidatePolicies(qc)
    },
  })
}

export function usePublishPolicy() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, require_reacknowledgement }: { id: string; require_reacknowledgement?: boolean }) =>
      api.post<{ data: PolicyDetail; notified: number }>(`/api/v1/policies/${id}/publish`, {
        ...(require_reacknowledgement !== undefined ? { require_reacknowledgement } : {}),
      }),
    onSuccess: (res) => {
      qc.setQueryData(['policies', 'detail', res.data.id], { data: res.data })
      invalidatePolicies(qc)
    },
  })
}

/**
 * Round R — Delete (Owner / HR admin). The policy is gone everywhere and its
 * PDF removed; the record of who agreed is kept; the deletion is audited.
 */
export function useDeletePolicy() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ data: { id: string; deleted: true } }>(`/api/v1/policies/${id}/delete`, {}),
    onSuccess: (res) => {
      qc.removeQueries({ queryKey: ['policies', 'detail', res.data.id] })
      invalidatePolicies(qc)
    },
  })
}

export function useArchivePolicy() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ data: PolicyDetail }>(`/api/v1/policies/${id}/archive`, {}),
    onSuccess: (res) => {
      qc.setQueryData(['policies', 'detail', res.data.id], res)
      invalidatePolicies(qc)
    },
  })
}

/**
 * Remind everyone still pending (in-app + email). The API allows one
 * reminder per policy per hour — a 429 carries code REMIND_TOO_SOON and a
 * message the UI shows verbatim.
 */
export function useRemindPolicy() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ data: { reminded: number } }>(`/api/v1/policies/${id}/remind`, {}),
    onSuccess: () => invalidatePolicies(qc),
  })
}

/**
 * "I have read and agree." Idempotent server-side; a 409 POLICY_VERSION_STALE
 * means the policy moved on while it was open — refetch and read again.
 */
export function useAcknowledgePolicy() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, version }: { id: string; version: number }) =>
      api.post<{ data: { policy_id: string; version: number; acknowledged_at: string } }>(
        `/api/v1/policies/${id}/acknowledge`,
        { version },
      ),
    onSuccess: () => invalidatePolicies(qc),
  })
}

// ─── CSV export ──────────────────────────────────────────────────────────────

/**
 * Download the acknowledgement roster as CSV (name,email,role,status,
 * acknowledged_at). Cookie-authed fetch → blob → anchor click, the same
 * pattern as the invoice PDF / data-export downloads.
 */
export async function downloadPolicyAcksCsv(policyId: string, title?: string): Promise<void> {
  const { blob, filename } = await api.download(
    `/api/v1/policies/${policyId}/acknowledgements?format=csv`,
  )
  const safeTitle = (title ?? 'policy')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename ?? `${safeTitle || 'policy'}-acknowledgements.csv`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export function useExportPolicyAcksCsv() {
  return useMutation({
    mutationFn: ({ id, title }: { id: string; title?: string }) => downloadPolicyAcksCsv(id, title),
  })
}

// ─── Helpers shared by the HR and employee surfaces ──────────────────────────

/**
 * Human label for a target-role set (null/[] = everyone). The workspace-owner
 * role is DISPLAYED as "Admin" everywhere in the app (founder decision — see
 * roleLabel in lib/stores/auth.store.ts and Settings → Roles), so the editor's
 * audience chip, these captions and the roster pills all say "Admins". Proper
 * nouns ("HR admins") — never lower-case the output.
 */
export const POLICY_TARGET_ROLE_LABELS: Record<PolicyTargetRole, string> = {
  owner: 'Admins',
  admin: 'HR admins',
  manager: 'Managers',
  finance: 'Finance',
  employee: 'Employees',
}

export function policyAudienceLabel(roles: string[] | null | undefined): string {
  if (!roles || roles.length === 0) return 'Everyone'
  const labels = roles
    .map((r) => POLICY_TARGET_ROLE_LABELS[r as PolicyTargetRole] ?? r)
    .filter((v, i, arr) => arr.indexOf(v) === i)
  return labels.join(' · ')
}

export function formatFileSize(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
