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
