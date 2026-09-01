'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../client'

/**
 * Project members (round E): the INTERNAL roster of a project — employees and
 * managers given access, shown with their workspace role. Guests stay on
 * their own card (use-pm-guests). The server gates add/remove/privacy to the
 * project lead + manager-and-above; the list is visible to anyone who can
 * see the project.
 */

export interface PmProjectMember {
  user_id: string
  added_at: string
  name: string | null
  email: string
  avatar_url: string | null
  role: string
  is_lead: boolean
}

export function usePmProjectMembers(projectId: string, enabled = true) {
  return useQuery({
    queryKey: ['pm', 'project-members', projectId],
    queryFn: () =>
      api.get<{ data: PmProjectMember[]; total: number }>(`/api/v1/pm/projects/${projectId}/members`),
    staleTime: 30_000,
    enabled: enabled && !!projectId,
  })
}

function invalidate(qc: ReturnType<typeof useQueryClient>, projectId: string) {
  void qc.invalidateQueries({ queryKey: ['pm', 'project-members', projectId] })
  void qc.invalidateQueries({ queryKey: ['pm', 'project-detail', projectId] })
}

export function useAddPmMember(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (userId: string) =>
      api.post<{ data: { project_id: string; user_id: string } }>(
        `/api/v1/pm/projects/${projectId}/members`,
        { user_id: userId },
      ),
    onSuccess: () => invalidate(qc, projectId),
  })
}

export function useRemovePmMember(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (userId: string) =>
      api.post<{ data: { removed: boolean } }>(`/api/v1/pm/projects/${projectId}/members/remove`, {
        user_id: userId,
      }),
    onSuccess: () => invalidate(qc, projectId),
  })
}

export function useSetPmProjectVisibility(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (isPrivate: boolean) =>
      api.post<{ data: { is_private: boolean } }>(`/api/v1/pm/projects/${projectId}/visibility`, {
        is_private: isPrivate,
      }),
    onSuccess: () => {
      invalidate(qc, projectId)
      void qc.invalidateQueries({ queryKey: ['pm', 'projects'] })
    },
  })
}
