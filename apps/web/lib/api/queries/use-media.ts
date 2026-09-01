'use client'

import { useMutation, useQueryClient } from '@tanstack/react-query'

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'

/**
 * Media pipeline hooks (PRD v4 §4). Multipart uploads go through a dedicated
 * fetch (the JSON api client sets Content-Type: application/json, which breaks
 * FormData boundaries); cookies ride via credentials: 'include'.
 */

async function uploadFile(path: string, blob: Blob): Promise<{ data: { avatar_url?: string; logo_url?: string } }> {
  const form = new FormData()
  form.append('file', blob, 'image.webp')
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    credentials: 'include',
    body: form,
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(
      (json as { message?: string | string[] })?.message?.toString() ??
        `Upload failed (${res.status})`,
    )
  }
  return json
}

async function del(path: string): Promise<void> {
  const res = await fetch(`${BASE_URL}${path}`, { method: 'DELETE', credentials: 'include' })
  if (!res.ok) {
    const json = await res.json().catch(() => ({}))
    throw new Error(
      (json as { message?: string })?.message ?? `Remove failed (${res.status})`,
    )
  }
}

/**
 * Every cached payload that carries a face. Invalidating only ['auth','me']
 * left the topbar correct and every other screen showing the OLD photo for the
 * global 5-minute staleTime (focus refetch is off) — so the change looked like
 * it "didn't apply everywhere".
 */
const AVATAR_QUERY_KEYS = [
  ['auth', 'me'],
  ['employees'],
  ['settings', 'members'],
  ['reports'],
  ['pm', 'users'],
  ['dashboard'],
] as const

function invalidateAvatarSurfaces(qc: ReturnType<typeof useQueryClient>) {
  for (const key of AVATAR_QUERY_KEYS) {
    qc.invalidateQueries({ queryKey: [...key] })
  }
}

export function useUploadAvatar() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (blob: Blob) => uploadFile('/api/v1/media/avatar', blob),
    onSuccess: () => invalidateAvatarSurfaces(qc),
  })
}

export function useRemoveAvatar() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => del('/api/v1/media/avatar'),
    onSuccess: () => invalidateAvatarSurfaces(qc),
  })
}

export function useUploadLogo() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (blob: Blob) => uploadFile('/api/v1/org/logo', blob),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['auth', 'me'] })
      // The org Settings pages read the logo off the organization payload
      qc.invalidateQueries({ queryKey: ['settings', 'organization'] })
    },
  })
}

export function useRemoveLogo() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => del('/api/v1/org/logo'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['auth', 'me'] })
      qc.invalidateQueries({ queryKey: ['settings', 'organization'] })
    },
  })
}

// ─── Project logo (round E) — same pipeline, per PM project ─────────────────

/**
 * Plain helper (not a hook) for the create-project flow, which only knows the
 * new project's id after the create lands. The server center-crops with
 * sharp, so an uncropped file is fine here.
 */
export function uploadProjectLogoBlob(projectId: string, blob: Blob) {
  return uploadFile(`/api/v1/pm/projects/${projectId}/logo`, blob)
}

function invalidateProjectLogo(qc: ReturnType<typeof useQueryClient>, projectId: string) {
  void qc.invalidateQueries({ queryKey: ['pm', 'project-detail', projectId] })
  void qc.invalidateQueries({ queryKey: ['pm', 'projects'] })
}

export function useUploadProjectLogo(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (blob: Blob) => uploadFile(`/api/v1/pm/projects/${projectId}/logo`, blob),
    onSuccess: () => invalidateProjectLogo(qc, projectId),
  })
}

export function useRemoveProjectLogo(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      // POST …/logo/remove (not DELETE): parity with the PM controller's
      // action-route convention.
      const res = await fetch(`${BASE_URL}/api/v1/pm/projects/${projectId}/logo/remove`, {
        method: 'POST',
        credentials: 'include',
      })
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { message?: string }
        throw new Error(json?.message ?? `Remove failed (${res.status})`)
      }
    },
    onSuccess: () => invalidateProjectLogo(qc, projectId),
  })
}
