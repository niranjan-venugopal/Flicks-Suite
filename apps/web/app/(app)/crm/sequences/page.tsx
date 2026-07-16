'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Btn, Icon, Modal, Pill, SectionHead } from '@/components/proto'
import { EmptyState } from '@/components/crm/kit'
import { useToast } from '@/components/ui/use-toast'
import { FEATURES } from '@/lib/feature-flags'
import { ComingSoon } from '@/components/crm/ComingSoon'
import {
  useSequences,
  useCreateSequence,
  useSequenceEnrollments,
  useExitEnrollment,
  type Sequence,
} from '@/lib/api/queries/use-crm'

// ─────────────────────────────────────────────────────────
// C10 — Sequences: timed follow-up email. List + steps
// editor + enrollments drawer. Enrollment happens from a
// deal (header action) or a contact; exits are automatic on
// reply / DNC / won / lost, or manual here.
// ─────────────────────────────────────────────────────────

export default function SequencesPage() {
  if (!FEATURES.crm_email) {
    return (
      <ComingSoon
        title="Sequences"
        line="Timed follow-up email is being reimagined — the engine is built and tested, and it returns here in a new shape soon."
        icon={<Icon.send size={24} />}
        bullets={['Multi-step follow-ups with send windows', 'Automatic exits on reply, unsubscribe, win or loss', 'Daily per-sender safety throttles']}
      />
    )
  }
  return <SequencesLive />
}

function SequencesLive() {
  const { data, isLoading } = useSequences()
  const [createOpen, setCreateOpen] = useState(false)
  const [drawerFor, setDrawerFor] = useState<Sequence | null>(null)
  const rows = data?.data ?? []

  return (
    <div style={{ padding: '28px 32px 64px', maxWidth: 980, margin: '0 auto' }}>
      <SectionHead
        title="Sequences"
        sub="Timed follow-up email — steps send inside the window, and replies, unsubscribes, wins and losses exit automatically."
        right={<Btn kind="primary" size="sm" icon={<Icon.plus size={14} />} onClick={() => setCreateOpen(true)}>New sequence</Btn>}
      />

      {isLoading ? (
        <div style={{ padding: 60, display: 'flex', justifyContent: 'center' }}><Icon.refresh size={20} className="animate-spin" style={{ color: 'var(--text-mute)' }} /></div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Icon.send size={22} />}
          line="No sequences yet. Build a 2–3 step follow-up and enroll contacts straight from their deals — the engine handles timing, windows and exits."
          cta="New sequence"
          onCta={() => setCreateOpen(true)}
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {rows.map((s) => (
            <div key={s.id} className="card" style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '16px 20px' }}>
              <div style={{ width: 36, height: 36, borderRadius: 10, background: 'rgba(62,123,250,.14)', color: 'var(--blue)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Icon.send size={16} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 800 }}>{s.name}</div>
                <div className="t-mute" style={{ fontSize: 11.5 }}>
                  {s.steps.length} step{s.steps.length === 1 ? '' : 's'} · sends {s.send_window_start}–{s.send_window_end} {s.timezone.split('/')[1] ?? s.timezone}
                </div>
              </div>
              <Pill tone={s.active_enrollments > 0 ? 'blue' : ''}>{s.active_enrollments} active</Pill>
              <Btn kind="secondary" size="sm" onClick={() => setDrawerFor(s)}>Enrollments</Btn>
            </div>
          ))}
        </div>
      )}

      {createOpen && <CreateSequenceModal onClose={() => setCreateOpen(false)} />}
      {drawerFor && <EnrollmentsModal sequence={drawerFor} onClose={() => setDrawerFor(null)} />}
    </div>
  )
}

function CreateSequenceModal({ onClose }: { onClose: () => void }) {
  const { toast } = useToast()
  const create = useCreateSequence()
  const [name, setName] = useState('')
  const [windowStart, setWindowStart] = useState('09:00')
  const [windowEnd, setWindowEnd] = useState('18:00')
  const [steps, setSteps] = useState([{ subject: '', body_html: '<p>Hi {{first_name}},</p>', wait_days: 0 }])

  const submit = async () => {
    try {
      await create.mutateAsync({ name, send_window_start: windowStart, send_window_end: windowEnd, steps })
      toast({ title: 'Sequence created' })
      onClose()
    } catch (err) {
      toast({ title: 'Could not create sequence', description: err instanceof Error ? err.message : undefined, variant: 'destructive' })
    }
  }
  const valid = name.trim() && steps.every((s) => s.subject.trim() && s.body_html.trim())

  return (
    <Modal open onClose={onClose} width={680} title="New sequence" sub="Steps send in order; each wait is measured from the previous send"
      footer={<>
        <Btn kind="ghost" onClick={onClose}>Cancel</Btn>
        <Btn kind="primary" icon={<Icon.check size={14} />} onClick={() => void submit()} disabled={!valid || create.isPending}>
          {create.isPending ? 'Creating…' : 'Create sequence'}
        </Btn>
      </>}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px 120px', gap: 12, marginBottom: 14 }}>
        <div><div className="label">Name</div><input autoFocus className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Renewal nudge" style={{ width: '100%' }} /></div>
        <div><div className="label">Window from</div><input className="input" type="time" value={windowStart} onChange={(e) => setWindowStart(e.target.value)} style={{ width: '100%' }} /></div>
        <div><div className="label">to</div><input className="input" type="time" value={windowEnd} onChange={(e) => setWindowEnd(e.target.value)} style={{ width: '100%' }} /></div>
      </div>
      {steps.map((s, i) => (
        <div key={i} style={{ border: '1px solid var(--bord)', borderRadius: 12, padding: 14, marginBottom: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <Pill tone="blue">Step {i + 1}</Pill>
            {i > 0 && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, fontWeight: 700, color: 'var(--text-2)' }}>
                wait
                <input className="input t-num" type="number" min={0} value={s.wait_days}
                  onChange={(e) => setSteps((arr) => arr.map((x, j) => (j === i ? { ...x, wait_days: Math.max(0, parseInt(e.target.value || '0', 10)) } : x)))}
                  style={{ width: 60, height: 28, fontSize: 11.5 }} /> day(s) after the previous step
              </span>
            )}
            <div style={{ flex: 1 }} />
            {steps.length > 1 && (
              <Btn kind="ghost" size="sm" icon={<Icon.trash size={12} />} onClick={() => setSteps((arr) => arr.filter((_, j) => j !== i))} />
            )}
          </div>
          <input className="input" value={s.subject} placeholder="Subject — variables work: {{first_name}}, {{deal_title}}…"
            onChange={(e) => setSteps((arr) => arr.map((x, j) => (j === i ? { ...x, subject: e.target.value } : x)))}
            style={{ width: '100%', marginBottom: 8 }} />
          <textarea className="input" value={s.body_html}
            onChange={(e) => setSteps((arr) => arr.map((x, j) => (j === i ? { ...x, body_html: e.target.value } : x)))}
            style={{ width: '100%', height: 90, padding: 10, fontFamily: 'var(--font-mono)', fontSize: 11.5, resize: 'vertical' }} />
        </div>
      ))}
      <Btn kind="secondary" size="sm" icon={<Icon.plus size={13} />} onClick={() => setSteps((arr) => [...arr, { subject: '', body_html: '<p></p>', wait_days: 3 }])}>
        Add step
      </Btn>
    </Modal>
  )
}

function EnrollmentsModal({ sequence, onClose }: { sequence: Sequence; onClose: () => void }) {
  const { data, isLoading } = useSequenceEnrollments(sequence.id)
  const exit = useExitEnrollment()
  const rows = data?.data ?? []
  return (
    <Modal open onClose={onClose} width={640} title={`${sequence.name} — enrollments`} sub="Replies, unsubscribes, wins and losses exit automatically">
      {isLoading ? (
        <div style={{ padding: 30, display: 'flex', justifyContent: 'center' }}><Icon.refresh size={18} className="animate-spin" style={{ color: 'var(--text-mute)' }} /></div>
      ) : rows.length === 0 ? (
        <div className="t-mute" style={{ fontSize: 12.5 }}>Nobody enrolled yet — use "Enroll in sequence" on a deal.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {rows.map((e, i) => (
            <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0', borderBottom: i < rows.length - 1 ? '1px solid var(--bord)' : 'none' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 800 }}>{e.person_name ?? e.person_email ?? '—'}</div>
                <div className="t-mute" style={{ fontSize: 10.5 }}>
                  step {e.current_step + 1}/{sequence.steps.length}
                  {e.next_send_at && e.status === 'active' ? ` · next ${new Date(e.next_send_at).toLocaleString()}` : ''}
                  {e.deal_id && <> · <Link href={`/crm/deals/${e.deal_id}`} style={{ color: 'var(--blue)', textDecoration: 'none' }}>deal</Link></>}
                </div>
              </div>
              <Pill tone={e.status === 'active' ? 'blue' : e.status === 'completed' ? 'green' : 'coral'}>
                {e.status === 'exited' ? `exited · ${e.exit_reason}` : e.status}
              </Pill>
              {e.status === 'active' && (
                <Btn kind="ghost" size="sm" icon={<Icon.x size={12} />} onClick={() => exit.mutate(e.id)} disabled={exit.isPending}>Exit</Btn>
              )}
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}
