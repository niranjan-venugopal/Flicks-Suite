'use client'

import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../client'
import { usePresenceStore, type ResolvedPresence } from '@/lib/presence/presence-store'
import type { PresenceStatus } from '@/components/presence/PresenceDot'

/** Presence API hooks (PRD v4 §5). Socket broadcasts overlay these reads. */

export type ManualStatus = 'available' | 'busy' | 'dnd' | 'brb' | 'away' | 'offline'

export function useSetStatus() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { status: ManualStatus; message?: string; expires_at?: string }) =>
      api.put('/api/v1/me/status', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['presence'] }),
  })
}

export function useClearStatus() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.delete('/api/v1/me/status'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['presence'] }),
  })
}

/**
 * Batched presence for a set of user ids. Seeds the store; live socket
 * `status_changed` events keep it fresh afterwards. Poll as fallback.
 */
export function usePresence(userIds: string[]) {
  const upsertMany = usePresenceStore((s) => s.upsertMany)
  const key = [...userIds].sort().join(',')
  const query = useQuery({
    queryKey: ['presence', key],
    queryFn: () =>
      api.get<{ data: ResolvedPresence[] }>(
        `/api/v1/presence?userIds=${encodeURIComponent(key)}`,
      ),
    enabled: userIds.length > 0,
    refetchInterval: 60_000, // socket is primary; this is the safety net
    staleTime: 30_000,
  })
  useEffect(() => {
    if (query.data?.data) upsertMany(query.data.data)
  }, [query.data, upsertMany])
  return query
}

/** Live status for one user from the store (socket-fed). */
export function useUserPresence(userId: string | undefined): {
  status: PresenceStatus | undefined
  message: string | null
} {
  const entry = usePresenceStore((s) => (userId ? s.byUser[userId] : undefined))
  return { status: entry?.status, message: entry?.message ?? null }
}
