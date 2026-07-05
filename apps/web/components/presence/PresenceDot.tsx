'use client'

import type { CSSProperties } from 'react'

/**
 * Presence primitives (PRD v4 §5 + design bundle exact spec).
 * Two axes: the dot is live presence; work context rides along as text.
 * Dot styles: green/red/yellow/purple solids · DND = red with a white dash ·
 * offline = hollow gray · ooo_available = green with a purple ring.
 */

export type PresenceStatus =
  | 'available'
  | 'busy'
  | 'dnd'
  | 'brb'
  | 'away'
  | 'offline'
  | 'in_office'
  | 'out_of_office'
  | 'ooo_available'
  | 'remote_available'

export const STATUS_META: Record<
  PresenceStatus,
  { label: string; dot: 'green' | 'red' | 'yellow' | 'purple' | 'dnd' | 'hollow' | 'ooo'; auto?: boolean }
> = {
  available: { label: 'Available', dot: 'green' },
  busy: { label: 'Busy', dot: 'red' },
  dnd: { label: 'Do not disturb', dot: 'dnd' },
  brb: { label: 'Be right back', dot: 'yellow' },
  away: { label: 'Appear away', dot: 'yellow' },
  offline: { label: 'Appear offline', dot: 'hollow' },
  in_office: { label: 'In office', dot: 'green', auto: true },
  out_of_office: { label: 'Out of office', dot: 'purple', auto: true },
  ooo_available: { label: 'Available · Out of office', dot: 'ooo', auto: true },
  remote_available: { label: 'Available · Remote', dot: 'green', auto: true },
}

const DOT_COLOR = { green: '#27D280', red: '#F8786B', yellow: '#FED800', purple: '#9B7BFA' }

export function PresenceDot({
  status = 'available',
  size = 10,
  ring = 'var(--bg)',
  style,
}: {
  status?: PresenceStatus
  size?: number
  ring?: string
  style?: CSSProperties
}) {
  const meta = STATUS_META[status] ?? STATUS_META.available
  const base: CSSProperties = {
    width: size,
    height: size,
    borderRadius: '50%',
    boxShadow: `0 0 0 ${Math.max(2, size * 0.18)}px ${ring}`,
    flexShrink: 0,
    display: 'inline-block',
    ...style,
  }
  if (meta.dot === 'hollow') {
    return (
      <span
        style={{
          ...base,
          background: 'transparent',
          border: `${Math.max(1.5, size * 0.16)}px solid #5C6477`,
          boxSizing: 'border-box',
        }}
      />
    )
  }
  if (meta.dot === 'ooo') {
    return (
      <span
        style={{
          ...base,
          background: DOT_COLOR.green,
          border: `${Math.max(1.5, size * 0.18)}px solid ${DOT_COLOR.purple}`,
          boxSizing: 'border-box',
        }}
      />
    )
  }
  if (meta.dot === 'dnd') {
    return (
      <span style={{ ...base, background: DOT_COLOR.red, position: 'relative' }}>
        <span
          style={{
            position: 'absolute',
            left: '18%',
            right: '18%',
            top: '50%',
            height: Math.max(1.5, size * 0.18),
            transform: 'translateY(-50%)',
            background: '#fff',
            borderRadius: 99,
          }}
        />
      </span>
    )
  }
  return <span style={{ ...base, background: DOT_COLOR[meta.dot] }} />
}
