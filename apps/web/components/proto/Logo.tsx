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
      <path d="M1.73 16.74L6.34 16.74L6.34 27.73C6.34 29.36 8.38 30.14 9.47 28.88L21.1 15.44C22.14 14.26 21.31 12.43 19.74 12.43L15.12 12.43L15.12 1.44C15.12 -0.19 13.08 -0.97 11.99 0.29L0.36 13.73C-0.68 14.91 0.15 16.74 1.73 16.74Z" />
      <rect x="0" y="9.5" width="7" height="2.2" rx="1.1" />
      <rect x="0" y="14" width="4" height="2.2" rx="1.1" />
    </svg>
  )
}

interface LogoMarkProps {
  size?: number
  style?: CSSProperties
}

export function LogoMark({ size = 32, style }: LogoMarkProps) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.28,
        background: 'linear-gradient(135deg, #3E7BFA 0%, #5A95FF 60%, #9B7BFA 100%)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxShadow: '0 6px 16px rgba(62,123,250,.4), inset 0 1px 0 rgba(255,255,255,.3)',
        flexShrink: 0,
        ...style,
      }}
    >
      <Logo size={size * 0.62} color="#fff" />
    </div>
  )
}
