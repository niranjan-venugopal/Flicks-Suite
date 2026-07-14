'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Btn, Icon, Pill, SectionHead } from '@/components/proto'
import { EmptyState } from '@/components/crm/kit'
import { ACT_META, ScheduleActivityModal, useCompleteWithNext, dueLabel } from '@/components/crm/activity-widgets'
import { useMyActivities, useDeleteActivity, type Activity } from '@/lib/api/queries/use-crm'

// ─────────────────────────────────────────────────────────
// C8 — My Activities: overdue / today / upcoming / done,
// complete → "what's next?" loop (§6)
// ─────────────────────────────────────────────────────────

export default function MyActivitiesPage() {
  const { data, isLoading } = useMyActivities()
  const del = useDeleteActivity()
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const completeLoop = useCompleteWithNext()
  const d = data?.data

  const total = d ? d.overdue.length + d.today.length + d.upcoming.length : 0

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
          <Bucket label="Overdue" tone="coral" items={d?.overdue ?? []} onComplete={completeLoop.start} onDelete={(a) => del.mutate({ id: a.id, dealId: a.deal_id })} />
          <Bucket label="Today" tone="blue" items={d?.today ?? []} onComplete={completeLoop.start} onDelete={(a) => del.mutate({ id: a.id, dealId: a.deal_id })} />
          <Bucket label="Upcoming" tone="" items={d?.upcoming ?? []} onComplete={completeLoop.start} onDelete={(a) => del.mutate({ id: a.id, dealId: a.deal_id })} />
          {(d?.completed.length ?? 0) > 0 && (
            <Bucket label="Recently completed" tone="green" items={d!.completed} muted />
          )}
        </>
      )}

      <ScheduleActivityModal open={scheduleOpen} onClose={() => setScheduleOpen(false)} />
      {completeLoop.ui}
    </div>
  )
}

function Bucket({ label, tone, items, onComplete, onDelete, muted }: {
  label: string
  tone: '' | 'blue' | 'coral' | 'green'
  items: Activity[]
  onComplete?: (a: Activity) => void
  onDelete?: (a: Activity) => void
  muted?: boolean
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
            <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: i < items.length - 1 ? '1px solid var(--bord)' : 'none', opacity: muted ? 0.7 : 1 }}>
              <div style={{ width: 30, height: 30, borderRadius: 9, background: `${M.color}20`, color: M.color, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
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
                </div>
              </div>
              {onComplete && !a.completed_at && (
                <Btn kind="secondary" size="sm" icon={<Icon.check size={13} />} onClick={() => onComplete(a)}>Complete</Btn>
              )}
              {onDelete && !a.completed_at && (
                <Btn kind="ghost" size="sm" icon={<Icon.trash size={13} />} onClick={() => onDelete(a)} />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
