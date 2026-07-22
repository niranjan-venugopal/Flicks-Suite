'use client'

import { useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { observer } from 'mobx-react-lite'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Btn, Icon, Pill, SectionHead, Toggle, avBg, initials } from '@/components/proto'
import { Kbd, PendingDot, PriorityGlyph, StateGlyph, PM_PRIORITY_LABEL } from '@/components/pm/glyphs'
import { PmBoard } from '@/components/pm/board'
import { api } from '@/lib/api/client'
import { usePm } from '@/lib/pm/PmProvider'
import { recentG, useHotkeys } from '@/lib/pm/hotkeys'
import type { PmSyncEngine } from '@/lib/pm/engine'
import type { PmIssueRow, PmStateRow } from '@/lib/pm/types'

// ─────────────────────────────────────────────────────────
// P2 list + P3 board + P5 filters/views + §9.4 bulk edit, on the FSE graph.
// Keys: C create · J/K move · X/⇧X select · 0–4 priority · S state ·
// A assignee · I me · ⌘Z/⌘⇧Z undo/redo · Esc clear. REST fallback below.
// ─────────────────────────────────────────────────────────

const CAT_ORDER = ['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled']

interface Filters {
  prios: number[]
  assignee: 'any' | 'me' | 'unassigned'
  showClosed: boolean
}
const DEFAULT_FILTERS: Filters = { prios: [], assignee: 'any', showClosed: false }

interface SavedViewRow {
  id: string
  name: string
  is_shared: boolean
  owner_user_id: string | null
  filters: Partial<Filters> & { group_by?: string }
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
  return <SyncIssueList engine={engine} />
}

// ─── SYNC MODE ───────────────────────────────────────────────────────────────

const SyncIssueList = observer(function SyncIssueList({ engine }: { engine: PmSyncEngine }) {
  const store = engine.store
  const qc = useQueryClient()
  const router = useRouter()
  const [viewMode, setViewMode] = useState<'list' | 'board'>('list')
  const [groupBy, setGroupBy] = useState<'state' | 'priority' | 'assignee'>('state')
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS)
  const [activeViewId, setActiveViewId] = useState<string | null>(null)
  const [composerOpen, setComposerOpen] = useState(false)
  const [focusIdx, setFocusIdx] = useState(-1)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [anchorIdx, setAnchorIdx] = useState(-1)
  const [menu, setMenu] = useState<{ kind: 'state' | 'assignee'; issueId: string } | null>(null)
  const [bulkMenu, setBulkMenu] = useState<'state' | 'assignee' | null>(null)
  const [saveOpen, setSaveOpen] = useState(false)

  const team = store.teamList()[0]
  const states = team ? store.statesForTeam(team.id) : []
  const allIssues = team ? store.issuesForTeam(team.id) : []
  const me = engineUserId(engine)

  // Saved views (server-backed; work in both transports).
  const views = useQuery({
    queryKey: ['pm', 'views'],
    queryFn: () => api.get<{ data: { views: SavedViewRow[]; favorite_ids: string[] } }>('/api/v1/pm/views?object_type=pm_issue'),
  })
  const createView = useMutation({
    mutationFn: (body: { name: string; is_shared: boolean }) =>
      api.post('/api/v1/pm/views', { object_type: 'pm_issue', name: body.name, is_shared: body.is_shared, filters: { ...filters, group_by: groupBy } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['pm', 'views'] }); setSaveOpen(false) },
  })
  const favView = useMutation({
    mutationFn: ({ id, favorite }: { id: string; favorite: boolean }) => api.post(`/api/v1/pm/views/${id}/favorite`, { favorite }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pm', 'views'] }),
  })

  // §9.1 filter application (AND across fields).
  const stateById = useMemo(() => new Map(states.map((s) => [s.id, s])), [states])
  const issues = useMemo(() => {
    return allIssues.filter((i) => {
      const cat = stateById.get(i.state_id)?.category
      if (!filters.showClosed && (cat === 'completed' || cat === 'canceled')) return false
      if (filters.prios.length && !filters.prios.includes(i.priority)) return false
      if (filters.assignee === 'me' && i.assignee_user_id !== me) return false
      if (filters.assignee === 'unassigned' && i.assignee_user_id) return false
      return true
    })
  }, [allIssues, filters, stateById, me])

  // Grouping (list mode).
  const groups = useMemo(() => {
    if (groupBy === 'state') {
      return states
        .slice()
        .sort((a, b) => CAT_ORDER.indexOf(a.category) - CAT_ORDER.indexOf(b.category) || a.position - b.position)
        .map((s) => ({
          key: s.id,
          label: s.name,
          glyph: <StateGlyph cat={s.category} size={13} />,
          rows: issues.filter((i) => i.state_id === s.id).sort((a, b) => (a.board_rank < b.board_rank ? -1 : 1)),
        }))
        .filter((g) => g.rows.length > 0)
    }
    if (groupBy === 'priority') {
      return [1, 2, 3, 4, 0].map((p) => ({
        key: `p${p}`,
        label: PM_PRIORITY_LABEL[p]!,
        glyph: <PriorityGlyph p={p} size={13} />,
        rows: issues.filter((i) => i.priority === p),
      })).filter((g) => g.rows.length > 0)
    }
    const byAssignee = new Map<string, PmIssueRow[]>()
    for (const i of issues) {
      const k = i.assignee_user_id ?? 'unassigned'
      byAssignee.set(k, [...(byAssignee.get(k) ?? []), i])
    }
    return [...byAssignee.entries()].map(([k, rows]) => ({
      key: k,
      label: k === 'unassigned' ? 'Unassigned' : store.users.get(k)?.name ?? '—',
      glyph: <Icon.user size={13} style={{ color: 'var(--text-mute)' }} />,
      rows,
    }))
  }, [issues, groupBy, states, store.users])

  const flat = useMemo(() => groups.flatMap((g) => g.rows), [groups])
  const focused = focusIdx >= 0 && focusIdx < flat.length ? flat[focusIdx] : null
  const targets = sel.size > 0 ? [...sel] : focused ? [focused.id] : []

  const toggleSel = (id: string, idx: number, range = false) => {
    setSel((prev) => {
      const next = new Set(prev)
      if (range && anchorIdx >= 0) {
        const [a, b] = [Math.min(anchorIdx, idx), Math.max(anchorIdx, idx)]
        for (let k = a; k <= b; k++) if (flat[k]) next.add(flat[k]!.id)
      } else if (next.has(id)) next.delete(id)
      else { next.add(id); setAnchorIdx(idx) }
      return next
    })
  }

  useHotkeys({
    c: (e) => { if (recentG()) return; e.preventDefault(); setComposerOpen(true) }, // yields to G-then-C
    j: () => setFocusIdx((i) => Math.min(flat.length - 1, i + 1)),
    k: () => setFocusIdx((i) => Math.max(0, i - 1)),
    arrowdown: () => setFocusIdx((i) => Math.min(flat.length - 1, i + 1)),
    arrowup: () => setFocusIdx((i) => Math.max(0, i - 1)),
    x: () => { if (focused) toggleSel(focused.id, focusIdx) },
    'shift+x': () => { if (focused) toggleSel(focused.id, focusIdx, true) },
    enter: () => { if (focused) router.push(`/pm/issues/${focused.id}`) },
    escape: () => { setMenu(null); setBulkMenu(null); setComposerOpen(false); setSel(new Set()); setFocusIdx(-1) },
    'mod+z': (e) => { e.preventDefault(); engine.undo() },
    'mod+shift+z': (e) => { e.preventDefault(); engine.redo() },
    ...Object.fromEntries(
      [0, 1, 2, 3, 4].map((p) => [String(p), () => engine.bulkApply(targets, (id) => engine.setIssuePriority(id, p))]),
    ),
    s: () => {
      if (sel.size > 0) setBulkMenu('state')
      else if (focused) setMenu({ kind: 'state', issueId: focused.id })
    },
    a: () => {
      if (sel.size > 0) setBulkMenu('assignee')
      else if (focused) setMenu({ kind: 'assignee', issueId: focused.id })
    },
    i: () => engine.bulkApply(targets, (id) => engine.assignIssue(id, me)),
    'shift+t': (e) => { e.preventDefault(); engine.bulkApply(targets, (id) => engine.sendToTriage(id)) },
  })

  if (!store.hydrated) {
    return <div className="t-mute" style={{ padding: 60, textAlign: 'center', fontSize: 12.5 }}>Hydrating local store…</div>
  }
  if (!team) {
    return <div className="t-mute" style={{ padding: 60, textAlign: 'center', fontSize: 12.5 }}>Workspace seeding…</div>
  }

  const applyView = (v: SavedViewRow) => {
    setActiveViewId(v.id)
    setFilters({
      prios: v.filters.prios ?? [],
      assignee: (v.filters.assignee as Filters['assignee']) ?? 'any',
      showClosed: v.filters.showClosed ?? false,
    })
    if (v.filters.group_by) setGroupBy(v.filters.group_by as never)
  }

  return (
    <div style={{ padding: '22px 26px 64px', maxWidth: viewMode === 'board' ? 1400 : 1060, margin: '0 auto' }}>
      <SectionHead
        title={`${team.key} · ${filters.showClosed ? 'All issues' : 'Active'}`}
        sub={`${issues.length} of ${allIssues.length} issues · ${store.pendingCount} pending · ${store.online ? 'live' : 'OFFLINE — changes queue'}`}
        right={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <div style={{ display: 'flex', gap: 3, padding: 3, background: 'var(--surf-1)', border: '1px solid var(--bord)', borderRadius: 8 }}>
              {(['list', 'board'] as const).map((m) => (
                <button key={m} onClick={() => setViewMode(m)}
                  style={{ padding: '5px 11px', borderRadius: 5, border: 'none', cursor: 'pointer', background: viewMode === m ? 'var(--surf-3)' : 'transparent', color: viewMode === m ? '#fff' : 'var(--text-2)', fontSize: 10.5, fontWeight: 800, textTransform: 'capitalize' }}>
                  {m}
                </button>
              ))}
            </div>
            <Btn kind="primary" size="sm" icon={<Icon.plus size={13} />} onClick={() => setComposerOpen(true)}>
              New issue <Kbd style={{ marginLeft: 6, background: 'rgba(255,255,255,.18)', border: 'none', color: '#fff' }}>C</Kbd>
            </Btn>
            <Pill tone={store.online ? 'blue' : 'yellow'} dot>{store.online ? 'sync' : 'offline'}</Pill>
          </div>
        }
      />

      {/* P5 — saved views tabs + filter bar */}
      <div style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <button onClick={() => { setActiveViewId(null); setFilters(DEFAULT_FILTERS); setGroupBy('state') }}
          style={viewTabStyle(activeViewId === null)}>
          Active
        </button>
        {(views.data?.data.views ?? []).map((v) => (
          <button key={v.id} onClick={() => applyView(v)} style={viewTabStyle(activeViewId === v.id)}>
            {v.name}
            {v.is_shared && <span style={{ fontSize: 8, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--blue)', border: '1px solid rgba(62,123,250,.4)', borderRadius: 99, padding: '0 4px', marginLeft: 5 }}>team</span>}
            <span
              onClick={(e) => { e.stopPropagation(); favView.mutate({ id: v.id, favorite: !(views.data?.data.favorite_ids ?? []).includes(v.id) }) }}
              title="Pin to favorites"
              style={{ marginLeft: 5, color: (views.data?.data.favorite_ids ?? []).includes(v.id) ? 'var(--yellow)' : 'var(--text-faint)' }}
            >★</span>
          </button>
        ))}
        <button onClick={() => setSaveOpen(true)} title="Save current filters as a view"
          style={{ padding: '5px 9px', borderRadius: 7, border: '1px dashed var(--bord-2)', background: 'transparent', color: 'var(--text-faint)', fontSize: 11, fontWeight: 800, cursor: 'pointer' }}>
          + Save view
        </button>
        <span style={{ flex: 1 }} />

        {/* Filters (§9.1 core set) */}
        <div style={{ display: 'flex', gap: 3 }}>
          {[1, 2, 3, 4].map((p) => (
            <button key={p} title={`Filter ${PM_PRIORITY_LABEL[p]}`}
              onClick={() => setFilters((f) => ({ ...f, prios: f.prios.includes(p) ? f.prios.filter((x) => x !== p) : [...f.prios, p] }))}
              style={{ width: 24, height: 24, borderRadius: 6, border: `1px solid ${filters.prios.includes(p) ? 'rgba(62,123,250,.5)' : 'var(--bord)'}`, background: filters.prios.includes(p) ? 'rgba(62,123,250,.12)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
              <PriorityGlyph p={p} size={11} />
            </button>
          ))}
        </div>
        <select className="input" value={filters.assignee} onChange={(e) => setFilters((f) => ({ ...f, assignee: e.target.value as Filters['assignee'] }))}
          style={{ height: 28, width: 110, fontSize: 11 }}>
          <option value="any">Anyone</option>
          <option value="me">Assigned: me</option>
          <option value="unassigned">Unassigned</option>
        </select>
        <button onClick={() => setFilters((f) => ({ ...f, showClosed: !f.showClosed }))}
          style={{ padding: '5px 9px', borderRadius: 7, border: '1px solid var(--bord)', background: filters.showClosed ? 'var(--surf-2)' : 'transparent', color: filters.showClosed ? '#fff' : 'var(--text-2)', fontSize: 10.5, fontWeight: 800, cursor: 'pointer' }}>
          {filters.showClosed ? 'All states' : '+ Done'}
        </button>
        {viewMode === 'list' && (
          <select className="input" value={groupBy} onChange={(e) => setGroupBy(e.target.value as never)} style={{ height: 28, width: 128, fontSize: 11 }}>
            <option value="state">Group: state</option>
            <option value="priority">Group: priority</option>
            <option value="assignee">Group: assignee</option>
          </select>
        )}
      </div>

      {saveOpen && <SaveViewInline pending={createView.isPending} onSave={(name, shared) => createView.mutate({ name, is_shared: shared })} onClose={() => setSaveOpen(false)} />}
      {composerOpen && <QuickCreate engine={engine} teamId={team.id} onClose={() => setComposerOpen(false)} />}

      {viewMode === 'board' ? (
        <PmBoard engine={engine} teamId={team.id} issues={issues} states={states} />
      ) : (
        <>
          {groups.map((g) => (
            <div key={g.key} style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, padding: '0 2px' }}>
                {g.glyph}
                <span className="t-caption">{g.label}</span>
                <span style={{ fontSize: 10, fontWeight: 800, fontFamily: 'var(--font-mono)', color: 'var(--text-faint)' }}>{g.rows.length}</span>
              </div>
              <div className="card" style={{ padding: 0, overflow: 'visible' }}>
                {g.rows.map((issue, i) => (
                  <IssueRow
                    key={issue.id}
                    issue={issue}
                    state={stateById.get(issue.state_id)!}
                    teamKey={team.key}
                    engine={engine}
                    last={i === g.rows.length - 1}
                    focused={focused?.id === issue.id}
                    selected={sel.has(issue.id)}
                    onOpen={() => router.push(`/pm/issues/${issue.id}`)}
                    onFocus={() => setFocusIdx(flat.findIndex((f) => f.id === issue.id))}
                    onToggleSel={(range) => toggleSel(issue.id, flat.findIndex((f) => f.id === issue.id), range)}
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
                {allIssues.length === 0 ? 'Write issues, not user stories — describe the task and press Enter.' : 'Nothing matches these filters.'}
              </div>
              {allIssues.length === 0 && (
                <Btn kind="primary" size="sm" onClick={() => setComposerOpen(true)}>
                  Create the first issue <Kbd style={{ marginLeft: 7, background: 'rgba(255,255,255,.18)', border: 'none', color: '#fff' }}>C</Kbd>
                </Btn>
              )}
            </div>
          )}
        </>
      )}

      {/* §9.4 bulk bar */}
      {sel.size > 0 && (
        <div style={{ position: 'sticky', bottom: 14, zIndex: 60, display: 'flex', justifyContent: 'center', marginTop: 10, pointerEvents: 'none' }}>
          <div className="card-glass" style={{ pointerEvents: 'auto', display: 'flex', alignItems: 'center', gap: 11, padding: '9px 14px', borderRadius: 12, flexWrap: 'wrap', maxWidth: '94%', position: 'relative' }}>
            <span style={{ fontSize: 11.5, fontWeight: 800, color: '#fff' }}>{sel.size} selected</span>
            <span style={{ width: 1, height: 16, background: 'var(--bord-2)' }} />
            {[['0–4', 'priority'], ['S', 'status'], ['A', 'assignee'], ['I', 'assign me']].map(([k, l]) => (
              <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5, fontWeight: 700, color: 'var(--text-faint)' }}>
                <Kbd>{k}</Kbd>{l}
              </span>
            ))}
            <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-faint)' }}>cap 500</span>
            <button onClick={() => setSel(new Set())} style={{ background: 'none', border: 'none', color: 'var(--text-mute)', fontSize: 11, fontWeight: 800, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <Kbd>Esc</Kbd> clear
            </button>
            {bulkMenu === 'state' && (
              <BulkMenu onClose={() => setBulkMenu(null)}>
                {states.map((s) => (
                  <button key={s.id} onClick={() => { engine.bulkApply(targets, (id) => engine.moveIssueState(id, s.id)); setBulkMenu(null); setSel(new Set()) }} style={menuRowStyle(false)}>
                    <StateGlyph cat={s.category} size={12} /> {s.name}
                  </button>
                ))}
              </BulkMenu>
            )}
            {bulkMenu === 'assignee' && (
              <BulkMenu onClose={() => setBulkMenu(null)}>
                <button onClick={() => { engine.bulkApply(targets, (id) => engine.assignIssue(id, null)); setBulkMenu(null); setSel(new Set()) }} style={menuRowStyle(false)}>
                  Unassigned
                </button>
                {[...store.users.values()].map((u) => (
                  <button key={u.id} onClick={() => { engine.bulkApply(targets, (id) => engine.assignIssue(id, u.id)); setBulkMenu(null); setSel(new Set()) }} style={menuRowStyle(false)}>
                    <MiniAv name={u.name ?? '?'} size={15} /> {u.name}
                  </button>
                ))}
              </BulkMenu>
            )}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 14, marginTop: 10, flexWrap: 'wrap' }}>
        {[['C', 'create'], ['J/K', 'move'], ['X/⇧X', 'select'], ['0–4', 'priority'], ['S', 'status'], ['A', 'assignee'], ['I', 'assign me'], ['⌘Z', 'undo'], ['Esc', 'clear']].map(([k, l]) => (
          <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5, fontWeight: 700, color: 'var(--text-faint)' }}>
            <Kbd>{k}</Kbd>{l}
          </span>
        ))}
      </div>
    </div>
  )
})

function viewTabStyle(active: boolean): React.CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', padding: '5px 11px', borderRadius: 7,
    border: `1px solid ${active ? 'var(--bord-2)' : 'var(--bord)'}`,
    background: active ? 'var(--surf-2)' : 'transparent',
    color: active ? '#fff' : 'var(--text-2)', fontSize: 11, fontWeight: 800, cursor: 'pointer',
  }
}

function SaveViewInline({ onSave, onClose, pending }: { onSave: (name: string, shared: boolean) => void; onClose: () => void; pending: boolean }) {
  const [name, setName] = useState('')
  const [shared, setShared] = useState(false)
  return (
    <div className="card" style={{ display: 'flex', gap: 9, alignItems: 'center', padding: 10, marginBottom: 12, border: '1px solid var(--bord-2)' }}>
      <input autoFocus className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="View name — e.g. Urgent · unassigned"
        onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) onSave(name.trim(), shared); if (e.key === 'Escape') onClose() }}
        style={{ flex: 1, height: 34 }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <Toggle on={shared} onChange={setShared} />
        <span style={{ fontSize: 11, fontWeight: 700 }}>Team view</span>
      </div>
      <Btn kind="primary" size="sm" disabled={!name.trim() || pending} onClick={() => onSave(name.trim(), shared)}>
        {pending ? 'Saving…' : 'Save'}
      </Btn>
      <Btn kind="ghost" size="sm" onClick={onClose}>Cancel</Btn>
    </div>
  )
}

function BulkMenu({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 70 }} />
      <div style={{ position: 'absolute', bottom: 'calc(100% + 6px)', left: '50%', transform: 'translateX(-50%)', zIndex: 80, width: 220, maxHeight: 260, overflow: 'auto', background: 'rgba(18,18,30,.98)', border: '1px solid var(--bord-2)', borderRadius: 10, padding: 5, boxShadow: '0 16px 40px rgba(0,0,0,.5)' }}>
        {children}
      </div>
    </>
  )
}

function engineUserId(engine: PmSyncEngine): string {
  return (engine as unknown as { userId: string }).userId
}

function MiniAv({ name, size = 18 }: { name: string; size?: number }) {
  return (
    <span style={{ width: size, height: size, borderRadius: '50%', background: avBg(name), display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 800, fontSize: Math.max(7, size * 0.36), letterSpacing: '-0.02em', flexShrink: 0 }}>
      {initials(name)}
    </span>
  )
}

// ─── Row ─────────────────────────────────────────────────────────────────────

const IssueRow = observer(function IssueRow({ issue, state, teamKey, engine, last, focused, selected, onFocus, onOpen, onToggleSel, menu, openMenu, closeMenu, states }: {
  issue: PmIssueRow
  state: PmStateRow
  teamKey: string
  engine: PmSyncEngine
  last: boolean
  focused: boolean
  selected: boolean
  onFocus: () => void
  onOpen: () => void
  onToggleSel: (range: boolean) => void
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
      onClick={(e) => { if (e.shiftKey) onToggleSel(true); else onFocus() }}
      onDoubleClick={onOpen}
      style={{
        display: 'flex', alignItems: 'center', gap: 9, height: 34, padding: '0 12px',
        cursor: 'pointer', position: 'relative',
        borderBottom: last ? 'none' : '1px solid var(--bord)',
        outline: focused ? '2px solid var(--blue)' : 'none', outlineOffset: -2,
        background: selected ? 'rgba(62,123,250,.1)' : focused ? 'rgba(62,123,250,.06)' : 'transparent',
        transition: 'background .12s ease-out',
      }}
    >
      <span
        onClick={(e) => { e.stopPropagation(); onToggleSel(e.shiftKey) }}
        style={{ width: 13, height: 13, borderRadius: 4, border: `1.5px solid ${selected ? 'var(--blue)' : 'var(--bord-2)'}`, background: selected ? 'var(--blue)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, cursor: 'pointer' }}
      >
        {selected && <Icon.check size={9} style={{ color: '#fff' }} />}
      </span>
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
      {issue.estimate && (
        <span style={{ fontSize: 9, fontWeight: 800, fontFamily: 'var(--font-mono)', color: 'var(--text-mute)', background: 'var(--surf-2)', border: '1px solid var(--bord)', borderRadius: 4, padding: '0 4px', flexShrink: 0 }}>
          {Number(issue.estimate)}
        </span>
      )}
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
