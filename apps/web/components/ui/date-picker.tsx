'use client'

import { useEffect, useState, type CSSProperties } from 'react'
import { Icon } from '@/components/proto'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

// ─────────────────────────────────────────────────────────
// House date picker (design ref: dark popover — centered "April 2023" with
// round prev/next buttons, Mo–Su headers, 6 rows, adjacent-month days
// dimmed; range selection renders as ONE rounded blue pill spanning the
// days). Values are house YYYY-MM-DD strings ('' = empty). Replaces the
// native <input type="date"> everywhere; datetime-local/month stay native.
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
        <span style={{ flex: 1, textAlign: 'center', fontSize: 15, fontWeight: 800 }}>{monthLabel(cursor)}</span>
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
