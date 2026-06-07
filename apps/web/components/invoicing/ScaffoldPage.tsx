'use client'

import { Icon, Pill, SectionHead } from '@/components/proto'
import type { IconKey } from '@/components/proto'

/**
 * Invoicing v3 scaffold page. A consistent placeholder for routes whose UI is
 * implemented in a later sprint — keeps the navigation + route group real and
 * the design language (proto components + globals.css tokens) in place.
 */
export function ScaffoldPage({
  icon = 'wallet',
  eyebrow = 'Invoicing',
  title,
  sub,
  sprint,
}: {
  icon?: IconKey
  eyebrow?: string
  title: string
  sub?: string
  sprint: string
}) {
  const IconCmp = Icon[icon]
  return (
    <div style={{ padding: '28px 32px', maxWidth: 1100, margin: '0 auto' }}>
      <SectionHead
        eyebrow={eyebrow}
        title={title}
        sub={sub}
        right={<Pill tone="blue">{sprint}</Pill>}
      />
      <div
        className="glass"
        style={{
          marginTop: 24,
          padding: '48px 32px',
          borderRadius: 16,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 14,
          textAlign: 'center',
        }}
      >
        <div
          style={{
            width: 56,
            height: 56,
            borderRadius: 14,
            display: 'grid',
            placeItems: 'center',
            background: 'rgba(62,123,250,0.13)',
            color: 'var(--blue)',
          }}
        >
          <IconCmp size={26} />
        </div>
        <div className="t-h3">Coming together in {sprint}</div>
        <div className="t-body" style={{ color: 'var(--muted)', maxWidth: 520 }}>
          The data model, RLS isolation, and API routes for this area are
          scaffolded. The interactive UI lands in {sprint}.
        </div>
      </div>
    </div>
  )
}
