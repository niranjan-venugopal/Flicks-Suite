'use client'

import { useEffect, useState, type CSSProperties } from 'react'
import { Icon } from '@/components/proto'
import { assetCategoryIcon, assetCategoryLabel } from '@/lib/api/queries/use-assets'

/**
 * Round P R4 — the register's photo tile. Shows the signed 64 / 256 px photo
 * when there is one, otherwise a tinted category glyph so a row without a
 * photo still reads at a glance (laptop vs SIM vs ID card). Signed URLs
 * expire after 15 minutes: an img error falls back to the glyph instead of
 * the browser's broken-image icon.
 */
export function AssetThumb({
  src,
  category,
  name,
  size = 36,
  radius = 9,
  style,
}: {
  src: string | null | undefined
  category: string | null | undefined
  name?: string
  size?: number
  radius?: number
  style?: CSSProperties
}) {
  const [broken, setBroken] = useState(false)
  useEffect(() => {
    setBroken(false)
  }, [src])

  const base: CSSProperties = {
    width: size,
    height: size,
    borderRadius: radius,
    flexShrink: 0,
    overflow: 'hidden',
    ...style,
  }

  if (src && !broken) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={name ?? assetCategoryLabel(category)}
        onError={() => setBroken(true)}
        style={{ ...base, objectFit: 'cover', background: 'var(--surf-2)', border: '1px solid var(--bord)' }}
      />
    )
  }

  const Glyph = Icon[assetCategoryIcon(category)]
  return (
    <div
      title={assetCategoryLabel(category)}
      style={{
        ...base,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'color-mix(in srgb, var(--blue) 12%, transparent)',
        color: 'var(--blue)',
        border: '1px solid color-mix(in srgb, var(--blue) 18%, transparent)',
      }}
    >
      <Glyph size={Math.max(12, Math.round(size * 0.46))} />
    </div>
  )
}
