'use client'

import type { ReactNode } from 'react'

type Accent = 'blue' | 'green' | 'yellow' | 'coral' | 'purple'
const ACCENT_MAP: Record<Accent, string> = {
  blue: 'var(--blue)',
  green: 'var(--green)',
  yellow: 'var(--yellow)',
  coral: 'var(--coral)',
  purple: 'var(--purple)',
}

interface KpiProps {
  label: string
  value: ReactNode
  delta?: ReactNode
  trend?: 'up' | 'down' | 'flat'
  icon?: ReactNode
  accent?: Accent
}

export function Kpi({ label, value, delta, trend, icon, accent = 'blue' }: KpiProps) {
  const c = ACCENT_MAP[accent]
  const trendColor =
    trend === 'up' ? 'var(--green)' : trend === 'down' ? 'var(--coral)' : 'var(--text-mute)'
  const trendArrow = trend === 'up' ? '↑' : trend === 'down' ? '↓' : '·'

  return (
    <div
      className="card"
      style={{
        padding: '18px 20px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        minHeight: 108,
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div className="t-caption">{label}</div>
        {icon && (
          <div
            style={{
              width: 30,
              height: 30,
              borderRadius: 8,
              background: `color-mix(in srgb, ${c} 13%, transparent)`,
              color: c,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {icon}
          </div>
        )}
      </div>
      <div
        style={{
          fontSize: 30,
          fontWeight: 800,
          letterSpacing: '-0.04em',
          color: 'var(--text)',
          fontVariantNumeric: 'tabular-nums',
          lineHeight: 1,
        }}
      >
        {value}
      </div>
      {delta !== undefined && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 12,
            fontWeight: 700,
            color: trendColor,
          }}
        >
          <span>{trendArrow}</span>
          {delta}
        </div>
      )}
    </div>
  )
}
