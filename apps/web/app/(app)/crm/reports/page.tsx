'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Btn, Icon, Modal, Pill, SectionHead } from '@/components/proto'
import { EmptyState, OwnerAv } from '@/components/crm/kit'
import { useToast } from '@/components/ui/use-toast'
import { FEATURES } from '@/lib/feature-flags'
import {
  useReportsOverview,
  useForecastReport,
  useGoals,
  useSetGoal,
  useReps,
  type ForecastRow,
} from '@/lib/api/queries/use-crm'

// ─────────────────────────────────────────────────────────
// C16 Reports dashboard · C17 Forecast · §19.6 goals —
// scr-reports.jsx ported to live data. All sums in the
// workspace base currency (deals carry base snapshots).
// ─────────────────────────────────────────────────────────

const fmtBase = (v: number) =>
  v >= 10_000_000 ? `₹${(v / 10_000_000).toFixed(1)} Cr` : v >= 100_000 ? `₹${(v / 100_000).toFixed(1)} L` : `₹${Math.round(v).toLocaleString('en-IN')}`

const LOST_COLS = ['#F8786B', '#FF9933', '#FED800', '#9B7BFA', '#5C6477']

function RptCard({ title, sub, children, wide }: { title: string; sub?: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="card" style={{ gridColumn: wide ? 'span 2' : 'span 1', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div>
        <div style={{ fontSize: 13.5, fontWeight: 800 }}>{title}</div>
        {sub && <div className="t-caption" style={{ marginTop: 2 }}>{sub}</div>}
      </div>
      {children}
    </div>
  )
}

export default function ReportsPage() {
  const [tab, setTab] = useState<'reports' | 'forecast' | 'goals'>('reports')
  return (
    <div style={{ padding: '28px 32px 64px', maxWidth: 1060, margin: '0 auto' }}>
      <SectionHead title="Reports" sub="Pipeline health, forecast and goals — all sums in your base currency." />
      <div style={{ display: 'flex', gap: 4, padding: 3, background: 'var(--surf-1)', border: '1px solid var(--bord)', borderRadius: 10, marginBottom: 18, width: 'fit-content' }}>
        {([['reports', 'Dashboard'], ['forecast', 'Forecast'], ['goals', 'Goals']] as const).map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} style={{ padding: '8px 14px', borderRadius: 7, border: 'none', cursor: 'pointer', background: tab === k ? 'var(--surf-3)' : 'transparent', color: tab === k ? '#fff' : 'var(--text-2)', fontSize: 12, fontWeight: 800 }}>{l}</button>
        ))}
      </div>
      {tab === 'reports' && <Dashboard />}
      {tab === 'forecast' && <Forecast />}
      {tab === 'goals' && <Goals />}
    </div>
  )
}

function Dashboard() {
  const { data, isLoading } = useReportsOverview()
  const [dim, setDim] = useState<'by_source' | 'by_owner'>('by_source')
  const d = data?.data
  if (isLoading) return <div style={{ padding: 60, display: 'flex', justifyContent: 'center' }}><Icon.refresh size={20} className="animate-spin" style={{ color: 'var(--text-mute)' }} /></div>
  if (!d || d.snapshot.every((s) => s.count === 0)) {
    return <EmptyState icon={<Icon.chart size={22} />} line="Not enough data yet — log activities and move deals to unlock reports." cta="Open the board" onCta={() => { window.location.href = '/crm/deals' }} />
  }
  const maxRaw = Math.max(1, ...d.snapshot.map((r) => r.raw))
  const maxVel = Math.max(1, ...d.velocity.map((v) => v.value))
  const lostTotal = Math.max(1, d.lost_reasons.reduce((s, r) => s + r.count, 0))
  const rows = d.win_loss[dim]

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 14 }}>
      <RptCard title="Pipeline snapshot" sub={`raw vs weighted by stage · avg days in stage · last ${d.window_days}d`}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
          {d.snapshot.map((r) => (
            <div key={r.stage_id}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ fontSize: 11.5, fontWeight: 700 }}>{r.stage} <span style={{ color: 'var(--text-faint)', fontWeight: 600 }}>· {r.count} deals · {r.avg_days}d avg</span></span>
                <span className="t-num" style={{ fontSize: 11.5, fontWeight: 800 }}>{fmtBase(r.raw)}</span>
              </div>
              <div style={{ position: 'relative', height: 14, borderRadius: 5, background: 'var(--surf-2)', overflow: 'hidden' }}>
                <div style={{ position: 'absolute', inset: 0, width: `${(r.raw / maxRaw) * 100}%`, background: 'rgba(62,123,250,.3)', borderRadius: 5 }} />
                <div title={`weighted ${fmtBase(r.weighted)}`} style={{ position: 'absolute', top: 0, bottom: 0, width: `${(r.weighted / maxRaw) * 100}%`, background: 'var(--blue)', borderRadius: 5 }} />
              </div>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 14 }}>
          <span className="t-caption" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--blue)' }} />weighted</span>
          <span className="t-caption" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 8, height: 8, borderRadius: 2, background: 'rgba(62,123,250,.3)' }} />raw</span>
        </div>
      </RptCard>

      <RptCard title="Funnel conversion" sub="how far deals created in the window travelled">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {d.funnel.map((f, i) => (
            <div key={f.stage} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ width: 110, fontSize: 11, fontWeight: 700, color: 'var(--text-2)', textAlign: 'right' }}>{f.stage}</span>
              <div style={{ flex: 1, height: 20, borderRadius: 5, background: 'var(--surf-2)', overflow: 'hidden' }}>
                <div style={{ width: `${Math.max(f.pct, 4)}%`, height: '100%', background: i === d.funnel.length - 1 ? 'var(--green)' : 'var(--purple, #9b7bfa)', opacity: 0.4 + 0.6 * (f.pct / 100), display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: 7 }}>
                  <span style={{ fontSize: 9.5, fontWeight: 800, color: '#fff' }}>{f.pct}%</span>
                </div>
              </div>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderRadius: 9, background: 'rgba(39,210,128,.07)', border: '1px solid rgba(39,210,128,.25)' }}>
          <Icon.award size={14} style={{ color: 'var(--green)' }} />
          <span style={{ fontSize: 11.5, fontWeight: 800 }}>Overall win rate {d.win_loss.overall_win_rate}%</span>
        </div>
      </RptCard>

      <RptCard title="Win / loss" sub="by source & owner · lost reasons">
        <div style={{ display: 'inline-flex', gap: 3, padding: 3, background: 'var(--surf-1)', border: '1px solid var(--bord)', borderRadius: 8, width: 'fit-content' }}>
          {([['by_source', 'By source'], ['by_owner', 'By owner']] as const).map(([k, l]) => (
            <button key={k} onClick={() => setDim(k)} style={{ padding: '5px 11px', borderRadius: 5, border: 'none', cursor: 'pointer', background: dim === k ? 'var(--surf-3)' : 'transparent', color: dim === k ? '#fff' : 'var(--text-2)', fontSize: 10.5, fontWeight: 800 }}>{l}</button>
          ))}
        </div>
        {rows.length === 0 ? <div className="t-mute" style={{ fontSize: 12 }}>No decided deals in the window yet.</div> : (
          <table className="tbl" style={{ margin: '0 -20px', width: 'calc(100% + 40px)' }}>
            <thead><tr><th>{dim === 'by_source' ? 'Source' : 'Owner'}</th><th style={{ textAlign: 'right' }}>Win rate</th><th style={{ textAlign: 'right' }}>Avg size</th><th style={{ textAlign: 'right' }}>Cycle</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td style={{ fontWeight: 700 }}>{r.key}</td>
                  <td className="t-num" style={{ textAlign: 'right', color: 'var(--green)', fontWeight: 800 }}>{r.win_rate}%</td>
                  <td className="t-num" style={{ textAlign: 'right' }}>{r.avg_size ? fmtBase(r.avg_size) : '—'}</td>
                  <td className="t-num" style={{ textAlign: 'right' }}>{r.avg_cycle_days != null ? `${r.avg_cycle_days}d` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {d.lost_reasons.length > 0 && (
          <div>
            <div className="t-caption" style={{ marginBottom: 8 }}>Lost reasons · {lostTotal} deals</div>
            <div style={{ display: 'flex', height: 12, borderRadius: 99, overflow: 'hidden', marginBottom: 8 }}>
              {d.lost_reasons.map((r, i) => (
                <div key={r.label} title={`${r.label} · ${r.count}`} style={{ width: `${(r.count / lostTotal) * 100}%`, background: LOST_COLS[i % LOST_COLS.length] }} />
              ))}
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {d.lost_reasons.map((r, i) => (
                <span key={r.label} className="t-caption" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: LOST_COLS[i % LOST_COLS.length] }} />{r.label} · {r.count}
                </span>
              ))}
            </div>
          </div>
        )}
      </RptCard>

      <RptCard title="Sales velocity" sub="(# open × avg size × win rate) ÷ avg cycle days · monthly">
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, height: 120, padding: '0 4px' }}>
          {d.velocity.map((v, i) => (
            <div key={v.month} title={`${v.month}: ${fmtBase(v.value)}/day`} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 9.5, fontWeight: 800, color: i === d.velocity.length - 1 ? 'var(--green)' : 'var(--text-mute)', fontFamily: 'var(--font-mono)' }}>{v.value >= 1000 ? fmtBase(v.value) : Math.round(v.value)}</span>
              <div style={{ width: '100%', height: `${(v.value / maxVel) * 86}%`, minHeight: 6, borderRadius: '5px 5px 0 0', background: i === d.velocity.length - 1 ? 'var(--green)' : 'rgba(39,210,128,.35)' }} />
              <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-mute)' }}>{v.month.slice(5)}</span>
            </div>
          ))}
        </div>
        <div className="t-caption">₹ per day of expected won value</div>
      </RptCard>

      <RptCard title="Activity leaderboard" sub={`completed in the last ${d.window_days}d · goal progress where set (§19.6)`} wide>
        <table className="tbl" style={{ margin: '0 -20px', width: 'calc(100% + 40px)' }}>
          <thead><tr><th>Rep</th><th style={{ textAlign: 'right' }}>Calls</th><th style={{ textAlign: 'right' }}>Meetings</th><th style={{ textAlign: 'right' }}>Tasks done</th>{FEATURES.crm_email && <th style={{ textAlign: 'right' }}>Emails</th>}<th style={{ width: 200 }}>Goal progress</th></tr></thead>
          <tbody>
            {d.leaderboard.map((r) => (
              <tr key={r.user_id}>
                <td><span style={{ display: 'inline-flex', alignItems: 'center', gap: 9 }}><OwnerAv name={r.name} size={24} /><span style={{ fontWeight: 800 }}>{r.name}</span></span></td>
                <td className="t-num" style={{ textAlign: 'right' }}>{r.calls}</td>
                <td className="t-num" style={{ textAlign: 'right' }}>{r.meetings}</td>
                <td className="t-num" style={{ textAlign: 'right' }}>{r.tasks}</td>
                {FEATURES.crm_email && <td className="t-num" style={{ textAlign: 'right' }}>{r.emails}</td>}
                <td>
                  {r.goal_pct != null ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ flex: 1, height: 6, borderRadius: 99, background: 'var(--surf-2)', overflow: 'hidden' }}>
                        <div style={{ width: `${r.goal_pct}%`, height: '100%', borderRadius: 99, background: r.goal_pct >= 70 ? 'var(--green)' : r.goal_pct >= 50 ? 'var(--yellow)' : 'var(--coral)' }} />
                      </div>
                      <span className="t-num" style={{ fontSize: 10.5, fontWeight: 800, width: 34 }}>{r.goal_pct}%</span>
                    </div>
                  ) : <span className="t-caption">no goal set</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </RptCard>
    </div>
  )
}

function Forecast() {
  const { data, isLoading } = useForecastReport(4)
  const [drill, setDrill] = useState<ForecastRow | null>(null)
  const rows = data?.data ?? []
  if (isLoading) return <div style={{ padding: 60, display: 'flex', justifyContent: 'center' }}><Icon.refresh size={20} className="animate-spin" style={{ color: 'var(--text-mute)' }} /></div>
  if (rows.every((r) => r.weighted === 0 && r.won === 0)) {
    return <EmptyState icon={<Icon.trend size={22} />} line="Forecast unlocks when deals carry values and expected close dates." cta="Open the board" onCta={() => { window.location.href = '/crm/deals' }} />
  }
  const max = Math.max(1, ...rows.map((f) => Math.max(f.weighted, f.committed, f.won, f.goal ?? 0)))
  const H = 170
  return (
    <div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
        {([['var(--purple, #9b7bfa)', 'Weighted'], ['var(--blue)', 'Committed (≥70%)'], ['var(--green)', 'Won'], ['rgba(254,216,0,.8)', 'Goal']] as const).map(([c, l]) => (
          <span key={l} className="t-caption" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: l === 'Goal' ? 0 : 2, background: l === 'Goal' ? 'transparent' : c, borderTop: l === 'Goal' ? `2px dashed ${c}` : 'none' }} />{l}
          </span>
        ))}
        <div style={{ flex: 1 }} />
        <span className="t-caption">by expected close month · base currency</span>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${rows.length},1fr)`, gap: 14, alignItems: 'end', minHeight: 220 }}>
          {rows.map((f) => (
            <div key={f.period} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ position: 'relative', height: H, display: 'flex', alignItems: 'flex-end', gap: 8, justifyContent: 'center' }}>
                {f.goal != null && <div title={`Goal ${fmtBase(f.goal)}`} style={{ position: 'absolute', left: 0, right: 0, bottom: (f.goal / max) * H, borderTop: '2px dashed rgba(254,216,0,.6)' }} />}
                {([['weighted', 'var(--purple, #9b7bfa)'], ['committed', 'var(--blue)'], ['won', 'var(--green)']] as const).map(([k, c]) => (
                  <div key={k} onClick={() => setDrill(f)} title={`${k} ${fmtBase(f[k])}`}
                    style={{ width: 34, height: Math.max(4, (f[k] / max) * H), borderRadius: '6px 6px 0 0', background: c, opacity: k === 'won' && !f[k] ? 0.25 : 1, cursor: 'pointer' }} />
                ))}
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 12, fontWeight: 800 }}>{f.period}</div>
                <div className="t-caption" style={{ marginTop: 2 }}>{fmtBase(f.committed)} committed</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table className="tbl">
          <thead><tr><th>Month</th><th style={{ textAlign: 'right' }}>Weighted</th><th style={{ textAlign: 'right' }}>Committed</th><th style={{ textAlign: 'right' }}>Won to date</th><th style={{ textAlign: 'right' }}>Goal</th><th style={{ textAlign: 'right' }}>Gap to goal</th></tr></thead>
          <tbody>
            {rows.map((f) => (
              <tr key={f.period} onClick={() => setDrill(f)} style={{ cursor: 'pointer' }}>
                <td style={{ fontWeight: 800 }}>{f.period}</td>
                <td className="t-num" style={{ textAlign: 'right', color: 'var(--purple, #9b7bfa)', fontWeight: 800 }}>{fmtBase(f.weighted)}</td>
                <td className="t-num" style={{ textAlign: 'right', color: 'var(--blue)', fontWeight: 800 }}>{fmtBase(f.committed)}</td>
                <td className="t-num" style={{ textAlign: 'right', color: 'var(--green)', fontWeight: 800 }}>{f.won ? fmtBase(f.won) : '—'}</td>
                <td className="t-num" style={{ textAlign: 'right' }}>{f.goal != null ? fmtBase(f.goal) : '—'}</td>
                <td className="t-num" style={{ textAlign: 'right', fontWeight: 800, color: f.goal != null && f.won + f.committed >= f.goal ? 'var(--green)' : 'var(--yellow)' }}>
                  {f.gap_to_goal != null ? fmtBase(f.gap_to_goal) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {drill && (
        <div className="card" style={{ marginTop: 14, padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--bord)', display: 'flex', alignItems: 'center' }}>
            <div className="t-h3" style={{ flex: 1, fontSize: 13 }}>Deals closing in {drill.period}</div>
            <Btn kind="ghost" size="sm" icon={<Icon.x size={12} />} onClick={() => setDrill(null)} />
          </div>
          {drill.deals.length === 0 ? (
            <div className="t-mute" style={{ padding: 18, fontSize: 12.5 }}>No open deals with a close date in this month.</div>
          ) : drill.deals.map((d) => (
            <Link key={d.id} href={`/crm/deals/${d.id}`} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '11px 18px', borderBottom: '1px solid var(--bord)', textDecoration: 'none', color: 'inherit' }}>
              <OwnerAv name={d.owner_name ?? '—'} size={22} />
              <span style={{ flex: 1, fontSize: 12.5, fontWeight: 800 }}>{d.title}</span>
              <span className="t-caption">{d.probability}%</span>
              <span className="t-num" style={{ fontSize: 12, fontWeight: 800 }}>{fmtBase(d.value)}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

function Goals() {
  const { data, isLoading } = useGoals()
  const reps = useReps()
  const setGoal = useSetGoal()
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7))
  const [userId, setUserId] = useState('')
  const [target, setTarget] = useState('')
  const rows = data?.data ?? []

  const submit = async () => {
    try {
      await setGoal.mutateAsync({ period, user_id: userId || null, target_base: parseFloat(target) })
      toast({ title: 'Goal saved' })
      setOpen(false); setTarget('')
    } catch (err) {
      toast({ title: 'Could not save goal', description: err instanceof Error ? err.message : undefined, variant: 'destructive' })
    }
  }

  return (
    <div style={{ maxWidth: 720 }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <Btn kind="primary" size="sm" icon={<Icon.plus size={13} />} onClick={() => setOpen(true)}>Set goal</Btn>
      </div>
      {isLoading ? (
        <div style={{ padding: 40, display: 'flex', justifyContent: 'center' }}><Icon.refresh size={18} className="animate-spin" style={{ color: 'var(--text-mute)' }} /></div>
      ) : rows.length === 0 ? (
        <EmptyState icon={<Icon.target size={22} />} line="Monthly won-revenue targets show on the forecast (team) and the leaderboard (per rep)." cta="Set goal" onCta={() => setOpen(true)} />
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <table className="tbl">
            <thead><tr><th>Month</th><th>Who</th><th style={{ textAlign: 'right' }}>Target</th><th></th></tr></thead>
            <tbody>
              {rows.map((g) => (
                <tr key={g.id}>
                  <td style={{ fontWeight: 800 }}>{g.period}</td>
                  <td>{g.user_id ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><OwnerAv name={g.user_name ?? '?'} size={20} />{g.user_name}</span> : <Pill tone="blue">Whole team</Pill>}</td>
                  <td className="t-num" style={{ textAlign: 'right', fontWeight: 800 }}>{fmtBase(g.target_base)}</td>
                  <td style={{ textAlign: 'right' }}>
                    <Btn kind="ghost" size="sm" icon={<Icon.trash size={12} />} disabled={setGoal.isPending}
                      onClick={() => setGoal.mutate({ period: g.period, user_id: g.user_id, target_base: 0 }, { onSuccess: () => toast({ title: 'Goal removed' }) })} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="t-caption" style={{ marginTop: 10 }}>Team goals draw the dashed line on the forecast; per-rep goals fill the leaderboard progress bars.</div>

      {open && (
        <Modal open onClose={() => setOpen(false)} width={440} title="Set a goal" sub="Monthly won-revenue target in base currency (§19.6)"
          footer={<>
            <Btn kind="ghost" onClick={() => setOpen(false)}>Cancel</Btn>
            <Btn kind="primary" icon={<Icon.check size={14} />} disabled={!target || !(parseFloat(target) > 0) || setGoal.isPending} onClick={() => void submit()}>
              {setGoal.isPending ? 'Saving…' : 'Save goal'}
            </Btn>
          </>}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div><div className="label">Month</div><input className="input" type="month" value={period} onChange={(e) => setPeriod(e.target.value)} style={{ width: '100%', height: 38 }} /></div>
            <div>
              <div className="label">Who</div>
              <select className="input" value={userId} onChange={(e) => setUserId(e.target.value)} style={{ width: '100%', height: 38 }}>
                <option value="">Whole team</option>
                {(reps.data?.data ?? []).map((r) => <option key={r.user_id} value={r.user_id}>{r.name}</option>)}
              </select>
            </div>
            <div style={{ gridColumn: '1/-1' }}>
              <div className="label">Target (base currency)</div>
              <input autoFocus className="input t-num" placeholder="500000" value={target} onChange={(e) => setTarget(e.target.value.replace(/[^\d.]/g, ''))} style={{ width: '100%', height: 38 }} />
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
