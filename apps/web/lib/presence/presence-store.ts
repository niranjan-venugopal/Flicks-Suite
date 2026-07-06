'use client'

import { create } from 'zustand'
import type { PresenceStatus } from '@/components/presence/PresenceDot'

export interface ResolvedPresence {
  userId: string
  status: PresenceStatus
  message: string | null
  manual: boolean
  /** ISO expiry of a manual status ("clear after") — null for Never/auto. */
  expires_at?: string | null
}

interface PresenceState {
  byUser: Record<string, ResolvedPresence>
  /** Whether MY resolved status is DND (drives toast suppression). */
  selfDnd: boolean
  selfUserId: string | null
  upsert: (p: ResolvedPresence) => void
  upsertMany: (list: ResolvedPresence[]) => void
  setSelf: (userId: string) => void
}

/** Live presence cache fed by the /presence socket + batched GETs. */
export const usePresenceStore = create<PresenceState>()((set, get) => ({
  byUser: {},
  selfDnd: false,
  selfUserId: null,
  upsert: (p) =>
    set((s) => ({
      byUser: { ...s.byUser, [p.userId]: p },
      selfDnd: p.userId === s.selfUserId ? p.status === 'dnd' : s.selfDnd,
    })),
  upsertMany: (list) =>
    set((s) => {
      const byUser = { ...s.byUser }
      let selfDnd = s.selfDnd
      for (const p of list) {
        byUser[p.userId] = p
        if (p.userId === s.selfUserId) selfDnd = p.status === 'dnd'
      }
      return { byUser, selfDnd }
    }),
  setSelf: (userId) =>
    set((s) => ({
      selfUserId: userId,
      selfDnd: s.byUser[userId]?.status === 'dnd',
    })),
}))

/** Module-level DND flag readable from non-React code (use-toast). */
export function isSelfDnd(): boolean {
  return usePresenceStore.getState().selfDnd
}
