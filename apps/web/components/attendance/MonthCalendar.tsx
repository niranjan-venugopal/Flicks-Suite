'use client'

import { useMemo, useState } from 'react'
import { Icon } from '@/components/proto'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useMyAttendanceMonth, type AttendanceMonthDay } from '@/lib/api/queries/use-attendance'
import { useCalendarEvents, type CalendarEvent } from '@/lib/api/queries/use-calendar'

// ─────────────────────────────────────────────────────────
// The ONE unified calendar (design ref: modernized month grid) — layers
// everything we've built per day: the attendance status dot (green success ·
// orange pending regularization · coral rejected/absent) + holiday / my
// leave / team leave markers, with a day popover showing clock in / clock
// out / total hours and the punch id. Used by /calendar and by the
// attendance page's "Calendar view" toggle. No PDF anywhere (user cut it).
// ─────────────────────────────────────────────────────────

const WEEK = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

// Pending is a deliberate ORANGE (design screenshot) — distinct from the
// holiday yellow so the two never collide on one grid.
const DOT = { green: 'var(--green)', orange: '#F5A623', coral: 'var(--coral)' } as const

const toISO = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

export type DayDot = { color: string; label: 'Success' | 'Pending' | 'Rejected' | 'Absent' } | null

/** Dot derivation — first match wins (§plan A). Exported for tests. */
export function dotForDay(day: AttendanceMonthDay, todayISO: string): DayDot {
  if (day.date > todayISO) return null
  if (day.regularization?.status === 'pending') return { color: DOT.orange, label: 'Pending' }
  if (day.regularization?.status === 'rejected') return { color: DOT.coral, label: 'Rejected' }
  const worked = ['present', 'late', 'half_day', 'work_from_home', 'on_duty', 'comp_off']
  if ((day.attendanceStatus && worked.includes(day.attendanceStatus)) || day.firstPunchInAt) {
    return { color: DOT.green, label: 'Success' }
  }
  if (day.attendanceStatus === 'on_leave' || day.attendanceStatus === 'holiday' || day.attendanceStatus === 'weekend') return null
  if (day.isHoliday || day.isWeekend) return null
  if (day.attendanceStatus === 'absent') return { color: DOT.coral, label: 'Absent' }
  return { color: DOT.coral, label: 'Absent' } // empty past working day
}

const eventColor = (e: CalendarEvent) =>
  e.type === 'holiday' ? 'var(--yellow)' : e.type === 'my_leave' ? 'var(--blue)' : 'var(--purple)'

function fmtClock(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }).toLowerCase()
}
function fmtHM(mins: number): string {
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`
}
function fmtDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00`)
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

function LegendChip({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 10.5, fontWeight: 700, color: 'var(--text-mute)' }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: color }} />
      {label}
    </span>
  )
}

function StatusDot({ color, size = 9 }: { color: string; size?: number }) {
  return (
    <span style={{
      width: size, height: size, borderRadius: '50%', background: color, display: 'inline-block',
      boxShadow: `0 0 0 ${Math.round(size * 0.45)}px ${color}22, 0 0 0 ${Math.round(size * 0.9)}px ${color}11`,
    }} />
  )
}

export function monthOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
export function monthTitle(d: Date): string {
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`
}

export function MonthCalendar({ cursor }: { cursor: Date }) {
  const month = monthOf(cursor)
  const attendance = useMyAttendanceMonth(month)

  // Event window covers the whole visible 6-week grid.
  const monthStart = new Date(cursor.getFullYear(), cursor.getMonth(), 1)
  const gridStart = new Date(monthStart)
  gridStart.setDate(monthStart.getDate() - monthStart.getDay()) // Sunday-first
  const gridEnd = new Date(gridStart)
  gridEnd.setDate(gridStart.getDate() + 41)
  const events = useCalendarEvents(toISO(gridStart), toISO(gridEnd))

  const [openDate, setOpenDate] = useState<string | null>(null)
  const todayIso = toISO(new Date())

  const dayByDate = useMemo(
    () => new Map((attendance.data?.days ?? []).map((d) => [d.date, d])),
    [attendance.data],
  )
  const eventsByDate = useMemo(() => {
    const m = new Map<string, CalendarEvent[]>()
    for (const e of events.data ?? []) {
      const cur = new Date(`${e.startDate}T00:00:00`)
      const end = new Date(`${e.endDate}T00:00:00`)
      while (cur <= end) {
        const key = toISO(cur)
        const arr = m.get(key) ?? []
        arr.push(e)
        m.set(key, arr)
        cur.setDate(cur.getDate() + 1)
      }
    }
    return m
  }, [events.data])

  const cells = useMemo(
    () => Array.from({ length: 42 }, (_, i) => {
      const d = new Date(gridStart)
      d.setDate(gridStart.getDate() + i)
      return d
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [month],
  )

  return (
    <div>
      {/* Legend — attendance dots + event markers, all six in one row */}
      <div style={{ display: 'flex', gap: 14, marginBottom: 12, flexWrap: 'wrap' }}>
        <LegendChip color={DOT.green} label="Success" />
        <LegendChip color={DOT.orange} label="Pending" />
        <LegendChip color={DOT.coral} label="Rejected / Absent" />
        <LegendChip color="var(--yellow)" label="Holiday" />
        <LegendChip color="var(--blue)" label="My leave" />
        <LegendChip color="var(--purple)" label="Team leave" />
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {/* Sun→Sat header (design) */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', borderBottom: '1px solid var(--bord)' }}>
          {WEEK.map((w) => (
            <div key={w} style={{ padding: '12px 14px', textAlign: 'center', fontSize: 13, fontWeight: 700, color: 'var(--text-2)' }}>{w}</div>
          ))}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gridAutoRows: 'minmax(96px, 1fr)' }}>
          {cells.map((d, i) => {
            const iso = toISO(d)
            const inMonth = d.getMonth() === cursor.getMonth()
            const day = inMonth ? dayByDate.get(iso) : undefined
            const dot = day ? dotForDay(day, todayIso) : null
            const dayEvents = eventsByDate.get(iso) ?? []
            const isToday = iso === todayIso
            // Catalog: hover = tooltip with the punches; click = day popover.
            const tip = day
              ? [
                  day.attendanceStatus ? day.attendanceStatus.replace(/_/g, ' ') : day.isHoliday ? 'holiday' : day.isWeekend ? 'weekend' : undefined,
                  day.firstPunchInAt ? `in ${fmtClock(day.firstPunchInAt)}` : undefined,
                  day.lastPunchOutAt ? `out ${fmtClock(day.lastPunchOutAt)}` : undefined,
                  day.regularization ? `regularization ${day.regularization.status}` : undefined,
                ].filter(Boolean).join(' · ') || undefined
              : undefined
            const cell = (
              <div
                key={iso}
                title={tip}
                onClick={() => { if (dot || dayEvents.length) setOpenDate(openDate === iso ? null : iso) }}
                style={{
                  borderRight: (i % 7) < 6 ? '1px solid var(--bord)' : 'none',
                  borderBottom: i < 35 ? '1px solid var(--bord)' : 'none',
                  padding: '10px 12px', position: 'relative',
                  cursor: dot || dayEvents.length ? 'pointer' : 'default',
                  background: isToday ? 'var(--surf-1)' : 'transparent',
                  outline: isToday ? '1px solid var(--bord-2)' : 'none', outlineOffset: -1,
                }}
              >
                <div style={{ textAlign: 'right', fontSize: 14, fontWeight: 700, color: inMonth ? 'var(--text)' : 'var(--text-faint)' }}>
                  {inMonth ? String(d.getDate()).padStart(2, '0') : d.getDate() === 1
                    ? `${MONTHS[d.getMonth()]!.slice(0, 3)} 01`
                    : d.getDate()}
                </div>
                {dot && (
                  <div style={{ display: 'flex', justifyContent: 'center', marginTop: 14 }}>
                    <StatusDot color={dot.color} />
                  </div>
                )}
                {dayEvents.length > 0 && (
                  <div style={{ display: 'flex', gap: 4, justifyContent: 'center', marginTop: dot ? 10 : 18 }}>
                    {dayEvents.slice(0, 3).map((e) => (
                      <span key={e.id} title={e.title} style={{ width: 6, height: 6, borderRadius: '50%', background: eventColor(e) }} />
                    ))}
                  </div>
                )}
              </div>
            )
            // Only the open day mounts a PopoverContent (42-popover perf rule).
            if (openDate !== iso || !inMonth) return cell
            return (
              <Popover key={iso} open onOpenChange={(o) => { if (!o) setOpenDate(null) }}>
                <PopoverTrigger asChild>{cell}</PopoverTrigger>
                <PopoverContent align="center" style={{ width: 400, padding: 0 }}>
                  <DayDetail day={day} dot={dot} events={dayEvents} iso={iso} />
                </PopoverContent>
              </Popover>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function DayDetail({ day, dot, events, iso }: {
  day: AttendanceMonthDay | undefined
  dot: DayDot
  events: CalendarEvent[]
  iso: string
}) {
  const firstIn = day?.punches.find((p) => p.punchType === 'in')
  return (
    <div style={{ padding: '16px 18px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 12, borderBottom: '1px solid var(--bord)' }}>
        <Icon.cal size={14} style={{ color: 'var(--text-mute)' }} />
        <span style={{ fontSize: 13.5, fontWeight: 800 }}>{fmtDay(iso)}</span>
        <span style={{ flex: 1 }} />
        {dot && (
          <>
            <StatusDot color={dot.color} size={8} />
            <span style={{ fontSize: 12.5, fontWeight: 800 }}>{dot.label}</span>
          </>
        )}
      </div>
      {day && (dot?.label === 'Success' || day.firstPunchInAt) && (
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', paddingTop: 14 }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{
              width: 52, height: 52, borderRadius: '50%', background: 'var(--green)', color: '#fff',
              display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 8px',
            }}>
              <Icon.fingerprint size={22} />
            </div>
            <div style={{ fontSize: 12.5, fontWeight: 800 }}>Clocked successfully</div>
            {firstIn && <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text-faint)' }}>id: {firstIn.id.slice(0, 8)}</div>}
          </div>
          <div style={{ flex: 1, display: 'grid', rowGap: 8 }}>
            {[
              ['clock in', fmtClock(day.firstPunchInAt)],
              ['clock out', fmtClock(day.lastPunchOutAt)],
              ['total hours', fmtHM(day.totalWorkedMinutes)],
            ].map(([k, v]) => (
              <div key={k} style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ width: 82, fontSize: 11.5, fontWeight: 600, color: 'var(--text-mute)' }}>{k}</span>
                <span style={{ fontSize: 11.5, color: 'var(--text-mute)' }}>:</span>
                <span style={{ fontSize: 14, fontWeight: 800 }}>{v}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {day?.regularization && dot?.label !== 'Success' && (
        <div style={{ paddingTop: 12, fontSize: 12, fontWeight: 600, color: 'var(--text-2)' }}>
          Regularization ({day.regularization.requestType.replace(/_/g, ' ')}) — {day.regularization.status}
        </div>
      )}
      {events.length > 0 && (
        <div style={{ paddingTop: 12, display: 'grid', rowGap: 6 }}>
          {events.map((e) => (
            <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 700 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: eventColor(e), flexShrink: 0 }} />
              <span style={{ color: 'var(--text-2)' }}>{e.title}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
