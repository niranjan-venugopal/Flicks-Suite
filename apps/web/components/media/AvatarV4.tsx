'use client'

import { useState } from 'react'
import { avBg, initials } from '@/components/proto'
import { PresenceDot, type PresenceStatus } from '@/components/presence/PresenceDot'

/**
 * D6 — Avatar v4 (PRD v4 §4). Numeric sizes (24/32/40/64 or any px), image ·
 * deterministic-initials fallback · loading shimmer · broken-image resolves to
 * initials (never a broken glyph). Presence-dot slot bottom-right, sized at
 * max(8, 30% of avatar), with a ring that matches the surface behind it.
 *
 * The legacy proto <Avatar> (sm/md/lg/xl class-based) remains untouched — this
 * component is additive and adopted surface-by-surface.
 */
export function AvatarV4({
  name = 'User',
  size = 40,
  src,
  loading = false,
  presence,
  ring = 'var(--bg)',
}: {
  name?: string
  size?: number
  src?: string | null
  loading?: boolean
  presence?: PresenceStatus
  ring?: string
}) {
  const [broken, setBroken] = useState(false)
  const dotSize = Math.max(8, Math.round(size * 0.3))

  const inner = (() => {
    if (loading) {
      return (
        <div
          className="v4-shimmer"
          style={{
            width: size,
            height: size,
            background:
              'linear-gradient(100deg, var(--surf-2) 40%, var(--surf-3) 50%, var(--surf-2) 60%)',
            backgroundSize: '200% 100%',
            animation: 'v4shimmer 1.4s linear infinite',
          }}
        />
      )
    }
    if (src && !broken) {
      return (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={name}
          width={size}
          height={size}
          style={{ width: size, height: size, objectFit: 'cover', display: 'block' }}
          onError={() => setBroken(true)}
        />
      )
    }
    return (
      <div
        style={{
          width: size,
          height: size,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: avBg(name),
          color: '#fff',
          fontWeight: 800,
          fontSize: Math.max(9, size * 0.36),
          letterSpacing: '-0.02em',
        }}
      >
        {initials(name)}
      </div>
    )
  })()

  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <style>{`@keyframes v4shimmer { 0% { background-position: 200% 0 } 100% { background-position: -200% 0 } }`}</style>
      <div style={{ width: size, height: size, borderRadius: '50%', overflow: 'hidden' }}>{inner}</div>
      {presence && (
        <span style={{ position: 'absolute', bottom: -1, right: -1, lineHeight: 0 }}>
          <PresenceDot status={presence} size={dotSize} ring={ring} />
        </span>
      )}
    </div>
  )
}
