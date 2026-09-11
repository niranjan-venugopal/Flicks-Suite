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

// The brand tile, traced from the original Specflicks artwork (spec-pfp.png):
// the same diagonal navy gradient and the same bolt outline, drawn inline so
// the mark never depends on a file request. A stale or filtered image
// response (founder, 2026-09-11, Safari) used to leave a broken-image glyph
// in every sidebar; nothing here can fail to load.
const MARK_GRADIENT =
  'linear-gradient(to top right, #1e3b7e 0%, #11214a 25%, #070c22 50%, #020310 100%)'
const MARK_PATH =
  'M100.6 126.6 L103.7 121.7 L107.3 118.3 L124.7 97.7 L129.3 93.3 L139.7 80.7 L147.3 73.3 L149.4 72.4 L151.7 72.3 L154.0 73.0 L155.6 74.4 L156.6 76.4 L157.0 79.0 L157.0 117.0 L157.6 119.4 L158.6 120.4 L161.0 121.0 L177.7 121.3 L179.7 122.3 L181.0 124.0 L181.9 127.9 L180.9 130.9 L178.3 134.3 L174.7 137.7 L164.3 150.3 L159.7 154.7 L142.3 175.3 L135.3 182.3 L132.7 183.7 L131.1 183.9 L128.0 183.0 L126.3 181.7 L125.0 178.0 L125.0 139.0 L124.4 136.6 L123.1 135.7 L109.0 136.0 L104.1 134.9 L102.3 133.7 L101.0 132.0 L100.1 128.9Z M74.6 106.3 L75.0 105.0 L76.6 103.6 L79.0 103.0 L100.0 103.0 L103.7 104.3 L104.7 106.3 L104.7 107.7 L103.1 110.1 L100.0 111.0 L79.0 111.0 L76.6 110.4 L75.4 109.6 L74.7 108.3Z M74.6 128.3 L75.4 126.4 L78.4 124.4 L86.0 124.0 L88.4 124.6 L90.3 125.7 L91.4 127.6 L91.6 129.6 L90.6 131.6 L88.7 132.7 L80.0 133.0 L77.4 132.6 L75.6 131.4 L74.7 130.3Z'

export function LogoMark({ size = 32, style }: LogoMarkProps) {
  return (
    <span
      role="img"
      aria-label="Flicks Suite"
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.28,
        background: MARK_GRADIENT,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        overflow: 'hidden',
        ...style,
      }}
    >
      <svg width={size} height={size} viewBox="0 0 256 256" fill="#fff" aria-hidden="true">
        <path d={MARK_PATH} />
      </svg>
    </span>
  )
}
