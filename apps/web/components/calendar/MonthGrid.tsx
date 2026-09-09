'use client'

import { useMemo } from 'react'
import type { CalendarFeedItem } from '@/lib/api/queries/use-calendar'
import { EventChip, type ChipActions } from './EventChip'
import { atMinutes, occursOn, sortItems, toISODate, todayISO, weekdayShort } from './calendar-utils'

const MAX_CHIPS = 3

/**
 * Month view — 6 × 7 cells honouring the workspace's first day of the
 * week, up to three chips per day and a "+N more" that jumps to that day.
 * No attendance dots: every item is a real, titled chip.
 */
export function MonthGrid({
  cells,
  month,
  weekStartsOn,
  items,
  actions,
  onOpenDay,
  onSlotClick,
}: {
  cells: Date[]
  month: number
  weekStartsOn: number
  items: CalendarFeedItem[]
  actions: ChipActions
  onOpenDay: (iso: string) => void
  onSlotClick: (start: Date) => void
}) {
  const today = todayISO()
  const headers = Array.from({ length: 7 }, (_, i) => weekdayShort((weekStartsOn + i) % 7))
  const perDay = useMemo(
    () =>
      cells.map((d) => {
        const iso = toISODate(d)
        return { iso, d, items: sortItems(items.filter((it) => occursOn(it, iso))) }
      }),
    [cells, items],
  )

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }} data-calendar-grid="month">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', borderBottom: '1px solid var(--bord)', background: 'var(--bg-2)' }}>
        {headers.map((h, i) => (
          <div key={`${h}-${i}`} style={{ padding: '9px 10px', fontSize: 10.5, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--text-mute)', borderLeft: i ? '1px solid var(--bord)' : 'none' }}>
            {h}
          </div>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gridAutoRows: 'minmax(108px, 1fr)' }}>
        {perDay.map(({ iso, d, items: dayItems }, i) => {
          const inMonth = d.getMonth() === month
          const isToday = iso === today
          const shown = dayItems.length > MAX_CHIPS ? dayItems.slice(0, MAX_CHIPS - 1) : dayItems
          const more = dayItems.length - shown.length
          return (
            <div
              key={iso}
              data-calendar-cell={iso}
              onClick={() => onSlotClick(atMinutes(iso, 9 * 60))}
              style={{
                padding: '6px 6px 6px',
                borderLeft: i % 7 ? '1px solid var(--bord)' : 'none',
                borderTop: i >= 7 ? '1px solid var(--bord)' : 'none',
                background: isToday ? 'rgba(62,123,250,.05)' : 'transparent',
                opacity: inMonth ? 1 : 0.45,
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
                minWidth: 0,
                cursor: 'copy',
              }}
            >
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onOpenDay(iso) }}
                title="Open day"
                style={{
                  alignSelf: 'flex-start', minWidth: 24, height: 24, padding: '0 6px', borderRadius: 999, border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                  background: isToday ? 'var(--blue)' : 'transparent', color: isToday ? '#fff' : 'var(--text)', fontSize: 12.5, fontWeight: 800, marginBottom: 2,
                }}
              >
                {d.getDate()}
              </button>
              {shown.map((it) => (
                <EventChip key={it.id} item={it} variant="chip" actions={actions} />
              ))}
              {more > 0 && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onOpenDay(iso) }}
                  style={{ height: 18, border: 'none', background: 'transparent', color: 'var(--text-mute)', fontSize: 10.5, fontWeight: 800, cursor: 'pointer', textAlign: 'left', padding: '0 6px', fontFamily: 'inherit' }}
                >
                  +{more} more
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
