'use client'

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../client'

// ─────────────────────────────────────────────────────────
// Round J — the Teams-style calendar. One feed endpoint returns every
// source the viewer may see (holidays, my leave, team availability,
// birthdays & anniversaries, my CRM calls & meetings, events / meetings)
// plus the workspace calendar prefs; the rest is event CRUD + RSVP.
// ─────────────────────────────────────────────────────────

export type CalendarItemType =
  | 'holiday'
  | 'my_leave'
  | 'team_leave'
  | 'event'
  | 'meeting'
  | 'birthday'
  | 'anniversary'
  | 'crm_activity'

export type MeetingProvider = 'none' | 'teams' | 'google_meet' | 'other'
export type AttendeeResponse = 'pending' | 'accepted' | 'declined' | 'tentative'

export interface CalendarPerson {
  userId: string
  name: string
  avatarUrl: string | null
}

export interface CalendarAttendee extends CalendarPerson {
  response: AttendeeResponse
  isOptional: boolean
}

export interface CalendarFeedItem {
  /** Read-only sources are prefixed (`holiday:<id>`); events carry their uuid. */
  id: string
  type: CalendarItemType
  title: string
  allDay: boolean
  /** ISO-8601 UTC instants; `endAt` is exclusive. */
  startAt: string
  endAt: string
  /** Inclusive calendar days in the item's own `timezone`. */
  startDate: string
  endDate: string
  timezone: string
  color: string | null
  status?: string
  description?: string | null
  location?: string | null
  meetingProvider?: MeetingProvider
  meetingUrl?: string | null
  visibility?: 'private' | 'team' | 'company'
  organizer?: CalendarPerson | null
  attendees?: CalendarAttendee[]
  myResponse?: AttendeeResponse | null
  canEdit: boolean
  /** Deep link for read-only sources (leave page, deal, employee profile). */
  link?: string
  meta?: Record<string, unknown>
}

export interface CalendarPrefs {
  timezone: string
  /** 0=Sunday .. 6=Saturday */
  weekStartsOn: number
  /** 0=Sunday .. 6=Saturday */
  workingDays: number[]
  /** 'HH:mm' */
  workStart: string
  workEnd: string
}

export interface CalendarFeed {
  data: CalendarFeedItem[]
  prefs: CalendarPrefs
  sources: { crm: boolean }
}

export interface InvitablePerson extends CalendarPerson {
  email: string
  departmentName: string | null
}

export interface AttendeeInput {
  userId: string
  isOptional?: boolean
}

export interface CreateEventPayload {
  kind: 'event' | 'meeting'
  title: string
  description?: string
  location?: string
  allDay: boolean
  startDate?: string
  endDate?: string
  startAt?: string
  endAt?: string
  timezone?: string
  visibility?: 'private' | 'company'
  meetingProvider?: MeetingProvider
  meetingUrl?: string
  color?: string
  attendees?: AttendeeInput[]
}

export type UpdateEventPayload = Partial<CreateEventPayload>

const invalidateCalendar = (qc: ReturnType<typeof useQueryClient>) => {
  void qc.invalidateQueries({ queryKey: ['calendar'] })
  void qc.invalidateQueries({ queryKey: ['dashboard'] })
  void qc.invalidateQueries({ queryKey: ['notifications'] })
}

export function useCalendarFeed(from: string, to: string, enabled = true) {
  return useQuery({
    queryKey: ['calendar', 'feed', from, to],
    queryFn: () => api.get<CalendarFeed>(`/api/v1/calendar/events?from=${from}&to=${to}`),
    enabled: enabled && !!from && !!to,
    // Keep the previous range on screen while the next one loads — no blank
    // grid flash when paging weeks.
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  })
}

export function useCalendarEvent(id: string | null | undefined) {
  return useQuery({
    queryKey: ['calendar', 'event', id ?? 'none'],
    queryFn: () => api.get<{ data: CalendarFeedItem }>(`/api/v1/calendar/events/${id}`),
    enabled: !!id,
    staleTime: 15_000,
    retry: false,
  })
}

export function useCalendarPeople(q: string, enabled = true) {
  const qs = q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''
  return useQuery({
    queryKey: ['calendar', 'people', q.trim()],
    queryFn: () => api.get<{ data: InvitablePerson[] }>(`/api/v1/calendar/people${qs}`),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  })
}

export function useCreateEvent() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: CreateEventPayload) =>
      api.post<{ data: CalendarFeedItem }>('/api/v1/calendar/events', payload),
    onSuccess: () => invalidateCalendar(qc),
  })
}

export function useUpdateEvent() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...payload }: UpdateEventPayload & { id: string }) =>
      api.patch<{ data: CalendarFeedItem }>(`/api/v1/calendar/events/${id}`, payload),
    onSuccess: () => invalidateCalendar(qc),
  })
}

export function useCancelEvent() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      api.delete<{ data: { id: string; cancelledAt: string } }>(`/api/v1/calendar/events/${id}`),
    onSuccess: () => invalidateCalendar(qc),
  })
}

export function useRsvp() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, response }: { id: string; response: Exclude<AttendeeResponse, 'pending'> }) =>
      api.post<{ data: CalendarFeedItem }>(`/api/v1/calendar/events/${id}/rsvp`, { response }),
    onSuccess: () => invalidateCalendar(qc),
  })
}

export function useICalUrl() {
  return useQuery({
    queryKey: ['calendar', 'me', 'ical-url'],
    queryFn: () => api.get<{ url: string }>('/api/v1/calendar/me/ical-url'),
    staleTime: Infinity, // URL is stable for the lifetime of JWT_SECRET
  })
}
