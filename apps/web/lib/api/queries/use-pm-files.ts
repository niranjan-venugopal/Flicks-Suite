'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, APIError, silentRefresh } from '../client'
import { useEffectiveFlags } from './use-auth'
import {
  chunk,
  PM_ACCEPTED_EXTENSIONS,
  PM_FILES_PER_REQUEST,
  type PmFile,
  type PmFileKind,
  type PmFileObjectType,
} from '@/lib/pm/files'

export type { PmFile, PmFileKind, PmFileObjectType } from '@/lib/pm/files'

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'

// ─────────────────────────────────────────────────────────
// Round L item 6 — PM attachment hooks. Uploads go through XHR (the JSON api
// client cannot send FormData, and fetch has no upload progress); cookies
// ride via withCredentials, and an expired access cookie recovers through
// the SAME single-flight silent refresh the api client uses.
// ─────────────────────────────────────────────────────────

export interface UploadPmFilesInput {
  objectType: PmFileObjectType
  objectId: string
  kind: PmFileKind
  files: File[]
  /** 0–100, called as bytes leave the browser (not server processing time). */
  onProgress?: (pct: number) => void
  signal?: AbortSignal
}

function xhrUpload(input: UploadPmFilesInput): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const form = new FormData()
    form.append('object_type', input.objectType)
    form.append('object_id', input.objectId)
    form.append('kind', input.kind)
    for (const f of input.files) form.append('files', f, f.name)

    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${BASE_URL}/api/v1/pm/uploads`)
    xhr.withCredentials = true
    xhr.responseType = 'text'
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && input.onProgress) {
        input.onProgress(Math.min(99, Math.round((e.loaded / e.total) * 100)))
      }
    }
    xhr.onerror = () => reject(new Error('Upload failed — check your connection and try again.'))
    xhr.onabort = () => reject(new Error('Upload cancelled'))
    xhr.onload = () => {
      let body: unknown = null
      try {
        body = xhr.responseText ? JSON.parse(xhr.responseText) : null
      } catch {
        body = null
      }
      resolve({ status: xhr.status, body })
    }
    if (input.signal) {
      if (input.signal.aborted) {
        reject(new Error('Upload cancelled'))
        return
      }
      input.signal.addEventListener('abort', () => xhr.abort(), { once: true })
    }
    xhr.send(form)
  })
}

function errorMessage(status: number, body: unknown): string {
  const b = body as { message?: string | string[]; code?: string } | null
  const msg = Array.isArray(b?.message) ? b!.message.join(', ') : b?.message
  if (msg) return msg
  if (status === 413) return 'That upload is too large.'
  if (status === 503) return 'File storage is not configured on this server.'
  if (status === 404) return 'That issue is not available.'
  if (status === 403) return 'You don’t have permission to attach files here.'
  return `Upload failed (${status})`
}

/**
 * Upload files onto an issue, a comment, or a draft (per-open composer id;
 * bound to the issue/comment on create via attachment_ids). More than 10
 * files go up in sequential batches of 10 with one aggregate progress
 * figure. Throws an APIError with `.status` on failure; files from batches
 * that already landed stay where they were sent (issue) or as drafts.
 */
export async function uploadPmFiles(input: UploadPmFilesInput): Promise<PmFile[]> {
  if (!input.files.length) return []
  const totalBytes = input.files.reduce((s, f) => s + f.size, 0) || 1
  let doneBytes = 0
  const out: PmFile[] = []
  for (const batch of chunk(input.files, PM_FILES_PER_REQUEST)) {
    const batchBytes = batch.reduce((s, f) => s + f.size, 0)
    const one: UploadPmFilesInput = {
      ...input,
      files: batch,
      onProgress: input.onProgress
        ? (pct) => input.onProgress!(Math.min(99, Math.round(((doneBytes + (batchBytes * pct) / 100) / totalBytes) * 100)))
        : undefined,
    }
    let res = await xhrUpload(one)
    if (res.status === 401 && (await silentRefresh())) res = await xhrUpload(one)
    if (res.status < 200 || res.status >= 300) {
      throw new APIError(res.status, errorMessage(res.status, res.body), res.body)
    }
    out.push(...(((res.body as { data?: PmFile[] } | null)?.data ?? []) as PmFile[]))
    doneBytes += batchBytes
  }
  input.onProgress?.(100)
  return out
}

export interface PmUploadConfig {
  configured: boolean
  enabled: boolean
  max_file_bytes: number
  max_files: number
  quota_bytes: number
  accepted_extensions: string[]
}

export function usePmUploadConfig(enabled = true) {
  return useQuery({
    queryKey: ['pm', 'uploads', 'config'],
    queryFn: () => api.get<{ data: PmUploadConfig }>('/api/v1/pm/uploads/config'),
    staleTime: 5 * 60 * 1000,
    retry: false,
    enabled,
  })
}

/**
 * The two switches the issue components read:
 *   rich        — pm_attachments flag on ⇒ Linear-style editor + markdown view
 *                 (off ⇒ the plain textarea/input experience, unchanged UX)
 *   attachments — flag on AND storage configured ⇒ Attach / drop / paste-image
 * `loaded` is false until /me has answered; callers treat that as "rich" to
 * avoid an editor ⇄ textarea flicker on every page load.
 */
export function useAttachmentsEnabled(): {
  rich: boolean
  attachments: boolean
  loaded: boolean
  config: PmUploadConfig | undefined
  /** Live from the API when known; the static mirror until then. */
  acceptedExtensions: ReadonlyArray<string>
} {
  const { flags, loaded } = useEffectiveFlags()
  const flagOn = !loaded || flags.includes('pm_attachments')
  const cfg = usePmUploadConfig(flagOn)
  const config = cfg.data?.data
  // Unknown (still loading) reads as on to avoid a flicker; a FAILED config
  // read reads as off — never expose an Attach that can only error.
  const configured = cfg.isError ? false : config === undefined ? true : config.configured && config.enabled
  return {
    rich: flagOn,
    attachments: flagOn && configured,
    loaded,
    config,
    acceptedExtensions: config?.accepted_extensions?.length ? config.accepted_extensions : PM_ACCEPTED_EXTENSIONS,
  }
}

/** Signed URLs embedded in the payload live 1 h — refetch at 50 min so an open tab never shows expired images. */
export const PM_FILES_REFRESH_MS = 50 * 60_000

export function useIssueFiles(issueId: string | null | undefined, opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['pm', 'issue-files', issueId],
    queryFn: () => api.get<{ data: PmFile[] }>(`/api/v1/pm/issues/${issueId}/files`),
    enabled: !!issueId && (opts.enabled ?? true),
    staleTime: 5 * 60 * 1000,
    refetchInterval: PM_FILES_REFRESH_MS,
  })
}

export function invalidateIssueFiles(qc: ReturnType<typeof useQueryClient>, issueId: string) {
  void qc.invalidateQueries({ queryKey: ['pm', 'issue-detail', issueId] })
  void qc.invalidateQueries({ queryKey: ['pm', 'issue-files', issueId] })
}

/** POST pm/files/:id/delete — uploader or Owner/Admin. Pass issueId to refresh that issue's detail + files. */
export function useDeletePmFile() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (vars: { fileId: string; issueId?: string | null }) =>
      api.post<{ data: { id: string; deleted: true } }>(`/api/v1/pm/files/${vars.fileId}/delete`, {}),
    onSuccess: (_res, vars) => {
      if (vars.issueId) invalidateIssueFiles(qc, vars.issueId)
    },
  })
}

/** Upload directly onto an existing issue (the description card's Attach) and refresh it. */
export function useUploadIssueFiles(issueId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (vars: { files: File[]; kind?: PmFileKind; onProgress?: (pct: number) => void }) =>
      uploadPmFiles({
        objectType: 'issue',
        objectId: issueId,
        kind: vars.kind ?? 'attachment',
        files: vars.files,
        onProgress: vars.onProgress,
      }),
    onSuccess: () => invalidateIssueFiles(qc, issueId),
  })
}
