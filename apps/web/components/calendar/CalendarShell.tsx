'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Btn, Icon, Modal, SectionHead, SkeletonCard } from '@/components/proto'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { MonthYearPanel } from '@/components/ui/date-picker'
import { RoundNav } from '@/components/ui/month-nav'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { useToast } from '@/components/ui/use-toast'
import { useIsMobile, useMediaQuery } from '@/lib/hooks/use-is-mobile'
import { useOrganization } from '@/lib/api/queries/use-settings'
import { EVENTS, track } from '@/lib/analytics/posthog'
import {
  useCalendarEvent,
  useCalendarFeed,
  useCancelEvent,
  type CalendarFeedItem,
} from '@/lib/api/queries/use-calendar'
import { AgendaList } from './AgendaList'
import { CalendarLegend } from './CalendarLegend'
import { EventComposer, presetForDay, presetForSlot, type ComposerPreset } from './EventComposer'
import { EventDetail } from './EventDetail'
import { MiniMonth } from './MiniMonth'
import { MonthGrid } from './MonthGrid'
import { SubscribeDialog } from './SubscribeDialog'
import { ViewSwitch } from './ViewSwitch'
import { WeekGrid } from './WeekGrid'
import {
  VIEWS,
  browserTimezone,
  filterKeyOf,
  fmtRangeTitle,
  isISODate,
  loadFilters,
  parseISODate,
  rangeFor,
  sameClock,
  saveFilters,
  stepDate,
  toISODate,
  type CalendarView,
  type FilterKey,
} from './calendar-utils'
import type { ChipActions } from './EventChip'

// ─────────────────────────────────────────────────────────
// Round J — the Teams-style workspace calendar. URL carries `?view=&date=`
// (shareable, survives reload); `?event=<id>&date=` is the deep link the
// invite notification / email lands on.
// ─────────────────────────────────────────────────────────

const MOBILE_VIEWS: CalendarView[] = ['agenda', 'month']

export function CalendarShell() {
  const router = useRouter()
  const pathname = usePathname() ?? '/calendar'
  const sp = useSearchParams()
  const { toast } = useToast()
  const isMobile = useIsMobile()
  const wide = useMediaQuery('(min-width: 1180px)')
  const org = useOrganization()

  // ── URL state ──
  const rawView = sp.get('view')
  const rawDate = sp.get('date')
  const eventParam = sp.get('event')
  const view: CalendarView = useMemo(() => {
    const v = (VIEWS as string[]).includes(rawView ?? '') ? (rawView as CalendarView) : isMobile ? 'agenda' : 'week'
    return isMobile && !MOBILE_VIEWS.includes(v) ? 'agenda' : v
  }, [rawView, isMobile])
  const date = useMemo(() => (isISODate(rawDate) ? parseISODate(rawDate) : new Date()), [rawDate])

  const setUrl = useCallback(
    (next: { view?: CalendarView; date?: Date; event?: string | null }) => {
      const q = new URLSearchParams()
      q.set('view', next.view ?? view)
      q.set('date', toISODate(next.date ?? date))
      const ev = next.event === undefined ? eventParam : next.event
      if (ev) q.set('event', ev)
      router.replace(`${pathname}?${q.toString()}`, { scroll: false })
    },
    [router, pathname, view, date, eventParam],
  )
  const setView = (v: CalendarView) => {
    if (v !== view) track(EVENTS.CALENDAR_VIEW_CHANGED, { view: v })
    setUrl({ view: v })
  }
  const setDate = (d: Date) => setUrl({ date: d })
  // Canonical URL: a bare /calendar becomes ?view=week&date=<today> so the
  // address bar is always shareable and a reload lands on the same page.
  useEffect(() => {
    if (!(VIEWS as string[]).includes(rawView ?? '') || !isISODate(rawDate) || (isMobile && !MOBILE_VIEWS.includes(rawView as CalendarView))) {
      setUrl({})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawView, rawDate, isMobile])

  // ── Data ──
  const weekStartsOn = org.data?.weekStartsOn ?? 1
  const range = useMemo(() => rangeFor(view, date, weekStartsOn), [view, date, weekStartsOn])
  const feed = useCalendarFeed(range.from, range.to)
  const prefs = feed.data?.prefs
  const showCrm = feed.data?.sources.crm ?? false

  // ── Filters (per browser) ──
  const [filters, setFilters] = useState<Record<FilterKey, boolean>>(loadFilters)
  const changeFilters = (f: Record<FilterKey, boolean>) => {
    setFilters(f)
    saveFilters(f)
  }
  const items = useMemo(
    () => (feed.data?.data ?? []).filter((it) => filters[filterKeyOf(it)]),
    [feed.data, filters],
  )

  // ── Composer / cancel / subscribe ──
  const [composer, setComposer] = useState<{ open: boolean; preset?: ComposerPreset; editing?: CalendarFeedItem | null }>({ open: false })
  const openNew = (preset?: ComposerPreset) => setComposer({ open: true, preset, editing: null })
  const openEdit = (item: CalendarFeedItem) => setComposer({ open: true, editing: item })
  const closeComposer = () => setComposer((c) => ({ ...c, open: false }))
  const [cancelTarget, setCancelTarget] = useState<CalendarFeedItem | null>(null)
  const cancelMut = useCancelEvent()
  const [subscribeOpen, setSubscribeOpen] = useState(false)

  const confirmCancel = async () => {
    if (!cancelTarget) return
    try {
      await cancelMut.mutateAsync(cancelTarget.id)
      toast({ title: cancelTarget.type === 'meeting' ? 'Meeting cancelled' : 'Event cancelled', description: 'Attendees have been told.' })
      setCancelTarget(null)
      if (detail?.id === cancelTarget.id) closeDetail()
    } catch (e) {
      toast({ title: 'Could not cancel', description: e instanceof Error ? e.message : 'Try again', variant: 'destructive' })
    }
  }

  const actions: ChipActions = useMemo(
    () => ({ onEdit: openEdit, onCancel: (it) => setCancelTarget(it) }),
    [],
  )

  // ── Deep link: ?event=<id>[&date=] ──
  const [detail, setDetail] = useState<CalendarFeedItem | null>(null)
  const closeDetail = () => {
    setDetail(null)
    if (eventParam) setUrl({ event: null })
  }
  const deep = useCalendarEvent(eventParam)
  const consumed = useRef<string | null>(null)
  useEffect(() => {
    if (!eventParam) return
    if (consumed.current === eventParam) return
    if (deep.isLoading) return
    consumed.current = eventParam
    if (deep.data?.data) {
      const it = deep.data.data
      if (it.status === 'cancelled') {
        toast({
          title: `That ${it.type === 'meeting' ? 'meeting' : 'event'} was cancelled`,
          description: `${it.organizer?.name ?? 'The organizer'} cancelled "${it.title}".`,
        })
        setUrl({ event: null })
        return
      }
      setDetail(it)
      // Jump the grid to the event's day so it is on screen behind the card.
      const d = it.allDay ? parseISODate(it.startDate) : new Date(it.startAt)
      if (toISODate(d) !== toISODate(date)) setUrl({ date: d })
      return
    }
    if (deep.isError) {
      toast({
        title: 'That event is no longer on your calendar',
        description: 'It may have been cancelled, or you are not on its invite list.',
      })
      setUrl({ event: null })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventParam, deep.isLoading, deep.data, deep.isError])
  // Keep the open card fresh after an RSVP / edit (the feed refetches).
  useEffect(() => {
    if (!detail) return
    const fresh = feed.data?.data.find((it) => it.id === detail.id)
    if (fresh && fresh !== detail) setDetail(fresh)
  }, [feed.data, detail])

  // ── Toolbar title (month/year chooser) ──
  const [titleOpen, setTitleOpen] = useState(false)
  const tz = browserTimezone()
  const tzNote = prefs && !sameClock(prefs.timezone, tz) ? `Times in your zone (${tz}) · workspace runs on ${prefs.timezone}` : `Times in ${tz}`

  const viewOptions = isMobile ? MOBILE_VIEWS : VIEWS

  return (
    <div style={{ padding: isMobile ? '18px 14px 40px' : '28px 32px 24px', position: 'relative' }}>
      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1440, margin: '0 auto' }}>
        <SectionHead
          title="Calendar"
          sub={`Holidays, leave, team availability and meetings — one calendar. ${tzNote}.`}
          right={
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {!isMobile && (
                <Btn kind="secondary" size="sm" icon={<Icon.cal size={13} />} onClick={() => setSubscribeOpen(true)}>
                  Subscribe (iCal)
                </Btn>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Btn kind="primary" size="sm" icon={<Icon.plus size={13} />} iconRight={<Icon.chevD size={12} />} data-calendar-new>
                    New
                  </Btn>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" style={{ minWidth: 200 }}>
                  <DropdownMenuItem onSelect={() => openNew({ kind: 'event' })} data-calendar-new-event>
                    <Icon.cal size={13} style={{ marginRight: 8 }} /> New event
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => openNew({ kind: 'meeting' })} data-calendar-new-meeting>
                    <Icon.people size={13} style={{ marginRight: 8 }} /> Schedule meeting
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          }
        />

        {/* Toolbar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
          <RoundNav dir="prev" onClick={() => setDate(stepDate(view, date, -1))} />
          <RoundNav dir="next" onClick={() => setDate(stepDate(view, date, 1))} />
          <Btn kind="secondary" size="sm" onClick={() => setDate(new Date())} data-calendar-today>
            Today
          </Btn>
          <Popover open={titleOpen} onOpenChange={setTitleOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                title="Choose month and year"
                data-calendar-title
                style={{
                  fontSize: isMobile ? 16 : 20, fontWeight: 800, letterSpacing: '-0.02em', cursor: 'pointer',
                  background: 'transparent', border: 'none', color: 'var(--text)', fontFamily: 'inherit', padding: 0,
                }}
              >
                {fmtRangeTitle(view, range, date)}
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" style={{ padding: 0 }}>
              <MonthYearPanel
                cursor={date}
                onPick={(d) => {
                  setDate(d)
                  setTitleOpen(false)
                }}
              />
            </PopoverContent>
          </Popover>
          <span style={{ flex: 1 }} />
          <ViewSwitch view={view} onChange={setView} options={viewOptions} />
        </div>

        {/* Body */}
        <div style={{ display: 'grid', gridTemplateColumns: wide ? '256px minmax(0, 1fr)' : 'minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
          {wide && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, position: 'sticky', top: 0 }}>
              <MiniMonth
                date={date}
                onPick={(iso) => {
                  setDate(parseISODate(iso))
                  if (view === 'month') setView('day')
                }}
              />
              <CalendarLegend filters={filters} onChange={changeFilters} showCrm={showCrm} />
            </div>
          )}
          <div style={{ minWidth: 0 }}>
            {feed.isLoading && !feed.data ? (
              <SkeletonCard lines={8} />
            ) : feed.isError ? (
              <div className="card" style={{ padding: 32, textAlign: 'center' }}>
                <div style={{ fontWeight: 800, marginBottom: 4 }}>Could not load your calendar</div>
                <div className="t-mute" style={{ fontSize: 12, marginBottom: 12 }}>
                  {feed.error instanceof Error ? feed.error.message : 'Try again in a moment.'}
                </div>
                <Btn kind="secondary" size="sm" onClick={() => void feed.refetch()}>Retry</Btn>
              </div>
            ) : view === 'month' ? (
              <MonthGrid
                cells={range.days}
                month={date.getMonth()}
                weekStartsOn={weekStartsOn}
                items={items}
                actions={actions}
                onOpenDay={(iso) => {
                  setUrl({ view: isMobile ? 'agenda' : 'day', date: parseISODate(iso) })
                }}
                onSlotClick={(start) => openNew(presetForSlot(start, 'event'))}
              />
            ) : view === 'agenda' ? (
              <AgendaList days={range.days} items={items} actions={actions} onNewOn={(iso) => openNew(presetForDay(iso))} />
            ) : (
              <WeekGrid
                days={range.days}
                items={items}
                prefs={prefs}
                actions={actions}
                onSlotClick={(start) => openNew(presetForSlot(start))}
                onMoreAllDay={(iso) => setUrl({ view: 'day', date: parseISODate(iso) })}
              />
            )}
            {!wide && !isMobile && (
              <div style={{ marginTop: 12 }}>
                <CalendarLegend filters={filters} onChange={changeFilters} showCrm={showCrm} />
              </div>
            )}
          </div>
        </div>
      </div>

      <EventComposer
        open={composer.open}
        onClose={closeComposer}
        preset={composer.preset}
        editing={composer.editing}
        onSaved={(item) => {
          if (detail && detail.id === item.id) setDetail(item)
        }}
      />

      <ConfirmDialog
        open={!!cancelTarget}
        onClose={() => setCancelTarget(null)}
        title={cancelTarget?.type === 'meeting' ? 'Cancel meeting' : 'Cancel event'}
        body={
          cancelTarget ? (
            <span>
              Remove <b>{cancelTarget.title}</b> from everyone&apos;s calendar? Attendees will be notified. This can&apos;t be undone.
            </span>
          ) : null
        }
        confirmLabel={cancelTarget?.type === 'meeting' ? 'Cancel meeting' : 'Cancel event'}
        cancelLabel="Keep it"
        danger
        loading={cancelMut.isPending}
        loadingLabel="Cancelling…"
        onConfirm={() => void confirmCancel()}
      />

      <Modal open={!!detail} onClose={closeDetail} title={detail?.title ?? 'Event'} width={460} hideHeader bodyPadding={0}>
        {detail && (
          <EventDetail
            item={detail}
            onClose={closeDetail}
            onEdit={(it) => {
              closeDetail()
              openEdit(it)
            }}
            onCancel={(it) => {
              closeDetail()
              setCancelTarget(it)
            }}
          />
        )}
      </Modal>

      <SubscribeDialog open={subscribeOpen} onOpenChange={setSubscribeOpen} />
    </div>
  )
}
