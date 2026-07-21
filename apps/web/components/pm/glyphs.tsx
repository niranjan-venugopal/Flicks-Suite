'use client'

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
