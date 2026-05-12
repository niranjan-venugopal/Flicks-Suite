'use client'

import type { CSSProperties } from 'react'

const AV_BG: Array<[string, string]> = [
  ['#3E7BFA', '#5A95FF'],
  ['#27D280', '#3FE69E'],
  ['#FED800', '#FFE94D'],
  ['#F8786B', '#FFA08D'],
  ['#9B7BFA', '#B89BFF'],
  ['#FF8A3D', '#FFB066'],
  ['#22C9D6', '#5BE0EA'],
  ['#FF6E9C', '#FFA0BF'],
  ['#7CB342', '#A2D45A'],
]

/** Deterministic gradient seeded by name (or any string). */
export function avBg(seed: string | undefined | null): string {
  let h = 0
  for (const c of seed || '?') h = (h * 31 + c.charCodeAt(0)) | 0
  const i = Math.abs(h) % AV_BG.length
  return `linear-gradient(135deg, ${AV_BG[i]![0]} 0%, ${AV_BG[i]![1]} 100%)`
}

export function initials(name: string | undefined | null): string {
  if (!name) return '?'
  const p = name.trim().split(/\s+/)
  return ((p[0]?.[0] || '') + (p[1]?.[0] || p[0]?.[1] || '')).toUpperCase()
}

type AvatarSize = 'sm' | 'md' | 'lg' | 'xl'

interface AvatarProps {
  name?: string
  size?: AvatarSize
  src?: string
  className?: string
  style?: CSSProperties
}

export function Avatar({ name = '', size = 'md', src, className = '', style }: AvatarProps) {
  const sizeCls =
    size === 'lg' ? ' lg' : size === 'xl' ? ' xl' : size === 'sm' ? ' sm' : ''
  const cls = 'avatar' + sizeCls + (className ? ' ' + className : '')

  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={src} alt={name} className={cls} style={{ objectFit: 'cover', ...style }} />
    )
  }
  return (
    <div className={cls} style={{ background: avBg(name), ...style }}>
      {initials(name)}
    </div>
  )
}

interface AvatarStackProps {
  people: Array<{ name: string; src?: string } | string>
  max?: number
  size?: AvatarSize
}

export function AvatarStack({ people, max = 4, size = 'sm' }: AvatarStackProps) {
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center' }}>
      {people.slice(0, max).map((p, i) => {
        const obj = typeof p === 'string' ? { name: p } : p
        return (
          <Avatar
            key={i}
            name={obj.name}
            src={obj.src}
            size={size}
            style={{ marginLeft: i ? -8 : 0, zIndex: max - i }}
          />
        )
      })}
      {people.length > max && (
        <div
          className="avatar sm"
          style={{ marginLeft: -8, background: '#1a1a28', color: '#fff', fontSize: 9 }}
        >
          +{people.length - max}
        </div>
      )}
    </div>
  )
}
