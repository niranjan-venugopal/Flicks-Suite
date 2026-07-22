'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { observer } from 'mobx-react-lite'
import { Icon, Pill, SectionHead } from '@/components/proto'
import { Kbd, PendingDot, PriorityGlyph, PM_PRIORITY_LABEL } from '@/components/pm/glyphs'
import { PmAv } from '@/components/pm/projects'
import { usePm } from '@/lib/pm/PmProvider'
import { useHotkeys } from '@/lib/pm/hotkeys'
import type { PmSyncEngine } from '@/lib/pm/engine'

// ─────────────────────────────────────────────────────────
// P8 — Triage conveyor (§8): keyboard-first intake gate.
// ↑↓ move · 0–4 priority · A assignee · ⇧↵ accept · ⇧⌫ decline ·
// Z snooze (1d/3d/1w) · M merge-as-duplicate · Enter opens.
// Snoozed issues hide until due (local filter on snoozed_until).
// ─────────────────────────────────────────────────────────

export default function PmTriagePage() {
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
        The triage conveyor needs the sync engine — REST users can move issues out of Triage from the list.
      </div>
    )
  }
  return <TriageBody engine={engine} />
}

const TriageBody = observer(function TriageBody({ engine }: { engine: PmSyncEngine }) {
  const store = engine.store
  const router = useRouter()
  const teams = store.teamList().filter((t) => t.triage_enabled)
  const [teamId, setTeamId] = useState(teams[0]?.id ?? '')
  const team = store.teams.get(teamId)
  const [idx, setIdx] = useState(0)
  const [menu, setMenu] = useState<'assignee' | 'snooze' | 'merge' | 'decline' | null>(null)
  const [mergeKey, setMergeKey] = useState('')
  const [declineReason, setDeclineReason] = useState('')

  const rows = store.triageIssuesForTeam(teamId)
  const focused = rows[Math.min(idx, Math.max(0, rows.length - 1))] ?? null
  const users = [...store.users.values()]

  const act = (fn: (id: string) => void) => {
    if (!focused) return
    fn(focused.id)
    setMenu(null)
    setIdx((i) => Math.min(i, Math.max(0, rows.length - 2)))
  }

  useHotkeys({
    arrowdown: () => setIdx((i) => Math.min(rows.length - 1, i + 1)),
    arrowup: () => setIdx((i) => Math.max(0, i - 1)),
    j: () => setIdx((i) => Math.min(rows.length - 1, i + 1)),
    k: () => setIdx((i) => Math.max(0, i - 1)),
    enter: () => { if (focused && !menu) router.push(`/pm/issues/${focused.id}`) },
    'shift+enter': (e) => { e.preventDefault(); act((id) => engine.triageAccept(id)) },
    'shift+backspace': (e) => { e.preventDefault(); setMenu(menu === 'decline' ? null : 'decline') },
    a: () => { if (focused) setMenu(menu === 'assignee' ? null : 'assignee') },
    z: () => { if (focused) setMenu(menu === 'snooze' ? null : 'snooze') },
    m: () => { if (focused) setMenu(menu === 'merge' ? null : 'merge') },
    escape: () => setMenu(null),
    ...Object.fromEntries(
      [0, 1, 2, 3, 4].map((p) => [String(p), () => { if (focused) engine.setIssuePriority(focused.id, p) }]),
    ),
  })

  const snoozeUntil = (days: number) => {
    const until = new Date(Date.now() + days * 86_400_000).toISOString()
    act((id) => engine.snoozeIssue(id, until))
  }

  const mergeAsDuplicate = () => {
    if (!focused || !mergeKey.trim() || !team) return
    const m = mergeKey.trim().toUpperCase().match(/^([A-Z0-9]+)-(\d+)$/)
    if (!m) return
    const target = [...store.issues.values()].find((i) => {
      const t = store.teams.get(i.team_id)
      return t?.key === m[1] && i.number === Number(m[2]) && !i.deleted_at
    })
    if (!target || target.id === focused.id) return
    engine.relateIssues(focused.id, target.id, 'duplicate_of')
    setMergeKey('')
    setMenu(null)
  }

  if (!team) {
    return <div className="t-mute" style={{ padding: 60, textAlign: 'center', fontSize: 12.5 }}>No triage-enabled team.</div>
  }

  return (
    <div style={{ padding: '22px 26px 64px', maxWidth: 900, margin: '0 auto' }}>
      <SectionHead
        title="Triage"
        sub="The intake gate — accept, decline, merge or snooze. Keyboard does everything."
        right={<Pill tone="blue" dot>sync</Pill>}
      />
      {teams.length > 1 && (
        <div style={{ display: 'flex', gap: 3, padding: 3, background: 'var(--surf-1)', border: '1px solid var(--bord)', borderRadius: 8, width: 'fit-content', marginBottom: 12 }}>
          {teams.map((t) => (
            <button key={t.id} onClick={() => { setTeamId(t.id); setIdx(0) }}
              style={{ padding: '5px 11px', borderRadius: 5, border: 'none', cursor: 'pointer', background: teamId === t.id ? 'var(--surf-3)' : 'transparent', color: teamId === t.id ? '#fff' : 'var(--text-2)', fontSize: 10.5, fontWeight: 800 }}>
              {t.key}
            </button>
          ))}
        </div>
      )}

      {rows.length === 0 ? (
        <div className="card" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '52px 24px', gap: 12 }}>
          <div style={{ width: 46, height: 46, borderRadius: 12, background: 'var(--surf-2)', border: '1px solid var(--bord)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-mute)' }}>
            <Icon.inbox size={20} />
          </div>
          <div className="t-mute" style={{ fontSize: 12.5 }}>Triage is clear — intake lands here from non-members, the API and imports.</div>
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {rows.map((issue, i) => {
            const isFocused = focused?.id === issue.id
            const creator = issue.creator_user_id ? store.users.get(issue.creator_user_id)?.name : null
            return (
              <div key={issue.id}
                onClick={() => setIdx(i)}
                onDoubleClick={() => router.push(`/pm/issues/${issue.id}`)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 9, minHeight: 40, padding: '0 12px', cursor: 'pointer',
                  borderBottom: i < rows.length - 1 ? '1px solid var(--bord)' : 'none',
                  outline: isFocused ? '2px solid var(--blue)' : 'none', outlineOffset: -2,
                  background: isFocused ? 'rgba(62,123,250,.06)' : 'transparent', position: 'relative',
                }}>
                <span style={{ fontSize: 10.5, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--text-mute)', width: 58, flexShrink: 0 }}>
                  {team.key}-{issue.number}
                </span>
                <PriorityGlyph p={issue.priority} size={13} />
                <span style={{ flex: 1, fontSize: 12.5, fontWeight: 700, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'flex', alignItems: 'center', gap: 7 }}>
                  {issue.title}
                  {issue._pending && <PendingDot />}
                </span>
                {creator && <span style={{ fontSize: 9.5, fontWeight: 700, color: 'var(--text-faint)' }}>by {creator}</span>}
                {issue.assignee_user_id && <PmAv name={store.users.get(issue.assignee_user_id)?.name ?? '?'} size={16} />}
                {isFocused && menu === 'assignee' && (
                  <FloatMenu>
                    <MenuBtn onClick={() => act((id) => engine.assignIssue(id, null))}>Unassigned</MenuBtn>
                    {users.map((u) => (
                      <MenuBtn key={u.id} onClick={() => act((id) => engine.assignIssue(id, u.id))}>
                        <PmAv name={u.name ?? '?'} size={14} /> {u.name}
                      </MenuBtn>
                    ))}
                  </FloatMenu>
                )}
                {isFocused && menu === 'snooze' && (
                  <FloatMenu>
                    <MenuBtn onClick={() => snoozeUntil(1)}>Snooze 1 day</MenuBtn>
                    <MenuBtn onClick={() => snoozeUntil(3)}>Snooze 3 days</MenuBtn>
                    <MenuBtn onClick={() => snoozeUntil(7)}>Snooze 1 week</MenuBtn>
                  </FloatMenu>
                )}
                {isFocused && menu === 'merge' && (
                  <FloatMenu>
                    <div style={{ padding: '4px 6px' }}>
                      <input autoFocus className="input" placeholder={`Duplicate of… e.g. ${team.key}-12`} value={mergeKey}
                        onChange={(e) => setMergeKey(e.target.value)}
                        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') mergeAsDuplicate(); if (e.key === 'Escape') setMenu(null) }}
                        style={{ height: 28, fontSize: 11, width: 190 }} />
                    </div>
                  </FloatMenu>
                )}
                {isFocused && menu === 'decline' && (
                  <FloatMenu>
                    <div style={{ padding: '4px 6px', display: 'flex', gap: 6 }}>
                      <input autoFocus className="input" placeholder="Reason (optional)" value={declineReason}
                        onChange={(e) => setDeclineReason(e.target.value)}
                        onKeyDown={(e) => {
                          e.stopPropagation()
                          if (e.key === 'Enter') { act((id) => engine.triageDecline(id, declineReason.trim() || undefined)); setDeclineReason('') }
                          if (e.key === 'Escape') setMenu(null)
                        }}
                        style={{ height: 28, fontSize: 11, width: 190 }} />
                    </div>
                  </FloatMenu>
                )}
              </div>
            )
          })}
        </div>
      )}

      <div style={{ display: 'flex', gap: 12, marginTop: 10, flexWrap: 'wrap' }}>
        {[['↑↓', 'move'], ['0–4', PM_PRIORITY_LABEL.slice(1, 3).join('/').toLowerCase()], ['A', 'assignee'], ['⇧↵', 'accept'], ['⇧⌫', 'decline'], ['Z', 'snooze'], ['M', 'merge dup'], ['Enter', 'open']].map(([k, l]) => (
          <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5, fontWeight: 700, color: 'var(--text-faint)' }}>
            <Kbd>{k}</Kbd>{l}
          </span>
        ))}
      </div>
    </div>
  )
})

function FloatMenu({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ position: 'absolute', right: 10, top: 38, zIndex: 60, background: 'rgba(18,18,30,.98)', border: '1px solid var(--bord-2)', borderRadius: 10, padding: 4, boxShadow: '0 14px 40px rgba(0,0,0,.5)', minWidth: 170, maxHeight: 260, overflowY: 'auto' }}>
      {children}
    </div>
  )
}

function MenuBtn({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button onClick={(e) => { e.stopPropagation(); onClick() }}
      style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '7px 9px', borderRadius: 7, background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-2)', fontSize: 11.5, fontWeight: 700, textAlign: 'left' }}>
      {children}
    </button>
  )
}
