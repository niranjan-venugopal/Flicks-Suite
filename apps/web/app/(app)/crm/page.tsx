'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Btn, Icon, Kpi, Pill, SectionHead } from '@/components/proto'
import { EmptyState, fmtCur } from '@/components/crm/kit'
import { ACT_META, dueLabel, useCompleteWithNext } from '@/components/crm/activity-widgets'
import { useQuickAdd } from '@/lib/stores/quick-add.store'
import { useAuthStore } from '@/lib/stores/auth.store'
import { useToast } from '@/components/ui/use-toast'
import {
  useBoard,
  useForecast,
  useMyActivities,
  useReps,
  useSampleDataStatus,
  useSampleData,
  type Activity,
  type DealCard,
} from '@/lib/api/queries/use-crm'

// ─────────────────────────────────────────────────────────
// C1 — CRM Overview: quick-start checklist (§19.10), KPI row,
// tasks today (complete → what's-next loop), recent activity,
// rotting deals. Goal card (§19.6) and the BCC dropbox join
// with their phases.
// ─────────────────────────────────────────────────────────

const DISMISS_KEY = 'crm.quickstart.dismissed'

export default function CrmOverviewPage() {
  const router = useRouter()
  const quickAdd = useQuickAdd()
  const forecast = useForecast()
  const board = useBoard()
  const mine = useMyActivities()
  const { currentUser } = useAuthStore()
  const reps = useReps()
  const completeLoop = useCompleteWithNext()

  const f = forecast.data?.data
  const base = f?.base_currency ?? 'INR'
  const cards: DealCard[] = (board.data?.data.columns ?? []).flatMap((c) => c.cards)
  const rotting = cards.filter((d) => d.rot_state)
  const noNext = cards.filter((d) => !d.next_activity_at)
  const acts = mine.data?.data
  const totalOpenDeals = f?.open_count ?? 0
  const anyActivity = !!acts && (acts.overdue.length + acts.today.length + acts.upcoming.length + acts.completed.length > 0)

  const [dismissed, setDismissed] = useState(true)
  useEffect(() => { setDismissed(localStorage.getItem(DISMISS_KEY) === '1') }, [])
  const dismiss = () => { localStorage.setItem(DISMISS_KEY, '1'); setDismissed(true) }

  const steps: Array<{ label: string; done: boolean; onClick: () => void }> = [
    { label: 'Create your first deal', done: totalOpenDeals + (f?.won_value ? 1 : 0) > 0, onClick: () => quickAdd.openWith('deal') },
    { label: 'Link a company & contact to a deal', done: cards.some((d) => d.company_id || d.primary_person_id), onClick: () => quickAdd.openWith('deal') },
    { label: 'Schedule a follow-up activity', done: anyActivity, onClick: () => router.push('/crm/activities') },
    { label: 'Invite your team', done: (reps.data?.data.length ?? 0) > 1, onClick: () => router.push('/settings/members') },
    { label: 'Walk the pipeline on the board', done: rotting.length + noNext.length < cards.length || cards.length > 0, onClick: () => router.push('/crm/deals') },
  ]
  const doneCount = steps.filter((s) => s.done).length

  if (!board.isLoading && cards.length === 0 && totalOpenDeals === 0 && !anyActivity) {
    return (
      <div style={{ padding: '28px 32px 64px' }}>
        <SectionHead title="CRM" sub="Your pipeline at a glance." />
        <EmptyState
          icon={<Icon.funnel size={22} />}
          line="Your CRM is ready. Create your first deal — or load sample data to explore every screen (removable in one click, C22)."
          cta="New deal"
          onCta={() => quickAdd.openWith('deal')}
          secondary={<SampleDataButton />}
        />
      </div>
    )
  }

  return (
    <div style={{ padding: '28px 32px 64px' }}>
      <SectionHead title="CRM" sub="Your pipeline at a glance — deals, follow-ups and what needs attention." />

      {/* Quick-start checklist (§19.10) */}
      {!dismissed && doneCount < steps.length && (
        <div className="card" style={{ position: 'relative', borderColor: 'rgba(62,123,250,.35)', marginBottom: 16 }}>
          <button onClick={dismiss} title="Dismiss" style={{ position: 'absolute', top: 12, right: 12, width: 24, height: 24, borderRadius: 7, background: 'var(--surf-2)', border: '1px solid var(--bord)', color: 'var(--text-mute)', cursor: 'pointer' }}><Icon.x size={12} /></button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <div style={{ width: 32, height: 32, borderRadius: 9, background: 'rgba(62,123,250,.16)', color: 'var(--blue)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon.zap size={16} /></div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13.5, fontWeight: 800 }}>Get set up</div>
              <div className="t-mute" style={{ fontSize: 11 }}>{doneCount} of {steps.length} done</div>
            </div>
            <div style={{ width: 120, height: 6, borderRadius: 99, background: 'var(--surf-2)', overflow: 'hidden' }}>
              <div style={{ width: `${(doneCount / steps.length) * 100}%`, height: '100%', borderRadius: 99, background: 'var(--blue)', transition: 'width .3s' }} />
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(190px,1fr))', gap: 8 }}>
            {steps.map((s) => (
              <button key={s.label} onClick={s.onClick} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '9px 11px', borderRadius: 9, background: s.done ? 'rgba(39,210,128,.07)' : 'var(--surf-1)', border: `1px solid ${s.done ? 'rgba(39,210,128,.3)' : 'var(--bord)'}`, cursor: 'pointer', textAlign: 'left' }}>
                <span style={{ width: 17, height: 17, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: s.done ? 'var(--green)' : 'transparent', border: s.done ? 'none' : '1.5px solid var(--bord-2)', color: '#01010D' }}>
                  {s.done && <Icon.check size={11} />}
                </span>
                <span style={{ fontSize: 11.5, fontWeight: 700, color: s.done ? 'var(--text-mute)' : '#fff', textDecoration: s.done ? 'line-through' : 'none' }}>{s.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* KPI row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(210px,1fr))', gap: 14, marginBottom: 16 }}>
        <Kpi label="Pipeline · open" value={fmtCur(f?.open_value ?? 0, base)} delta={`${totalOpenDeals} deals · weighted ${fmtCur(f?.weighted_value ?? 0, base)}`} icon={<Icon.funnel size={16} />} accent="blue" />
        <Kpi label="Tasks today" value={String(acts?.today.length ?? 0)} delta={`${acts?.overdue.length ?? 0} overdue`} trend={acts?.overdue.length ? 'down' : undefined} icon={<Icon.check size={16} />} accent="green" />
        <Kpi label="Rotting deals" value={String(rotting.length)} delta={`${noNext.length} with no next activity`} trend={rotting.length ? 'down' : undefined} icon={<Icon.clock size={16} />} accent="coral" />
        <Kpi label="Won · all time" value={fmtCur(f?.won_value ?? 0, base)} delta="win rate & forecast live in Reports" icon={<Icon.award size={16} />} accent="purple" />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Tasks today */}
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--bord)', display: 'flex', alignItems: 'center' }}>
              <div className="t-h3" style={{ flex: 1 }}>Tasks today</div>
              <Link href="/crm/activities" style={{ fontSize: 12, fontWeight: 700, color: 'var(--blue)', textDecoration: 'none' }}>My activities →</Link>
            </div>
            {(acts ? [...acts.overdue, ...acts.today] : []).slice(0, 6).map((a: Activity) => {
              const M = ACT_META[a.type]
              const Ic = Icon[M.icon]
              const due = dueLabel(a)
              return (
                <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 18px', borderBottom: '1px solid var(--bord)' }}>
                  <button title="Complete" onClick={() => completeLoop.start(a)} style={{ width: 20, height: 20, borderRadius: '50%', border: '1.5px solid var(--bord-2)', background: 'transparent', cursor: 'pointer', flexShrink: 0 }} />
                  <div style={{ width: 26, height: 26, borderRadius: 7, background: `${M.color}1e`, color: M.color, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Ic size={13} /></div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.subject}</div>
                    {a.deal_id && a.deal_title && (
                      <Link href={`/crm/deals/${a.deal_id}`} style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text-mute)', textDecoration: 'none' }}>{a.deal_title}</Link>
                    )}
                  </div>
                  <span style={{ fontSize: 11, fontWeight: 700, color: due.overdue ? 'var(--coral)' : 'var(--text-2)', whiteSpace: 'nowrap' }}>{due.text}</span>
                </div>
              )
            })}
            {acts && acts.overdue.length + acts.today.length === 0 && (
              <div className="t-mute" style={{ padding: 18, fontSize: 12.5 }}>Nothing due today — schedule the next step on any deal so it never goes quiet.</div>
            )}
          </div>

          {/* Recent activity */}
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--bord)' }}><div className="t-h3">Recent activity</div></div>
            {(acts?.completed ?? []).slice(0, 5).map((a) => {
              const M = ACT_META[a.type]
              const Ic = Icon[M.icon]
              return (
                <div key={a.id} style={{ display: 'flex', gap: 12, padding: '11px 18px', borderBottom: '1px solid var(--bord)' }}>
                  <div style={{ width: 26, height: 26, borderRadius: 7, background: `${M.color}1e`, color: M.color, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Ic size={13} /></div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 700, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.subject}</div>
                    <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text-mute)', marginTop: 1 }}>
                      {[
                        a.assignee_user_id && a.assignee_user_id !== currentUser?.id && a.assignee_name ? `for ${a.assignee_name}` : null,
                        a.deal_title,
                        a.outcome?.replace(/_/g, ' '),
                      ].filter(Boolean).join(' · ') || M.label}
                    </div>
                  </div>
                  <span className="t-caption" style={{ whiteSpace: 'nowrap' }}>{a.completed_at ? new Date(a.completed_at).toLocaleDateString() : ''}</span>
                </div>
              )
            })}
            {(acts?.completed.length ?? 0) === 0 && (
              <div className="t-mute" style={{ padding: 18, fontSize: 12.5 }}>Completed activities show up here.</div>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Rotting deals */}
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--bord)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <div className="t-h3" style={{ flex: 1 }}>Rotting deals</div>
              <Pill tone="coral" dot>{rotting.length}</Pill>
            </div>
            {rotting.slice(0, 6).map((d) => (
              <Link key={d.id} href={`/crm/deals/${d.id}`} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '11px 18px', borderBottom: '1px solid var(--bord)', textDecoration: 'none', color: 'inherit' }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: d.rot_state === 'red' ? 'var(--coral)' : 'var(--yellow)' }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 800, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.title}</div>
                  <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text-mute)' }}>Idle {d.idle_days}d in stage</div>
                </div>
                <span className="t-num" style={{ fontSize: 12, fontWeight: 800 }}>{fmtCur(parseFloat(d.value_amount), d.currency)}</span>
              </Link>
            ))}
            {rotting.length === 0 && <div className="t-mute" style={{ padding: 18, fontSize: 12.5 }}>Nothing is rotting — nice.</div>}
            <div style={{ padding: '10px 18px' }}>
              <Link href="/crm/deals" style={{ fontSize: 11.5, fontWeight: 800, color: 'var(--blue)', textDecoration: 'none' }}>Open board →</Link>
            </div>
          </div>

          {/* Shortcuts */}
          <div className="card">
            <div className="t-caption" style={{ marginBottom: 10 }}>Shortcuts</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Btn kind="primary" size="sm" icon={<Icon.plus size={13} />} onClick={() => quickAdd.openWith('deal')}>New deal <span style={{ opacity: 0.6, fontFamily: 'var(--font-mono)', fontSize: 10 }}>N</span></Btn>
              <Btn kind="secondary" size="sm" icon={<Icon.search size={13} />} onClick={() => window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true }))}>Search everything <span style={{ opacity: 0.6, fontFamily: 'var(--font-mono)', fontSize: 10 }}>/</span></Btn>
              <Link href="/crm/activities"><Btn kind="secondary" size="sm" icon={<Icon.cal size={13} />} style={{ width: '100%' }}>My activities</Btn></Link>
            </div>
            <div className="t-caption" style={{ marginTop: 12 }}>
              Open <Link href="/crm/reports" style={{ color: 'var(--blue)' }}>Reports</Link> for pipeline health, forecast and goals — or <Link href="/crm/leads" style={{ color: 'var(--blue)' }}>Leads</Link> to triage new business.
            </div>
          </div>
        </div>
      </div>

      {completeLoop.ui}
    </div>
  )
}

// ── C22 · Sample data toggle — seed a labelled pack, remove it in one click ──
function SampleDataButton() {
  const { toast } = useToast()
  const status = useSampleDataStatus()
  const sample = useSampleData()
  const loaded = status.data?.data.loaded ?? false
  return (
    <Btn kind="secondary" size="sm" icon={loaded ? <Icon.trash size={13} /> : <Icon.spark size={13} />} disabled={sample.isPending || status.isLoading}
      onClick={() => sample.mutate(loaded ? 'remove' : 'seed', {
        onSuccess: () => toast({ title: loaded ? 'Sample data removed' : 'Sample data loaded', description: loaded ? 'Only the demo records were deleted.' : 'Companies, contacts, deals, activities and leads — all labelled “(sample)”.' }),
        onError: (err) => toast({ title: 'Sample data', description: err instanceof Error ? err.message : undefined, variant: 'destructive' }),
      })}>
      {sample.isPending ? 'Working…' : loaded ? 'Remove sample data' : 'Load sample data'}
    </Btn>
  )
}
