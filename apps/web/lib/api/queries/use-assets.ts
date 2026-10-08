'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, APIError, handleTenantMismatch, loginHref, silentRefresh, tenantHeaders } from '../client'
import type { IconKey } from '@/components/proto'
import type { PillTone } from '@/components/proto'

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'

/**
 * Company asset register (Round P R4) — HR registers equipment (laptop,
 * phone, SIM, ID card …) with a photo, tag and serial, assigns it to a person
 * (during onboarding or later), the person acknowledges receipt from
 * "My assets", HR records the return at exit. Every hook rides the
 * `['assets', …]` key tree; mutations invalidate the whole tree plus the
 * employee surfaces that show equipment (360 tab, removal preview).
 *
 * Routes: /api/v1/assets — see apps/api/src/modules/assets.
 */

// ─── Vocabulary (mirrors packages/db/src/schema/assets.ts) ───────────────────

export type AssetCategory =
  | 'laptop'
  | 'desktop'
  | 'monitor'
  | 'phone'
  | 'sim'
  | 'tablet'
  | 'id_card'
  | 'access_card'
  | 'keys'
  | 'peripheral'
  | 'furniture'
  | 'vehicle'
  | 'other'
export type AssetCondition = 'new' | 'good' | 'fair' | 'poor' | 'damaged'
export type AssetStatus = 'in_stock' | 'assigned' | 'under_repair' | 'retired' | 'lost'

export const ASSET_CATEGORIES: ReadonlyArray<{ value: AssetCategory; label: string; icon: IconKey }> = [
  { value: 'laptop', label: 'Laptop', icon: 'laptop' },
  { value: 'desktop', label: 'Desktop', icon: 'grid' },
  { value: 'monitor', label: 'Monitor', icon: 'image' },
  { value: 'phone', label: 'Phone', icon: 'phone' },
  { value: 'sim', label: 'SIM card', icon: 'wifi' },
  { value: 'tablet', label: 'Tablet', icon: 'sheet' },
  { value: 'id_card', label: 'ID card', icon: 'card' },
  { value: 'access_card', label: 'Access card', icon: 'key' },
  { value: 'keys', label: 'Keys', icon: 'key' },
  { value: 'peripheral', label: 'Peripheral', icon: 'keyboard' },
  { value: 'furniture', label: 'Furniture', icon: 'building' },
  { value: 'vehicle', label: 'Vehicle', icon: 'pin' },
  { value: 'other', label: 'Other', icon: 'tag' },
]

export const ASSET_CONDITIONS: ReadonlyArray<{ value: AssetCondition; label: string; tone: PillTone }> = [
  { value: 'new', label: 'New', tone: 'green' },
  { value: 'good', label: 'Good', tone: 'blue' },
  { value: 'fair', label: 'Fair', tone: 'yellow' },
  { value: 'poor', label: 'Poor', tone: 'coral' },
  { value: 'damaged', label: 'Damaged', tone: 'coral' },
]

export const ASSET_STATUSES: ReadonlyArray<{ value: AssetStatus; label: string; tone: PillTone }> = [
  { value: 'in_stock', label: 'In stock', tone: 'blue' },
  { value: 'assigned', label: 'Assigned', tone: 'green' },
  { value: 'under_repair', label: 'Under repair', tone: 'yellow' },
  { value: 'retired', label: 'Retired', tone: '' },
  { value: 'lost', label: 'Lost', tone: 'coral' },
]

export const assetCategoryLabel = (v: string | null | undefined) =>
  ASSET_CATEGORIES.find((c) => c.value === v)?.label ?? 'Other'
export const assetCategoryIcon = (v: string | null | undefined): IconKey =>
  ASSET_CATEGORIES.find((c) => c.value === v)?.icon ?? 'tag'
export const assetConditionMeta = (v: string | null | undefined) =>
  ASSET_CONDITIONS.find((c) => c.value === v) ?? ASSET_CONDITIONS[1]
export const assetStatusMeta = (v: string | null | undefined) =>
  ASSET_STATUSES.find((s) => s.value === v) ?? ASSET_STATUSES[0]

// ─── Types (mirror AssetsService responses) ──────────────────────────────────

export interface AssetAssignmentSummary {
  id: string
  employee_id: string
  employee_name: string
  employee_code: string | null
  /** Signed avatar URL of the holder, when they have one. */
  employee_avatar_url: string | null
  assigned_at: string
  assigned_by_name: string | null
  issue_condition: AssetCondition | null
  notes: string | null
  acknowledged_at: string | null
}

export interface Asset {
  id: string
  asset_tag: string
  name: string
  category: AssetCategory
  brand: string | null
  model: string | null
  serial_number: string | null
  /** 15-minute signed URLs of the 256 / 64 px photo variants; null without a photo. */
  photo_url: string | null
  photo_thumb_url: string | null
  purchase_date: string | null
  /** Decimal string from numeric(15,2), e.g. "54999.00". */
  purchase_value: string | null
  currency: string
  condition: AssetCondition
  status: AssetStatus
  notes: string | null
  created_at: string
  updated_at: string
  /** The open assignment, or null when nobody holds it. */
  current_assignment: AssetAssignmentSummary | null
}

export interface AssetHistoryRow extends AssetAssignmentSummary {
  returned_at: string | null
  returned_by_name: string | null
  return_condition: AssetCondition | null
  return_notes: string | null
}

export interface AssetDetail extends Asset {
  /** Every assignment, newest first (the open one first when present). */
  history: AssetHistoryRow[]
}

export interface AssetsSummary {
  total: number
  assigned: number
  in_stock: number
  under_repair: number
  retired: number
  lost: number
  /** Open assignments the holder has not acknowledged yet. */
  awaiting_acknowledgement: number
}

export interface MyAsset {
  asset: Omit<Asset, 'current_assignment'>
  assignment: {
    id: string
    assigned_at: string
    assigned_by_name: string | null
    issue_condition: AssetCondition | null
    notes: string | null
    acknowledged_at: string | null
  }
}

export interface EmployeeAssets {
  /** Open assignments (what they hold now). */
  current: Asset[]
  /** Returned assignments, newest first. */
  history: Array<AssetHistoryRow & { asset_id: string; asset_tag: string; asset_name: string; category: AssetCategory }>
}

export interface AssetsFilters {
  status?: AssetStatus | ''
  category?: AssetCategory | ''
  employee_id?: string
  q?: string
  limit?: number
  offset?: number
}

export interface CreateAssetPayload {
  /** Blank → the server assigns the next free AST-NNNN. */
  asset_tag?: string
  name: string
  category: AssetCategory
  brand?: string | null
  model?: string | null
  serial_number?: string | null
  purchase_date?: string | null
  purchase_value?: string | number | null
  currency?: string
  condition?: AssetCondition
  notes?: string | null
}

/** Everything optional; `status` only among in_stock | under_repair | retired | lost and only while nobody holds it. */
export type UpdateAssetPayload = Partial<CreateAssetPayload> & {
  status?: Exclude<AssetStatus, 'assigned'>
}

export interface AssignAssetPayload {
  employee_id: string
  /** ISO date-time; defaults to now. */
  assigned_at?: string
  issue_condition?: AssetCondition
  notes?: string | null
}

export interface ReturnAssetPayload {
  return_condition: AssetCondition
  return_notes?: string | null
  /** Where the asset goes after the return; defaults to in_stock. */
  next_status?: Exclude<AssetStatus, 'assigned'>
}

export const ASSETS_KEY = ['assets'] as const
export const ASSETS_PAGE_MAX = 100

// ─── Queries ─────────────────────────────────────────────────────────────────

function qs(filters?: AssetsFilters): string {
  if (!filters) return ''
  const p = new URLSearchParams()
  if (filters.status) p.set('status', filters.status)
  if (filters.category) p.set('category', filters.category)
  if (filters.employee_id) p.set('employee_id', filters.employee_id)
  if (filters.q?.trim()) p.set('q', filters.q.trim())
  p.set('limit', String(filters.limit ?? ASSETS_PAGE_MAX))
  if (filters.offset) p.set('offset', String(filters.offset))
  const s = p.toString()
  return s ? `?${s}` : ''
}

/** Register list (admin). `total` is the real count; the page shows the first `limit`. */
export function useAssets(filters?: AssetsFilters, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ['assets', 'list', filters ?? {}],
    queryFn: () => api.get<{ data: Asset[]; total: number }>(`/api/v1/assets${qs(filters)}`),
    enabled: options?.enabled ?? true,
  })
}

export function useAssetsSummary(enabled = true) {
  return useQuery({
    queryKey: ['assets', 'summary'],
    queryFn: () => api.get<{ data: AssetsSummary }>('/api/v1/assets/summary'),
    enabled,
  })
}

/** Next free tag (AST-0001 …) for the Add form; computed over every tag ever used, deleted rows included. */
export function useNextAssetTag(enabled = true) {
  return useQuery({
    queryKey: ['assets', 'next-tag'],
    queryFn: () => api.get<{ data: { asset_tag: string } }>('/api/v1/assets/next-tag'),
    enabled,
    staleTime: 0,
  })
}

export function useAsset(id: string | null | undefined) {
  return useQuery({
    queryKey: ['assets', 'detail', id],
    queryFn: () => api.get<{ data: AssetDetail }>(`/api/v1/assets/${id}`),
    enabled: !!id,
    retry: (count, err) => !(err instanceof APIError && (err.status === 404 || err.status === 403)) && count < 2,
  })
}

/** What one employee holds now + what they returned (employee 360 tab, offboarding dialog, removal preview). */
export function useEmployeeAssets(employeeId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['assets', 'employee', employeeId],
    queryFn: () => api.get<{ data: EmployeeAssets }>(`/api/v1/assets/by-employee/${employeeId}`),
    enabled: !!employeeId && enabled,
  })
}

/** The signed-in person's equipment. Any member may call it; seats without an employee record get []. */
export function useMyAssets(enabled = true) {
  return useQuery({
    queryKey: ['assets', 'me'],
    queryFn: () => api.get<{ data: MyAsset[] }>('/api/v1/assets/me'),
    enabled,
    staleTime: 60_000,
    // A guest seat is denied (403) and a removed record 404s — render the
    // honest state at once instead of retrying three times behind a skeleton.
    retry: (count, err) => !(err instanceof APIError && (err.status === 404 || err.status === 403)) && count < 2,
  })
}

// ─── Mutations ───────────────────────────────────────────────────────────────

export function invalidateAssets(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: [...ASSETS_KEY] })
  // The employee 360 / removal preview show equipment counts too.
  void qc.invalidateQueries({ queryKey: ['employees'] })
}

export function useCreateAsset() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: CreateAssetPayload) => api.post<{ data: Asset }>('/api/v1/assets', payload),
    onSuccess: () => invalidateAssets(qc),
  })
}

export function useUpdateAsset() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: UpdateAssetPayload }) =>
      api.patch<{ data: AssetDetail }>(`/api/v1/assets/${id}`, payload),
    onSuccess: (res) => {
      qc.setQueryData(['assets', 'detail', res.data.id], res)
      invalidateAssets(qc)
    },
  })
}

/**
 * Multipart photo upload (field `file`, ≤ 8 MB JPG/PNG/WebP; the server
 * re-encodes to 256 + 64 px WebP like avatars). Dedicated fetch because the
 * JSON client's Content-Type breaks FormData; cookies ride via
 * credentials: 'include' and a lapsed access cookie is redeemed once through
 * the shared silent refresh.
 */
async function uploadAssetPhoto(assetId: string, blob: Blob): Promise<{ data: AssetDetail }> {
  const form = new FormData()
  form.append('file', blob, 'photo.webp')
  const send = () =>
    fetch(`${BASE_URL}/api/v1/assets/${assetId}/photo`, { method: 'POST', credentials: 'include', headers: tenantHeaders(), body: form })
  let res = await send()
  if (res.status === 401 && (await silentRefresh())) res = await send()
  if (res.status === 401) {
    if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
      window.location.href = loginHref()
    }
    throw new APIError(401, 'Your session expired — sign in again to upload.')
  }
  const json = (await res.json().catch(() => ({}))) as { message?: string | string[]; code?: string; data?: AssetDetail }
  if (res.status === 409 && json.code === 'TENANT_MISMATCH') handleTenantMismatch()
  if (!res.ok) {
    const message = Array.isArray(json.message) ? json.message.join(', ') : json.message
    const friendly = res.status === 429 ? 'Too many uploads — wait a minute and try again.' : message
    throw new APIError(res.status, friendly ?? `Upload failed (${res.status})`, json)
  }
  return json as { data: AssetDetail }
}

export function useUploadAssetPhoto(assetId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (blob: Blob) => uploadAssetPhoto(assetId, blob),
    onSuccess: (res) => {
      qc.setQueryData(['assets', 'detail', assetId], res)
      invalidateAssets(qc)
    },
  })
}

/**
 * Same upload, keyed per call instead of per hook — for the Add form, where
 * the asset id only exists once the create has returned.
 */
export function useUploadAssetPhotoById() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, blob }: { id: string; blob: Blob }) => uploadAssetPhoto(id, blob),
    onSuccess: (res) => {
      qc.setQueryData(['assets', 'detail', res.data.id], res)
      invalidateAssets(qc)
    },
  })
}

export function useRemoveAssetPhoto() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.post<{ data: AssetDetail }>(`/api/v1/assets/${id}/photo/remove`, {}),
    onSuccess: (res) => {
      qc.setQueryData(['assets', 'detail', res.data.id], res)
      invalidateAssets(qc)
    },
  })
}

/** Hand the asset to a person. 409 ASSET_ALREADY_ASSIGNED when someone holds it; 400 when the person has left. */
export function useAssignAsset() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: AssignAssetPayload }) =>
      api.post<{ data: AssetDetail }>(`/api/v1/assets/${id}/assign`, payload),
    onSuccess: (res) => {
      qc.setQueryData(['assets', 'detail', res.data.id], res)
      invalidateAssets(qc)
    },
  })
}

/** Take it back. 409 ASSET_NOT_ASSIGNED when nobody holds it. */
export function useReturnAsset() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: ReturnAssetPayload }) =>
      api.post<{ data: AssetDetail }>(`/api/v1/assets/${id}/return`, payload),
    onSuccess: (res) => {
      qc.setQueryData(['assets', 'detail', res.data.id], res)
      invalidateAssets(qc)
    },
  })
}

/** "I received this." Only the current holder may call it; idempotent. */
export function useAcknowledgeAsset() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ data: { asset_id: string; acknowledged_at: string } }>(`/api/v1/assets/${id}/acknowledge`, {}),
    onSuccess: () => invalidateAssets(qc),
  })
}

/** Soft delete. 409 ASSET_ASSIGNED while somebody holds it ("Return it first"). */
export function useDeleteAsset() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.post<{ data: { deleted: true } }>(`/api/v1/assets/${id}/delete`, {}),
    onSuccess: () => invalidateAssets(qc),
  })
}

// ─── CSV export ──────────────────────────────────────────────────────────────

/** Download the register as CSV (tag, name, category, brand, model, serial, status, condition, holder, assigned on, acknowledged, purchase date, value). */
export async function downloadAssetsCsv(): Promise<void> {
  const { blob, filename } = await api.download('/api/v1/assets/export.csv')
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename ?? 'assets.csv'
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export function useExportAssetsCsv() {
  return useMutation({ mutationFn: () => downloadAssetsCsv() })
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function formatAssetValue(value: string | number | null | undefined, currency = 'INR'): string {
  if (value === null || value === undefined || value === '') return ''
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return ''
  try {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n)
  } catch {
    return `${currency} ${n.toFixed(0)}`
  }
}
