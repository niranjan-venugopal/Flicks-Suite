'use client'

import { useEffect, useState, type CSSProperties } from 'react'
import { Icon } from '@/components/proto'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

// ─────────────────────────────────────────────────────────
// House date picker (design ref: dark popover — centered "April 2023" with
// round prev/next buttons, Mo–Su headers, 6 rows, adjacent-month days
// dimmed; range selection renders as ONE rounded blue pill spanning the
// days). Values are house YYYY-MM-DD strings ('' = empty). Replaces every
// native calendar input in the app: DateField for dates, DateRangeField for
// ranges, DateTimeField for 'YYYY-MM-DDTHH:mm', MonthField for 'YYYY-MM'.
// (Only <input type="time"> stays native — it renders a clock, not a
// calendar, and has no house equivalent.)
// ─────────────────────────────────────────────────────────

const WEEK = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

const toISO = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const parse = (iso: string) => new Date(`${iso}T00:00:00`)
const dowMon = (d: Date) => (d.getDay() + 6) % 7 // Mon=0
const monthLabel = (d: Date) => `${MONTHS[d.getMonth()]} ${d.getFullYear()}`

function fmtShort(iso: string): string {
  if (!iso) return ''
  const d = parse(iso)
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

function RoundNav({ dir, onClick }: { dir: 'prev' | 'next'; onClick: () => void }) {
  const Ic = dir === 'prev' ? Icon.arrowL : Icon.arrow
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        width: 32, height: 32, borderRadius: '50%', cursor: 'pointer',
        background: '#fff', border: 'none', color: '#01010D',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <Ic size={13} />
    </button>
  )
}

/**
 * Month + year chooser (same design language): round year nav, 3×4 month
 * grid, the selected month as the glowing blue pill. Used inside
 * CalendarPanel (click the month label) and by MonthNav toolbars.
 * Clicking the YEAR label opens a 12-year grid (same pill styling) so users
 * can jump years directly instead of tapping the arrow once per year.
 */
export function MonthYearPanel({ cursor, onPick }: { cursor: Date; onPick: (d: Date) => void }) {
  const [year, setYear] = useState(cursor.getFullYear())
  const [view, setView] = useState<'months' | 'years'>('months')
  // 12-year page aligned so the current selection sits inside it.
  const [yearBase, setYearBase] = useState(() => Math.floor(cursor.getFullYear() / 12) * 12)

  if (view === 'years') {
    const years = Array.from({ length: 12 }, (_, i) => yearBase + i)
    return (
      <div style={{ width: 316, padding: '14px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
          <RoundNav dir="prev" onClick={() => setYearBase((b) => b - 12)} />
          <span style={{ flex: 1, textAlign: 'center', fontSize: 15, fontWeight: 800 }}>
            {yearBase}–{yearBase + 11}
          </span>
          <RoundNav dir="next" onClick={() => setYearBase((b) => b + 12)} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
          {years.map((y) => {
            const isSel = y === year
            return (
              <button
                key={y}
                type="button"
                onClick={() => { setYear(y); setView('months') }}
                style={{
                  height: 40, border: 'none', cursor: 'pointer', borderRadius: 999,
                  background: isSel ? 'var(--blue)' : 'transparent',
                  color: isSel ? '#fff' : 'var(--text)',
                  fontSize: 12.5, fontWeight: isSel ? 800 : 600,
                  boxShadow: isSel ? '0 0 14px rgba(62,123,250,.35)' : 'none',
                }}
              >
                {y}
              </button>
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <div style={{ width: 316, padding: '14px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
        <RoundNav dir="prev" onClick={() => setYear((y) => y - 1)} />
        <button
          type="button"
          onClick={() => { setYearBase(Math.floor(year / 12) * 12); setView('years') }}
          title="Choose year"
          style={{
            flex: 1, textAlign: 'center', fontSize: 15, fontWeight: 800, cursor: 'pointer',
            background: 'transparent', border: 'none', color: 'var(--text)', fontFamily: 'inherit',
          }}
        >
          {year}
        </button>
        <RoundNav dir="next" onClick={() => setYear((y) => y + 1)} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
        {MONTHS.map((m, i) => {
          const isSel = year === cursor.getFullYear() && i === cursor.getMonth()
          return (
            <button
              key={m}
              type="button"
              onClick={() => onPick(new Date(year, i, 1))}
              style={{
                height: 40, border: 'none', cursor: 'pointer', borderRadius: 999,
                background: isSel ? 'var(--blue)' : 'transparent',
                color: isSel ? '#fff' : 'var(--text)',
                fontSize: 12.5, fontWeight: isSel ? 800 : 600,
                boxShadow: isSel ? '0 0 14px rgba(62,123,250,.35)' : 'none',
              }}
            >
              {m.slice(0, 3)}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function CalendarPanel({
  mode, selStart, selEnd, min, max, onPick, initialCursor,
}: {
  mode: 'single' | 'range'
  selStart: string
  selEnd: string | null
  min?: string
  max?: string
  onPick: (iso: string) => void
  initialCursor: Date
}) {
  const [cursor, setCursor] = useState(initialCursor)
  const [view, setView] = useState<'days' | 'months'>('days')

  if (view === 'months') {
    return (
      <MonthYearPanel
        cursor={cursor}
        onPick={(d) => { setCursor(d); setView('days') }}
      />
    )
  }

  const monthStart = new Date(cursor.getFullYear(), cursor.getMonth(), 1)
  const gridStart = new Date(monthStart)
  gridStart.setDate(monthStart.getDate() - dowMon(monthStart))
  const cells = Array.from({ length: 42 }, (_, i) => {
    const d = new Date(gridStart)
    d.setDate(gridStart.getDate() + i)
    return d
  })
  const inRange = (iso: string) => !!selStart && !!selEnd && iso >= selStart && iso <= selEnd
  const disabled = (iso: string) => (min ? iso < min : false) || (max ? iso > max : false)

  return (
    <div style={{ width: 316, padding: '14px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
        <RoundNav dir="prev" onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))} />
        <button
          type="button"
          onClick={() => setView('months')}
          title="Choose month and year"
          style={{
            flex: 1, textAlign: 'center', fontSize: 15, fontWeight: 800, cursor: 'pointer',
            background: 'transparent', border: 'none', color: 'var(--text)', fontFamily: 'inherit',
          }}
        >
          {monthLabel(cursor)}
        </button>
        <RoundNav dir="next" onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', marginBottom: 4 }}>
        {WEEK.map((w) => (
          <span key={w} style={{ textAlign: 'center', fontSize: 11.5, fontWeight: 700, color: 'var(--text-mute)', padding: '4px 0' }}>{w}</span>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', rowGap: 4 }}>
        {cells.map((d, i) => {
          const iso = toISO(d)
          const inMonth = d.getMonth() === cursor.getMonth()
          const isSel = mode === 'single' ? iso === selStart : inRange(iso) || iso === selStart
          const isStart = iso === selStart
          const isEnd = selEnd ? iso === selEnd : isStart
          const col = i % 7
          const off = disabled(iso)
          // The range pill: interior cells square; the range ends and any
          // row-wrap edges get the rounded outer corners.
          const borderRadius = !isSel
            ? 8
            : mode === 'single' || (isStart && isEnd)
              ? 999
              : `${isStart || col === 0 ? 999 : 0}px ${isEnd || col === 6 ? 999 : 0}px ${isEnd || col === 6 ? 999 : 0}px ${isStart || col === 0 ? 999 : 0}px`
          return (
            <button
              key={iso}
              type="button"
              disabled={off}
              onClick={() => onPick(iso)}
              style={{
                height: 38, border: 'none', cursor: off ? 'default' : 'pointer',
                background: isSel ? 'var(--blue)' : 'transparent',
                borderRadius,
                color: off ? 'var(--text-faint)' : isSel ? '#fff' : inMonth ? 'var(--text)' : 'var(--text-faint)',
                fontSize: 13.5, fontWeight: isSel ? 800 : 600,
                boxShadow: isSel ? '0 0 14px rgba(62,123,250,.35)' : 'none',
                opacity: off ? 0.5 : 1,
              }}
            >
              {d.getDate()}
            </button>
          )
        })}
      </div>
    </div>
  )
}

const triggerStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, width: '100%', height: 42,
  padding: '0 12px', textAlign: 'left', cursor: 'pointer',
  background: 'var(--surf-2)', border: '1px solid var(--bord)',
  borderRadius: 'var(--r-sm)', color: 'var(--text)', fontSize: 13, fontWeight: 600,
}

/** Single date. Value = 'YYYY-MM-DD' | ''. */
export function DateField({
  value, onChange, min, max, placeholder = 'Pick a date', id, disabled, required, style, defaultOpen,
}: {
  value: string
  onChange: (v: string) => void
  min?: string
  max?: string
  placeholder?: string
  id?: string
  disabled?: boolean
  required?: boolean
  style?: CSSProperties
  /** Open the popover on mount — for click-to-edit inline fields. */
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen ?? false)
  return (
    <Popover open={open} onOpenChange={disabled ? () => undefined : setOpen}>
      <PopoverTrigger asChild>
        <button type="button" id={id} disabled={disabled} aria-required={required} style={{ ...triggerStyle, opacity: disabled ? 0.55 : 1, ...style }}>
          <Icon.cal size={14} style={{ color: 'var(--text-mute)', flexShrink: 0 }} />
          <span style={{ flex: 1, color: value ? 'var(--text)' : 'var(--text-faint)', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
            {value ? fmtShort(value) : placeholder}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" style={{ padding: 0 }}>
        <CalendarPanel
          mode="single"
          selStart={value}
          selEnd={null}
          min={min}
          max={max}
          initialCursor={value ? parse(value) : new Date()}
          onPick={(iso) => { onChange(iso); setOpen(false) }}
        />
      </PopoverContent>
    </Popover>
  )
}

const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'))
const MINUTES = Array.from({ length: 12 }, (_, i) => String(i * 5).padStart(2, '0'))

/**
 * Date + time in one popover. Value = 'YYYY-MM-DDTHH:mm' | '' — byte-identical
 * to what <input type="datetime-local"> produced, so callers keep their format.
 * The calendar is the house one; the clock is two native selects (styled by
 * `select.input`), which is the house pattern for dropdowns.
 */
export function DateTimeField({
  value, onChange, min, placeholder = 'Pick date & time', id, disabled, required, style,
}: {
  value: string
  onChange: (v: string) => void
  /** Earliest selectable DATE (YYYY-MM-DD). */
  min?: string
  placeholder?: string
  id?: string
  disabled?: boolean
  required?: boolean
  style?: CSSProperties
}) {
  const [open, setOpen] = useState(false)
  const datePart = value.slice(0, 10)
  // Default to the next round hour so "schedule an activity" opens usable.
  const timePart = value.length >= 16 ? value.slice(11, 16) : '09:00'
  const [hh, mm] = timePart.split(':')

  const commit = (d: string, t: string) => onChange(d ? `${d}T${t}` : '')

  return (
    <Popover open={open} onOpenChange={disabled ? () => undefined : setOpen}>
      <PopoverTrigger asChild>
        <button type="button" id={id} disabled={disabled} aria-required={required} style={{ ...triggerStyle, opacity: disabled ? 0.55 : 1, ...style }}>
          <Icon.cal size={14} style={{ color: 'var(--text-mute)', flexShrink: 0 }} />
          <span style={{ flex: 1, color: datePart ? 'var(--text)' : 'var(--text-faint)', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
            {datePart ? `${fmtShort(datePart)} · ${timePart}` : placeholder}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" style={{ padding: 0 }}>
        <CalendarPanel
          mode="single"
          selStart={datePart}
          selEnd={null}
          min={min}
          initialCursor={datePart ? parse(datePart) : new Date()}
          onPick={(iso) => commit(iso, timePart)}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 16px 14px' }}>
          <Icon.clock size={14} style={{ color: 'var(--text-mute)', flexShrink: 0 }} />
          <select
            className="input"
            aria-label="Hour"
            value={hh}
            onChange={(e) => commit(datePart || toISO(new Date()), `${e.target.value}:${mm}`)}
            style={{ height: 34, width: 74, fontSize: 12.5 }}
          >
            {HOURS.map((h) => <option key={h} value={h}>{h}</option>)}
          </select>
          <span style={{ color: 'var(--text-mute)', fontWeight: 800 }}>:</span>
          <select
            className="input"
            aria-label="Minute"
            value={MINUTES.includes(mm) ? mm : '00'}
            onChange={(e) => commit(datePart || toISO(new Date()), `${hh}:${e.target.value}`)}
            style={{ height: 34, width: 74, fontSize: 12.5 }}
          >
            {MINUTES.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <button
            type="button"
            onClick={() => setOpen(false)}
            style={{
              marginLeft: 'auto', height: 34, padding: '0 14px', borderRadius: 999,
              background: 'var(--blue)', border: 'none', color: '#fff',
              fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            Done
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** Month + year in one popover. Value = 'YYYY-MM' | '' (replaces type="month"). */
export function MonthField({
  value, onChange, placeholder = 'Pick a month', id, disabled, style,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  id?: string
  disabled?: boolean
  style?: CSSProperties
}) {
  const [open, setOpen] = useState(false)
  const cursor = value ? new Date(`${value}-01T00:00:00`) : new Date()

  return (
    <Popover open={open} onOpenChange={disabled ? () => undefined : setOpen}>
      <PopoverTrigger asChild>
        <button type="button" id={id} disabled={disabled} style={{ ...triggerStyle, opacity: disabled ? 0.55 : 1, ...style }}>
          <Icon.cal size={14} style={{ color: 'var(--text-mute)', flexShrink: 0 }} />
          <span style={{ flex: 1, color: value ? 'var(--text)' : 'var(--text-faint)', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
            {value ? monthLabel(cursor) : placeholder}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" style={{ padding: 0 }}>
        <MonthYearPanel
          cursor={cursor}
          onPick={(d) => {
            onChange(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

/** From–to range in ONE field/popover; the selection renders as a blue pill. */
export function DateRangeField({
  start, end, onChange, min, max, disabled, style,
}: {
  start: string
  end: string
  onChange: (r: { start: string; end: string }) => void
  min?: string
  max?: string
  disabled?: boolean
  style?: CSSProperties
}) {
  const [open, setOpen] = useState(false)
  // Draft while picking: first click sets start (end pending), second commits.
  const [draft, setDraft] = useState<{ start: string; end: string | null }>({ start, end })
  useEffect(() => {
    if (open) setDraft({ start, end })
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (iso: string) => {
    if (!draft.start || draft.end !== null) {
      // fresh selection
      setDraft({ start: iso, end: null })
    } else if (iso < draft.start) {
      // clicking before the start RESTARTS the range there (invariant end>=start)
      setDraft({ start: iso, end: null })
    } else {
      setDraft({ start: draft.start, end: iso })
      onChange({ start: draft.start, end: iso })
      setOpen(false)
    }
  }

  const label = start && end
    ? start === end ? fmtShort(start) : `${fmtShort(start)} – ${fmtShort(end)}`
    : 'Pick a date range'

  return (
    <Popover open={open} onOpenChange={disabled ? () => undefined : setOpen}>
      <PopoverTrigger asChild>
        <button type="button" disabled={disabled} style={{ ...triggerStyle, opacity: disabled ? 0.55 : 1, ...style }}>
          <Icon.cal size={14} style={{ color: 'var(--text-mute)', flexShrink: 0 }} />
          <span style={{ flex: 1, color: start ? 'var(--text)' : 'var(--text-faint)', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
            {label}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" style={{ padding: 0 }}>
        <CalendarPanel
          mode="range"
          selStart={draft.start}
          selEnd={draft.end}
          min={min}
          max={max}
          initialCursor={draft.start ? parse(draft.start) : new Date()}
          onPick={pick}
        />
      </PopoverContent>
    </Popover>
  )
}
