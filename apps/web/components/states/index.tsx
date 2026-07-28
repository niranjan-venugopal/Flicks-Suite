'use client'

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { Btn, Icon } from '@/components/proto'
import { Kbd } from '@/components/pm/glyphs'
import { Modal } from '@/components/proto'

// ─────────────────────────────────────────────────────────
// States & Interactions kit — the catalog's shared vocabulary, implemented
// once and used by every module. Motion contract: hover 0ms · fades 120ms ·
// slides/exits 160–180ms · pops 140ms · ease-out, zero bounce. Keyframes and
// the reduced-motion guard live in app/globals.css.
// ─────────────────────────────────────────────────────────

/**
 * Empty state — exactly one line, one primary CTA, one keyboard hint.
 * Never a dead end: a zero-result search offers create instead of nothing.
 */
export function StateEmpty({
  line,
  cta,
  onCta,
  kbd,
  icon,
  secondary,
  onSecondary,
  dashed = true,
}: {
  line: string
  cta?: string
  onCta?: () => void
  kbd?: string
  icon?: ReactNode
  secondary?: string
  onSecondary?: () => void
  dashed?: boolean
}) {
  return (
    <div
      className="pm-fade"
      style={{
        border: dashed ? '1px dashed var(--bord)' : '1px solid var(--bord)',
        borderRadius: 10,
        padding: '22px 16px',
        textAlign: 'center',
      }}
    >
      {icon && <div style={{ marginBottom: 8, color: 'var(--text-faint)' }}>{icon}</div>}
      <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-2)', marginBottom: cta ? 10 : 0 }}>
        {line}
      </div>
      {cta && (
        <div style={{ display: 'inline-flex', gap: 7, alignItems: 'center' }}>
          <Btn kind="primary" size="sm" onClick={onCta}>
            {cta}
            {kbd && (
              <Kbd style={{ marginLeft: 6, background: 'rgba(255,255,255,.18)', border: 'none', color: '#fff' }}>
                {kbd}
              </Kbd>
            )}
          </Btn>
          {secondary && (
            <Btn kind="ghost" size="sm" onClick={onSecondary}>
              {secondary}
            </Btn>
          )}
        </div>
      )}
    </div>
  )
}

/** Shimmering skeleton block — cold FIRST load only; warm renders are instant. */
export function Sk({ w = '100%', h = 11, r = 6, style }: { w?: number | string; h?: number; r?: number; style?: CSSProperties }) {
  return <span className="skel" style={{ display: 'block', width: w, height: h, borderRadius: r, ...style }} />
}

/**
 * Cold-load skeleton rows that mirror the real row anatomy (glyph · key ·
 * title · avatar) so the crossfade to content doesn't jump.
 */
export function SkeletonRows({ rows = 5, height = 34 }: { rows?: number; height?: number }) {
  return (
    <div>
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          style={{
            display: 'flex', alignItems: 'center', gap: 9,
            height, padding: '0 12px',
            borderBottom: i < rows - 1 ? '1px solid var(--bord)' : 'none',
          }}
        >
          <Sk w={13} h={13} r={7} />
          <Sk w={48} h={9} />
          <Sk w="42%" h={10} />
          <span style={{ flex: 1 }} />
          <Sk w={18} h={18} r={9} />
        </div>
      ))}
    </div>
  )
}

/** Skeleton grid for card/KPI surfaces. */
export function SkeletonCards({ count = 4, height = 96 }: { count?: number; height?: number }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.min(count, 4)}, 1fr)`, gap: 14 }}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="card" style={{ height }}>
          <Sk w={64} h={9} style={{ marginBottom: 12 }} />
          <Sk w={92} h={20} style={{ marginBottom: 10 }} />
          <Sk w="60%" h={8} />
        </div>
      ))}
    </div>
  )
}

/**
 * Status chip — the one shape used for every lifecycle (issue, invoice,
 * leave, deal, subscription). `pop` fires the 140ms scale on transition, so
 * a status change morphs in place instead of swapping surfaces.
 */
export function StateChip({
  color,
  children,
  icon,
  dashed,
  pop,
  style,
}: {
  color: string
  children: ReactNode
  icon?: ReactNode
  dashed?: boolean
  pop?: boolean
  style?: CSSProperties
}) {
  return (
    <span
      className={pop ? 'pm-pop' : undefined}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        padding: '2px 9px', borderRadius: 99,
        background: `${color}14`,
        border: `1px ${dashed ? 'dashed' : 'solid'} ${color}45`,
        color, fontSize: 10.5, fontWeight: 800, whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {icon}
      {!icon && <span style={{ width: 5, height: 5, borderRadius: '50%', background: color, display: 'inline-block' }} />}
      {children}
    </span>
  )
}

/**
 * Type-to-arm confirm — reserved for DESTRUCTIVE, CROSS-USER actions only.
 * Everything reversible gets an undo toast instead (see toastUndo).
 */
export function ConfirmArm({
  open,
  onOpenChange,
  title,
  sub,
  phrase,
  confirmLabel = 'Delete',
  onConfirm,
  pending,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  title: string
  sub: string
  /** The exact string the user must type (team key, invoice number…). */
  phrase: string
  confirmLabel?: string
  onConfirm: () => void
  pending?: boolean
}) {
  const [typed, setTyped] = useState('')
  useEffect(() => { if (open) setTyped('') }, [open])
  const armed = typed.trim() === phrase

  return (
    <Modal
      open={open}
      onClose={() => onOpenChange(false)}
      width={410}
      title={title}
      sub={sub}
      footer={
        <>
          <Btn kind="ghost" onClick={() => onOpenChange(false)}>Cancel</Btn>
          <Btn
            kind="danger"
            onClick={onConfirm}
            disabled={!armed || pending}
            style={!armed ? { opacity: 0.4, pointerEvents: 'none' } : undefined}
          >
            {confirmLabel}
          </Btn>
        </>
      }
    >
      <input
        autoFocus
        className="input"
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        placeholder={phrase}
        style={{ height: 36, width: 160, fontFamily: 'var(--font-mono)' }}
      />
    </Modal>
  )
}

/**
 * Inline validation message — fires on BLUR, never while typing (catalog).
 * Pair with a coral border on the field itself.
 */
export function FieldError({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <div className="pm-fade" style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 5 }}>
      <Icon.warn size={10} style={{ color: 'var(--coral)' }} />
      <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--coral)' }}>{message}</span>
    </div>
  )
}

/** Border colour for a field in the error state. */
export const errorBorder = (hasError: boolean): CSSProperties =>
  hasError ? { borderColor: 'rgba(248,120,107,.55)' } : {}

/**
 * Offline queue pill — shows the count of writes waiting to replay, in order.
 * Yellow per the sync ladder (synced green · pending blue · queued yellow).
 */
export function OfflinePill({ count }: { count: number }) {
  if (count <= 0) return null
  return (
    <span
      className="pm-fade"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '3px 9px', borderRadius: 99,
        background: 'rgba(254,216,0,.12)', border: '1px solid rgba(254,216,0,.3)',
        color: 'var(--yellow)', fontSize: 10, fontWeight: 800,
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--yellow)' }} />
      {count} queued offline
    </span>
  )
}
