'use client'

import { CalendarPanel } from '@/components/ui/date-picker'
import { toISODate } from './calendar-utils'

// The house panel is 316 px wide by design; the rail is 256 px, so it is
// scaled down uniformly (nav buttons and the 6-row grid keep their proportions).
const PANEL_W = 316
const PANEL_H = 352
const SCALE = 0.79

/**
 * The rail's month picker — the house date-picker panel in single mode.
 * Keyed by month so prev/next in the toolbar moves the panel too (it keeps
 * its own cursor while the user browses inside it).
 */
export function MiniMonth({ date, onPick }: { date: Date; onPick: (iso: string) => void }) {
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden', width: '100%' }}>
      <div style={{ width: PANEL_W * SCALE, height: PANEL_H * SCALE, margin: '0 auto', position: 'relative' }}>
        <div style={{ position: 'absolute', top: 0, left: 0, width: PANEL_W, transform: `scale(${SCALE})`, transformOrigin: 'top left' }}>
          <CalendarPanel
            key={`${date.getFullYear()}-${date.getMonth()}`}
            mode="single"
            selStart={toISODate(date)}
            selEnd={null}
            initialCursor={date}
            onPick={onPick}
          />
        </div>
      </div>
    </div>
  )
}
