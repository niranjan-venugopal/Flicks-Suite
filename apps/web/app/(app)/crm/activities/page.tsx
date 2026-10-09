'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Btn, Icon, Modal, Pill, SectionHead } from '@/components/proto'
import { EmptyState } from '@/components/crm/kit'
import { DateTimeField } from '@/components/ui/date-picker'
import { useToast } from '@/components/ui/use-toast'
import { ACT_META, ScheduleActivityModal, useCompleteWithNext, dueLabel } from '@/components/crm/activity-widgets'
import { useAuthStore } from '@/lib/stores/auth.store'
import {
  useMyActivities,
  useDeleteActivity,
  useUpdateActivity,
  useReopenActivity,
  useReps,
  type Activity,
  type UpdateActivityBody,
} from '@/lib/api/queries/use-crm'

// ─────────────────────────────────────────────────────────
// C8 — My Activities: overdue / today / upcoming / done,
// complete → "what's next?" loop (§6). Round R R3: every row is editable
// (subject, notes, due, assignee, type) and a finished one can be marked
// not done — it goes back to the queue and the deal's next-step follows.
// ─────────────────────────────────────────────────────────

export default function MyActivitiesPage() {
  const { data, isLoading } = useMyActivities()
  const { currentUser } = useAuthStore()
  const { toast } = useToast()
  const del = useDeleteActivity()
  const reopen = useReopenActivity()
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const [editing, setEditing] = useState<Activity | null>(null)
  const completeLoop = useCompleteWithNext()
  const d = data?.data

  const total = d ? d.overdue.length + d.today.length + d.upcoming.length : 0
  const onDelete = (a: Activity) => del.mutate({ id: a.id, dealId: a.deal_id })
  const onReopen = (a: Activity) =>
    reopen.mutate({ id: a.id, dealId: a.deal_id }, {
      onSuccess: () => toast({ title: 'Marked not done', description: `“${a.subject}” is back in your queue.` }),
      onError: (err) => toast({ title: 'Could not reopen', description: err instanceof Error ? err.message : undefined, variant: 'destructive' }),
    })

  return (
    <div style={{ padding: '28px 32px 64px', maxWidth: 980, margin: '0 auto' }}>
      <SectionHead
        title="My activities"
        sub={d ? `${d.overdue.length} overdue · ${d.today.length} today · ${d.upcoming.length} upcoming` : 'Your follow-up queue'}
        right={<Btn kind="primary" size="sm" icon={<Icon.plus size={14} />} onClick={() => setScheduleOpen(true)}>Schedule</Btn>}
      />

      {isLoading ? (
        <div style={{ padding: 60, display: 'flex', justifyContent: 'center' }}>
          <Icon.refresh size={20} className="animate-spin" style={{ color: 'var(--text-mute)' }} />
        </div>
      ) : total === 0 && (d?.completed.length ?? 0) === 0 ? (
        <EmptyState
          icon={<Icon.cal size={22} />}
          line="Nothing scheduled. Activity-based selling means every deal always has a next step — schedule your first one."
          cta="Schedule an activity"
          onCta={() => setScheduleOpen(true)}
        />
      ) : (
        <>
          <Bucket label="Overdue" tone="coral" items={d?.overdue ?? []} onComplete={completeLoop.start} onEdit={setEditing} onDelete={onDelete} />
          <Bucket label="Today" tone="blue" items={d?.today ?? []} onComplete={completeLoop.start} onEdit={setEditing} onDelete={onDelete} />
          <Bucket label="Upcoming" tone="" items={d?.upcoming ?? []} onComplete={completeLoop.start} onEdit={setEditing} onDelete={onDelete} />
          {(d?.completed.length ?? 0) > 0 && (
            <Bucket label="Recently completed" tone="green" items={d!.completed} muted meId={currentUser?.id}
              onEdit={setEditing} onReopen={onReopen} reopening={reopen.isPending} onDelete={onDelete} />
          )}
        </>
      )}

      <ScheduleActivityModal open={scheduleOpen} onClose={() => setScheduleOpen(false)} />
      {editing && <EditActivityModal activity={editing} onClose={() => setEditing(null)} />}
      {completeLoop.ui}
    </div>
  )
}

function Bucket({ label, tone, items, onComplete, onEdit, onReopen, reopening, onDelete, muted, meId }: {
  label: string
  tone: '' | 'blue' | 'coral' | 'green'
  items: Activity[]
  onComplete?: (a: Activity) => void
  onEdit?: (a: Activity) => void
  /** Round R R3 — "mark not done" on a completed task / call / meeting. */
  onReopen?: (a: Activity) => void
  reopening?: boolean
  onDelete?: (a: Activity) => void
  muted?: boolean
  /** When set, rows whose assignee isn't me are labelled "for {assignee}". */
  meId?: string
}) {
  if (!items.length) return null
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span className="t-caption">{label}</span>
        <Pill tone={tone}>{items.length}</Pill>
      </div>
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {items.map((a, i) => {
          const M = ACT_META[a.type]
          const Ic = Icon[M.icon]
          const due = dueLabel(a)
          return (
            <div key={a.id} data-testid={`activity-row-${a.id}`} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: i < items.length - 1 ? '1px solid var(--bord)' : 'none', opacity: muted ? 0.7 : 1 }}>
              <div style={{ width: 30, height: 30, borderRadius: 9, background: `color-mix(in srgb, ${M.color} 13%, transparent)`, color: M.color, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <Ic size={14} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {a.subject}
                  {a.outcome && <span className="t-mute" style={{ fontSize: 11, marginLeft: 8 }}>· {a.outcome.replace(/_/g, ' ')}</span>}
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 2 }}>
                  {a.deal_id && a.deal_title && (
                    <Link href={`/crm/deals/${a.deal_id}`} style={{ fontSize: 11, fontWeight: 700, color: 'var(--blue)', textDecoration: 'none' }}>
                      {a.deal_title}
                    </Link>
                  )}
                  <span style={{ fontSize: 10.5, fontWeight: 700, color: due.overdue ? 'var(--coral)' : 'var(--text-mute)' }}>{due.text}</span>
                  {meId && a.assignee_user_id && a.assignee_user_id !== meId && a.assignee_name && (
                    <Pill tone="blue">for {a.assignee_name}</Pill>
                  )}
                </div>
              </div>
              {onComplete && !a.completed_at && (
                <Btn kind="secondary" size="sm" icon={<Icon.check size={13} />} onClick={() => onComplete(a)}>Complete</Btn>
              )}
              {onReopen && a.completed_at && a.type !== 'note' && (
                <Btn kind="secondary" size="sm" icon={<Icon.refresh size={13} />} disabled={reopening} onClick={() => onReopen(a)} title="Back to the queue" data-testid={`activity-reopen-${a.id}`}>Not done</Btn>
              )}
              {onEdit && (
                <Btn kind="ghost" size="sm" icon={<Icon.edit size={13} />} onClick={() => onEdit(a)} title="Edit" data-testid={`activity-edit-${a.id}`} />
              )}
              {/* Completed activities are deletable too — that history IS the
                  dump at client volume (round 9). */}
              {onDelete && (
                <Btn kind="ghost" size="sm" icon={<Icon.trash size={13} />} onClick={() => onDelete(a)} />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

const pad = (n: number) => String(n).padStart(2, '0')
/** ISO instant → the 'YYYY-MM-DDTHH:mm' the DateTimeField speaks (local time). */
function toLocalInput(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// Round R R3 — edit an activity in place.
function EditActivityModal({ activity, onClose }: { activity: Activity; onClose: () => void }) {
  const update = useUpdateActivity()
  const reps = useReps()
  const { toast } = useToast()
  const isNote = activity.type === 'note'
  const [form, setForm] = useState({
    type: activity.type as string,
    subject: activity.subject,
    body: activity.body ?? '',
    due: toLocalInput(activity.due_at),
    assignee_user_id: activity.assignee_user_id ?? '',
  })
  const valid = form.subject.trim().length > 0 && (form.type === 'note' || form.due.length >= 16)
  const submit = async () => {
    const body: UpdateActivityBody = {
      subject: form.subject.trim(),
      body: form.body.trim() || null,
    }
    if (!isNote) {
      body.type = form.type
      body.due_at = form.due ? new Date(form.due).toISOString() : null
      if (!activity.completed_at && form.assignee_user_id && form.assignee_user_id !== activity.assignee_user_id) body.assignee_user_id = form.assignee_user_id
    }
    try {
      await update.mutateAsync({ id: activity.id, body, dealId: activity.deal_id })
      toast({ title: 'Activity updated' })
      onClose()
    } catch (err) {
      toast({ title: 'Could not save', description: err instanceof Error ? err.message : undefined, variant: 'destructive' })
    }
  }
  return (
    <Modal open onClose={onClose} width={520} title={isNote ? 'Edit note' : 'Edit activity'} sub={isNote ? 'A note is a record of what happened — fix the wording' : 'Change what, when and who; the deal’s next step follows'}
      footer={<>
        <Btn kind="ghost" onClick={onClose} disabled={update.isPending}>Cancel</Btn>
        <Btn kind="primary" icon={<Icon.check size={14} />} disabled={!valid || update.isPending} onClick={() => void submit()} data-testid="activity-edit-save">
          {update.isPending ? 'Saving…' : 'Save'}
        </Btn>
      </>}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }} data-testid="activity-edit-modal">
        <div style={{ gridColumn: '1/-1' }}>
          <div className="label">Subject</div>
          <input autoFocus className="input" value={form.subject} onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))} maxLength={200} style={{ width: '100%' }} data-testid="activity-edit-subject" />
        </div>
        {!isNote && (
          <>
            <div>
              <div className="label">Type</div>
              <select className="input" value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))} style={{ height: 38, width: '100%' }}>
                <option value="task">Task</option>
                <option value="call">Call</option>
                <option value="meeting">Meeting</option>
              </select>
            </div>
            <div>
              <div className="label">Due</div>
              <DateTimeField value={form.due} onChange={(v) => setForm((f) => ({ ...f, due: v }))} style={{ height: 38, width: '100%' }} />
            </div>
            {/* A finished item is a record of who did it — not re-assignable. */}
            {!activity.completed_at && (
              <div style={{ gridColumn: '1/-1' }}>
                <div className="label">Assigned to</div>
                <select className="input" value={form.assignee_user_id} onChange={(e) => setForm((f) => ({ ...f, assignee_user_id: e.target.value }))} style={{ height: 38, width: '100%' }} data-testid="activity-edit-assignee">
                  {!(reps.data?.data ?? []).some((r) => r.user_id === form.assignee_user_id) && <option value={form.assignee_user_id}>{activity.assignee_name ?? 'Current assignee'}</option>}
                  {(reps.data?.data ?? []).map((r) => <option key={r.user_id} value={r.user_id}>{r.name}</option>)}
                </select>
              </div>
            )}
          </>
        )}
        <div style={{ gridColumn: '1/-1' }}>
          <div className="label">Notes</div>
          <textarea className="input" value={form.body} onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))} maxLength={5000} style={{ width: '100%', height: 80, padding: 10, resize: 'vertical' }} />
        </div>
      </div>
    </Modal>
  )
}
