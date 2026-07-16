'use client'

import Link from 'next/link'
import { Icon, Pill } from '@/components/proto'
import { fmtCur } from '@/components/crm/kit'
import { ACT_META } from '@/components/crm/activity-widgets'
import type { RefDeal, RefActivity } from '@/lib/api/queries/use-crm'

// Shared detail-page cards used by both the Contact (C4) and Company (C5) 360°
// pages — open deals list + recent-activity timeline in the proto design.

export function DealsCard({ deals, base, loading }: { deals: RefDeal[]; base: string; loading: boolean }) {
  const open = deals.filter((d) => d.status === 'open')
  const openValue = open.reduce((a, d) => a + parseFloat(d.value_base_amount), 0)
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--bord)', display: 'flex', alignItems: 'center', gap: 9 }}>
        <Icon.funnel size={15} style={{ color: 'var(--blue)' }} />
        <span style={{ fontSize: 13, fontWeight: 800, flex: 1 }}>Deals</span>
        {open.length > 0 && <span className="t-mute" style={{ fontSize: 11 }}>{open.length} open · {fmtCur(openValue, base)}</span>}
      </div>
      {loading ? (
        <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Icon.refresh size={16} className="animate-spin" style={{ color: 'var(--text-mute)' }} /></div>
      ) : deals.length === 0 ? (
        <div className="t-mute" style={{ padding: 18, fontSize: 12.5 }}>No deals yet.</div>
      ) : (
        deals.map((d, i) => (
          <Link key={d.id} href={`/crm/deals/${d.id}`} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '12px 18px', borderBottom: i < deals.length - 1 ? '1px solid var(--bord)' : 'none', textDecoration: 'none', color: 'inherit' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 800 }}>{d.title}</div>
              <div className="t-mute" style={{ fontSize: 10.5 }}>
                {d.stage_name ?? '—'}{d.win_probability != null ? ` · ${d.win_probability}%` : ''}{d.expected_close_date ? ` · close ${d.expected_close_date}` : ''}
              </div>
            </div>
            {d.status !== 'open'
              ? <Pill tone={d.status === 'won' ? 'green' : 'coral'}>{d.status === 'won' ? '🏆 Won' : 'Lost'}</Pill>
              : <span className="t-num" style={{ fontSize: 12, fontWeight: 800 }}>{fmtCur(parseFloat(d.value_base_amount), base)}</span>}
          </Link>
        ))
      )}
    </div>
  )
}

export function ActivityCard({ activities, loading }: { activities: RefActivity[]; loading: boolean }) {
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--bord)', display: 'flex', alignItems: 'center', gap: 9 }}>
        <Icon.clock size={15} style={{ color: 'var(--purple, #9b7bfa)' }} />
        <span style={{ fontSize: 13, fontWeight: 800, flex: 1 }}>Recent activity</span>
      </div>
      {loading ? (
        <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Icon.refresh size={16} className="animate-spin" style={{ color: 'var(--text-mute)' }} /></div>
      ) : activities.length === 0 ? (
        <div className="t-mute" style={{ padding: 18, fontSize: 12.5 }}>No activity logged yet.</div>
      ) : (
        activities.map((a, i) => {
          const M = ACT_META[a.type as keyof typeof ACT_META] ?? ACT_META.task
          const Ic = Icon[M.icon]
          const done = !!a.completed_at
          return (
            <div key={a.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 11, padding: '12px 18px', borderBottom: i < activities.length - 1 ? '1px solid var(--bord)' : 'none' }}>
              <div style={{ width: 26, height: 26, borderRadius: 8, background: `${M.color}1e`, color: M.color, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Ic size={13} /></div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 800 }}>{a.subject}</div>
                <div className="t-mute" style={{ fontSize: 10.5 }}>
                  {done ? `Completed ${new Date(a.completed_at!).toLocaleDateString()}` : a.due_at ? `Due ${new Date(a.due_at).toLocaleDateString()}` : M.label}
                  {a.assignee_name ? ` · ${a.assignee_name}` : ''}
                  {a.deal_id && <> · <Link href={`/crm/deals/${a.deal_id}`} style={{ color: 'var(--blue)', textDecoration: 'none' }}>deal</Link></>}
                </div>
              </div>
              {done && <Icon.check size={13} style={{ color: 'var(--green)', flexShrink: 0, marginTop: 3 }} />}
            </div>
          )
        })
      )}
    </div>
  )
}
