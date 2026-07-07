'use client'

import type { CSSProperties } from 'react'

/**
 * Shimmer placeholder (perceived-performance pass, 2026-07-06). Uses the
 * `.skel` class from globals.css; size via props, layout via `style`.
 */
export function Skeleton({
  w = '100%',
  h = 14,
  r = 8,
  style,
}: {
  w?: number | string
  h?: number | string
  r?: number | string
  style?: CSSProperties
}) {
  return <div className="skel" style={{ width: w, height: h, borderRadius: r, ...style }} />
}

/** A card-shaped skeleton block: title bar + n content lines. */
export function SkeletonCard({ lines = 3, style }: { lines?: number; style?: CSSProperties }) {
  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12, ...style }}>
      <Skeleton w={160} h={16} />
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} h={12} w={`${88 - i * 14}%`} />
      ))}
    </div>
  )
}
