'use client'

import { useQuery } from '@tanstack/react-query'
import { api } from '../client'

export interface CalendarEvent {
  id: string
  type: 'holiday' | 'my_leave' | 'team_leave'
  title: string
  startDate: string // YYYY-MM-DD
  endDate: string // YYYY-MM-DD inclusive
  status?: string
  color?: string
  meta?: Record<string, unknown>
}

export function useCalendarEvents(from: string, to: string) {
  return useQuery({
    queryKey: ['calendar', 'events', from, to],
    queryFn: () =>
      api.get<CalendarEvent[]>(
        `/api/v1/calendar/events?from=${from}&to=${to}`,
      ),
    // Calendar events change infrequently — cache 60s.
    staleTime: 60_000,
  })
}

export function useICalUrl() {
  return useQuery({
    queryKey: ['calendar', 'me', 'ical-url'],
    queryFn: () => api.get<{ url: string }>('/api/v1/calendar/me/ical-url'),
    staleTime: Infinity, // URL is stable for the lifetime of JWT_SECRET
  })
}
