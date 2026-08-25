'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../client'

/**
 * PM guest seats (round 7): per-project external collaborators. Admin-only
 * endpoints (the server enforces owner/admin).
 */

export interface PmProjectGuest {
  userId: string
  addedAt: string
  email: string
  fullName: string | null
  avatarUrl: string | null
  role: string
  status: 'active' | 'invited' | 'deactivated'
  invitedAt: string | null
}

export function usePmProjectGuests(projectId: string, enabled = true) {
  return useQuery({
    queryKey: ['pm', 'project-guests', projectId],
    queryFn: () =>
      api.get<{ data: PmProjectGuest[]; total: number }>(
        `/api/v1/pm/projects/${projectId}/guests`,
      ),
    staleTime: 30_000,
    enabled: enabled && !!projectId,
  })
}

function invalidate(qc: ReturnType<typeof useQueryClient>, projectId: string) {
  qc.invalidateQueries({ queryKey: ['pm', 'project-guests', projectId] })
  qc.invalidateQueries({ queryKey: ['pm', 'project-detail', projectId] })
}

export function useInvitePmGuest(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: { email: string; full_name?: string }) =>
      api.post<{ data: { userId: string; status: string; magicLinkSent: boolean } }>(
        `/api/v1/pm/projects/${projectId}/guests`,
        payload,
      ),
    onSuccess: () => invalidate(qc, projectId),
  })
}

export function useRevokePmGuest(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (userId: string) =>
      api.post<{ data: { removed: boolean; membershipRevoked: boolean } }>(
        `/api/v1/pm/projects/${projectId}/guests/${userId}/remove`,
        {},
      ),
    onSuccess: () => invalidate(qc, projectId),
  })
}
