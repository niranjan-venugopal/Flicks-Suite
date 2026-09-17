'use client'

// ─────────────────────────────────────────────────────────
// Round M — the projects list's progress ring (the ClickUp rollup): a 20 px
// SVG with a `--green` arc over a `--surf-3` track. `pct` is clamped to
// 0–100 and exposed as data-pct for the live verification script.
// ─────────────────────────────────────────────────────────

export interface ProgressRingProps {
  /** 0–100. */
  pct: number
  size?: number
  stroke?: number
  color?: string
  track?: string
  title?: string
}

export function ProgressRing({ pct, size = 20, stroke = 2.5, color = 'var(--green)', track = 'var(--surf-3)', title }: ProgressRingProps) {
  const clamped = Math.max(0, Math.min(100, Math.round(Number.isFinite(pct) ? pct : 0)))
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const arc = (clamped / 100) * c
  return (
    <svg
      data-testid="progress-ring"
      data-pct={clamped}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={title ?? `${clamped}% complete`}
      style={{ flexShrink: 0, display: 'block', transform: 'rotate(-90deg)' }}
    >
      {title && <title>{title}</title>}
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={track} strokeWidth={stroke} />
      {clamped > 0 && (
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${arc} ${Math.max(c - arc, 0)}`}
          style={{ transition: 'stroke-dasharray .25s ease-out' }}
        />
      )}
    </svg>
  )
}

/** Whole-percent completion of a progress triple — 100 only when every point is done. */
export function progressPct(p: { scope: number; done: number }): number {
  if (!p.scope || p.scope <= 0) return 0
  if (p.done >= p.scope) return 100
  return Math.floor((p.done / p.scope) * 100)
}
