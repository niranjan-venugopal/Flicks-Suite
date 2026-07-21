'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { observer } from 'mobx-react-lite'
import { Icon, Pill, SectionHead } from '@/components/proto'
import { Kbd, PendingDot, PriorityGlyph, StateGlyph } from '@/components/pm/glyphs'
import { usePm } from '@/lib/pm/PmProvider'
import { useHotkeys } from '@/lib/pm/hotkeys'
import type { PmSyncEngine } from '@/lib/pm/engine'

// ─────────────────────────────────────────────────────────
// P6 — My Issues: assigned / created / subscribed tabs, straight off the
// local graph (instant). Everything opens with Enter; J/K move.
// ─────────────────────────────────────────────────────────

const TABS = ['assigned', 'created', 'subscribed'] as const

export default function MyIssuesPage() {
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
        My Issues needs the sync engine — the REST fallback lists everything under Projects → Issues.
      </div>
    )
  }
  return <MyIssues engine={engine} />
}

const MyIssues = observer(function MyIssues({ engine }: { engine: PmSyncEngine }) {
  const router = useRouter()
  const store = engine.store
  const me = (engine as unknown as { userId: string }).userId
  const [tab, setTab] = useState<(typeof TABS)[number]>('assigned')
  const [focusIdx, setFocusIdx] = useState(-1)

  const stateById = useMemo(
    () => new Map([...store.states.values()].map((s) => [s.id, s])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store.states.size],
  )

  const rows = useMemo(() => {
    const all = [...store.issues.values()].filter((i) => !i.deleted_at)
    let mine
    if (tab === 'assigned') mine = all.filter((i) => i.assignee_user_id === me)
    else if (tab === 'created') mine = all.filter((i) => i.creator_user_id === me)
    else mine = all.filter((i) => (store.issueSubscribers.get(i.id) ?? []).includes(me))
    return mine.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
  }, [tab, store.issues, store.issueSubscribers, me])

  const focused = focusIdx >= 0 && focusIdx < rows.length ? rows[focusIdx] : null

  useHotkeys({
    j: () => setFocusIdx((i) => Math.min(rows.length - 1, i + 1)),
    k: () => setFocusIdx((i) => Math.max(0, i - 1)),
    arrowdown: () => setFocusIdx((i) => Math.min(rows.length - 1, i + 1)),
    arrowup: () => setFocusIdx((i) => Math.max(0, i - 1)),
    enter: () => { if (focused) router.push(`/pm/issues/${focused.id}`) },
    escape: () => setFocusIdx(-1),
  })

  return (
    <div style={{ padding: '22px 26px 64px', maxWidth: 900, margin: '0 auto' }}>
      <SectionHead
        title="My Issues"
        sub="Assigned to you, created by you, and everything you subscribe to — from the local graph, instantly."
        right={<Pill tone="blue" dot>sync</Pill>}
      />
      <div style={{ display: 'flex', gap: 4, padding: 3, background: 'var(--surf-1)', border: '1px solid var(--bord)', borderRadius: 9, width: 'fit-content', marginBottom: 14 }}>
        {TABS.map((t) => (
          <button key={t} onClick={() => { setTab(t); setFocusIdx(-1) }}
            style={{ padding: '6px 14px', borderRadius: 6, border: 'none', cursor: 'pointer', background: tab === t ? 'var(--surf-3)' : 'transparent', color: tab === t ? '#fff' : 'var(--text-2)', fontSize: 11.5, fontWeight: 800, textTransform: 'capitalize' }}>
            {t}
          </button>
        ))}
      </div>

      {rows.length === 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '52px 24px', gap: 12 }}>
          <div style={{ width: 46, height: 46, borderRadius: 12, background: 'var(--surf-2)', border: '1px solid var(--bord)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-mute)' }}>
            <Icon.check size={20} />
          </div>
          <div className="t-mute" style={{ fontSize: 12.5 }}>Nothing {tab} — a clean queue.</div>
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {rows.map((issue, i) => {
            const state = stateById.get(issue.state_id)
            const team = store.teams.get(issue.team_id)
            return (
              <div key={issue.id}
                onClick={() => router.push(`/pm/issues/${issue.id}`)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 9, height: 34, padding: '0 12px', cursor: 'pointer',
                  borderBottom: i < rows.length - 1 ? '1px solid var(--bord)' : 'none',
                  outline: focused?.id === issue.id ? '2px solid var(--blue)' : 'none', outlineOffset: -2,
                  background: focused?.id === issue.id ? 'rgba(62,123,250,.06)' : 'transparent',
                }}>
                {state && <StateGlyph cat={state.category} size={13} />}
                <span style={{ fontSize: 10.5, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--text-mute)', width: 58, flexShrink: 0 }}>
                  {team?.key}-{issue.number}
                </span>
                <PriorityGlyph p={issue.priority} size={13} />
                <span style={{ flex: 1, fontSize: 12.5, fontWeight: 700, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'flex', alignItems: 'center', gap: 7 }}>
                  {issue.title}
                  {issue._pending && <PendingDot />}
                </span>
                {issue.due_date && (
                  <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-faint)' }}>
                    {new Date(issue.due_date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}

      <div style={{ display: 'flex', gap: 14, marginTop: 10 }}>
        {[['J/K', 'move'], ['Enter', 'open'], ['G then B', 'issues'], ['⌘K', 'palette']].map(([k, l]) => (
          <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5, fontWeight: 700, color: 'var(--text-faint)' }}>
            <Kbd>{k}</Kbd>{l}
          </span>
        ))}
      </div>
    </div>
  )
})
