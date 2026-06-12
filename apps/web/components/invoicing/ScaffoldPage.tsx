'use client'

import { Icon } from '@/components/proto'
import type { IconKey } from '@/components/proto'
import { INVO, InvoPage, InvoTitle, InvoCard } from '@/components/invoicing/invo'

/**
 * Invoicing scaffold page (Invo design language). A consistent placeholder for
 * routes whose UI is implemented in a later sprint — keeps navigation real and
 * the prototype look in place.
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
    <InvoPage>
      <InvoTitle
        right={
          <span
            style={{
              padding: '4px 12px',
              borderRadius: 999,
              background: 'rgba(62,123,250,0.15)',
              color: INVO.blue,
              fontWeight: 700,
              fontSize: 12,
              letterSpacing: '-0.01em',
            }}
          >
            {sprint}
          </span>
        }
      >
        {title}
      </InvoTitle>
      {sub && (
        <div style={{ fontWeight: 600, fontSize: 14, color: INVO.muted50, letterSpacing: '-0.02em', marginTop: -8, marginBottom: 24 }}>
          {sub}
        </div>
      )}
      <InvoCard
        strong
        style={{
          padding: '48px 32px',
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
            color: INVO.blue,
          }}
        >
          <IconCmp size={26} />
        </div>
        <div style={{ fontWeight: 700, fontSize: 18, color: '#fff', letterSpacing: '-0.02em' }}>
          Coming together in {sprint}
        </div>
        <div style={{ fontWeight: 600, fontSize: 14, color: INVO.muted50, maxWidth: 520, letterSpacing: '-0.02em' }}>
          The data model, RLS isolation, and API routes for this area are scaffolded. The interactive UI lands in {sprint}.
        </div>
      </InvoCard>
    </InvoPage>
  )
}
