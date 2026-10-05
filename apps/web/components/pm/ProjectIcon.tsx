'use client'

import { useEffect, useState } from 'react'
import { lucideComponent, looksLikeLucideIcon, tileColor } from './icons/project-icons'

/**
 * The project's face, everywhere (Round P R5): list rows, the project
 * header, the issue composer pill, the timeline, the roadmap, the issue
 * detail. Precedence:
 *   1. an uploaded image (`logoUrl`) — rounded square, broken-image fallback
 *      to the tile (signed URLs age out in offline caches);
 *   2. `lucide:<name>` — white glyph on the project's colour tile;
 *   3. a legacy emoji — on a neutral tile so old projects line up with new;
 *   4. nothing — the default glyph on the default colour.
 * `size` is the tile edge in px; the glyph scales with it.
 */
export function ProjectIcon({
  logoUrl,
  icon,
  color,
  name,
  size = 20,
  radius,
  className,
  style,
  title,
}: {
  logoUrl?: string | null
  icon?: string | null
  color?: string | null
  /** Seeds the fallback colour when the project has none stored. */
  name?: string | null
  size?: number
  radius?: number
  className?: string
  style?: React.CSSProperties
  title?: string
}) {
  const [broken, setBroken] = useState(false)
  useEffect(() => {
    setBroken(false)
  }, [logoUrl])
  const r = radius ?? Math.max(4, Math.round(size * 0.28))
  const base: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: r,
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    verticalAlign: 'middle',
    ...style,
  }

  if (logoUrl && !broken) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={logoUrl}
        alt=""
        title={title}
        className={className}
        onError={() => setBroken(true)}
        style={{ ...base, objectFit: 'cover', background: 'var(--surf-1)' }}
        data-project-icon="image"
      />
    )
  }

  if (looksLikeLucideIcon(icon)) {
    const Glyph = lucideComponent(icon)!
    return (
      <span
        className={className}
        title={title}
        style={{ ...base, background: tileColor(color, name), color: '#fff' }}
        data-project-icon="lucide"
        data-icon={icon}
      >
        <Glyph size={Math.round(size * 0.6)} strokeWidth={2} absoluteStrokeWidth={false} aria-hidden />
      </span>
    )
  }

  if (icon) {
    return (
      <span
        className={className}
        title={title}
        style={{ ...base, background: 'var(--surf-1)', border: '1px solid var(--bord)', fontSize: Math.round(size * 0.7), lineHeight: 1 }}
        data-project-icon="emoji"
      >
        {icon}
      </span>
    )
  }

  const Default = lucideComponent('lucide:folder-kanban')!
  return (
    <span
      className={className}
      title={title}
      style={{ ...base, background: tileColor(color, name), color: '#fff' }}
      data-project-icon="default"
    >
      <Default size={Math.round(size * 0.6)} strokeWidth={2} aria-hidden />
    </span>
  )
}
