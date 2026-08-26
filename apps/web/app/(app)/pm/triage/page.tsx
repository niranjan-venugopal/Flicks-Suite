'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { observer } from 'mobx-react-lite'
import { Btn, Icon, Pill, SectionHead } from '@/components/proto'
import { Kbd, StateGlyph, PriorityGlyph, PendingDot, PM_PRIORITY_LABEL } from '@/components/pm/glyphs'
import { PmAv } from '@/components/pm/projects'
import { usePm } from '@/lib/pm/PmProvider'
import { useHotkeys } from '@/lib/pm/hotkeys'
import type { PmSyncEngine } from '@/lib/pm/engine'

// ─────────────────────────────────────────────────────────
// P8 — Triage conveyor (§8), faithful to scr-issue-inbox.jsx: 250px queue
// rail + focus card + glass keyboard toolbar (0–4 · A · L · Z snooze · M
// merge-duplicate · ⇧⌫ Decline · ⇧⏎ Accept → Backlog).
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
        The triage view isn’t available in this workspace right now — you can still move issues out of Triage from the Issues list.
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
  const [menu, setMenu] = useState<'assignee' | 'labels' | 'snooze' | 'merge' | 'decline' | null>(null)
  const [mergeQ, setMergeQ] = useState('')
  const [declineReason, setDeclineReason] = useState('')

  const rows = store.triageIssuesForTeam(teamId)
  const focus = rows[Math.min(idx, Math.max(0, rows.length - 1))] ?? null
  const users = [...store.users.values()]
  const teamLabels = [...store.labels.values()].filter((l) => !l.team_id || l.team_id === teamId)

  const [exiting, setExiting] = useState<'accept' | 'decline' | null>(null)
  // Catalog: the card exits right (accept) or left (decline) over 160–180ms,
  // THEN the mutation fires and the next card rises into place.
  const act = (fn: (id: string) => void, dir: 'accept' | 'decline' = 'accept') => {
    if (!focus || exiting) return
    const id = focus.id
    setExiting(dir)
    window.setTimeout(() => {
      fn(id)
      setExiting(null)
      setMenu(null)
      setIdx((i) => Math.min(i, Math.max(0, rows.length - 2)))
    }, 180)
  }

  useHotkeys({
    arrowdown: () => setIdx((i) => Math.min(rows.length - 1, i + 1)),
    arrowup: () => setIdx((i) => Math.max(0, i - 1)),
    j: () => setIdx((i) => Math.min(rows.length - 1, i + 1)),
    k: () => setIdx((i) => Math.max(0, i - 1)),
    enter: () => { if (focus && !menu) router.push(`/pm/issues/${focus.id}`) },
    'shift+enter': (e) => { e.preventDefault(); act((id) => engine.triageAccept(id)) },
    'shift+backspace': (e) => { e.preventDefault(); setMenu(menu === 'decline' ? null : 'decline') },
    a: () => { if (focus) setMenu(menu === 'assignee' ? null : 'assignee') },
    l: () => { if (focus) setMenu(menu === 'labels' ? null : 'labels') },
    z: () => { if (focus) setMenu(menu === 'snooze' ? null : 'snooze') },
    m: () => { if (focus) setMenu(menu === 'merge' ? null : 'merge') },
    escape: () => setMenu(null),
    ...Object.fromEntries(
      [0, 1, 2, 3, 4].map((p) => [String(p), () => { if (focus) engine.setIssuePriority(focus.id, p) }]),
    ),
  })

  const snoozeUntil = (days: number) => {
    const until = new Date(Date.now() + days * 86_400_000).toISOString()
    act((id) => engine.snoozeIssue(id, until))
  }

  const mergeCandidates = mergeQ.trim()
    ? [...store.issues.values()]
        .filter((i) => !i.deleted_at && i.id !== focus?.id && store.states.get(i.state_id)?.category !== 'triage')
        .filter((i) => {
          const t = store.teams.get(i.team_id)
          const key = `${t?.key ?? ''}-${i.number}`.toLowerCase()
          const q = mergeQ.trim().toLowerCase()
          return i.title.toLowerCase().includes(q) || key.includes(q.replace(/\s/g, ''))
        })
        .slice(0, 5)
    : []

  if (!team) {
    return <div className="t-mute" style={{ padding: 60, textAlign: 'center', fontSize: 12.5 }}>No triage-enabled team.</div>
  }

  const creatorName = focus?.creator_user_id ? store.users.get(focus.creator_user_id)?.name ?? 'a member' : 'intake'
  const focusLabels = focus ? (store.issueLabels.get(focus.id) ?? []) : []

  return (
    <div style={{ padding: '22px 26px 64px', maxWidth: 1080, margin: '0 auto' }}>
      <SectionHead
        title="Triage"
        sub="The intake gate — accept, decline, merge or snooze. Keyboard does everything."
        right={<Pill tone="blue" dot>sync</Pill>}
      />
      {teams.length > 1 && (
        <div style={{ display: 'flex', gap: 3, padding: 3, background: 'var(--surf-1)', border: '1px solid var(--bord)', borderRadius: 8, width: 'fit-content', marginBottom: 12 }}>
          {teams.map((t) => (
            <button key={t.id} onClick={() => { setTeamId(t.id); setIdx(0); setMenu(null) }}
              style={{ padding: '5px 11px', borderRadius: 5, border: 'none', cursor: 'pointer', background: teamId === t.id ? 'var(--surf-3)' : 'transparent', color: teamId === t.id ? '#fff' : 'var(--text-2)', fontSize: 10.5, fontWeight: 800 }}>
              {t.key}
            </button>
          ))}
        </div>
      )}

      {rows.length === 0 || !focus ? (
        <div className="card" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '52px 24px', gap: 12 }}>
          <div style={{ width: 46, height: 46, borderRadius: 12, background: 'var(--surf-2)', border: '1px solid var(--bord)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-mute)' }}>
            <Icon.inbox size={20} />
          </div>
          <div className="t-mute" style={{ fontSize: 12.5 }}>Triage zero — every request reviewed. New intake lands here automatically.</div>
          <Btn kind="secondary" size="sm" onClick={() => router.push('/pm/issues')}>Back to Active</Btn>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '250px 1fr', gap: 16, alignItems: 'start' }}>
          {/* Queue rail */}
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '10px 13px', borderBottom: '1px solid var(--bord)', display: 'flex', alignItems: 'center', gap: 7 }}>
              <StateGlyph cat="triage" size={13} />
              <span style={{ fontSize: 11.5, fontWeight: 800, flex: 1 }}>Queue</span>
              <span style={{ fontSize: 10, fontWeight: 800, fontFamily: 'var(--font-mono)', color: 'var(--coral)' }}>{rows.length}</span>
            </div>
            {rows.map((i, ii) => (
              <button key={i.id} onClick={() => { setIdx(ii); setMenu(null) }}
                style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 3, padding: '9px 13px', background: focus.id === i.id ? 'var(--surf-2)' : 'transparent', border: 'none', borderBottom: '1px solid var(--bord)', cursor: 'pointer', textAlign: 'left', transition: 'background .12s ease-out' }}>
                <span style={{ fontSize: 9.5, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--text-faint)' }}>
                  {team.key}-{i.number} · {new Date(i.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                </span>
                <span style={{ fontSize: 11.5, fontWeight: 750, color: '#fff', lineHeight: 1.35, display: 'flex', alignItems: 'center', gap: 6 }}>
                  {i.title}{i._pending && <PendingDot />}
                </span>
              </button>
            ))}
          </div>

          {/* Focus card + toolbar */}
          <div>
            <div
              key={focus.id}
              className={exiting === 'accept' ? 'card pm-exit-right' : exiting === 'decline' ? 'card pm-exit-left' : 'card pm-fade'}
              style={{ padding: '16px 18px', marginBottom: 10 }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 10.5, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--text-mute)' }}>{team.key}-{focus.number}</span>
                <Pill tone="purple">source · {focus.source === 'manual' ? creatorName : focus.source}</Pill>
                {focus.priority > 0 && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10, fontWeight: 800, color: 'var(--text-2)' }}>
                    <PriorityGlyph p={focus.priority} size={11} />{PM_PRIORITY_LABEL[focus.priority]}
                  </span>
                )}
                {focus.assignee_user_id && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10, fontWeight: 700, color: 'var(--text-2)' }}>
                    <PmAv name={store.users.get(focus.assignee_user_id)?.name ?? '?'} src={store.users.get(focus.assignee_user_id)?.avatar_url} size={15} />
                    {store.users.get(focus.assignee_user_id)?.name}
                  </span>
                )}
                {focusLabels.map((lid) => {
                  const l = store.labels.get(lid)
                  return l ? (
                    <span key={lid} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '0 7px', height: 16, borderRadius: 99, border: `1px solid ${l.color ?? '#5C6477'}55`, color: l.color ?? 'var(--text-2)', fontSize: 9, fontWeight: 800 }}>
                      <span style={{ width: 5, height: 5, borderRadius: '50%', background: l.color ?? '#5C6477' }} />{l.name}
                    </span>
                  ) : null
                })}
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: 9.5, fontWeight: 700, color: 'var(--text-faint)' }}>
                  created {new Date(focus.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                </span>
              </div>
              <div style={{ fontSize: 16, fontWeight: 800, letterSpacing: '-0.01em', marginBottom: 7 }}>{focus.title}</div>
              <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-2)', lineHeight: 1.65 }}>
                Reported via {focus.source === 'api' ? 'the public API with triage:true' : focus.source === 'manual' ? `${creatorName} — sent to triage` : 'intake'} — needs priority, owner and a decision before it enters the backlog.
              </div>
            </div>

            {/* Keyboard toolbar */}
            <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '10px 14px', borderRadius: 12, flexWrap: 'wrap', position: 'relative' }}>
              <KbdHint k="0–4" label="priority" />
              <ToolDrop label="assign" k="A" open={menu === 'assignee'} onToggle={() => setMenu(menu === 'assignee' ? null : 'assignee')}>
                <DropBtn onClick={() => act((id) => engine.assignIssue(id, null))}>Unassigned</DropBtn>
                {users.map((u) => (
                  <DropBtn key={u.id} onClick={() => { engine.assignIssue(focus.id, u.id); setMenu(null) }}>
                    <PmAv name={u.name ?? '?'} src={u.avatar_url} size={14} /> {u.name}
                  </DropBtn>
                ))}
              </ToolDrop>
              <ToolDrop label="label" k="L" open={menu === 'labels'} onToggle={() => setMenu(menu === 'labels' ? null : 'labels')}>
                {teamLabels.length === 0 && <div className="t-mute" style={{ padding: '6px 9px', fontSize: 10.5 }}>No labels yet</div>}
                {teamLabels.map((l) => {
                  const on = focusLabels.includes(l.id)
                  return (
                    <DropBtn key={l.id} onClick={() => {
                      engine.setIssueLabels(focus.id, on ? focusLabels.filter((x) => x !== l.id) : [...focusLabels, l.id])
                    }}>
                      <span style={{ width: 7, height: 7, borderRadius: 2, background: l.color ?? '#5C6477' }} /> {l.name} {on && <Icon.check size={11} style={{ color: 'var(--blue)', marginLeft: 'auto' }} />}
                    </DropBtn>
                  )
                })}
              </ToolDrop>
              <span style={{ width: 1, height: 16, background: 'var(--bord-2)' }} />
              <ToolDrop label="Snooze" k="Z" open={menu === 'snooze'} onToggle={() => setMenu(menu === 'snooze' ? null : 'snooze')}>
                <DropBtn onClick={() => snoozeUntil(1)}>1 day</DropBtn>
                <DropBtn onClick={() => snoozeUntil(3)}>3 days</DropBtn>
                <DropBtn onClick={() => snoozeUntil(7)}>1 week</DropBtn>
              </ToolDrop>
              <ToolDrop label="Merge duplicate" k="M" width={250} open={menu === 'merge'} onToggle={() => setMenu(menu === 'merge' ? null : 'merge')}>
                <div style={{ padding: 3 }}>
                  <input autoFocus placeholder="Fuzzy search issues…" className="input" value={mergeQ}
                    onChange={(e) => setMergeQ(e.target.value)}
                    onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') setMenu(null) }}
                    style={{ height: 28, fontSize: 11, marginBottom: 5, width: '100%' }} />
                  {mergeCandidates.map((c) => {
                    const t = store.teams.get(c.team_id)
                    return (
                      <DropBtn key={c.id} onClick={() => { act((id) => engine.relateIssues(id, c.id, 'duplicate_of')); setMergeQ('') }}>
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-mute)' }}>{t?.key}-{c.number}</span>
                        <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.title}</span>
                      </DropBtn>
                    )
                  })}
                  {mergeQ.trim() && mergeCandidates.length === 0 && <div className="t-mute" style={{ padding: '4px 6px', fontSize: 10.5 }}>No matches</div>}
                </div>
              </ToolDrop>
              <span style={{ flex: 1 }} />
              <div style={{ position: 'relative' }}>
                <button onClick={() => setMenu(menu === 'decline' ? null : 'decline')}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '7px 13px', borderRadius: 9, background: 'rgba(248,120,107,.1)', border: '1px solid rgba(248,120,107,.35)', color: 'var(--coral)', fontSize: 11.5, fontWeight: 800, cursor: 'pointer' }}>
                  <Kbd style={{ background: 'rgba(248,120,107,.15)', borderColor: 'rgba(248,120,107,.4)', color: 'var(--coral)' }}>⇧⌫</Kbd> Decline
                </button>
                {menu === 'decline' && (
                  <div style={{ position: 'absolute', bottom: 'calc(100% + 5px)', right: 0, zIndex: 40, width: 230, background: 'rgba(18,18,30,.98)', border: '1px solid var(--bord-2)', borderRadius: 10, padding: 7, boxShadow: '0 16px 40px rgba(0,0,0,.5)' }}>
                    <input autoFocus className="input" placeholder="Reason (optional) — ⏎ declines" value={declineReason}
                      onChange={(e) => setDeclineReason(e.target.value)}
                      onKeyDown={(e) => {
                        e.stopPropagation()
                        if (e.key === 'Enter') { act((id) => engine.triageDecline(id, declineReason.trim() || undefined), 'decline'); setDeclineReason('') }
                        if (e.key === 'Escape') setMenu(null)
                      }}
                      style={{ height: 28, fontSize: 11, width: '100%' }} />
                  </div>
                )}
              </div>
              <button onClick={() => act((id) => engine.triageAccept(id))}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '7px 13px', borderRadius: 9, background: 'var(--blue)', border: 'none', color: '#fff', fontSize: 11.5, fontWeight: 800, cursor: 'pointer', boxShadow: '0 6px 18px rgba(62,123,250,.35)' }}>
                <Kbd style={{ background: 'rgba(255,255,255,.2)', border: 'none', color: '#fff' }}>⇧⏎</Kbd> Accept → Backlog
              </button>
            </div>
            <div style={{ fontSize: 9.5, fontWeight: 700, color: 'var(--text-faint)', marginTop: 8 }}>
              accepted/declined leave the queue · <Kbd>↑↓</Kbd> walk the queue · decline reason optional · Accept stamps triaged_at
            </div>
          </div>
        </div>
      )}
    </div>
  )
})

function KbdHint({ k, label }: { k: string; label: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, color: 'var(--text-2)' }}>
      <Kbd>{k}</Kbd>{label}
    </span>
  )
}

function ToolDrop({ label, k, open, onToggle, width = 170, children }: {
  label: string; k: string; open: boolean; onToggle: () => void; width?: number; children: React.ReactNode
}) {
  return (
    <div style={{ position: 'relative' }}>
      <button onClick={onToggle}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 10px', borderRadius: 8, background: 'var(--surf-1)', border: '1px solid var(--bord)', color: 'var(--text-2)', fontSize: 11, fontWeight: 800, cursor: 'pointer' }}>
        <Kbd>{k}</Kbd> {label}
      </button>
      {open && (
        <div style={{ position: 'absolute', bottom: 'calc(100% + 5px)', left: 0, zIndex: 40, width, background: 'rgba(18,18,30,.98)', border: '1px solid var(--bord-2)', borderRadius: 9, padding: 4, boxShadow: '0 16px 40px rgba(0,0,0,.5)', maxHeight: 260, overflowY: 'auto' }}>
          {children}
        </div>
      )}
    </div>
  )
}

function DropBtn({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button onClick={(e) => { e.stopPropagation(); onClick() }}
      style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 7, textAlign: 'left', padding: '6px 9px', borderRadius: 6, background: 'transparent', border: 'none', color: '#fff', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surf-1)' }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}>
      {children}
    </button>
  )
}
