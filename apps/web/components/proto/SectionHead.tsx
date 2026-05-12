'use client'

import type { ReactNode } from 'react'

interface SectionHeadProps {
  eyebrow?: ReactNode
  title: ReactNode
  sub?: ReactNode
  right?: ReactNode
}

export function SectionHead({ eyebrow, title, sub, right }: SectionHeadProps) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-end',
        marginBottom: 18,
        gap: 24,
      }}
    >
      <div>
        {eyebrow && (
          <div className="t-caption" style={{ marginBottom: 6 }}>
            {eyebrow}
          </div>
        )}
        <div className="t-h2" style={{ marginBottom: sub ? 6 : 0 }}>
          {title}
        </div>
        {sub && <div className="t-mute">{sub}</div>}
      </div>
      {right}
    </div>
  )
}
