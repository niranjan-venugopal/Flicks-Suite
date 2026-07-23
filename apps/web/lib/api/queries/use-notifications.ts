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
  archivedAt: string | null
  snoozedUntil: string | null
  groupCount: number
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

// Real-time delivery is the primary path: NotificationsSocket (mounted in the
// app layout) invalidates this query on a `notification` push. This poll is now
// just a safety net for a dropped/blocked socket — hence the long 120s
// interval. Still refetches on window focus and on popover open so a returning
// tab surfaces new items immediately.
export function useUnreadNotifications() {
  return useQuery({
    queryKey: ['notifications', 'unread'],
    queryFn: () => api.get<UnreadResponse>('/api/v1/notifications/unread?limit=10'),
    refetchInterval: 120_000,
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

// ─── Inbox (PRD v6 §11 / P9) ───────────────────────────────────────────────────

export interface InboxResponse {
  items: NotificationItem[]
  snoozed: NotificationItem[]
}

export function useInbox(scope: 'pm' | 'all' = 'pm') {
  return useQuery({
    queryKey: ['notifications', 'inbox', scope],
    queryFn: () => api.get<InboxResponse>(`/api/v1/notifications/inbox?scope=${scope}`),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    refetchOnMount: 'always',
    staleTime: 5_000,
  })
}

export function useArchiveNotification() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      api.patch<void>(`/api/v1/notifications/${id}/archive`, undefined),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notifications'] })
    },
  })
}

export function useSnoozeNotification() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, until }: { id: string; until: string }) =>
      api.patch<void>(`/api/v1/notifications/${id}/snooze`, { until }),
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
  | 'crm_activity'
  | 'crm_digest'
  | 'pm_assigned'
  | 'pm_mention'
  | 'pm_comment'
  | 'pm_status'
  | 'pm_cycle_digest'
  | 'pm_project_nudge'
  | 'pm_github'

export interface PreferenceRow {
  event: NotificationEvent
  inApp: boolean
  email: boolean
}

export interface PreferencesResponse {
  events: PreferenceRow[]
  emailDigest?: 'urgent' | 'hourly' | 'daily'
}

export function useUpdateEmailDigest() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (frequency: 'urgent' | 'hourly' | 'daily') =>
      api.put('/api/v1/notifications/preferences/email-digest', { frequency }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notifications', 'preferences'] })
    },
  })
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
