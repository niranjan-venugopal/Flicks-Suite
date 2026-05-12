'use client'

import type { ReactNode } from 'react'

interface DonutSegment {
  value: number
  color: string
}

interface DonutProps {
  segments: DonutSegment[]
  size?: number
  thickness?: number
  label?: ReactNode
  sub?: ReactNode
}

export function Donut({ segments, size = 120, thickness = 14, label, sub }: DonutProps) {
  const r = (size - thickness) / 2
  const c = 2 * Math.PI * r
  const total = segments.reduce((s, x) => s + x.value, 0) || 1
  let off = 0

  return (
    <div style={{ position: 'relative', width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="rgba(255,255,255,.06)"
          strokeWidth={thickness}
        />
        {segments.map((s, i) => {
          const len = (s.value / total) * c
          const dash = `${len} ${c - len}`
          const el = (
            <circle
              key={i}
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={s.color}
              strokeWidth={thickness}
              strokeDasharray={dash}
              strokeDashoffset={-off}
              strokeLinecap="butt"
            />
          )
          off += len
          return el
        })}
      </svg>
      {(label || sub) && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {label && (
            <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.03em' }}>{label}</div>
          )}
          {sub && (
            <div
              style={{
                fontSize: 10.5,
                fontWeight: 700,
                color: 'rgba(255,255,255,.5)',
                letterSpacing: '.04em',
                textTransform: 'uppercase',
                marginTop: 2,
              }}
            >
              {sub}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
