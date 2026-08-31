'use client'

import { useState, type CSSProperties, type ReactNode } from 'react'
import { Btn, Icon, Avatar } from '@/components/proto'

// ─────────────────────────────────────────────────────────
// CRM v5 shared kit — faithful TS port of the approved
// prototype's crm-shared.jsx: tags · currency chips ·
// C20 filter/views/bulk · keymap · C22 empty states
// ─────────────────────────────────────────────────────────

// ── Tags (§19.1) ──
export interface TagRef {
  id: string
  label: string
  color: string | null
}
export function TagChip({ tag, small, onRemove }: { tag: TagRef; small?: boolean; onRemove?: () => void }) {
  const color = tag.color ?? '#3E7BFA'
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, padding: small ? '1px 7px' : '2px 9px',
      borderRadius: 99, background: `${color}1c`, border: `1px solid ${color}45`, color,
      fontSize: small ? 9.5 : 10.5, fontWeight: 800, letterSpacing: '.02em', whiteSpace: 'nowrap',
    }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: color }} />
      {tag.label}
      {onRemove && (
        <span onClick={(e) => { e.stopPropagation(); onRemove() }} style={{ cursor: 'pointer', display: 'inline-flex', marginLeft: 1 }}>
          <Icon.x size={9} />
        </span>
      )}
    </span>
  )
}

// ── Currency value + base chip (§12.1) ──
export function fmtCur(v: number, cur: string) {
  const sym: Record<string, string> = { INR: '₹', USD: '$', EUR: '€', GBP: '£', SGD: 'S$', AED: 'د.إ' }
  const s = sym[cur]
  return `${s ?? cur + ' '}${Math.round(v).toLocaleString('en-IN')}`
}
export function CurVal({ v, cur, base, baseValue, size = 13 }: { v: number; cur: string; base: string; baseValue?: number; size?: number }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 7, whiteSpace: 'nowrap' }}>
      <span className="t-num" style={{ fontSize: size, fontWeight: 800 }}>{fmtCur(v, cur)}</span>
      {cur !== base && baseValue !== undefined && (
        <span title={`Converted at snapshot rate · base currency ${base}`} style={{ fontSize: size - 3, fontWeight: 700, color: 'var(--text-faint)', fontVariantNumeric: 'tabular-nums' }}>
          ≈ {fmtCur(baseValue, base)}
        </span>
      )}
    </span>
  )
}

// ── Owner avatar (AvP without live presence for now — presence wires per-page) ──
export function OwnerAv({ name, src, size = 20, title }: { name: string | null; src?: string | null; size?: number; title?: string }) {
  return (
    <span title={title ?? name ?? undefined} style={{ display: 'inline-flex', lineHeight: 0 }}>
      <Avatar name={name ?? '?'} src={src ?? undefined} style={{ width: size, height: size, fontSize: Math.max(8, size * 0.36) }} />
    </span>
  )
}

// ── C22 — Empty state (one line + ONE primary CTA, never a dead end) ──
export function EmptyState({ icon, line, cta, onCta, secondary, style }: {
  icon?: ReactNode; line: string; cta?: string; onCta?: () => void; secondary?: ReactNode; style?: CSSProperties
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '54px 24px', textAlign: 'center', gap: 14, ...style }}>
      <div style={{ width: 52, height: 52, borderRadius: 14, background: 'var(--surf-2)', border: '1px solid var(--bord)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-mute)' }}>
        {icon ?? <Icon.inbox size={22} />}
      </div>
      <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text-2)', maxWidth: 380, lineHeight: 1.5 }}>{line}</div>
      {(cta || secondary) && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {cta && <Btn kind="primary" size="sm" icon={<Icon.plus size={14} />} onClick={onCta}>{cta}</Btn>}
          {secondary}
        </div>
      )}
    </div>
  )
}

// ── C20 — Saved view tabs ──
export interface ViewTab {
  id: string
  label: string
  team?: boolean
  priv?: boolean
}
export function SavedViewTabs({ views, active, onChange, onSave }: {
  views: ViewTab[]; active: string; onChange: (id: string) => void; onSave?: () => void
}) {
  return (
    <div style={{ display: 'flex', gap: 4, padding: 3, background: 'var(--surf-1)', border: '1px solid var(--bord)', borderRadius: 9 }}>
      {views.map((v) => (
        <button key={v.id} onClick={() => onChange(v.id)} style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderRadius: 6, border: 'none', cursor: 'pointer',
          background: active === v.id ? 'var(--surf-3)' : 'transparent', color: active === v.id ? '#fff' : 'var(--text-2)',
          fontSize: 12, fontWeight: 800, whiteSpace: 'nowrap',
        }}>
          {v.label}
          {v.team ? (
            <span title="Team view" style={{ fontSize: 8.5, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--blue)', border: '1px solid rgba(62,123,250,.4)', borderRadius: 99, padding: '0 5px' }}>team</span>
          ) : v.priv ? (
            <Icon.lock size={10} style={{ color: 'var(--text-faint)' }} />
          ) : null}
        </button>
      ))}
      {onSave && (
        <button onClick={onSave} title="Save current filters as a view" style={{ padding: '7px 9px', borderRadius: 6, border: 'none', cursor: 'pointer', background: 'transparent', color: 'var(--text-faint)' }}>
          <Icon.plus size={13} />
        </button>
      )}
    </div>
  )
}

// ── C20 — Filter bar (search + removable chips + add-filter) ──
export interface FilterChip {
  key: string
  label: string
  value: string
}
export function FilterBar({ search, onSearch, searchPlaceholder = 'Search…', chips, onRemoveChip, addFilter, right }: {
  search: string
  onSearch: (q: string) => void
  searchPlaceholder?: string
  chips?: FilterChip[]
  onRemoveChip?: (key: string) => void
  /** Rendered inside the expandable "Add filter" panel. */
  addFilter?: ReactNode
  right?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', width: 220 }}>
          <Icon.search size={14} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-faint)' }} />
          <input
            className="input with-icon crm-filter-search"
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder={searchPlaceholder}
            style={{ height: 36, fontSize: 12 }}
          />
        </div>
        {(chips ?? []).map((c) => (
          <span key={c.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '7px 11px', borderRadius: 8, background: 'rgba(62,123,250,.1)', border: '1px solid rgba(62,123,250,.3)', fontSize: 11.5, fontWeight: 700, color: '#fff' }}>
            <span style={{ color: 'var(--text-mute)' }}>{c.label}</span> {c.value}
            <span onClick={() => onRemoveChip?.(c.key)} style={{ display: 'inline-flex', cursor: 'pointer' }}><Icon.x size={11} style={{ color: 'var(--text-mute)' }} /></span>
          </span>
        ))}
        {addFilter && (
          <button onClick={() => setOpen((o) => !o)} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '7px 11px', borderRadius: 8, background: open ? 'var(--surf-2)' : 'transparent', border: '1px dashed var(--bord-2)', color: 'var(--text-2)', fontSize: 11.5, fontWeight: 800, cursor: 'pointer' }}>
            <Icon.filter size={13} /> Add filter
          </button>
        )}
        <div style={{ flex: 1 }} />
        {right}
      </div>
      {open && addFilter && (
        <div style={{ marginTop: 10, padding: 14, borderRadius: 12, background: 'rgba(18,18,30,.9)', border: '1px solid var(--bord-2)' }}>
          {addFilter}
          <div className="t-caption" style={{ marginTop: 8 }}>Filters combine with AND · works on standard + custom fields</div>
        </div>
      )}
    </div>
  )
}

// ── C20 — Bulk bar (sticky, appears on selection) ──
export interface BulkAction {
  icon: ReactNode
  label: string
  danger?: boolean
  onClick: () => void
}
export function BulkBar({ count, onClear, actions }: { count: number; onClear: () => void; actions: BulkAction[] }) {
  if (!count) return null
  return (
    <div style={{ position: 'sticky', bottom: 14, zIndex: 40, display: 'flex', justifyContent: 'center', pointerEvents: 'none', marginTop: 10 }}>
      <div className="card-glass" style={{ pointerEvents: 'auto', display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderRadius: 13, boxShadow: 'var(--e2)' }}>
        <span style={{ fontSize: 12, fontWeight: 800, color: '#fff' }}>{count} selected</span>
        <div style={{ width: 1, height: 18, background: 'var(--bord-2)' }} />
        {actions.map((a) => (
          <button key={a.label} onClick={a.onClick} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 10px', borderRadius: 8, background: 'transparent', border: 'none', color: a.danger ? 'var(--coral)' : 'var(--text-2)', fontSize: 11.5, fontWeight: 800, cursor: 'pointer' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surf-2)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
            {a.icon} {a.label}
          </button>
        ))}
        <div style={{ width: 1, height: 18, background: 'var(--bord-2)' }} />
        <button onClick={onClear} style={{ background: 'none', border: 'none', color: 'var(--text-mute)', fontSize: 11.5, fontWeight: 800, cursor: 'pointer' }}>Clear</button>
      </div>
    </div>
  )
}

// ── Keymap overlay (?) ──
function Kbd({ children }: { children: ReactNode }) {
  return <kbd style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 22, height: 22, padding: '0 6px', borderRadius: 6, background: 'var(--surf-2)', border: '1px solid var(--bord-2)', fontSize: 11, fontWeight: 800, fontFamily: 'var(--font-mono)', color: '#fff' }}>{children}</kbd>
}
export function KeymapOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null
  const rows: Array<[ReactNode, string]> = [
    [<Kbd key="n">N</Kbd>, 'New deal (quick add)'],
    [<Kbd key="s">/</Kbd>, 'Search everything (people, companies, deals)'],
    [<span key="a" style={{ display: 'inline-flex', gap: 4 }}><Kbd>⌘</Kbd><Kbd>K</Kbd></span>, 'Command palette'],
    [<Kbd key="e">⏎</Kbd>, 'Open focused record'],
    [<Kbd key="sh">⇧</Kbd>, '+ click — multi-select cards'],
    [<Kbd key="q">?</Kbd>, 'This keymap'],
  ]
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 1200, background: 'rgba(0,0,0,.55)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div onClick={(e) => e.stopPropagation()} className="card-glass" style={{ width: '100%', maxWidth: 430, borderRadius: 16, padding: '20px 22px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 14 }}>
          <Icon.keyboard size={16} style={{ color: 'var(--blue)' }} />
          <span style={{ flex: 1, fontSize: 14, fontWeight: 800 }}>Keyboard</span>
          <button onClick={onClose} style={{ width: 26, height: 26, borderRadius: 7, background: 'var(--surf-2)', border: '1px solid var(--bord)', color: 'var(--text-2)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><Icon.x size={13} /></button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {rows.map((r, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '8px 0', borderBottom: i < rows.length - 1 ? '1px solid var(--bord)' : 'none' }}>
              <div style={{ width: 92 }}>{r[0]}</div>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-2)' }}>{r[1]}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
