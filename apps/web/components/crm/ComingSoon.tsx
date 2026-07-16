'use client'

import { Icon, Pill } from '@/components/proto'
import type { ReactNode } from 'react'

/**
 * "Coming soon" panel for parked features — used while a surface is being
 * rethought. Full-page variant for routes, compact variant for tabs/cards.
 */
export function ComingSoon({
  title,
  line,
  icon,
  bullets,
  compact,
}: {
  title: string
  line: string
  icon?: ReactNode
  bullets?: string[]
  compact?: boolean
}) {
  return (
    <div style={compact ? {} : { padding: '28px 32px 64px', maxWidth: 760, margin: '0 auto' }}>
      <div className="card" style={{ textAlign: 'center', padding: compact ? '34px 24px' : '54px 24px' }}>
        <div style={{ width: 56, height: 56, borderRadius: 16, background: 'var(--surf-2)', border: '1px solid var(--bord)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px', color: 'var(--text-mute)' }}>
          {icon ?? <Icon.spark size={24} />}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, marginBottom: 8 }}>
          <span style={{ fontSize: 16, fontWeight: 800 }}>{title}</span>
          <Pill tone="yellow">Coming soon</Pill>
        </div>
        <div className="t-mute" style={{ fontSize: 12.5, lineHeight: 1.6, maxWidth: 440, margin: '0 auto' }}>{line}</div>
        {bullets && bullets.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 380, margin: '18px auto 0', textAlign: 'left' }}>
            {bullets.map((b) => (
              <div key={b} style={{ display: 'flex', gap: 9 }}>
                <Icon.check size={13} style={{ color: 'var(--green)', flexShrink: 0, marginTop: 2 }} />
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)', lineHeight: 1.5 }}>{b}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
