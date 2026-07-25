'use client'

import type { CSSProperties } from 'react'
import { Icon } from '@/components/proto'

// PM glyph language — 1:1 translation of the approved prototype's
// pm-shared.jsx (PRD v6 design kit). Fixed color mapping per state category;
// priority glyphs use keyboard order 0–4.

export const PM_CAT_COLOR: Record<string, string> = {
  triage: '#9B7BFA',
  backlog: '#5C6477',
  unstarted: '#A8B0C2',
  started: '#FED800',
  completed: '#27D280',
  canceled: '#5C6477',
}

export function StateGlyph({ cat, size = 14, color }: { cat: string; size?: number; color?: string }) {
  const c = color || PM_CAT_COLOR[cat] || '#A8B0C2'
  const r = size / 2 - 1.5
  const cx = size / 2
  const cy = size / 2
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flexShrink: 0, display: 'block' }}>
      {cat === 'triage' && (
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={c} strokeWidth="1.6" strokeDasharray="1.2 2.2" strokeLinecap="round" />
      )}
      {cat === 'backlog' && (
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={c} strokeWidth="1.6" strokeDasharray="3 2.4" strokeLinecap="round" />
      )}
      {cat === 'unstarted' && <circle cx={cx} cy={cy} r={r} fill="none" stroke={c} strokeWidth="1.6" />}
      {cat === 'started' && (
        <>
          <circle cx={cx} cy={cy} r={r} fill="none" stroke={c} strokeWidth="1.6" />
          <path d={`M ${cx} ${cy - r + 1.6} A ${r - 1.6} ${r - 1.6} 0 0 1 ${cx} ${cy + r - 1.6} Z`} fill={c} />
        </>
      )}
      {cat === 'completed' && (
        <>
          <circle cx={cx} cy={cy} r={r + 0.4} fill={c} />
          <path
            d={`M ${cx - r * 0.48} ${cy} l ${r * 0.34} ${r * 0.36} l ${r * 0.62} -${r * 0.72}`}
            stroke="#01010D" strokeWidth="1.7" fill="none" strokeLinecap="round" strokeLinejoin="round"
          />
        </>
      )}
      {cat === 'canceled' && (
        <>
          <circle cx={cx} cy={cy} r={r} fill="none" stroke={c} strokeWidth="1.6" />
          <path d={`M ${cx - r * 0.6} ${cy + r * 0.6} L ${cx + r * 0.6} ${cy - r * 0.6}`} stroke={c} strokeWidth="1.6" strokeLinecap="round" />
        </>
      )}
    </svg>
  )
}

export function PriorityGlyph({ p = 0, size = 14 }: { p?: number; size?: number }) {
  const s = size
  if (p === 1)
    return (
      <svg width={s} height={s} viewBox="0 0 14 14" style={{ flexShrink: 0, display: 'block' }}>
        <rect x="1" y="1" width="12" height="12" rx="3" fill="#FF9933" />
        <path d="M7 3.6v4.2M7 10.4v.01" stroke="#01010D" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    )
  if (p === 0)
    return (
      <svg width={s} height={s} viewBox="0 0 14 14" style={{ flexShrink: 0, display: 'block' }}>
        <path d="M3.5 7h7" stroke="#3A4055" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    )
  const bars = ({ 2: 3, 3: 2, 4: 1 } as Record<number, number>)[p] ?? 1
  return (
    <svg width={s} height={s} viewBox="0 0 14 14" style={{ flexShrink: 0, display: 'block' }}>
      {[0, 1, 2].map((i) => (
        <rect
          key={i}
          x={1.5 + i * 4}
          y={[8.5, 5.5, 2.5][i]}
          width="3"
          height={[4, 7, 10][i]}
          rx="1"
          fill={i < bars ? '#A8B0C2' : 'rgba(168,176,194,.22)'}
        />
      ))}
    </svg>
  )
}

export const PM_PRIORITY_LABEL = ['No priority', 'Urgent', 'High', 'Medium', 'Low']

export function Kbd({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <kbd
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        minWidth: 17, height: 17, padding: '0 4.5px', borderRadius: 4.5,
        background: 'var(--surf-2)', border: '1px solid var(--bord-2)',
        fontSize: 9.5, fontWeight: 800, fontFamily: 'var(--font-mono)',
        color: 'var(--text-2)', lineHeight: 1, ...style,
      }}
    >
      {children}
    </kbd>
  )
}

export function PendingDot({ title = 'Syncing — not yet confirmed' }: { title?: string }) {
  return (
    <span
      title={title}
      style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--blue)', display: 'inline-block', flexShrink: 0 }}
    />
  )
}

// ─── Projects layer (§6, P11–P14) ────────────────────────────────────────────

export const PM_HEALTH: Record<string, { label: string; color: string; bg: string; border: string }> = {
  on_track: { label: 'On track', color: 'var(--green)', bg: 'rgba(39,210,128,.1)', border: 'rgba(39,210,128,.35)' },
  at_risk: { label: 'At risk', color: 'var(--yellow)', bg: 'rgba(254,216,0,.09)', border: 'rgba(254,216,0,.35)' },
  off_track: { label: 'Off track', color: 'var(--coral)', bg: 'rgba(248,120,107,.1)', border: 'rgba(248,120,107,.35)' },
}

export function HealthChip({ h, small }: { h: string; small?: boolean }) {
  const s = PM_HEALTH[h] ?? PM_HEALTH.on_track!
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, padding: small ? '0 7px' : '2px 9px',
      height: small ? 16 : undefined, borderRadius: 99, background: s.bg, border: `1px solid ${s.border}`,
      fontSize: small ? 9 : 10, fontWeight: 800, color: s.color, whiteSpace: 'nowrap', flexShrink: 0,
    }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: s.color }} />
      {s.label}
    </span>
  )
}

/** Stacked done/started progress bar (P11): green done, translucent-yellow started. */
export function PmProgressBar({ scope, started, done, h = 6 }: { scope: number; started: number; done: number; h?: number }) {
  const total = Math.max(scope, 1)
  return (
    <div style={{ width: '100%', height: h, borderRadius: 99, background: 'var(--surf-2)', overflow: 'hidden', display: 'flex' }}>
      <div style={{ width: `${(done / total) * 100}%`, background: 'var(--green)' }} />
      <div style={{ width: `${(started / total) * 100}%`, background: 'rgba(254,216,0,.55)' }} />
    </div>
  )
}

export const PM_PROJECT_STATUS_LABEL: Record<string, string> = {
  backlog: 'Backlog', planned: 'Planned', in_progress: 'In progress',
  paused: 'Paused', completed: 'Completed', canceled: 'Canceled',
}

/** Milestone diamond (P11/P12) — no proto icon for this shape. */
export function DiamondGlyph({ size = 11, color = 'var(--text-faint)' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" style={{ flexShrink: 0 }}>
      <rect x="2.6" y="2.6" width="6.8" height="6.8" rx="1.2" transform="rotate(45 6 6)" fill={color} />
    </svg>
  )
}

// ─── Git chip (P7/P16, pm-shared.jsx PrChip) ─────────────────────────────────
// merged → purple · closed → coral · open → green.
export interface GitLink {
  t: 'branch' | 'pr' | 'commit'
  label: string
  state: 'open' | 'merged' | 'closed'
  url?: string | null
}

export function PrChip({ g }: { g: GitLink }) {
  const c = g.state === 'merged' ? '#9B7BFA' : g.state === 'closed' ? '#F8786B' : '#27D280'
  const Ic = g.t === 'branch' ? Icon.gitBranch : g.t === 'pr' ? Icon.gitPr : Icon.gitCommit
  const inner = (
    <>
      <Ic size={11} style={{ color: c, flexShrink: 0 }} />
      <span>{g.label}</span>
      <span style={{ color: c, fontWeight: 800 }}>{g.state}</span>
    </>
  )
  const style: CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 8px', borderRadius: 6,
    background: 'var(--surf-1)', border: '1px solid var(--bord)',
    fontSize: 10, fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--text-2)',
    textDecoration: 'none',
  }
  return g.url ? (
    <a href={g.url} target="_blank" rel="noreferrer" style={style}>{inner}</a>
  ) : (
    <span style={style}>{inner}</span>
  )
}
