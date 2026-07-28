'use client'

import { useState } from 'react'
import { Icon } from '@/components/proto'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { MonthYearPanel } from '@/components/ui/date-picker'

// ─────────────────────────────────────────────────────────
// Shared month toolbar for the calendar + attendance pages: the bold month
// title opens the month/year chooser (same dark design as the date picker),
// flanked by the round prev/next pair. `maxMonth` disables forward nav past
// that month (attendance has no future records).
// ─────────────────────────────────────────────────────────

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

export function monthTitle(d: Date): string {
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`
}

const monthKey = (d: Date) => d.getFullYear() * 12 + d.getMonth()

function RoundNav({ dir, onClick, disabled }: { dir: 'prev' | 'next'; onClick: () => void; disabled?: boolean }) {
  const Ic = dir === 'prev' ? Icon.arrowL : Icon.arrow
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={dir === 'prev' ? 'Previous month' : 'Next month'}
      style={{
        width: 34, height: 34, borderRadius: '50%', cursor: disabled ? 'default' : 'pointer',
        background: dir === 'next' ? '#fff' : 'transparent',
        border: dir === 'next' ? 'none' : '1px solid var(--bord-2)',
        color: dir === 'next' ? '#01010D' : 'var(--text)',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        opacity: disabled ? 0.35 : 1,
      }}
    >
      <Ic size={13} />
    </button>
  )
}

export function MonthNav({ cursor, onChange, maxMonth }: {
  cursor: Date
  onChange: (d: Date) => void
  maxMonth?: Date
}) {
  const [open, setOpen] = useState(false)
  const nextDisabled = maxMonth ? monthKey(cursor) >= monthKey(maxMonth) : false
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            title="Choose month and year"
            style={{
              fontSize: 20, fontWeight: 800, letterSpacing: '-0.02em', cursor: 'pointer',
              background: 'transparent', border: 'none', color: 'var(--text)', fontFamily: 'inherit', padding: 0,
            }}
          >
            {monthTitle(cursor)}
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" style={{ padding: 0 }}>
          <MonthYearPanel
            cursor={cursor}
            onPick={(d) => {
              onChange(maxMonth && monthKey(d) > monthKey(maxMonth) ? new Date(maxMonth.getFullYear(), maxMonth.getMonth(), 1) : d)
              setOpen(false)
            }}
          />
        </PopoverContent>
      </Popover>
      <RoundNav dir="prev" onClick={() => onChange(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))} />
      <RoundNav dir="next" disabled={nextDisabled} onClick={() => onChange(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))} />
    </>
  )
}
