'use client'

import { Toggle } from '@/components/proto'
import { FILTER_KEYS, FILTER_META, type FilterKey } from './calendar-utils'

/** Legend + per-source toggles (the rail under the mini month). */
export function CalendarLegend({
  filters,
  onChange,
  showCrm,
}: {
  filters: Record<FilterKey, boolean>
  onChange: (next: Record<FilterKey, boolean>) => void
  showCrm: boolean
}) {
  const keys = FILTER_KEYS.filter((k) => k !== 'crm' || showCrm)
  return (
    <div className="card" style={{ padding: '12px 14px' }}>
      <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--text-mute)', marginBottom: 8 }}>
        Show
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {keys.map((k) => (
          <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: FILTER_META[k].color, flexShrink: 0 }} />
            <span
              onClick={() => onChange({ ...filters, [k]: !filters[k] })}
              style={{ flex: 1, fontSize: 12, fontWeight: 700, color: filters[k] ? 'var(--text)' : 'var(--text-mute)', cursor: 'pointer', userSelect: 'none' }}
            >
              {FILTER_META[k].label}
            </span>
            <Toggle on={filters[k]} onChange={(v) => onChange({ ...filters, [k]: v })} />
          </div>
        ))}
      </div>
    </div>
  )
}
