'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Btn, Icon, Modal, Toggle } from '@/components/proto'
import { DateField, DateTimeField } from '@/components/ui/date-picker'
import { PmAv } from '@/components/pm/projects'
import { PillOption, PropertyPill } from '@/components/pm/PropertyPill'
import { useToast } from '@/components/ui/use-toast'
import { useDebounce } from '@/lib/hooks/use-debounce'
import { useAuthStore } from '@/lib/stores/auth.store'
import { FEATURES } from '@/lib/feature-flags'
import { EVENTS, track } from '@/lib/analytics/posthog'
import {
  useCalendarPeople,
  useCreateEvent,
  useUpdateEvent,
  type CalendarFeedItem,
  type CalendarPerson,
  type CreateEventPayload,
  type MeetingProvider,
} from '@/lib/api/queries/use-calendar'
import {
  browserTimezone,
  fromLocalInput,
  parseISODate,
  providerLabel,
  providerUrlProblem,
  roundUpTo,
  toISODate,
  toLocalInput,
} from './calendar-utils'

// ─────────────────────────────────────────────────────────
// Round J — the ONE composer for "New event" and "Schedule meeting" (and
// editing either). Clones the Linear-style issue composer: chrome-less
// modal, borderless title, auto-grow description, property pills. Meeting
// link = pick the provider and paste the link; auto-generation arrives with
// Settings → Integrations (feature flag `calendar_meeting_links`).
// ─────────────────────────────────────────────────────────

export interface ComposerPreset {
  kind?: 'event' | 'meeting'
  /** Local start; the end defaults to +30 min. */
  startAt?: Date
  endAt?: Date
  allDay?: boolean
  /** All-day preset day (YYYY-MM-DD). */
  date?: string
}

const PROVIDERS: Array<{ key: MeetingProvider; label: string; placeholder: string }> = [
  { key: 'none', label: 'None', placeholder: '' },
  { key: 'teams', label: 'Teams', placeholder: 'https://teams.microsoft.com/l/meetup-join/…' },
  { key: 'google_meet', label: 'Google Meet', placeholder: 'https://meet.google.com/abc-defg-hij' },
  { key: 'other', label: 'Other', placeholder: 'https://… (Zoom, Webex, any https link)' },
]

const pillInput = {
  height: 26, borderRadius: 7, background: 'var(--surf-1)', border: '1px solid var(--bord)',
  color: 'var(--text)', fontSize: 11, fontWeight: 700, outline: 'none', padding: '0 9px', fontFamily: 'inherit',
} as const

export function EventComposer({
  open,
  onClose,
  preset,
  editing,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  preset?: ComposerPreset
  /** Edit mode — the event being changed. */
  editing?: CalendarFeedItem | null
  onSaved?: (item: CalendarFeedItem) => void
}) {
  const { toast } = useToast()
  const { currentUser } = useAuthStore()
  const create = useCreateEvent()
  const update = useUpdateEvent()
  const titleRef = useRef<HTMLInputElement>(null)

  const [kind, setKind] = useState<'event' | 'meeting'>('meeting')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [allDay, setAllDay] = useState(false)
  const [start, setStart] = useState('') // YYYY-MM-DDTHH:mm local
  const [end, setEnd] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [attendees, setAttendees] = useState<CalendarPerson[]>([])
  const [location, setLocation] = useState('')
  const [provider, setProvider] = useState<MeetingProvider>('none')
  const [url, setUrl] = useState('')
  const [visibility, setVisibility] = useState<'private' | 'company'>('private')
  const [q, setQ] = useState('')
  const dq = useDebounce(q, 200)
  const people = useCalendarPeople(dq, open)

  // Re-arm on the closed→open transition only (Round E lesson).
  const prevOpen = useRef(false)
  useEffect(() => {
    if (open && !prevOpen.current) {
      if (editing) {
        setKind(editing.type === 'meeting' ? 'meeting' : 'event')
        setTitle(editing.title)
        setDescription(editing.description ?? '')
        setAllDay(editing.allDay)
        if (editing.allDay) {
          setStartDate(editing.startDate)
          setEndDate(editing.endDate)
          const s = parseISODate(editing.startDate)
          s.setHours(9, 0, 0, 0)
          setStart(toLocalInput(s))
          setEnd(toLocalInput(new Date(s.getTime() + 30 * 60_000)))
        } else {
          setStart(toLocalInput(new Date(editing.startAt)))
          setEnd(toLocalInput(new Date(editing.endAt)))
          setStartDate(toISODate(new Date(editing.startAt)))
          setEndDate(toISODate(new Date(new Date(editing.endAt).getTime() - 1)))
        }
        setAttendees(
          (editing.attendees ?? [])
            .filter((a) => a.userId !== editing.organizer?.userId)
            .map((a) => ({ userId: a.userId, name: a.name, avatarUrl: a.avatarUrl })),
        )
        setLocation(editing.location ?? '')
        setProvider(editing.meetingProvider ?? 'none')
        setUrl(editing.meetingUrl ?? '')
        setVisibility(editing.visibility === 'company' ? 'company' : 'private')
      } else {
        const s = preset?.startAt ?? roundUpTo(new Date(), 30)
        const e = preset?.endAt ?? new Date(s.getTime() + 30 * 60_000)
        setKind(preset?.kind ?? 'meeting')
        setTitle('')
        setDescription('')
        setAllDay(preset?.allDay ?? false)
        setStart(toLocalInput(s))
        setEnd(toLocalInput(e))
        setStartDate(preset?.date ?? toISODate(s))
        setEndDate(preset?.date ?? toISODate(s))
        setAttendees([])
        setLocation('')
        setProvider('none')
        setUrl('')
        setVisibility('private')
      }
      setQ('')
    }
    prevOpen.current = open
  }, [open, editing, preset])

  // Keep the end after the start when the start moves (preserve duration).
  const onStartChange = (v: string) => {
    const prevS = fromLocalInput(start)
    const prevE = fromLocalInput(end)
    setStart(v)
    const s = fromLocalInput(v)
    if (!s) return
    const dur = prevS && prevE && prevE > prevS ? prevE.getTime() - prevS.getTime() : 30 * 60_000
    setEnd(toLocalInput(new Date(s.getTime() + dur)))
  }
  const onStartDateChange = (v: string) => {
    setStartDate(v)
    if (!endDate || endDate < v) setEndDate(v)
  }

  const me = currentUser?.id
  const options = (people.data?.data ?? []).filter((p) => p.userId !== me)
  const toggleAttendee = (p: CalendarPerson) =>
    setAttendees((prev) => (prev.some((a) => a.userId === p.userId) ? prev.filter((a) => a.userId !== p.userId) : [...prev, p]))

  const urlProblem = provider === 'none' ? null : providerUrlProblem(provider, url)
  const timing = useMemo(() => {
    if (allDay) {
      if (!startDate) return { ok: false as const, msg: 'Pick a date' }
      if (endDate && endDate < startDate) return { ok: false as const, msg: 'End date is before the start' }
      const days = Math.round((parseISODate(endDate || startDate).getTime() - parseISODate(startDate).getTime()) / 86_400_000) + 1
      if (days > 31) return { ok: false as const, msg: 'All-day events can span at most 31 days' }
      return { ok: true as const }
    }
    const s = fromLocalInput(start)
    const e = fromLocalInput(end)
    if (!s || !e) return { ok: false as const, msg: 'Pick a start and end time' }
    if (e <= s) return { ok: false as const, msg: 'End must be after the start' }
    if (e.getTime() - s.getTime() > 14 * 86_400_000) return { ok: false as const, msg: 'Timed events can span at most 14 days' }
    return { ok: true as const }
  }, [allDay, start, end, startDate, endDate])

  const saving = create.isPending || update.isPending
  const canSubmit = !!title.trim() && timing.ok && !urlProblem && !saving

  const submit = async () => {
    if (!canSubmit) return
    const payload: CreateEventPayload = {
      kind,
      title: title.trim(),
      description: description.trim() || undefined,
      location: location.trim() || undefined,
      allDay,
      timezone: browserTimezone(),
      visibility,
      meetingProvider: provider,
      meetingUrl: provider === 'none' ? undefined : url.trim() || undefined,
      attendees: attendees.map((a) => ({ userId: a.userId })),
    }
    if (allDay) {
      payload.startDate = startDate
      payload.endDate = endDate || startDate
    } else {
      payload.startAt = fromLocalInput(start)!.toISOString()
      payload.endAt = fromLocalInput(end)!.toISOString()
    }
    try {
      const res = editing
        ? await update.mutateAsync({ id: editing.id, ...payload, description: description.trim(), location: location.trim(), meetingUrl: provider === 'none' ? '' : url.trim() })
        : await create.mutateAsync(payload)
      if (!editing) track(EVENTS.CALENDAR_EVENT_CREATED, { kind, provider, all_day: allDay, attendees: attendees.length })
      toast({
        title: editing ? 'Saved' : kind === 'meeting' ? 'Meeting scheduled' : 'Event created',
        description: attendees.length && !editing ? `${attendees.length} ${attendees.length === 1 ? 'person' : 'people'} invited.` : undefined,
      })
      onSaved?.(res.data)
      onClose()
    } catch (e) {
      toast({ title: 'Could not save', description: e instanceof Error ? e.message : 'Try again', variant: 'destructive' })
    }
  }

  const heading = editing ? (kind === 'meeting' ? 'Edit meeting' : 'Edit event') : kind === 'meeting' ? 'Schedule meeting' : 'New event'
  const providerMeta = PROVIDERS.find((p) => p.key === provider) ?? PROVIDERS[0]!

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={heading}
      width={660}
      hideHeader
      bodyPadding="16px 20px 14px"
      footer={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
          {!timing.ok && <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--coral)' }}>{timing.msg}</span>}
          {timing.ok && urlProblem && <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--coral)' }}>{urlProblem}</span>}
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-faint)' }}>⌘↵ {editing ? 'save' : 'create'}</span>
          <Btn kind="ghost" onClick={onClose}>Cancel</Btn>
          <Btn kind="primary" disabled={!canSubmit} onClick={() => void submit()} data-calendar-submit>
            {saving ? 'Saving…' : editing ? 'Save changes' : kind === 'meeting' ? 'Schedule meeting' : 'Create event'}
          </Btn>
        </div>
      }
    >
      <div
        style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit()
          if (e.key === 'Escape') onClose()
        }}
      >
        {/* Breadcrumb: Calendar › kind switch, with the close X. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 2 }}>
          <span style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-2)' }}>Calendar</span>
          <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>›</span>
          <div style={{ display: 'flex', gap: 2, padding: 2, background: 'var(--surf-1)', border: '1px solid var(--bord)', borderRadius: 7 }} data-calendar-kind>
            {(
              [
                ['event', 'Event'],
                ['meeting', 'Meeting'],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => setKind(k)}
                style={{
                  padding: '3px 9px', borderRadius: 5, border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                  background: kind === k ? 'var(--surf-3)' : 'transparent', color: kind === k ? '#fff' : 'var(--text-2)', fontSize: 11, fontWeight: 800,
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <span style={{ flex: 1 }} />
          <div style={{ margin: '-4px -8px 0 0' }}>
            <Btn kind="ghost" size="sm" icon={<Icon.x size={15} />} onClick={onClose} />
          </div>
        </div>

        <input
          ref={titleRef}
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={kind === 'meeting' ? 'Meeting title' : 'Event title'}
          maxLength={200}
          data-calendar-title
          style={{
            width: '100%', background: 'transparent', border: 'none', outline: 'none',
            fontSize: 17, fontWeight: 700, color: '#fff', padding: '2px 0', letterSpacing: '-0.01em',
          }}
        />
        <textarea
          value={description}
          onChange={(e) => {
            setDescription(e.target.value)
            e.target.style.height = 'auto'
            e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`
          }}
          placeholder="Add an agenda or notes…"
          rows={2}
          maxLength={5000}
          style={{
            width: '100%', background: 'transparent', border: 'none', outline: 'none', resize: 'none',
            fontSize: 12.5, lineHeight: 1.6, color: 'var(--text)', padding: 0, minHeight: 40,
          }}
        />

        {/* When */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 4 }}>
          {allDay ? (
            <>
              <DateField value={startDate} onChange={onStartDateChange} style={{ height: 26, width: 140, fontSize: 11, borderRadius: 7 }} />
              <span style={{ fontSize: 11, color: 'var(--text-faint)', fontWeight: 700 }}>to</span>
              <DateField value={endDate} onChange={setEndDate} min={startDate || undefined} style={{ height: 26, width: 140, fontSize: 11, borderRadius: 7 }} />
            </>
          ) : (
            <>
              <DateTimeField value={start} onChange={onStartChange} style={{ height: 26, width: 176, fontSize: 11, borderRadius: 7 }} />
              <span style={{ fontSize: 11, color: 'var(--text-faint)', fontWeight: 700 }}>to</span>
              <DateTimeField value={end} onChange={setEnd} min={start.slice(0, 10) || undefined} style={{ height: 26, width: 176, fontSize: 11, borderRadius: 7 }} />
            </>
          )}
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 4 }}>
            <Toggle on={allDay} onChange={setAllDay} />
            <span onClick={() => setAllDay((v) => !v)} style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-2)', cursor: 'pointer', userSelect: 'none' }}>All day</span>
          </span>
        </div>

        {/* Who / where / how */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 2 }}>
          <PropertyPill
            title="Attendees"
            active={attendees.length > 0}
            width={280}
            icon={
              attendees.length ? (
                <span style={{ display: 'inline-flex' }}>
                  {attendees.slice(0, 3).map((a, i) => (
                    <span key={a.userId} style={{ marginLeft: i ? -5 : 0, display: 'inline-flex' }}>
                      <PmAv name={a.name} src={a.avatarUrl} size={15} />
                    </span>
                  ))}
                </span>
              ) : (
                <Icon.userPlus size={12} />
              )
            }
            label={attendees.length ? `${attendees.length} ${attendees.length === 1 ? 'attendee' : 'attendees'}` : 'Invite people'}
            menu={() => (
              <div onKeyDown={(e) => e.stopPropagation()}>
                <input
                  autoFocus
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search by name or email…"
                  data-calendar-people-search
                  style={{ ...pillInput, width: '100%', height: 30, marginBottom: 5, background: 'var(--surf-2)' }}
                />
                {attendees.length > 0 && (
                  <div style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-faint)', letterSpacing: '.06em', textTransform: 'uppercase', padding: '4px 9px 2px' }}>Invited</div>
                )}
                {attendees.map((a) => (
                  <PillOption key={a.userId} icon={<PmAv name={a.name} src={a.avatarUrl} size={15} />} label={a.name} selected onPick={() => toggleAttendee(a)} />
                ))}
                {options.filter((p) => !attendees.some((a) => a.userId === p.userId)).length > 0 && (
                  <div style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-faint)', letterSpacing: '.06em', textTransform: 'uppercase', padding: '6px 9px 2px' }}>People</div>
                )}
                {options
                  .filter((p) => !attendees.some((a) => a.userId === p.userId))
                  .slice(0, 40)
                  .map((p) => (
                    <PillOption
                      key={p.userId}
                      icon={<PmAv name={p.name} src={p.avatarUrl} size={15} />}
                      label={
                        <span>
                          {p.name}
                          {p.departmentName && <span style={{ color: 'var(--text-faint)', fontWeight: 600 }}> · {p.departmentName}</span>}
                        </span>
                      }
                      onPick={() => toggleAttendee(p)}
                    />
                  ))}
                {people.isFetched && options.length === 0 && (
                  <div style={{ fontSize: 11.5, color: 'var(--text-mute)', padding: '8px 9px', fontWeight: 600 }}>No one matches.</div>
                )}
              </div>
            )}
          />
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, ...pillInput, background: location ? 'var(--surf-2)' : 'var(--surf-1)', padding: '0 8px' }}>
            <Icon.pin size={12} style={{ color: 'var(--text-mute)' }} />
            <input
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="Location or room"
              maxLength={300}
              data-calendar-location
              style={{ background: 'transparent', border: 'none', outline: 'none', color: 'var(--text)', fontSize: 11, fontWeight: 700, width: 150, fontFamily: 'inherit' }}
            />
          </span>
          <PropertyPill
            title="Who can see this"
            active={visibility === 'company'}
            icon={visibility === 'company' ? <Icon.people size={12} /> : <Icon.lock size={12} />}
            label={visibility === 'company' ? 'Everyone in workspace' : 'Attendees only'}
            width={250}
            menu={(close) => (
              <>
                <PillOption icon={<Icon.lock size={12} />} label="Attendees only" selected={visibility === 'private'} onPick={() => { setVisibility('private'); close() }} />
                <PillOption icon={<Icon.people size={12} />} label="Everyone in workspace" selected={visibility === 'company'} onPick={() => { setVisibility('company'); close() }} />
              </>
            )}
          />
        </div>

        {/* Meeting link */}
        <div style={{ marginTop: 6, padding: '10px 12px', borderRadius: 9, background: 'var(--surf-1)', border: '1px solid var(--bord)', display: 'flex', flexDirection: 'column', gap: 8 }} data-calendar-link>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Icon.link size={13} style={{ color: 'var(--text-mute)' }} />
            <span style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-2)' }}>Meeting link</span>
            <div style={{ display: 'flex', gap: 2, padding: 2, background: 'var(--surf-1)', border: '1px solid var(--bord)', borderRadius: 7, marginLeft: 4 }}>
              {PROVIDERS.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  data-provider={p.key}
                  onClick={() => setProvider(p.key)}
                  style={{
                    padding: '3px 9px', borderRadius: 5, border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                    background: provider === p.key ? 'var(--surf-3)' : 'transparent', color: provider === p.key ? '#fff' : 'var(--text-2)', fontSize: 11, fontWeight: 800,
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          {provider !== 'none' && (
            <>
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder={providerMeta.placeholder}
                maxLength={2048}
                data-calendar-url
                style={{ ...pillInput, height: 30, width: '100%', background: 'var(--surf-2)', borderColor: urlProblem ? 'var(--coral)' : 'var(--bord)' }}
              />
              <div style={{ fontSize: 11, color: 'var(--text-mute)', fontWeight: 600, lineHeight: 1.5 }}>
                {url.trim()
                  ? `Attendees get a Join ${providerLabel(provider)} button.`
                  : `No link yet — the meeting shows as "${providerLabel(provider)} · link pending" and you can add it later.`}
                {!FEATURES.calendar_meeting_links && (provider === 'teams' || provider === 'google_meet') && (
                  <>
                    {' '}
                    Generate it automatically once {provider === 'teams' ? 'Microsoft 365' : 'Google'} is connected —{' '}
                    <span style={{ color: 'var(--text-2)' }}>Settings → Integrations (coming soon)</span>.
                  </>
                )}
              </div>
            </>
          )}
        </div>

        <div style={{ fontSize: 10.5, color: 'var(--text-faint)', fontWeight: 600, marginTop: 2 }}>
          Times in your zone ({browserTimezone()}). Invitees get an in-app notice and an email with a calendar invite.
          {editing && ' Attendees are told when the time, place or link changes.'}
        </div>
      </div>
    </Modal>
  )
}

export function presetForSlot(start: Date, kind: 'event' | 'meeting' = 'meeting'): ComposerPreset {
  return { kind, startAt: start, endAt: new Date(start.getTime() + 30 * 60_000) }
}

export function presetForDay(iso: string, kind: 'event' | 'meeting' = 'event'): ComposerPreset {
  const s = parseISODate(iso)
  s.setHours(9, 0, 0, 0)
  return { kind, startAt: s, endAt: new Date(s.getTime() + 30 * 60_000), date: iso }
}
