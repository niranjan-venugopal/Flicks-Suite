'use client'

import { useState } from 'react'
import { Btn, Icon, Modal } from '@/components/proto'
import { DateField } from '@/components/ui/date-picker'
import type { DealOutcomeBody } from '@/lib/api/queries/use-crm'

// ─────────────────────────────────────────────────────────
// Round R R3 — a closed deal's verdict is editable (manager and above):
// won ↔ lost, the lost reason / note, the won / lost date, and reopen into a
// CHOSEN open stage. Shared by the deal page and the Closed view.
// Mount these conditionally (`{mode && <OutcomeDialog …/>}`) so every open
// starts from the deal's current values.
// ─────────────────────────────────────────────────────────

export type OutcomeMode = 'to-won' | 'to-lost' | 'edit-reason' | 'edit-date'

export interface OutcomeDealRef {
  id: string
  title: string
  status: string
  won_at: string | null
  lost_at: string | null
  lost_reason_id: string | null
  lost_reason_note: string | null
}

const OTHER = '__other__'
const pad = (n: number) => String(n).padStart(2, '0')
/** Local calendar day of an instant (never the UTC day — IST evenings are tomorrow in UTC). */
export function localDay(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
/**
 * A picked day → an instant: keep the existing moment when the day did not
 * change; today → right now (local noon would be "in the future" before 12:00
 * and the server refuses future dates); any earlier day → local noon.
 */
function dayToInstant(day: string, existing: string | null): string {
  if (existing && localDay(existing) === day) return existing
  const now = new Date()
  if (day === localDay(now.toISOString())) return now.toISOString()
  return new Date(`${day}T12:00:00`).toISOString()
}

export function OutcomeDialog({ open, mode, deal, reasons, busy, onClose, onConfirm }: {
  open: boolean
  mode: OutcomeMode
  deal: OutcomeDealRef
  reasons: Array<{ id: string; label: string }>
  busy?: boolean
  onClose: () => void
  onConfirm: (body: DealOutcomeBody) => void
}) {
  const currentClose = deal.status === 'won' ? deal.won_at : deal.lost_at
  const [reason, setReason] = useState<string>(deal.lost_reason_id ?? (deal.lost_reason_note ? OTHER : ''))
  const [note, setNote] = useState(deal.lost_reason_note ?? '')
  const [day, setDay] = useState(localDay(currentClose))
  if (!open) return null

  const targetOutcome: 'won' | 'lost' = mode === 'to-won' ? 'won' : mode === 'to-lost' ? 'lost' : deal.status === 'won' ? 'won' : 'lost'
  const askReason = targetOutcome === 'lost' && mode !== 'edit-date'
  const askDate = mode !== 'edit-reason'
  const today = localDay(new Date().toISOString())
  const isOther = reason === OTHER
  const trimmedNote = note.trim()
  const reasonValid = !askReason || (!!reason && !isOther) || trimmedNote.length > 0
  const dateValid = mode === 'edit-date' ? !!day && day <= today : !day || day <= today
  const valid = reasonValid && dateValid
  const pills = [...reasons, { id: OTHER, label: 'Other' }]

  const title =
    mode === 'to-won' ? `Mark “${deal.title}” as won`
    : mode === 'to-lost' ? `Mark “${deal.title}” as lost`
    : mode === 'edit-reason' ? 'Edit the lost reason'
    : `Change the ${deal.status} date`
  const sub =
    mode === 'to-won' || mode === 'to-lost' ? 'The deal moves to the matching stage; reports, history and automations follow.'
    : mode === 'edit-reason' ? 'A reason keeps win / loss reporting honest.'
    : 'Reports and the Closed view use this date.'
  const confirmLabel = mode === 'to-won' ? 'Mark won' : mode === 'to-lost' ? 'Mark lost' : mode === 'edit-reason' ? 'Save reason' : 'Save date'

  const confirm = () => {
    if (!valid) return
    const body: DealOutcomeBody = { outcome: targetOutcome }
    if (askReason) {
      body.lost_reason_id = isOther || !reason ? null : reason
      body.lost_reason_note = trimmedNote || null
    }
    if (askDate && day && (mode === 'edit-date' || day !== localDay(currentClose))) {
      body.closed_at = dayToInstant(day, currentClose)
    }
    onConfirm(body)
  }

  return (
    <Modal open={open} onClose={onClose} width={460} title={title} sub={sub}
      footer={<>
        <Btn kind="ghost" onClick={onClose} disabled={busy}>Cancel</Btn>
        <Btn kind={targetOutcome === 'lost' && mode !== 'edit-date' ? 'danger' : 'primary'}
          icon={mode === 'to-won' ? <Icon.check size={14} /> : mode === 'to-lost' ? <Icon.x size={14} /> : <Icon.check size={14} />}
          disabled={!valid || busy} onClick={confirm} data-testid="outcome-confirm" style={valid ? undefined : { opacity: 0.45 }}>
          {busy ? 'Saving…' : confirmLabel}
        </Btn>
      </>}>
      <div data-testid="outcome-dialog" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {askReason && (
          <div>
            <div className="label">Lost reason</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
              {pills.map((r) => (
                <button key={r.id} type="button" onClick={() => setReason(r.id)} data-testid={`outcome-reason-${r.id === OTHER ? 'other' : r.id}`} style={{
                  padding: '8px 13px', borderRadius: 99, cursor: 'pointer',
                  background: reason === r.id ? 'rgba(248,120,107,.14)' : 'var(--surf-1)',
                  border: `1px solid ${reason === r.id ? 'rgba(248,120,107,.45)' : 'var(--bord)'}`,
                  fontSize: 12, fontWeight: 800, color: reason === r.id ? 'var(--coral)' : 'var(--text-2)',
                }}>{r.label}</button>
              ))}
            </div>
            {!reasonValid && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, fontWeight: 700, color: 'var(--text-mute)', marginBottom: 8 }}>
                <Icon.info size={12} /> {isOther ? 'Add a short note to continue' : 'Pick a reason, or choose Other and add a note'}
              </div>
            )}
            <div className="label">Note <span style={{ color: 'var(--text-faint)' }}>· {isOther ? 'required for Other' : 'optional'}</span></div>
            <textarea className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Went with a competitor on a 2-year discount…" data-testid="outcome-note" style={{ height: 64, padding: 11, resize: 'none', width: '100%' }} />
          </div>
        )}
        {askDate && (
          <div>
            <div className="label">
              {targetOutcome === 'won' ? 'Won on' : 'Lost on'}
              {mode !== 'edit-date' && <span style={{ color: 'var(--text-faint)' }}> · optional — keeps the current date if left alone</span>}
            </div>
            <div data-testid="outcome-date">
              <DateField value={day} onChange={setDay} max={today} style={{ height: 38, fontSize: 12.5 }} />
            </div>
            {day && day > today && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, fontWeight: 700, color: 'var(--coral)', marginTop: 6 }}>
                <Icon.warn size={12} /> The date cannot be in the future.
              </div>
            )}
          </div>
        )}
        {mode === 'to-won' && (
          <div className="t-mute" style={{ fontSize: 12, lineHeight: 1.5 }}>
            The lost reason is cleared. Anything that celebrates a win (sequences, automations) runs as if the deal had just been won.
          </div>
        )}
      </div>
    </Modal>
  )
}

export function ReopenDialog({ open, deal, stages, busy, onClose, onConfirm }: {
  open: boolean
  deal: { title: string }
  /** The pipeline's OPEN stages, in order. */
  stages: Array<{ id: string; name: string; win_probability: number }>
  busy?: boolean
  onClose: () => void
  onConfirm: (stageId: string) => void
}) {
  const [picked, setPicked] = useState('')
  if (!open) return null
  const stageId = picked || stages[0]?.id || ''
  return (
    <Modal open={open} onClose={onClose} width={420} title={`Reopen “${deal.title}”`} sub="Back onto the board, in the stage you choose"
      footer={<>
        <Btn kind="ghost" onClick={onClose} disabled={busy}>Cancel</Btn>
        <Btn kind="primary" icon={<Icon.refresh size={14} />} disabled={!stageId || busy} onClick={() => stageId && onConfirm(stageId)} data-testid="reopen-confirm">
          {busy ? 'Reopening…' : 'Reopen'}
        </Btn>
      </>}>
      <div className="label">Stage</div>
      {stages.length === 0 ? (
        <div className="t-mute" style={{ fontSize: 12.5 }}>This pipeline has no open stage to reopen into.</div>
      ) : (
        <select className="input" value={stageId} onChange={(e) => setPicked(e.target.value)} data-testid="reopen-stage" style={{ height: 38, width: '100%' }}>
          {stages.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.win_probability}%</option>)}
        </select>
      )}
      <div className="t-mute" style={{ fontSize: 11.5, marginTop: 10, lineHeight: 1.5 }}>The won / lost date and the lost reason are cleared; the stage history keeps the whole story.</div>
    </Modal>
  )
}
