'use client'

import { useState } from 'react'
import { Btn, Icon, Modal } from '@/components/proto'
import { DateTimeField } from '@/components/ui/date-picker'
import { useToast } from '@/components/ui/use-toast'
import { useAuthStore } from '@/lib/stores/auth.store'
import { useCreateActivity, useCompleteActivity, useReps, type Activity } from '@/lib/api/queries/use-crm'

// ─────────────────────────────────────────────────────────
// §6 activity widgets — schedule modal ("what's next?"
// doctrine 4c) + the complete→schedule-next loop + row bits
// ─────────────────────────────────────────────────────────

export const ACT_META: Record<Activity['type'], { icon: keyof typeof Icon; color: string; label: string }> = {
  task: { icon: 'check', color: '#3E7BFA', label: 'Task' },
  call: { icon: 'phone', color: '#27D280', label: 'Call' },
  meeting: { icon: 'cal', color: '#9B7BFA', label: 'Meeting' },
  note: { icon: 'msg', color: '#FED800', label: 'Note' },
}

const CALL_OUTCOMES = ['connected', 'no_answer', 'busy', 'voicemail', 'wrong_number'] as const

/** Local-timezone default for the house date+time field (tomorrow 10:00). */
function defaultWhen(): string {
  const d = new Date(Date.now() + 24 * 3600_000)
  d.setHours(10, 0, 0, 0)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function ScheduleActivityModal({ open, onClose, dealId, title = 'Schedule an activity', sub, defaultSubject }: {
  open: boolean
  onClose: () => void
  dealId?: string | null
  /** "Done — what's next?" when invoked from the completion loop. */
  title?: string
  sub?: string
  defaultSubject?: string
}) {
  const { toast } = useToast()
  const create = useCreateActivity()
  const { currentUser } = useAuthStore()
  const reps = useReps()
  const [type, setType] = useState<'task' | 'call' | 'meeting'>('call')
  const [subject, setSubject] = useState(defaultSubject ?? '')
  const [when, setWhen] = useState(defaultWhen())
  // '' = me. Only activities assigned to you appear in YOUR My Activities
  // queue, so ownership must be an explicit, visible choice here.
  const [assignee, setAssignee] = useState('')

  if (!open) return null
  const teammates = (reps.data?.data ?? []).filter((r) => r.user_id !== currentUser?.id)
  // Ownership must never be sticky: the modal stays mounted between opens, so
  // clear the assignee on EVERY close (backdrop, ✕, "No next step"), not just
  // after a successful submit — otherwise the next "what's next?" open would
  // silently default to the previously picked teammate.
  const close = () => {
    setAssignee('')
    onClose()
  }
  // Guard against a selection that left the roster (deactivated member): fall
  // back to Me rather than submitting an id the server will 400.
  const chosen = teammates.find((r) => r.user_id === assignee)
  const submit = async () => {
    try {
      await create.mutateAsync({
        type,
        subject: subject.trim(),
        due_at: new Date(when).toISOString(),
        ...(dealId ? { deal_id: dealId } : {}),
        ...(chosen ? { assignee_user_id: chosen.user_id } : {}),
      })
      toast({
        title: 'Scheduled',
        description: chosen ? `Assigned to ${chosen.name} — it lands in their My Activities queue.` : 'The deal keeps moving.',
      })
      setSubject('')
      close()
    } catch (err) {
      toast({ title: 'Could not schedule', description: err instanceof Error ? err.message : undefined, variant: 'destructive' })
    }
  }

  return (
    <Modal open={open} onClose={close} width={430} title={title} sub={sub ?? 'Keep the deal moving: always know the next step'}
      footer={<>
        <Btn kind="ghost" onClick={close}>No next step</Btn>
        <Btn kind="primary" icon={<Icon.check size={14} />} onClick={() => void submit()} disabled={!subject.trim() || create.isPending}>
          {create.isPending ? 'Scheduling…' : 'Schedule'}
        </Btn>
      </>}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        {(['task', 'call', 'meeting'] as const).map((k) => {
          const M = ACT_META[k]
          const Ic = Icon[M.icon]
          return (
            <button key={k} onClick={() => setType(k)} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, padding: '10px 0', borderRadius: 9, background: type === k ? 'var(--surf-3)' : 'var(--surf-1)', border: `1px solid ${type === k ? 'var(--bord-2)' : 'var(--bord)'}`, color: type === k ? '#fff' : 'var(--text-2)', fontSize: 12, fontWeight: 800, cursor: 'pointer' }}>
              <Ic size={13} />{M.label}
            </button>
          )
        })}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div>
          <div className="label">When</div>
          <DateTimeField value={when} onChange={setWhen} style={{ height: 38, fontSize: 12.5 }} />
        </div>
        <div>
          <div className="label">Subject</div>
          <input autoFocus className="input" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Debrief after contract review" style={{ height: 38, width: '100%' }}
            onKeyDown={(e) => { if (e.key === 'Enter' && subject.trim()) void submit() }} />
        </div>
        {teammates.length > 0 && (
          <div style={{ gridColumn: '1/-1' }}>
            <div className="label">Assign to</div>
            <select className="input" value={assignee} onChange={(e) => setAssignee(e.target.value)} style={{ height: 38, width: '100%' }}>
              <option value="">Me{currentUser?.name ? ` — ${currentUser.name}` : ''}</option>
              {teammates.map((r) => <option key={r.user_id} value={r.user_id}>{r.name}</option>)}
            </select>
            <div className="t-caption" style={{ marginTop: 6 }}>
              {chosen ? `Shows in ${chosen.name}’s My Activities queue; they get an in-app ping.` : 'Shows in your My Activities queue.'}
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}

/**
 * Complete an activity, then immediately prompt for the next one (doctrine 4c:
 * a completed step without a successor is how deals go quiet). Calls are asked
 * for an outcome first.
 */
export function useCompleteWithNext(dealId?: string | null) {
  const complete = useCompleteActivity()
  const { toast } = useToast()
  const [outcomeFor, setOutcomeFor] = useState<Activity | null>(null)
  const [nextOpen, setNextOpen] = useState(false)

  const run = async (a: Activity, outcome?: string) => {
    try {
      await complete.mutateAsync({ id: a.id, body: outcome ? { outcome } : undefined, dealId: dealId ?? a.deal_id })
      setOutcomeFor(null)
      setNextOpen(true)
    } catch (err) {
      toast({ title: 'Could not complete', description: err instanceof Error ? err.message : undefined, variant: 'destructive' })
    }
  }

  const start = (a: Activity) => {
    if (a.type === 'call') setOutcomeFor(a)
    else void run(a)
  }

  const ui = (
    <>
      {outcomeFor && (
        <Modal open onClose={() => setOutcomeFor(null)} width={420} title="How did the call go?" sub={outcomeFor.subject}
          footer={<Btn kind="ghost" onClick={() => void run(outcomeFor)}>Skip outcome</Btn>}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {CALL_OUTCOMES.map((o) => (
              <button key={o} onClick={() => void run(outcomeFor, o)} style={{ padding: '8px 13px', borderRadius: 99, background: 'var(--surf-1)', border: '1px solid var(--bord)', fontSize: 11.5, fontWeight: 800, color: 'var(--text-2)', cursor: 'pointer' }}>
                {o.replace(/_/g, ' ')}
              </button>
            ))}
          </div>
        </Modal>
      )}
      <ScheduleActivityModal open={nextOpen} onClose={() => setNextOpen(false)} dealId={dealId} title="Done — what's next?" sub="Schedule the next activity now so the deal never goes quiet" />
    </>
  )

  return { start, ui, busy: complete.isPending }
}

export function dueLabel(a: Activity): { text: string; overdue: boolean } {
  if (!a.due_at) return { text: '—', overdue: false }
  const d = new Date(a.due_at)
  return { text: d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }), overdue: !a.completed_at && d < new Date() }
}
