'use client'

import { useState, type CSSProperties, type ReactNode } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

// ─────────────────────────────────────────────────────────
// Round E — Linear-style property pills for the issue composer: a compact
// chip (glyph + current value) that opens a menu in a popover. Single-select
// closes on pick; multi-select (labels) stays open. Built on the house radix
// Popover so it layers correctly above the modal scrim (z-float).
// ─────────────────────────────────────────────────────────

const pillStyle = (active: boolean): CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  height: 26,
  padding: '0 9px',
  borderRadius: 7,
  background: active ? 'var(--surf-2)' : 'var(--surf-1)',
  border: '1px solid var(--bord)',
  color: active ? '#fff' : 'var(--text-2)',
  fontSize: 11,
  fontWeight: 700,
  cursor: 'pointer',
  maxWidth: 200,
  whiteSpace: 'nowrap',
})

export function PropertyPill({
  icon,
  label,
  title,
  active = false,
  width = 220,
  menu,
}: {
  icon?: ReactNode
  label: ReactNode
  title?: string
  /** Renders the pill "filled" (a value is picked). */
  active?: boolean
  width?: number
  /** Menu content; call close() after a single-select pick. */
  menu: (close: () => void) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" title={title} style={pillStyle(active)}>
          {icon}
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" style={{ width, maxHeight: 280, overflowY: 'auto', padding: 5 }}>
        {menu(() => setOpen(false))}
      </PopoverContent>
    </Popover>
  )
}

/** One row inside a PropertyPill menu. */
export function PillOption({
  icon,
  label,
  selected = false,
  onPick,
}: {
  icon?: ReactNode
  label: ReactNode
  selected?: boolean
  onPick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      style={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 9px',
        borderRadius: 7,
        background: selected ? 'var(--surf-2)' : 'transparent',
        border: 'none',
        cursor: 'pointer',
        color: selected ? '#fff' : 'var(--text-2)',
        fontSize: 11.5,
        fontWeight: 700,
        textAlign: 'left',
      }}
    >
      {icon}
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {label}
      </span>
      {selected && <span style={{ fontSize: 10, color: 'var(--text-mute)' }}>✓</span>}
    </button>
  )
}
