'use client'

import { useMemo, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Btn, Icon, Pill, SectionHead } from '@/components/proto'
import { api } from '@/lib/api/client'
import { usePm } from '@/lib/pm/PmProvider'
import type { PmSyncEngine } from '@/lib/pm/engine'
import type { PmIssueRow, PmStateRow } from '@/lib/pm/types'

// ─────────────────────────────────────────────────────────
// FSE SPIKE PAGE (Sprint 32, §3.9). Deliberately bare: proves the engine —
// optimistic <50ms, cross-client <1s, offline queue, kill-switch REST
// fallback. The real P2 issue list replaces this in Sprint 33.
// ─────────────────────────────────────────────────────────

const CAT_ORDER = ['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled']
const CAT_COLOR: Record<string, string> = {
  triage: '#9B7BFA', backlog: '#5C6477', unstarted: '#A8B0C2',
  started: '#FED800', completed: '#27D280', canceled: '#5C6477',
}

export default function PmIssuesPage() {
  const { mode, engine } = usePm()
  if (mode === 'loading') {
    return (
      <div style={{ padding: 60, display: 'flex', justifyContent: 'center' }}>
        <Icon.refresh size={20} className="animate-spin" style={{ color: 'var(--text-mute)' }} />
      </div>
    )
  }
  if (mode === 'rest' || !engine) return <RestIssues />
  return <SyncIssues engine={engine} />
}

// ─── SYNC MODE (local-first graph) ───────────────────────────────────────────

const SyncIssues = observer(function SyncIssues({ engine }: { engine: PmSyncEngine }) {
  const store = engine.store
  const [title, setTitle] = useState('')
  const [lastMs, setLastMs] = useState<number | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const team = store.teamList()[0]
  const states = team ? store.statesForTeam(team.id) : []
  const issues = team ? store.issuesForTeam(team.id) : []
  const byState = useMemo(() => {
    const m = new Map<string, PmIssueRow[]>()
    for (const i of issues) {
      const list = m.get(i.state_id) ?? []
      list.push(i)
      m.set(i.state_id, list)
    }
    return m
  }, [issues])

  if (!store.hydrated) {
    return <div className="t-mute" style={{ padding: 60, textAlign: 'center', fontSize: 12.5 }}>Hydrating local store…</div>
  }
  if (!team) {
    return <div className="t-mute" style={{ padding: 60, textAlign: 'center', fontSize: 12.5 }}>No team yet — the workspace seeds on first API call.</div>
  }

  const create = () => {
    if (!title.trim()) return
    const t0 = performance.now()
    engine.createIssue({ team_id: team.id, title: title.trim() })
    const ms = performance.now() - t0
    setLastMs(ms)
    setTitle('')
    inputRef.current?.focus()
  }

  const cycleState = (issue: PmIssueRow) => {
    const idx = states.findIndex((s) => s.id === issue.state_id)
    const next = states[(idx + 1) % states.length]
    if (next) engine.moveIssueState(issue.id, next.id)
  }

  return (
    <div style={{ padding: '28px 32px 64px', maxWidth: 860, margin: '0 auto' }}>
      <SectionHead
        title={`${team.key} · Issues (sync engine)`}
        sub={`Local-first spike — cursor ${store.cursor} · ${store.pendingCount} pending · ${store.online ? 'online' : 'OFFLINE (queueing)'}`}
        right={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {lastMs !== null && (
              <Pill tone={lastMs < 50 ? 'green' : 'coral'}>optimistic {lastMs.toFixed(1)}ms</Pill>
            )}
            <Pill tone="blue" dot>sync</Pill>
          </div>
        }
      />

      <div style={{ display: 'flex', gap: 9, marginBottom: 16 }}>
        <input
          ref={inputRef}
          autoFocus
          className="input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') create() }}
          placeholder="Issue title — Enter creates instantly, syncs behind"
          style={{ flex: 1, height: 38 }}
        />
        <Btn kind="primary" size="sm" icon={<Icon.plus size={14} />} onClick={create} disabled={!title.trim()}>
          Create
        </Btn>
      </div>

      {states
        .slice()
        .sort((a, b) => CAT_ORDER.indexOf(a.category) - CAT_ORDER.indexOf(b.category) || a.position - b.position)
        .map((state) => {
          const rows = (byState.get(state.id) ?? []).sort((a, b) => (a.board_rank < b.board_rank ? -1 : 1))
          if (!rows.length) return null
          return <StateGroup key={state.id} state={state} rows={rows} teamKey={team.key} onCycle={cycleState} onPriority={(i, p) => engine.setIssuePriority(i.id, p)} />
        })}
      {issues.length === 0 && (
        <div className="t-mute" style={{ padding: 40, textAlign: 'center', fontSize: 12.5 }}>
          No issues — create the first one above.
        </div>
      )}
    </div>
  )
})

const StateGroup = observer(function StateGroup({ state, rows, teamKey, onCycle, onPriority }: {
  state: PmStateRow
  rows: PmIssueRow[]
  teamKey: string
  onCycle: (i: PmIssueRow) => void
  onPriority: (i: PmIssueRow, p: number) => void
}) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ width: 9, height: 9, borderRadius: '50%', background: CAT_COLOR[state.category] }} />
        <span className="t-caption">{state.name}</span>
        <Pill>{rows.length}</Pill>
      </div>
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {rows.map((i, idx) => (
          <div key={i.id} style={{ display: 'flex', alignItems: 'center', gap: 10, height: 36, padding: '0 14px', borderBottom: idx < rows.length - 1 ? '1px solid var(--bord)' : 'none' }}>
            <span style={{ fontSize: 10.5, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--text-mute)', width: 64, flexShrink: 0 }}>
              {i.number ? `${teamKey}-${i.number}` : `${teamKey}-…`}
            </span>
            <span style={{ flex: 1, fontSize: 12.5, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'flex', alignItems: 'center', gap: 7 }}>
              {i.title}
              {i._pending && <span title="Syncing — not yet confirmed" style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--blue)', display: 'inline-block', flexShrink: 0 }} />}
            </span>
            <span style={{ display: 'flex', gap: 3 }}>
              {[0, 1, 2, 3, 4].map((p) => (
                <button key={p} onClick={() => onPriority(i, p)} title={`Priority ${p}`}
                  style={{ width: 18, height: 18, borderRadius: 4, border: '1px solid var(--bord)', background: i.priority === p ? 'var(--surf-3)' : 'transparent', color: i.priority === p ? '#fff' : 'var(--text-faint)', fontSize: 9.5, fontWeight: 800, cursor: 'pointer' }}>
                  {p}
                </button>
              ))}
            </span>
            <Btn kind="ghost" size="sm" onClick={() => onCycle(i)}>Next state</Btn>
          </div>
        ))}
      </div>
    </div>
  )
})

// ─── REST MODE (kill-switch fallback — react-query, house style) ─────────────

interface RestIssue extends PmIssueRow { }

function RestIssues() {
  const qc = useQueryClient()
  const teams = useQuery({
    queryKey: ['pm', 'teams'],
    queryFn: () => api.get<{ data: { teams: Array<{ id: string; key: string; name: string }>; states: PmStateRow[] } }>('/api/v1/pm/teams'),
  })
  const team = teams.data?.data.teams[0]
  const states = teams.data?.data.states.filter((s) => s.team_id === team?.id) ?? []
  const issues = useQuery({
    queryKey: ['pm', 'issues', team?.id ?? ''],
    queryFn: () => api.get<{ data: RestIssue[] }>(`/api/v1/pm/issues?team_id=${team!.id}`),
    enabled: !!team,
  })
  const create = useMutation({
    mutationFn: (title: string) => api.post('/api/v1/pm/issues', { team_id: team!.id, title }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pm', 'issues'] }),
  })
  const move = useMutation({
    mutationFn: ({ id, state_id }: { id: string; state_id: string }) =>
      api.post(`/api/v1/pm/issues/${id}/move-state`, { state_id }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pm', 'issues'] }),
  })
  const [title, setTitle] = useState('')

  return (
    <div style={{ padding: '28px 32px 64px', maxWidth: 860, margin: '0 auto' }}>
      <SectionHead
        title={`${team?.key ?? 'PM'} · Issues (REST fallback)`}
        sub="Kill-switch mode — plain react-query against conventional endpoints"
        right={<Pill tone="yellow" dot>rest</Pill>}
      />
      <div style={{ display: 'flex', gap: 9, marginBottom: 16 }}>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && title.trim() && team) { create.mutate(title.trim()); setTitle('') } }}
          placeholder="Issue title" style={{ flex: 1, height: 38 }} />
        <Btn kind="primary" size="sm" disabled={!title.trim() || !team || create.isPending}
          onClick={() => { create.mutate(title.trim()); setTitle('') }}>
          {create.isPending ? 'Creating…' : 'Create'}
        </Btn>
      </div>
      {issues.isLoading ? (
        <div style={{ padding: 40, display: 'flex', justifyContent: 'center' }}><Icon.refresh size={18} className="animate-spin" style={{ color: 'var(--text-mute)' }} /></div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {(issues.data?.data ?? []).map((i, idx, arr) => {
            const st = states.find((s) => s.id === i.state_id)
            const next = states[(states.findIndex((s) => s.id === i.state_id) + 1) % Math.max(states.length, 1)]
            return (
              <div key={i.id} style={{ display: 'flex', alignItems: 'center', gap: 10, height: 36, padding: '0 14px', borderBottom: idx < arr.length - 1 ? '1px solid var(--bord)' : 'none' }}>
                <span style={{ fontSize: 10.5, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--text-mute)', width: 64 }}>{team?.key}-{i.number}</span>
                <span style={{ flex: 1, fontSize: 12.5, fontWeight: 700 }}>{i.title}</span>
                <Pill>{st?.name ?? '—'}</Pill>
                {next && <Btn kind="ghost" size="sm" disabled={move.isPending} onClick={() => move.mutate({ id: i.id, state_id: next.id })}>Next state</Btn>}
              </div>
            )
          })}
          {(issues.data?.data ?? []).length === 0 && (
            <div className="t-mute" style={{ padding: 30, textAlign: 'center', fontSize: 12.5 }}>No issues yet.</div>
          )}
        </div>
      )}
    </div>
  )
}
