'use client'

import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import type { CalendarFeedItem, CalendarPrefs } from '@/lib/api/queries/use-calendar'
import { EventChip, type ChipActions } from './EventChip'
import {
  HOUR_PX,
  atMinutes,
  layoutDay,
  minutesNow,
  occursOn,
  sortItems,
  toISODate,
  todayISO,
  weekdayShort,
} from './calendar-utils'

const GUTTER = 56
const ALLDAY_MAX = 3

function hhmmToMin(v: string | undefined): number | null {
  if (!v) return null
  const m = /^(\d{1,2}):(\d{2})/.exec(v)
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

/**
 * The Teams-style time grid — Day (1 column) and Week (7 columns). Sticky
 * header carries the day names and the all-day lane (holidays, leave,
 * birthdays, all-day events); the body is a 24-hour scroller with working
 * hours tinted, today's column highlighted, a live now-line, and blocks laid
 * out in lanes. Clicking an empty slot starts a 30-minute event there.
 */
export function WeekGrid({
  days,
  items,
  prefs,
  actions,
  onSlotClick,
  onMoreAllDay,
}: {
  days: Date[]
  items: CalendarFeedItem[]
  prefs: CalendarPrefs | undefined
  actions: ChipActions
  onSlotClick: (start: Date) => void
  onMoreAllDay: (iso: string) => void
}) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 60_000)
    return () => window.clearInterval(t)
  }, [])
  // Open on the working morning, not midnight.
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const startMin = hhmmToMin(prefs?.workStart) ?? 9 * 60
    el.scrollTop = Math.max(0, (startMin / 60) * HOUR_PX - HOUR_PX)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days.length])

  const today = todayISO()
  const workStart = hhmmToMin(prefs?.workStart) ?? 9 * 60
  const workEnd = hhmmToMin(prefs?.workEnd) ?? 18 * 60
  const workingDays = prefs?.workingDays ?? [1, 2, 3, 4, 5]

  const perDay = useMemo(
    () =>
      days.map((d) => {
        const iso = toISODate(d)
        const allDay = sortItems(items.filter((it) => it.allDay && occursOn(it, iso)))
        return { iso, d, allDay, blocks: layoutDay(items, iso) }
      }),
    [days, items],
  )
  const allDayRows = Math.min(ALLDAY_MAX + 1, Math.max(1, ...perDay.map((p) => Math.min(p.allDay.length, ALLDAY_MAX + 1))))
  const cols = `${GUTTER}px repeat(${days.length}, minmax(0, 1fr))`

  const clickSlot = (e: MouseEvent<HTMLDivElement>, iso: string) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const y = e.clientY - rect.top
    const minutes = Math.max(0, Math.min(23 * 60 + 30, Math.floor((y / HOUR_PX) * 2) * 30))
    onSlotClick(atMinutes(iso, minutes))
  }

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }} data-calendar-grid={days.length === 1 ? 'day' : 'week'}>
      {/* Sticky header: day names + all-day lane */}
      <div style={{ borderBottom: '1px solid var(--bord)', background: 'var(--bg-2)' }}>
        <div style={{ display: 'grid', gridTemplateColumns: cols }}>
          <div />
          {perDay.map(({ iso, d }) => {
            const isToday = iso === today
            return (
              <div key={iso} style={{ padding: '10px 6px 6px', textAlign: 'center', borderLeft: '1px solid var(--bord)' }}>
                <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: isToday ? 'var(--blue)' : 'var(--text-mute)' }}>
                  {weekdayShort(d.getDay())}
                </div>
                <div
                  style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    minWidth: 28, height: 28, padding: '0 6px', borderRadius: 999, marginTop: 2,
                    background: isToday ? 'var(--blue)' : 'transparent',
                    color: isToday ? '#fff' : 'var(--text)', fontSize: 15, fontWeight: 800,
                    boxShadow: isToday ? '0 0 14px rgba(62,123,250,.35)' : 'none',
                  }}
                >
                  {d.getDate()}
                </div>
              </div>
            )
          })}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: cols, minHeight: allDayRows * 22 + 8 }} data-calendar-allday>
          <div style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-faint)', textAlign: 'right', padding: '4px 8px 0 0', letterSpacing: '.04em' }}>ALL DAY</div>
          {perDay.map(({ iso, allDay }) => (
            <div key={iso} style={{ borderLeft: '1px solid var(--bord)', padding: '3px 4px 4px', display: 'flex', flexDirection: 'column', gap: 2 }}>
              {allDay.slice(0, allDay.length > ALLDAY_MAX ? ALLDAY_MAX - 1 : ALLDAY_MAX).map((it) => (
                <EventChip key={it.id} item={it} variant="chip" actions={actions} side="bottom" />
              ))}
              {allDay.length > ALLDAY_MAX && (
                <button
                  type="button"
                  onClick={() => onMoreAllDay(iso)}
                  style={{ height: 18, border: 'none', background: 'transparent', color: 'var(--text-mute)', fontSize: 10.5, fontWeight: 800, cursor: 'pointer', textAlign: 'left', padding: '0 6px', fontFamily: 'inherit' }}
                >
                  +{allDay.length - (ALLDAY_MAX - 1)} more
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* 24-hour scroller */}
      <div ref={scrollerRef} style={{ overflowY: 'auto', overflowX: 'hidden', height: 'calc(100vh - 330px)', minHeight: 420, position: 'relative' }}>
        <div style={{ display: 'grid', gridTemplateColumns: cols, height: 24 * HOUR_PX, position: 'relative' }}>
          {/* Gutter */}
          <div style={{ position: 'relative' }}>
            {Array.from({ length: 24 }, (_, h) => (
              <div
                key={h}
                style={{ position: 'absolute', top: h * HOUR_PX - 7, right: 8, fontSize: 10.5, fontWeight: 700, color: 'var(--text-faint)', fontVariantNumeric: 'tabular-nums' }}
              >
                {h === 0 ? '' : `${String(h).padStart(2, '0')}:00`}
              </div>
            ))}
          </div>
          {/* Day columns */}
          {perDay.map(({ iso, d, blocks }) => {
            const isToday = iso === today
            const working = workingDays.includes(d.getDay())
            return (
              <div
                key={iso}
                data-calendar-column={iso}
                onClick={(e) => clickSlot(e, iso)}
                style={{ position: 'relative', borderLeft: '1px solid var(--bord)', background: isToday ? 'rgba(62,123,250,.05)' : 'transparent', cursor: 'copy' }}
              >
                {/* Hour lines */}
                {Array.from({ length: 24 }, (_, h) => (
                  <div key={h} style={{ position: 'absolute', left: 0, right: 0, top: h * HOUR_PX, borderTop: '1px solid var(--bord)', pointerEvents: 'none' }} />
                ))}
                {/* Half-hour ticks */}
                {Array.from({ length: 24 }, (_, h) => (
                  <div key={`half-${h}`} style={{ position: 'absolute', left: 0, right: 0, top: h * HOUR_PX + HOUR_PX / 2, borderTop: '1px dashed rgba(255,255,255,.04)', pointerEvents: 'none' }} />
                ))}
                {/* Working hours tint */}
                {working && workEnd > workStart && (
                  <div
                    style={{
                      position: 'absolute', left: 0, right: 0, top: (workStart / 60) * HOUR_PX, height: ((workEnd - workStart) / 60) * HOUR_PX,
                      background: 'rgba(255,255,255,.025)', pointerEvents: 'none',
                    }}
                  />
                )}
                {/* Now line */}
                {isToday && (
                  <div data-calendar-now style={{ position: 'absolute', left: 0, right: 0, top: (minutesNow(now) / 60) * HOUR_PX, height: 0, borderTop: '2px solid var(--coral)', pointerEvents: 'none', zIndex: 3 }}>
                    <span style={{ position: 'absolute', left: -5, top: -5, width: 8, height: 8, borderRadius: '50%', background: 'var(--coral)' }} />
                  </div>
                )}
                {/* Blocks */}
                {blocks.map((b) => {
                  const widthPct = 100 / b.lanes
                  return (
                    <EventChip
                      key={b.item.id}
                      item={b.item}
                      variant="block"
                      actions={actions}
                      style={{
                        top: b.top + 1,
                        height: b.height,
                        left: `calc(${b.lane * widthPct}% + 2px)`,
                        width: `calc(${widthPct}% - 4px)`,
                        zIndex: 2 + b.lane,
                      }}
                    />
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
