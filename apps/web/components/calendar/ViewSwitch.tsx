'use client'

import { VIEW_LABEL, type CalendarView } from './calendar-utils'

/** The attendance-page segmented pill, for Day / Week / Month / Agenda. */
export function ViewSwitch({
  view,
  onChange,
  options,
}: {
  view: CalendarView
  onChange: (v: CalendarView) => void
  options: CalendarView[]
}) {
  return (
    <div
      role="tablist"
      aria-label="Calendar view"
      style={{
        display: 'flex',
        gap: 3,
        padding: 3,
        background: 'var(--surf-1)',
        border: '1px solid var(--bord)',
        borderRadius: 9,
      }}
    >
      {options.map((key) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={view === key}
          onClick={() => onChange(key)}
          style={{
            padding: '6px 12px',
            borderRadius: 7,
            border: 'none',
            cursor: 'pointer',
            background: view === key ? 'var(--surf-3)' : 'transparent',
            color: view === key ? '#fff' : 'var(--text-2)',
            fontSize: 11.5,
            fontWeight: 800,
            fontFamily: 'inherit',
          }}
        >
          {VIEW_LABEL[key]}
        </button>
      ))}
    </div>
  )
}
