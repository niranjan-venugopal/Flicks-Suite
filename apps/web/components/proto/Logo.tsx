'use client'

import type { CSSProperties } from 'react'

interface LogoProps {
  size?: number
  color?: string
  style?: CSSProperties
}

export function Logo({ size = 28, color = '#fff', style }: LogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 36 36"
      fill={color}
      style={{ flexShrink: 0, ...style }}
    >
      {/* Bold lightning bolt */}
      <path d="M22.5 5L13 19L18.5 19L16 30L25.5 16.5L20 16.5Z" />
      {/* Motion / speed lines (top longer, bottom shorter) */}
      <rect x="3" y="13.8" width="8" height="2.8" rx="1.4" />
      <rect x="3" y="18.2" width="5.2" height="2.8" rx="1.4" />
    </svg>
  )
}

interface LogoMarkProps {
  size?: number
  style?: CSSProperties
}

export function LogoMark({ size = 32, style }: LogoMarkProps) {
  return (
    <img
      src="/spec-pfp.png"
      alt="Flicks Suite"
      width={size}
      height={size}
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.28,
        objectFit: 'cover',
        flexShrink: 0,
        ...style,
      }}
    />
  )
}
