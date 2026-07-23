'use client'

import type { CSSProperties, ReactNode } from 'react'

interface IconProps {
  size?: number
  style?: CSSProperties
  className?: string
}

function makeIcon(path: ReactNode, viewBox = '0 0 24 24') {
  function IconCmp({ size = 18, style, className }: IconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox={viewBox}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={style}
        className={className}
      >
        {path}
      </svg>
    )
  }
  return IconCmp
}

/**
 * Flicks Suite icon set — ported verbatim from the prototype.
 * All icons share: line style, 1.6 stroke, round caps/joins, 24×24 view box (unless noted).
 *
 * Usage:  <Icon.home size={16} />
 */
export const Icon = {
  // Nav
  home: makeIcon(<><path d="M3 11l9-7 9 7v9a1 1 0 01-1 1h-5v-7H9v7H4a1 1 0 01-1-1z" /></>),
  people: makeIcon(<><circle cx="12" cy="8" r="4" /><path d="M3 21c0-4.5 4-8 9-8s9 3.5 9 8" /></>),
  clock: makeIcon(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>),
  cal: makeIcon(<><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></>),
  sheet: makeIcon(<><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 9h8M8 13h8M8 17h5" /></>),
  // Lucide "Settings" gear — the old glyph overshot the 24×24 viewBox and
  // rendered cramped; this one stays inside the box and matches the set.
  cog: makeIcon(<><path d="M12.22 2h-.44a2 2 0 00-2 2v.18a2 2 0 01-1 1.73l-.43.25a2 2 0 01-2 0l-.15-.08a2 2 0 00-2.73.73l-.22.38a2 2 0 00.73 2.73l.15.1a2 2 0 011 1.72v.51a2 2 0 01-1 1.74l-.15.09a2 2 0 00-.73 2.73l.22.38a2 2 0 002.73.73l.15-.08a2 2 0 012 0l.43.25a2 2 0 011 1.73V20a2 2 0 002 2h.44a2 2 0 002-2v-.18a2 2 0 011-1.73l.43-.25a2 2 0 012 0l.15.08a2 2 0 002.73-.73l.22-.39a2 2 0 00-.73-2.73l-.15-.08a2 2 0 01-1-1.74v-.5a2 2 0 011-1.74l.15-.09a2 2 0 00.73-2.73l-.22-.38a2 2 0 00-2.73-.73l-.15.08a2 2 0 01-2 0l-.43-.25a2 2 0 01-1-1.73V4a2 2 0 00-2-2z" /><circle cx="12" cy="12" r="3" /></>),
  bell: makeIcon(<><path d="M6 8a6 6 0 0112 0v4l1.5 3h-15L6 12V8z" /><path d="M9 18a3 3 0 006 0" /></>),
  search: makeIcon(<><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" /></>),
  inbox: makeIcon(<><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5 4h14l3 8v6a2 2 0 01-2 2H4a2 2 0 01-2-2v-6z" /></>),
  chart: makeIcon(<><path d="M3 21h18M5 19V9M10 19V5M15 19v-7M20 19v-4" /></>),
  funnel: makeIcon(<><path d="M3 5h18l-7 8v6l-4 2v-8z" /></>),
  shield: makeIcon(<><path d="M12 2L4 5v7c0 5.5 3.5 9 8 10 4.5-1 8-4.5 8-10V5z" /></>),
  out: makeIcon(<><path d="M9 12h12M18 9l3 3-3 3" /><path d="M16 4H5a2 2 0 00-2 2v12a2 2 0 002 2h11" /></>),
  // Action
  plus: makeIcon(<><path d="M12 5v14M5 12h14" /></>),
  check: makeIcon(<><path d="M4 12l5 5L20 6" /></>),
  x: makeIcon(<><path d="M6 6l12 12M18 6L6 18" /></>),
  arrow: makeIcon(<><path d="M5 12h14M13 6l6 6-6 6" /></>),
  arrowL: makeIcon(<><path d="M19 12H5M11 6l-6 6 6 6" /></>),
  chevR: makeIcon(<><path d="M9 6l6 6-6 6" /></>),
  chevL: makeIcon(<><path d="M15 6l-6 6 6 6" /></>),
  chevD: makeIcon(<><path d="M6 9l6 6 6-6" /></>),
  chevU: makeIcon(<><path d="M6 15l6-6 6 6" /></>),
  more: makeIcon(<><circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" /></>),
  filter: makeIcon(<><path d="M3 6h18M6 12h12M10 18h4" /></>),
  download: makeIcon(<><path d="M12 4v12M6 10l6 6 6-6M4 20h16" /></>),
  upload: makeIcon(<><path d="M12 20V8M6 14l6-6 6 6M4 4h16" /></>),
  edit: makeIcon(<><path d="M4 20h4l11-11-4-4L4 16v4z" /><path d="M14 6l4 4" /></>),
  trash: makeIcon(<><path d="M4 7h16M9 7V4h6v3M6 7l1 13a2 2 0 002 2h6a2 2 0 002-2l1-13" /></>),
  copy: makeIcon(<><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 012-2h10" /></>),
  link: makeIcon(<><path d="M10 14a4 4 0 005.66 0l3-3a4 4 0 00-5.66-5.66L11 7" /><path d="M14 10a4 4 0 00-5.66 0l-3 3a4 4 0 005.66 5.66L13 17" /></>),
  // Status
  warn: makeIcon(<><path d="M12 3l10 17H2L12 3zM12 10v4M12 18v.5" /></>),
  info: makeIcon(<><circle cx="12" cy="12" r="9" /><path d="M12 8v.5M12 11v5" /></>),
  success: makeIcon(<><circle cx="12" cy="12" r="9" /><path d="M8 12l3 3 5-6" /></>),
  // Domain
  mail: makeIcon(<><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" /></>),
  phone: makeIcon(<><path d="M22 16.92v3a2 2 0 01-2.18 2 19.8 19.8 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.8 19.8 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.13.96.36 1.9.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.91.34 1.85.57 2.81.7a2 2 0 011.72 2z" /></>),
  pin: makeIcon(<><path d="M12 22s8-7 8-13a8 8 0 00-16 0c0 6 8 13 8 13z" /><circle cx="12" cy="9" r="3" /></>),
  building: makeIcon(<><rect x="4" y="3" width="16" height="18" rx="1" /><path d="M9 8h2M13 8h2M9 12h2M13 12h2M9 16h2M13 16h2" /></>),
  user: makeIcon(<><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 4-7 8-7s8 3 8 7" /></>),
  briefcase: makeIcon(<><rect x="3" y="7" width="18" height="13" rx="2" /><path d="M9 7V5a2 2 0 012-2h2a2 2 0 012 2v2M3 13h18" /></>),
  doc: makeIcon(<><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><path d="M14 2v6h6M8 13h8M8 17h6" /></>),
  card: makeIcon(<><rect x="2" y="6" width="20" height="13" rx="2" /><path d="M2 11h20M6 16h3" /></>),
  bank: makeIcon(<><path d="M3 22h18M3 10h18M5 22V10M9 22V10M15 22V10M19 22V10M2 10l10-7 10 7" /></>),
  globe: makeIcon(<><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a13 13 0 010 18M12 3a13 13 0 000 18" /></>),
  spark: makeIcon(<><path d="M12 2l2.4 6.6L21 11l-6.6 2.4L12 20l-2.4-6.6L3 11l6.6-2.4z" /></>),
  flag: makeIcon(<><path d="M5 21V4M5 4h12l-2 4 2 4H5" /></>),
  sun: makeIcon(<><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M4.93 4.93L6.34 6.34M17.66 17.66l1.41 1.41M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" /></>),
  moon: makeIcon(<><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" /></>),
  play: makeIcon(<><path d="M6 4l14 8-14 8z" fill="currentColor" /></>),
  pause: makeIcon(<><rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor" /><rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor" /></>),
  coffee: makeIcon(<><path d="M3 8h13v6a5 5 0 01-5 5H8a5 5 0 01-5-5V8z" /><path d="M16 8h2a3 3 0 010 6h-2M6 1v3M10 1v3M14 1v3" /></>),
  fingerprint: makeIcon(<><path d="M14 18.6c-.4 1-1.1 2.2-2 2.4M5.4 17C4 14.5 4 11 4 9.5a8 8 0 0114-5.4M9 19a3 3 0 01-1.5-3.4c-1-2.5-1-4.6 0-6 .6-1 1.7-1.6 2.5-1.6" /><path d="M12 11v3a8 8 0 002 5" /></>),
  zap: makeIcon(<><path d="M13 2L3 14h7l-1 8 10-12h-7z" /></>),
  layers: makeIcon(<><path d="M12 2l10 6-10 6L2 8z" /><path d="M2 17l10 6 10-6M2 12l10 6 10-6" /></>),
  tag: makeIcon(<><path d="M20.6 13.4l-7.2 7.2a2 2 0 01-2.8 0L2 12V2h10l8.6 8.6a2 2 0 010 2.8z" /><circle cx="7" cy="7" r="1.2" fill="currentColor" /></>),
  command: makeIcon(<><path d="M9 6V3a3 3 0 010 6H6a3 3 0 010-6h3zm0 0v12m0-12h6m0 0V3a3 3 0 116 0v3m-6 0H9m6 0v6m0 0v3a3 3 0 11-6 0v-3m6 0H9m6 0H9" /></>),
  refresh: makeIcon(<><path d="M3 12a9 9 0 0115-6.7L21 8M21 3v5h-5M21 12a9 9 0 01-15 6.7L3 16M3 21v-5h5" /></>),
  eye: makeIcon(<><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /></>),
  eyeOff: makeIcon(<><path d="M17.94 17.94A10 10 0 0112 19c-6 0-10-7-10-7a18.5 18.5 0 014.7-5.4M9.9 4.24A10 10 0 0112 4c6 0 10 7 10 7a18.4 18.4 0 01-2.16 3.19M14.12 14.12A3 3 0 119.88 9.88M2 2l20 20" /></>),
  swap: makeIcon(<><path d="M7 4v16M3 8l4-4 4 4M17 20V4M21 16l-4 4-4-4" /></>),
  msg: makeIcon(<><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" /></>),
  lock: makeIcon(<><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 018 0v4" /></>),
  key: makeIcon(<><circle cx="8" cy="15" r="4" /><path d="M11 12l9-9-2-2-2 2-2-2-2 2 2 2" /></>),
  trend: makeIcon(<><path d="M3 17l6-6 4 4 8-8M14 7h7v7" /></>),
  wifi: makeIcon(<><path d="M2 8a18 18 0 0120 0M5 12a13 13 0 0114 0M9 16a7 7 0 016 0" /><circle cx="12" cy="20" r=".8" fill="currentColor" /></>),
  clipboard: makeIcon(<><rect x="6" y="4" width="12" height="18" rx="2" /><path d="M9 4V2h6v2M9 12h6M9 16h6" /></>),
  laptop: makeIcon(<><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M2 20h20" /></>),
  award: makeIcon(<><circle cx="12" cy="9" r="6" /><path d="M9 14l-2 8 5-3 5 3-2-8" /></>),
  paperclip: makeIcon(<><path d="M21 11l-9 9a5 5 0 01-7-7l9-9a3 3 0 014 4l-9 9a1 1 0 01-2-2l8-8" /></>),
  wallet: makeIcon(<><path d="M21 12V8a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2h14a2 2 0 002-2v-2" /><circle cx="17" cy="14" r="1.5" fill="currentColor" /></>),
  grid: makeIcon(<><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>),
  send: makeIcon(<><path d="M22 2L11 13" /><path d="M22 2l-7 20-4-9-9-4z" /></>),
  // v4 media (design bundle icon additions — camera + image)
  camera: makeIcon(<><path d="M3 8h3.2L8 5.4h8L17.8 8H21a1 1 0 011 1v10a1 1 0 01-1 1H3a1 1 0 01-1-1V9a1 1 0 011-1z" /><circle cx="12" cy="13.4" r="3.4" /></>),
  image: makeIcon(<><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="8.5" cy="9.5" r="1.6" /><path d="M21 15.5l-5-5L6 21" /></>),
  // v4 feedback (design bundle icon additions — chat + star/smiley)
  chat: makeIcon(<><path d="M21 12a8 8 0 01-8 8H4l2.2-2.6A8 8 0 1121 12z" /></>),
  star: makeIcon(<><path d="M12 3l2.7 5.6 6.1.8-4.5 4.3 1.1 6-5.4-2.9-5.4 2.9 1.1-6L3.2 9.4l6.1-.8z" /></>),
  // CRM v5 additions (crm-shared.jsx / components.jsx — verbatim paths)
  kanban: makeIcon(<><rect x="3" y="3" width="5.5" height="18" rx="1.5" /><rect x="9.7" y="3" width="5.5" height="12" rx="1.5" /><rect x="16.4" y="3" width="5.5" height="8" rx="1.5" /></>),
  keyboard: makeIcon(<><rect x="2" y="6" width="20" height="12" rx="2" /><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M18 14h.01M9 14h6" /></>),
  target: makeIcon(<><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1.4" fill="currentColor" /></>),
  receipt: makeIcon(<><path d="M5 3v18l2-1.4 2 1.4 2-1.4 2 1.4 2-1.4 2 1.4V3l-2 1.4L14 3l-2 1.4L10 3 8 4.4 6 3z" /><path d="M9 8h6M9 12h6" /></>),
  file: makeIcon(<><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><path d="M14 2v6h6" /></>),
  userPlus: makeIcon(<><circle cx="9" cy="8" r="4" /><path d="M2 21c0-4 3.5-7 7-7 1.5 0 2.9.4 4 1.2" /><path d="M18 14v6M15 17h6" /></>),
  switchH: makeIcon(<><path d="M8 3L4 7l4 4M4 7h16M16 21l4-4-4-4M20 17H4" /></>),
  // PRD v6 P9/P16 — git glyphs (prototype pm-shared.jsx)
  gitPr: makeIcon(<><circle cx="6" cy="6" r="2.6" /><circle cx="6" cy="18" r="2.6" /><circle cx="18" cy="18" r="2.6" /><path d="M6 8.6v6.8M13 6h2a3 3 0 013 3v6.4" /><path d="M15.4 3.6L13 6l2.4 2.4" /></>),
  gitBranch: makeIcon(<><circle cx="6" cy="6" r="2.6" /><circle cx="6" cy="18" r="2.6" /><circle cx="18" cy="6" r="2.6" /><path d="M6 8.6v6.8M18 8.6c0 4-4 5.4-8 5.4" /></>),
} as const

export type IconKey = keyof typeof Icon
