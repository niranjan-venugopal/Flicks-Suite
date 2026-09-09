'use client'

import { useState } from 'react'
import { Btn, Icon, Modal, Pill } from '@/components/proto'
import { Sk } from '@/components/states'
import { fmtCur } from './kit'

// ─────────────────────────────────────────────────────────
// C3 — Won / Lost dialogs (scr-deal.jsx, ported verbatim)
// Won: celebrate + one-click deal→invoice/quote (§4.4)
// Lost: a reason OR a note (win/loss honesty) — never a dead end
// ─────────────────────────────────────────────────────────

export function WonDialog({ open, onClose, deal, onCreateInvoice, onCreateQuote, onCreateProject, busy }: {
  open: boolean
  onClose: () => void
  deal: { title: string; companyName?: string | null; value: number; currency: string; base: string; baseValue: number; productCount: number; customerLinked: boolean }
  onCreateInvoice: () => void
  onCreateQuote: () => void
  /** CRM→PM bridge (catalog: "Won offers Create project"). */
  onCreateProject?: () => void
  busy?: boolean
}) {
  if (!open) return null
  const sub = `${deal.companyName ? deal.companyName + ' — ' : ''}${deal.title} · ${fmtCur(deal.value, deal.currency)}${deal.currency !== deal.base ? ` ≈ ${fmtCur(deal.baseValue, deal.base)}` : ''}`
  return (
    <Modal open={open} onClose={onClose} width={480} title="Deal won 🏆" sub={sub}
      footer={<>
        <Btn kind="ghost" onClick={onClose}>Later</Btn>
        {onCreateProject && (
          <Btn kind="secondary" icon={<Icon.target size={14} />} onClick={onCreateProject} disabled={busy}>Create project</Btn>
        )}
        <Btn kind="secondary" icon={<Icon.doc size={14} />} onClick={onCreateQuote} disabled={busy}>Create quote</Btn>
        <Btn kind="primary" icon={<Icon.receipt size={14} />} onClick={onCreateInvoice} disabled={busy}>{busy ? 'Creating…' : 'Create invoice'}</Btn>
      </>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', gap: 10, padding: '11px 13px', borderRadius: 10, background: 'rgba(39,210,128,.07)', border: '1px solid rgba(39,210,128,.3)' }}>
          <Icon.receipt size={15} style={{ color: 'var(--green)', flexShrink: 0, marginTop: 1 }} />
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-2)', lineHeight: 1.5 }}>
            One click creates a <b style={{ color: '#fff' }}>draft invoice</b> from {deal.productCount > 0 ? `the ${deal.productCount} product${deal.productCount === 1 ? '' : 's'} on this deal` : 'the deal value'} — customer, currency and lines carry over; the invoice editor opens for review.
          </span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr', gap: 8, fontSize: 12 }}>
          <span style={{ color: 'var(--text-mute)', fontWeight: 600 }}>Billing customer</span>
          <span style={{ fontWeight: 800 }}>
            {deal.companyName ?? deal.title}{' '}
            <Pill tone={deal.customerLinked ? 'green' : 'blue'} style={{ marginLeft: 6 }}>{deal.customerLinked ? 'linked' : 'will be created'}</Pill>
          </span>
          <span style={{ color: 'var(--text-mute)', fontWeight: 600 }}>Currency</span>
          <span style={{ fontWeight: 800 }}>{deal.currency}</span>
          <span style={{ color: 'var(--text-mute)', fontWeight: 600 }}>Lines</span>
          <span style={{ fontWeight: 800 }}>{deal.productCount > 0 ? `${deal.productCount} product line${deal.productCount === 1 ? '' : 's'}` : '1 line from the deal value'}</span>
        </div>
      </div>
    </Modal>
  )
}

/** Sentinel id for the always-present "Other" pill (free-text note only). */
const OTHER = '__other__'

/**
 * Round I: the dialog can never deadlock. Reasons self-heal server-side (a
 * tenant created after migration 0032 used to have zero and the button was
 * hard-disabled for ever), an "Other" pill is always offered, a reason OR a
 * non-empty note makes the form valid, and a failed load shows an error line
 * with Retry instead of an empty row.
 */
export function LostDialog({ open, onClose, reasons, onConfirm, busy, loading, error, onRetry }: {
  open: boolean
  onClose: () => void
  reasons: Array<{ id: string; label: string }>
  /** `reasonId` is null when the user picked Other (note carries the why). */
  onConfirm: (reasonId: string | null, note: string) => void
  busy?: boolean
  loading?: boolean
  error?: boolean
  onRetry?: () => void
}) {
  const [reason, setReason] = useState<string>('')
  const [note, setNote] = useState('')
  if (!open) return null
  const trimmedNote = note.trim()
  const isOther = reason === OTHER
  const valid = (reason && !isOther) || trimmedNote.length > 0
  const pills = [...reasons, { id: OTHER, label: 'Other' }]
  return (
    <Modal open={open} onClose={onClose} width={440} title="Mark as lost" sub="A reason keeps win/loss reporting honest"
      footer={<>
        <Btn kind="ghost" onClick={onClose}>Cancel</Btn>
        <Btn kind="danger" icon={<Icon.x size={14} />} disabled={!valid || busy}
          onClick={() => valid && onConfirm(isOther || !reason ? null : reason, trimmedNote)}
          style={valid ? undefined : { opacity: 0.45 }}>
          {busy ? 'Saving…' : 'Mark lost'}
        </Btn>
      </>}>
      <div className="label">Lost reason</div>
      {loading ? (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }} data-testid="lost-reasons-loading">
          {[70, 90, 80, 96, 84].map((w, i) => <Sk key={i} w={w} h={32} style={{ borderRadius: 99 }} />)}
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
          {pills.map((r) => (
            <button key={r.id} type="button" onClick={() => setReason(r.id)} data-testid={`lost-reason-${r.id === OTHER ? 'other' : r.id}`} style={{
              padding: '8px 13px', borderRadius: 99, cursor: 'pointer',
              background: reason === r.id ? 'rgba(248,120,107,.14)' : 'var(--surf-1)',
              border: `1px solid ${reason === r.id ? 'rgba(248,120,107,.45)' : 'var(--bord)'}`,
              fontSize: 12, fontWeight: 800, color: reason === r.id ? 'var(--coral)' : 'var(--text-2)',
            }}>{r.label}</button>
          ))}
        </div>
      )}
      {error && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, fontWeight: 700, color: 'var(--coral)', marginBottom: 10 }}>
          <Icon.warn size={12} /> Couldn&apos;t load the reason list.
          {onRetry && <Btn kind="ghost" size="sm" onClick={onRetry}>Retry</Btn>}
          <span style={{ color: 'var(--text-mute)' }}>You can still choose Other and add a note.</span>
        </div>
      )}
      {!valid && !loading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, fontWeight: 700, color: 'var(--text-mute)', marginBottom: 10 }}>
          <Icon.info size={12} /> {isOther ? 'Add a short note to continue' : 'Pick a reason, or choose Other and add a note'}
        </div>
      )}
      <div className="label">Note <span style={{ color: 'var(--text-faint)' }}>· {isOther ? 'required for Other' : 'optional'}</span></div>
      <textarea className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Went with a competitor on a 2-year discount…" style={{ height: 64, padding: 11, resize: 'none', width: '100%' }} />
    </Modal>
  )
}
