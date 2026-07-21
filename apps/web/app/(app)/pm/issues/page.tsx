'use client'

import { useMemo, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Btn, Icon, Pill, SectionHead, Toggle, avBg, initials } from '@/components/proto'
import { Kbd, PendingDot, PriorityGlyph, StateGlyph, PM_PRIORITY_LABEL } from '@/components/pm/glyphs'
import { api } from '@/lib/api/client'
import { usePm } from '@/lib/pm/PmProvider'
import { useHotkeys } from '@/lib/pm/hotkeys'
import type { PmSyncEngine } from '@/lib/pm/engine'
import type { PmIssueRow, PmStateRow } from '@/lib/pm/types'

// ─────────────────────────────────────────────────────────
// P2 Issue list (scr-list.jsx) — 34px rows · state groups · keyboard-first
// (C create · J/K move · 0–4 priority · S state · A assign · I me · ⌘Z undo)
// + P4 quick-create composer with "create more". Runs on the FSE graph; the
// same page falls back to REST when the kill-switch is off.
// ─────────────────────────────────────────────────────────

const CAT_ORDER = ['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled']

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
  return <SyncIssueList engine={engine} />
}

// ─── SYNC MODE — the real list ───────────────────────────────────────────────

const SyncIssueList = observer(function SyncIssueList({ engine }: { engine: PmSyncEngine }) {
  const store = engine.store
  const [composerOpen, setComposerOpen] = useState(false)
  const [focusIdx, setFocusIdx] = useState(-1)
  const [menu, setMenu] = useState<{ kind: 'state' | 'assignee'; issueId: string } | null>(null)

  const team = store.teamList()[0]
  const states = team ? store.statesForTeam(team.id) : []
  const issues = team ? store.issuesForTeam(team.id) : []

  const groups = useMemo(() => {
    const sorted = states
      .slice()
      .sort((a, b) => CAT_ORDER.indexOf(a.category) - CAT_ORDER.indexOf(b.category) || a.position - b.position)
    return sorted
      .map((state) => ({
        state,
        rows: issues
          .filter((i) => i.state_id === state.id)
          .sort((a, b) => (a.board_rank < b.board_rank ? -1 : 1)),
      }))
      .filter((g) => g.rows.length > 0)
  }, [states, issues])

  const flat = useMemo(() => groups.flatMap((g) => g.rows), [groups])
  const focused = focusIdx >= 0 && focusIdx < flat.length ? flat[focusIdx] : null

  useHotkeys({
    c: (e) => { e.preventDefault(); setComposerOpen(true) },
    j: () => setFocusIdx((i) => Math.min(flat.length - 1, i + 1)),
    k: () => setFocusIdx((i) => Math.max(0, i - 1)),
    arrowdown: () => setFocusIdx((i) => Math.min(flat.length - 1, i + 1)),
    arrowup: () => setFocusIdx((i) => Math.max(0, i - 1)),
    escape: () => { setMenu(null); setComposerOpen(false); setFocusIdx(-1) },
    'mod+z': (e) => { e.preventDefault(); engine.undo() },
    'mod+shift+z': (e) => { e.preventDefault(); engine.redo() },
    ...Object.fromEntries(
      [0, 1, 2, 3, 4].map((p) => [String(p), () => { if (focused) engine.setIssuePriority(focused.id, p) }]),
    ),
    s: () => { if (focused) setMenu({ kind: 'state', issueId: focused.id }) },
    a: () => { if (focused) setMenu({ kind: 'assignee', issueId: focused.id }) },
    i: () => { if (focused) engine.assignIssue(focused.id, engineUserId(engine)) },
  })

  if (!store.hydrated) {
    return <div className="t-mute" style={{ padding: 60, textAlign: 'center', fontSize: 12.5 }}>Hydrating local store…</div>
  }
  if (!team) {
    return <div className="t-mute" style={{ padding: 60, textAlign: 'center', fontSize: 12.5 }}>Workspace seeding…</div>
  }

  return (
    <div style={{ padding: '22px 26px 64px', maxWidth: 1060, margin: '0 auto' }}>
      <SectionHead
        title={`${team.key} · Active`}
        sub={`${issues.length} issues · cursor ${store.cursor} · ${store.pendingCount} pending · ${store.online ? 'live' : 'OFFLINE — changes queue'}`}
        right={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Btn kind="ghost" size="sm" onClick={() => void engine.reset()} title="Wipe the local cache and re-bootstrap">
              Reset local data
            </Btn>
            <Btn kind="primary" size="sm" icon={<Icon.plus size={13} />} onClick={() => setComposerOpen(true)}>
              New issue <Kbd style={{ marginLeft: 6, background: 'rgba(255,255,255,.18)', border: 'none', color: '#fff' }}>C</Kbd>
            </Btn>
            <Pill tone={store.online ? 'blue' : 'yellow'} dot>{store.online ? 'sync' : 'offline'}</Pill>
          </div>
        }
      />

      {composerOpen && <QuickCreate engine={engine} teamId={team.id} onClose={() => setComposerOpen(false)} />}

      {groups.map(({ state, rows }) => (
        <div key={state.id} style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, padding: '0 2px' }}>
            <StateGlyph cat={state.category} size={13} />
            <span className="t-caption">{state.name}</span>
            <span style={{ fontSize: 10, fontWeight: 800, fontFamily: 'var(--font-mono)', color: 'var(--text-faint)' }}>{rows.length}</span>
          </div>
          <div className="card" style={{ padding: 0, overflow: 'visible' }}>
            {rows.map((issue, i) => (
              <IssueRow
                key={issue.id}
                issue={issue}
                state={state}
                teamKey={team.key}
                engine={engine}
                last={i === rows.length - 1}
                focused={focused?.id === issue.id}
                onFocus={() => setFocusIdx(flat.findIndex((f) => f.id === issue.id))}
                menu={menu?.issueId === issue.id ? menu.kind : null}
                openMenu={(kind) => setMenu({ kind, issueId: issue.id })}
                closeMenu={() => setMenu(null)}
                states={states}
              />
            ))}
          </div>
        </div>
      ))}

      {issues.length === 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '52px 24px', gap: 13 }}>
          <div style={{ width: 46, height: 46, borderRadius: 12, background: 'var(--surf-2)', border: '1px solid var(--bord)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-mute)' }}>
            <Icon.check size={20} />
          </div>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-2)', maxWidth: 380, lineHeight: 1.5, textAlign: 'center' }}>
            Write issues, not user stories — describe the task and press Enter.
          </div>
          <Btn kind="primary" size="sm" onClick={() => setComposerOpen(true)}>
            Create the first issue <Kbd style={{ marginLeft: 7, background: 'rgba(255,255,255,.18)', border: 'none', color: '#fff' }}>C</Kbd>
          </Btn>
        </div>
      )}

      <div style={{ display: 'flex', gap: 14, marginTop: 10, flexWrap: 'wrap' }}>
        {[['C', 'create'], ['J/K', 'move'], ['0–4', 'priority'], ['S', 'status'], ['A', 'assignee'], ['I', 'assign me'], ['⌘Z', 'undo'], ['Esc', 'clear']].map(([k, l]) => (
          <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5, fontWeight: 700, color: 'var(--text-faint)' }}>
            <Kbd>{k}</Kbd>{l}
          </span>
        ))}
      </div>
    </div>
  )
})

function engineUserId(engine: PmSyncEngine): string {
  return (engine as unknown as { userId: string }).userId
}

/** 18px initials avatar for dense rows (prototype PmAv). */
function MiniAv({ name, size = 18 }: { name: string; size?: number }) {
  return (
    <span style={{ width: size, height: size, borderRadius: '50%', background: avBg(name), display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 800, fontSize: Math.max(7, size * 0.36), letterSpacing: '-0.02em', flexShrink: 0 }}>
      {initials(name)}
    </span>
  )
}

// ─── Row (34px, scr-list.jsx density) ────────────────────────────────────────

const IssueRow = observer(function IssueRow({ issue, state, teamKey, engine, last, focused, onFocus, menu, openMenu, closeMenu, states }: {
  issue: PmIssueRow
  state: PmStateRow
  teamKey: string
  engine: PmSyncEngine
  last: boolean
  focused: boolean
  onFocus: () => void
  menu: 'state' | 'assignee' | null
  openMenu: (kind: 'state' | 'assignee') => void
  closeMenu: () => void
  states: PmStateRow[]
}) {
  const store = engine.store
  const assignee = issue.assignee_user_id ? store.users.get(issue.assignee_user_id) : null
  const overdue = issue.due_date ? new Date(issue.due_date) < new Date() && state.category !== 'completed' : false

  return (
    <div
      onClick={onFocus}
      style={{
        display: 'flex', alignItems: 'center', gap: 9, height: 34, padding: '0 12px',
        cursor: 'pointer', position: 'relative',
        borderBottom: last ? 'none' : '1px solid var(--bord)',
        outline: focused ? '2px solid var(--blue)' : 'none', outlineOffset: -2,
        background: focused ? 'rgba(62,123,250,.06)' : 'transparent',
        transition: 'background .12s ease-out',
      }}
    >
      <button onClick={(e) => { e.stopPropagation(); onFocus(); openMenu('state') }} title={state.name}
        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', display: 'flex' }}>
        <StateGlyph cat={state.category} size={13} />
      </button>
      <span style={{ fontSize: 10.5, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--text-mute)', width: 58, flexShrink: 0 }}>
        {issue.number ? `${teamKey}-${issue.number}` : `${teamKey}-…`}
      </span>
      <span title={PM_PRIORITY_LABEL[issue.priority]} style={{ display: 'flex', flexShrink: 0 }}>
        <PriorityGlyph p={issue.priority} size={13} />
      </span>
      <span style={{ flex: 1, fontSize: 12.5, fontWeight: 700, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'flex', alignItems: 'center', gap: 7 }}>
        {issue.title}
        {issue._pending && <PendingDot />}
      </span>
      {issue.due_date && (
        <span style={{ fontSize: 10, fontWeight: 700, flexShrink: 0, color: overdue ? 'var(--coral)' : 'var(--text-faint)' }}>
          {new Date(issue.due_date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
        </span>
      )}
      <button onClick={(e) => { e.stopPropagation(); onFocus(); openMenu('assignee') }} title={assignee?.name ?? 'Unassigned'}
        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', display: 'flex' }}>
        {assignee?.name ? (
          <MiniAv name={assignee.name} size={18} />
        ) : (
          <span style={{ width: 18, height: 18, borderRadius: '50%', border: '1.5px dashed var(--bord-2)', display: 'inline-block', boxSizing: 'border-box' }} />
        )}
      </button>

      {menu === 'state' && (
        <RowMenu onClose={closeMenu}>
          {states.map((s) => (
            <button key={s.id} onClick={(e) => { e.stopPropagation(); engine.moveIssueState(issue.id, s.id); closeMenu() }}
              style={menuRowStyle(s.id === issue.state_id)}>
              <StateGlyph cat={s.category} size={12} /> {s.name}
            </button>
          ))}
        </RowMenu>
      )}
      {menu === 'assignee' && (
        <RowMenu onClose={closeMenu}>
          <button onClick={(e) => { e.stopPropagation(); engine.assignIssue(issue.id, null); closeMenu() }} style={menuRowStyle(!issue.assignee_user_id)}>
            <span style={{ width: 14, height: 14, borderRadius: '50%', border: '1.5px dashed var(--bord-2)' }} /> Unassigned
          </button>
          {[...store.users.values()].map((u) => (
            <button key={u.id} onClick={(e) => { e.stopPropagation(); engine.assignIssue(issue.id, u.id); closeMenu() }}
              style={menuRowStyle(u.id === issue.assignee_user_id)}>
              <MiniAv name={u.name ?? '?'} size={15} /> {u.name}
            </button>
          ))}
        </RowMenu>
      )}
    </div>
  )
})

function menuRowStyle(active: boolean): React.CSSProperties {
  return {
    width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
    borderRadius: 7, background: active ? 'var(--surf-2)' : 'transparent', border: 'none',
    cursor: 'pointer', color: active ? '#fff' : 'var(--text-2)', fontSize: 11.5, fontWeight: 700, textAlign: 'left',
  }
}

function RowMenu({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <>
      <div onClick={(e) => { e.stopPropagation(); onClose() }} style={{ position: 'fixed', inset: 0, zIndex: 70 }} />
      <div style={{ position: 'absolute', right: 8, top: 32, zIndex: 80, width: 210, maxHeight: 260, overflow: 'auto', background: 'rgba(18,18,30,.98)', border: '1px solid var(--bord-2)', borderRadius: 10, padding: 5, boxShadow: '0 16px 40px rgba(0,0,0,.5)' }}>
        {children}
      </div>
    </>
  )
}

// ─── P4 quick-create composer ────────────────────────────────────────────────

function QuickCreate({ engine, teamId, onClose }: { engine: PmSyncEngine; teamId: string; onClose: () => void }) {
  const [title, setTitle] = useState('')
  const [priority, setPriority] = useState(0)
  const [createMore, setCreateMore] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const submit = () => {
    if (!title.trim()) return
    engine.createIssue({ team_id: teamId, title: title.trim(), priority })
    setTitle('')
    if (!createMore) onClose()
    else inputRef.current?.focus()
  }

  return (
    <div className="card" style={{ padding: 12, marginBottom: 14, border: '1px solid var(--bord-2)' }}>
      <div style={{ display: 'flex', gap: 9, alignItems: 'center' }}>
        <input
          ref={inputRef}
          autoFocus
          className="input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && title.trim()) submit()
            if (e.key === 'Escape') onClose()
          }}
          placeholder="Issue title — describe the task, not a user story"
          style={{ flex: 1, height: 38 }}
        />
        <div style={{ display: 'flex', gap: 3 }}>
          {[0, 1, 2, 3, 4].map((p) => (
            <button key={p} onClick={() => setPriority(p)} title={PM_PRIORITY_LABEL[p]}
              style={{ width: 26, height: 26, borderRadius: 6, border: `1px solid ${priority === p ? 'var(--bord-2)' : 'var(--bord)'}`, background: priority === p ? 'var(--surf-3)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
              <PriorityGlyph p={p} size={12} />
            </button>
          ))}
        </div>
        <Btn kind="primary" size="sm" disabled={!title.trim()} onClick={submit}>Create</Btn>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 9 }}>
        <Toggle on={createMore} onChange={setCreateMore} />
        <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-2)' }}>Create more</span>
        <span style={{ flex: 1 }} />
        <span style={{ display: 'inline-flex', gap: 10 }}>
          <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-faint)', display: 'inline-flex', gap: 5, alignItems: 'center' }}><Kbd>Enter</Kbd> create</span>
          <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-faint)', display: 'inline-flex', gap: 5, alignItems: 'center' }}><Kbd>Esc</Kbd> close</span>
        </span>
      </div>
    </div>
  )
}

// ─── REST MODE (kill-switch fallback) ────────────────────────────────────────

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
    queryFn: () => api.get<{ data: PmIssueRow[] }>(`/api/v1/pm/issues?team_id=${team!.id}`),
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
    <div style={{ padding: '22px 26px 64px', maxWidth: 1060, margin: '0 auto' }}>
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
              <div key={i.id} style={{ display: 'flex', alignItems: 'center', gap: 10, height: 34, padding: '0 12px', borderBottom: idx < arr.length - 1 ? '1px solid var(--bord)' : 'none' }}>
                {st && <StateGlyph cat={st.category} size={13} />}
                <span style={{ fontSize: 10.5, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--text-mute)', width: 58 }}>{team?.key}-{i.number}</span>
                <PriorityGlyph p={i.priority} size={13} />
                <span style={{ flex: 1, fontSize: 12.5, fontWeight: 700 }}>{i.title}</span>
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
