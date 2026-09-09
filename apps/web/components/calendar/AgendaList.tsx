'use client'

import { useMemo } from 'react'
import { Icon } from '@/components/proto'
import type { CalendarFeedItem } from '@/lib/api/queries/use-calendar'
import { EventChip, type ChipActions } from './EventChip'
import { fmtDayLong, occursOn, sortItems, toISODate, todayISO } from './calendar-utils'

/**
 * Agenda — date-grouped list of everything in the range (the phone layout,
 * and a view on desktop). Days without items are skipped.
 */
export function AgendaList({
  days,
  items,
  actions,
  onNewOn,
}: {
  days: Date[]
  items: CalendarFeedItem[]
  actions: ChipActions
  onNewOn: (iso: string) => void
}) {
  const today = todayISO()
  const groups = useMemo(
    () =>
      days
        .map((d) => {
          const iso = toISODate(d)
          return { iso, d, items: sortItems(items.filter((it) => occursOn(it, iso))) }
        })
        .filter((g) => g.items.length > 0),
    [days, items],
  )

  if (groups.length === 0) {
    return (
      <div className="card" style={{ padding: '40px 24px', textAlign: 'center' }} data-calendar-grid="agenda">
        <Icon.cal size={22} style={{ color: 'var(--text-faint)', marginBottom: 8 }} />
        <div style={{ fontSize: 13.5, fontWeight: 800 }}>Nothing scheduled</div>
        <div className="t-mute" style={{ fontSize: 12, marginTop: 4 }}>
          No holidays, leave, meetings or events in these {days.length} days.
        </div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-calendar-grid="agenda">
      {groups.map(({ iso, d, items: dayItems }) => (
        <div key={iso} className="card" style={{ padding: '10px 12px' }} data-agenda-day={iso}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 26, height: 26, padding: '0 6px', borderRadius: 999,
                background: iso === today ? 'var(--blue)' : 'var(--surf-2)', color: iso === today ? '#fff' : 'var(--text)', fontSize: 12.5, fontWeight: 800,
              }}
            >
              {d.getDate()}
            </span>
            <span style={{ fontSize: 12.5, fontWeight: 800, color: iso === today ? 'var(--blue)' : 'var(--text)' }}>{fmtDayLong(d)}</span>
            <span style={{ flex: 1 }} />
            <button
              type="button"
              onClick={() => onNewOn(iso)}
              title="New event on this day"
              style={{ width: 24, height: 24, borderRadius: 7, border: '1px solid var(--bord)', background: 'var(--surf-1)', color: 'var(--text-2)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
            >
              <Icon.plus size={12} />
            </button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {dayItems.map((it) => (
              <EventChip key={it.id} item={it} variant="chip" actions={actions} style={{ height: 30, fontSize: 12.5, borderRadius: 7 }} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
