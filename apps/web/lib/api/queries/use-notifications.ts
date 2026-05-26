'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../client'

export interface NotificationItem {
  id: string
  userId: string
  type: string
  message: string
  linkUrl: string | null
  readAt: string | null
  createdAt: string
}

export interface UnreadResponse {
  items: NotificationItem[]
  total: number
}

export interface ListResponse {
  items: NotificationItem[]
  total: number
  page: number
  pageSize: number
}

// Polled by the Topbar bell every 45s; also refetches on window focus so
// flipping back from another tab surfaces new items quickly.
export function useUnreadNotifications() {
  return useQuery({
    queryKey: ['notifications', 'unread'],
    queryFn: () => api.get<UnreadResponse>('/api/v1/notifications/unread?limit=10'),
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
    refetchOnMount: 'always',
    staleTime: 5_000,
  })
}

export function useAllNotifications(
  filter: 'all' | 'unread' = 'all',
  page = 1,
  pageSize = 20,
) {
  return useQuery({
    queryKey: ['notifications', 'list', filter, page, pageSize],
    queryFn: () => {
      const p = new URLSearchParams()
      p.set('filter', filter)
      p.set('page', String(page))
      p.set('pageSize', String(pageSize))
      return api.get<ListResponse>(`/api/v1/notifications?${p.toString()}`)
    },
    placeholderData: (prev) => prev,
  })
}

export function useMarkRead() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      api.patch<void>(`/api/v1/notifications/${id}/read`, undefined),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notifications'] })
    },
  })
}

export function useMarkAllRead() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.post<void>('/api/v1/notifications/mark-all-read', {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notifications'] })
    },
  })
}

// ─── Preferences (PRD §9.3) ────────────────────────────────────────────────────

export type NotificationEvent =
  | 'leave_requested'
  | 'leave_reviewed'
  | 'timesheet_submitted'
  | 'timesheet_reviewed'
  | 'regularization_requested'
  | 'regularization_reviewed'
  | 'onboarding_submitted'
  | 'onboarding_reviewed'

export interface PreferenceRow {
  event: NotificationEvent
  inApp: boolean
  email: boolean
}

export interface PreferencesResponse {
  events: PreferenceRow[]
}

export function useNotificationPreferences() {
  return useQuery({
    queryKey: ['notifications', 'preferences'],
    queryFn: () =>
      api.get<PreferencesResponse>('/api/v1/notifications/preferences'),
    staleTime: 60_000,
  })
}

export function useUpdateNotificationPreference() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: {
      event: NotificationEvent
      channel: 'in_app' | 'email'
      enabled: boolean
    }) => api.put('/api/v1/notifications/preferences', payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notifications', 'preferences'] })
    },
  })
}
