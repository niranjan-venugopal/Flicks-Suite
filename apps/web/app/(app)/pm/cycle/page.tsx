'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { observer } from 'mobx-react-lite'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Btn, Icon, Pill, SectionHead } from '@/components/proto'
import { Kbd, PendingDot, PriorityGlyph, StateGlyph } from '@/components/pm/glyphs'
import { api } from '@/lib/api/client'
import { usePm } from '@/lib/pm/PmProvider'
import type { PmSyncEngine } from '@/lib/pm/engine'

// ─────────────────────────────────────────────────────────
// P13 — Cycle page: header strip (progress · velocity · creep), cooldown
// banner, daily-snapshot burn columns, previous cycles, cycle-scoped issues.
// Stats come from REST (snapshot substrate); the issue list is the live graph.
// ─────────────────────────────────────────────────────────

interface CycleStatsResponse {
  data: {
    cycles: Array<{ id: string; number: number; status: string; starts_at: string; ends_at: string; cooldown_ends_at: string }>
    active: { id: string; number: number; starts_at: string; ends_at: string; cooldown_ends_at: string } | null
    snapshots: Array<{ snapshot_date: string; scope_points: string; started_points: string; completed_points: string }>
    stats: { velocity: number | null; completion_rate: number | null; creep: number; previous: Array<{ number: number; completed: number; scope: number }> }
  }
}

export default function PmCyclePage() {
  const { mode, engine } = usePm()
  if (mode === 'loading') {
    return (
      <div style={{ padding: 60, display: 'flex', justifyContent: 'center' }}>
        <Icon.refresh size={20} className="animate-spin" style={{ color: 'var(--text-mute)' }} />
      </div>
    )
  }
  if (mode === 'rest' || !engine) {
    return (
      <div className="t-mute" style={{ padding: 60, textAlign: 'center', fontSize: 12.5 }}>
        The cycle page needs the sync engine — the REST fallback lists everything under Issues.
      </div>
    )
  }
  return <CycleBody engine={engine} />
}

const CycleBody = observer(function CycleBody({ engine }: { engine: PmSyncEngine }) {
  const store = engine.store
  const router = useRouter()
  const qc = useQueryClient()
  const teams = store.teamList()
  const [teamId, setTeamId] = useState(() => teams.find((t) => t.cycles_enabled)?.id ?? teams[0]?.id ?? '')
  const team = store.teams.get(teamId)

  const statsQ = useQuery({
    queryKey: ['pm', 'cycles', teamId],
    queryFn: () => api.get<CycleStatsResponse>(`/api/v1/pm/teams/${teamId}/cycles`),
    enabled: Boolean(teamId && team?.cycles_enabled),
    refetchInterval: 60_000,
  })
  const enableCycles = useMutation({
    mutationFn: () => api.patch(`/api/v1/pm/teams/${teamId}`, { cycles_enabled: true }),
    onSuccess: () => setTimeout(() => qc.invalidateQueries({ queryKey: ['pm', 'cycles', teamId] }), 800),
  })

  const d = statsQ.data?.data
  const activeLocal = store.activeCycleForTeam(teamId)
  const active = activeLocal ?? d?.active ?? null
  const now = Date.now()

  // Progress from the live graph (estimate points, fallback 1).
  const cycleIssues = useMemo(() => {
    if (!active) return []
    return [...store.issues.values()]
      .filter((i) => i.cycle_id === active.id && !i.deleted_at)
      .sort((a, b) => a.priority - b.priority || a.number - b.number)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, store.issues.size, store.cursor])
  const progress = useMemo(() => {
    let scope = 0
    let done = 0
    for (const i of cycleIssues) {
      const cat = store.states.get(i.state_id)?.category
      if (cat === 'canceled') continue
      const w = i.estimate != null ? Number(i.estimate) : 1
      scope += w
      if (cat === 'completed') done += w
    }
    return { scope, done, pct: scope ? Math.round((done / scope) * 100) : 0 }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cycleIssues])

  // Cooldown: last completed cycle whose cooldown window contains now, with no active cycle.
  const cooldown = useMemo(() => {
    if (active) return null
    const cycles = [...store.cycles.values()].filter((c) => c.team_id === teamId)
    const inCooldown = cycles.find((c) => c.status === 'completed' && new Date(c.ends_at).getTime() <= now && new Date(c.cooldown_ends_at).getTime() > now)
    if (!inCooldown) return null
    const next = cycles.find((c) => c.number === inCooldown.number + 1)
    return { until: inCooldown.cooldown_ends_at, nextStarts: next?.starts_at ?? inCooldown.cooldown_ends_at }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, teamId, store.cycles.size, now])

  if (!team) return null

  if (!team.cycles_enabled) {
    return (
      <div style={{ padding: '22px 26px', maxWidth: 960, margin: '0 auto' }}>
        <SectionHead title="Cycle" sub="Cycles create momentum — enable them and Autopilot handles the rest." right={<Pill tone="blue" dot>sync</Pill>} />
        <TeamPicker teams={teams} teamId={teamId} setTeamId={setTeamId} />
        <div className="card" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '56px 24px', gap: 12, marginTop: 12 }}>
          <div style={{ width: 46, height: 46, borderRadius: 12, background: 'var(--surf-2)', border: '1px solid var(--bord)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-mute)' }}>
            <Icon.refresh size={20} />
          </div>
          <div className="t-mute" style={{ fontSize: 12.5, textAlign: 'center', maxWidth: 420, lineHeight: 1.6 }}>
            Cycles create momentum — a {team.cycle_length_weeks ?? 2}-week rhythm with Autopilot rollover: urgent and high roll forward, the rest returns honestly to the backlog.
          </div>
          <Btn kind="primary" size="sm" onClick={() => enableCycles.mutate()} disabled={enableCycles.isPending}>
            Enable cycles for {team.key}
          </Btn>
          <div style={{ fontSize: 9.5, fontWeight: 700, color: 'var(--text-faint)' }}>The scheduler creates the first cycle at the next {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][team.cycle_start_dow ?? 1]} midnight ({team.timezone ?? 'tenant tz'}).</div>
        </div>
      </div>
    )
  }

  const snapshots = d?.snapshots ?? []
  const maxPts = Math.max(1, ...snapshots.map((s) => Number(s.scope_points)))
  const endsInDays = active ? Math.max(0, Math.ceil((new Date(active.ends_at).getTime() - now) / 86_400_000)) : null

  return (
    <div style={{ padding: '22px 26px 64px', maxWidth: 980, margin: '0 auto' }}>
      <SectionHead title="Cycle" sub="Momentum with honest edges — Autopilot rolls urgent/high, returns the rest." right={<Pill tone="blue" dot>sync</Pill>} />
      <TeamPicker teams={teams} teamId={teamId} setTeamId={setTeamId} />

      {/* Header strip */}
      <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 16px', margin: '12px 0', flexWrap: 'wrap' }}>
        <Icon.refresh size={15} style={{ color: 'var(--blue)' }} />
        <span style={{ fontSize: 13.5, fontWeight: 800 }}>{active ? `Cycle ${active.number}` : 'No active cycle'}</span>
        {active && (
          <>
            <span style={{ width: 120 }}>
              <div style={{ height: 6, borderRadius: 99, background: 'var(--surf-2)', overflow: 'hidden' }}>
                <div style={{ width: `${progress.pct}%`, height: '100%', background: 'var(--blue)' }} />
              </div>
            </span>
            <span style={{ fontSize: 11.5, fontWeight: 800, fontFamily: 'var(--font-mono)' }}>{progress.pct}%</span>
            <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-mute)' }}>ends in {endsInDays}d</span>
          </>
        )}
        {d?.stats.velocity != null && (
          <span title="3-cycle rolling completed points" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 9px', borderRadius: 99, background: 'rgba(39,210,128,.1)', border: '1px solid rgba(39,210,128,.35)', fontSize: 10, fontWeight: 800, color: 'var(--green)' }}>
            velocity {d.stats.velocity}
          </span>
        )}
        {d && d.stats.creep > 0 && (
          <span title="Scope added after start" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 9px', borderRadius: 99, background: 'rgba(254,216,0,.09)', border: '1px solid rgba(254,216,0,.35)', fontSize: 10, fontWeight: 800, color: 'var(--yellow)' }}>
            creep +{d.stats.creep}%
          </span>
        )}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-faint)' }}>
          {team.timezone ?? 'tenant tz'} boundaries · cooldown {team.cooldown_days ?? 0}d after
        </span>
      </div>

      {/* Cooldown banner (§7.2) */}
      {cooldown && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 13px', borderRadius: 9, marginBottom: 12, background: 'rgba(155,123,250,.08)', border: '1px dashed rgba(155,123,250,.35)' }}>
          <Icon.clock size={13} style={{ color: 'var(--purple)' }} />
          <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-2)' }}>
            <b>Cooldown · next cycle starts {new Date(cooldown.nextStarts).toLocaleDateString(undefined, { weekday: 'short' })}</b>. No new cycle activates during cooldown.
          </span>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 260px', gap: 14, alignItems: 'start', marginBottom: 14 }}>
        {/* Burn columns from snapshots */}
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <span style={{ fontSize: 11.5, fontWeight: 800, flex: 1 }}>Scope · started · completed — daily snapshots</span>
            {[['var(--text-faint)', 'scope'], ['rgba(254,216,0,.8)', 'started'], ['var(--green)', 'completed']].map(([col, l]) => (
              <span key={l} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 9, fontWeight: 700, color: 'var(--text-faint)' }}>
                <span style={{ width: 7, height: 7, borderRadius: 2, background: col }} />{l}
              </span>
            ))}
          </div>
          {snapshots.length === 0 ? (
            <div className="t-mute" style={{ padding: '28px 0', textAlign: 'center', fontSize: 11.5 }}>
              Snapshots appear after the first daily sweep of an active cycle.
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 120 }}>
                {snapshots.map((s) => {
                  const scope = Number(s.scope_points)
                  const started = Number(s.started_points)
                  const done = Number(s.completed_points)
                  return (
                    <div key={s.snapshot_date} title={`${s.snapshot_date} — scope ${scope} · started ${started} · done ${done}`}
                      style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: 1, height: '100%' }}>
                      <div style={{ height: `${((scope - started - done) / maxPts) * 100}%`, background: 'rgba(255,255,255,.07)', borderRadius: '3px 3px 0 0' }} />
                      <div style={{ height: `${(started / maxPts) * 100}%`, background: 'rgba(254,216,0,.5)' }} />
                      <div style={{ height: `${(done / maxPts) * 100}%`, background: 'var(--green)', borderRadius: '0 0 2px 2px' }} />
                    </div>
                  )
                })}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 5 }}>
                <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-faint)' }}>{snapshots[0]?.snapshot_date}</span>
                <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-faint)' }}>today · {snapshots[snapshots.length - 1]?.snapshot_date}</span>
              </div>
            </>
          )}
        </div>

        {/* Previous cycles */}
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '10px 13px', borderBottom: '1px solid var(--bord)' }}><span style={{ fontSize: 11.5, fontWeight: 800 }}>Previous cycles</span></div>
          {(d?.stats.previous ?? []).length === 0 && (
            <div className="t-mute" style={{ padding: '16px 13px', fontSize: 11 }}>No completed cycles yet.</div>
          )}
          {(d?.stats.previous ?? []).map((pc) => {
            const denom = Math.max(1, ...(d?.stats.previous ?? []).map((x) => x.completed))
            return (
              <div key={pc.number} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 13px', borderBottom: '1px solid var(--bord)' }}>
                <span style={{ fontSize: 11, fontWeight: 800, fontFamily: 'var(--font-mono)', width: 32 }}>C{pc.number}</span>
                <span style={{ flex: 1 }}>
                  <div style={{ height: 5, borderRadius: 99, background: 'var(--surf-2)', overflow: 'hidden' }}>
                    <div style={{ width: `${(pc.completed / denom) * 100}%`, height: '100%', background: 'var(--green)', opacity: 0.8 }} />
                  </div>
                </span>
                <span style={{ fontSize: 10.5, fontWeight: 800, fontFamily: 'var(--font-mono)', color: 'var(--green)' }}>{pc.completed}</span>
              </div>
            )
          })}
          {d?.stats.completion_rate != null && (
            <div style={{ padding: '9px 13px', fontSize: 9.5, fontWeight: 700, color: 'var(--text-faint)' }}>
              completion {d.stats.completion_rate}% avg · full Insights = v1.5 on the same snapshots
            </div>
          )}
        </div>
      </div>

      {/* Cycle-scoped issues */}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--bord)' }}>
          <span style={{ fontSize: 11.5, fontWeight: 800 }}>In this cycle · {cycleIssues.length}</span>
        </div>
        {cycleIssues.length === 0 && <div className="t-mute" style={{ padding: '16px 14px', fontSize: 11.5 }}>Nothing in the cycle yet — move an issue to In Progress (auto-add) or set its cycle.</div>}
        {cycleIssues.map((i) => {
          const st = store.states.get(i.state_id)
          return (
            <div key={i.id} onClick={() => router.push(`/pm/issues/${i.id}`)}
              style={{ display: 'flex', alignItems: 'center', gap: 9, height: 34, padding: '0 12px', borderBottom: '1px solid var(--bord)', cursor: 'pointer' }}>
              {st && <StateGlyph cat={st.category} size={13} />}
              <span style={{ fontSize: 10.5, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--text-mute)', width: 58, flexShrink: 0 }}>
                {team.key}-{i.number}
              </span>
              <PriorityGlyph p={i.priority} size={13} />
              <span style={{ flex: 1, fontSize: 12.5, fontWeight: 700, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'flex', alignItems: 'center', gap: 7 }}>
                {i.title}{i._pending && <PendingDot />}
              </span>
              {i.estimate != null && (
                <span style={{ fontSize: 10, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--text-faint)' }}>{Number(i.estimate)} pts</span>
              )}
            </div>
          )
        })}
      </div>
      <div style={{ display: 'flex', gap: 14, marginTop: 10 }}>
        {[['G then T', 'triage'], ['G then B', 'issues'], ['⌘K', 'palette']].map(([k, l]) => (
          <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5, fontWeight: 700, color: 'var(--text-faint)' }}>
            <Kbd>{k}</Kbd>{l}
          </span>
        ))}
      </div>
    </div>
  )
})

function TeamPicker({ teams, teamId, setTeamId }: { teams: Array<{ id: string; key: string; name: string }>; teamId: string; setTeamId: (id: string) => void }) {
  if (teams.length <= 1) return null
  return (
    <div style={{ display: 'flex', gap: 3, padding: 3, background: 'var(--surf-1)', border: '1px solid var(--bord)', borderRadius: 8, width: 'fit-content' }}>
      {teams.map((t) => (
        <button key={t.id} onClick={() => setTeamId(t.id)}
          style={{ padding: '5px 11px', borderRadius: 5, border: 'none', cursor: 'pointer', background: teamId === t.id ? 'var(--surf-3)' : 'transparent', color: teamId === t.id ? '#fff' : 'var(--text-2)', fontSize: 10.5, fontWeight: 800 }}>
          {t.key}
        </button>
      ))}
    </div>
  )
}
