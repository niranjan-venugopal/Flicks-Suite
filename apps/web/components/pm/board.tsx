'use client'

import { useState } from 'react'
import { observer } from 'mobx-react-lite'
import { rankBetween } from '@flicks/shared/pm'
import { Icon, avBg, initials } from '@/components/proto'
import { IssueComposer } from '@/components/pm/IssueComposer'
import { PendingDot, PriorityGlyph, StateGlyph } from '@/components/pm/glyphs'
import type { PmSyncEngine } from '@/lib/pm/engine'
import type { PmIssueRow, PmStateRow } from '@/lib/pm/types'

// ─────────────────────────────────────────────────────────
// P3 Board (scr-board-pm.jsx) — columns = workflow states, native HTML5 drag
// (house pattern): drop on a column moves state; drop above a card re-ranks
// with the fractional index. Per-column quick-add + estimate point sums.
// ─────────────────────────────────────────────────────────

const CAT_ORDER = ['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled']

export const PmBoard = observer(function PmBoard({ engine, teamId, issues, states }: {
  engine: PmSyncEngine
  teamId: string
  issues: PmIssueRow[]
  states: PmStateRow[]
}) {
  const [dragId, setDragId] = useState<string | null>(null)
  const [overCol, setOverCol] = useState<string | null>(null)
  const [overCard, setOverCard] = useState<string | null>(null)
  // Round B: the column's + opens the full composer, pre-picked to that
  // state (it used to be a bare title input).
  const [addingIn, setAddingIn] = useState<string | null>(null)

  const ordered = states
    .slice()
    .sort((a, b) => CAT_ORDER.indexOf(a.category) - CAT_ORDER.indexOf(b.category) || a.position - b.position)

  const colRows = (stateId: string) =>
    issues.filter((i) => i.state_id === stateId).sort((a, b) => (a.board_rank < b.board_rank ? -1 : 1))

  const drop = (stateId: string) => {
    if (!dragId) return
    const issue = engine.store.issues.get(dragId)
    if (!issue) return
    const rows = colRows(stateId).filter((r) => r.id !== dragId)
    let rank: string
    if (overCard && overCard !== dragId) {
      const idx = rows.findIndex((r) => r.id === overCard)
      const before = idx > 0 ? rows[idx - 1]!.board_rank : null
      const target = rows[idx]?.board_rank ?? null
      rank = rankBetween(before, target)
    } else {
      rank = rankBetween(rows.length ? rows[rows.length - 1]!.board_rank : null, null)
    }
    if (issue.state_id !== stateId) engine.moveIssueState(dragId, stateId)
    engine.rankIssue(dragId, 'board_rank', rank)
    setDragId(null); setOverCol(null); setOverCard(null)
  }

  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', overflowX: 'auto', paddingBottom: 24 }}>
      {ordered.map((state) => {
        const rows = colRows(state.id)
        const points = rows.reduce((s, r) => s + (r.estimate ? Number(r.estimate) : 0), 0)
        return (
          <div
            key={state.id}
            onDragOver={(e) => { e.preventDefault(); setOverCol(state.id) }}
            onDrop={(e) => { e.preventDefault(); drop(state.id) }}
            style={{
              width: 264, flexShrink: 0, borderRadius: 12, padding: '10px 8px 8px',
              background: overCol === state.id && dragId ? 'rgba(62,123,250,.06)' : 'var(--surf-0, rgba(255,255,255,.02))',
              border: `1px solid ${overCol === state.id && dragId ? 'rgba(62,123,250,.35)' : 'var(--bord)'}`,
              transition: 'border-color .12s ease-out',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '0 6px 8px' }}>
              <StateGlyph cat={state.category} size={13} />
              <span style={{ fontSize: 11.5, fontWeight: 800 }}>{state.name}</span>
              <span style={{ fontSize: 10, fontWeight: 800, fontFamily: 'var(--font-mono)', color: 'var(--text-faint)' }}>{rows.length}</span>
              <span style={{ flex: 1 }} />
              {points > 0 && (
                <span title="Estimate points" style={{ fontSize: 9.5, fontWeight: 800, fontFamily: 'var(--font-mono)', color: 'var(--text-mute)', background: 'var(--surf-2)', border: '1px solid var(--bord)', borderRadius: 5, padding: '1px 5px' }}>
                  {points}
                </span>
              )}
              <button onClick={() => setAddingIn(state.id)} title="New issue in this state"
                style={{ width: 20, height: 20, borderRadius: 5, background: 'transparent', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Icon.plus size={12} />
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minHeight: 40 }}>
              {rows.map((issue) => (
                <BoardCard
                  key={issue.id}
                  issue={issue}
                  engine={engine}
                  dragging={dragId === issue.id}
                  isOver={overCard === issue.id && dragId !== issue.id}
                  onDragStart={() => setDragId(issue.id)}
                  onDragEnd={() => { setDragId(null); setOverCol(null); setOverCard(null) }}
                  onDragOverCard={() => setOverCard(issue.id)}
                />
              ))}
              {rows.length === 0 && (
                <div style={{ padding: '14px 8px', textAlign: 'center', fontSize: 10.5, fontWeight: 700, color: 'var(--text-faint)', border: '1px dashed var(--bord)', borderRadius: 9 }}>
                  Drop issues here
                </div>
              )}
            </div>
          </div>
        )
      })}
      <IssueComposer
        open={addingIn !== null}
        onClose={() => setAddingIn(null)}
        engine={engine}
        teamId={teamId}
        stateId={addingIn ?? undefined}
      />
    </div>
  )
})

const BoardCard = observer(function BoardCard({ issue, engine, dragging, isOver, onDragStart, onDragEnd, onDragOverCard }: {
  issue: PmIssueRow
  engine: PmSyncEngine
  dragging: boolean
  isOver: boolean
  onDragStart: () => void
  onDragEnd: () => void
  onDragOverCard: () => void
}) {
  const store = engine.store
  const team = store.teams.get(issue.team_id)
  const assignee = issue.assignee_user_id ? store.users.get(issue.assignee_user_id) : null
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={(e) => { e.preventDefault(); onDragOverCard() }}
      style={{
        borderRadius: 10, padding: '9px 11px', cursor: 'grab',
        background: 'var(--surf-1)', border: `1px solid ${isOver ? 'rgba(62,123,250,.5)' : 'var(--bord)'}`,
        opacity: dragging ? 0.45 : 1, transition: 'opacity .1s ease-out, border-color .12s ease-out',
        boxShadow: isOver ? '0 -2px 0 0 var(--blue)' : 'none',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 5 }}>
        <span style={{ fontSize: 9.5, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--text-mute)' }}>
          {issue.number ? `${team?.key}-${issue.number}` : `${team?.key}-…`}
        </span>
        {issue._pending && <PendingDot />}
        <span style={{ flex: 1 }} />
        <PriorityGlyph p={issue.priority} size={12} />
      </div>
      <div style={{ fontSize: 12, fontWeight: 700, color: '#fff', lineHeight: 1.35, marginBottom: 6, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
        {issue.title}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {issue.estimate && (
          <span style={{ fontSize: 9, fontWeight: 800, fontFamily: 'var(--font-mono)', color: 'var(--text-mute)', background: 'var(--surf-2)', border: '1px solid var(--bord)', borderRadius: 4, padding: '0 4px' }}>
            {Number(issue.estimate)}
          </span>
        )}
        {issue.due_date && (
          <span style={{ fontSize: 9.5, fontWeight: 700, color: 'var(--text-faint)' }}>
            {new Date(issue.due_date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {assignee?.name ? (
          <span style={{ width: 17, height: 17, borderRadius: '50%', background: avBg(assignee.name), display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 800, fontSize: 6.5 }}>
            {initials(assignee.name)}
          </span>
        ) : (
          <span style={{ width: 17, height: 17, borderRadius: '50%', border: '1.5px dashed var(--bord-2)', boxSizing: 'border-box' }} />
        )}
      </div>
    </div>
  )
})
