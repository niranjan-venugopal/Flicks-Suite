'use client'

import { useState } from 'react'
import { observer } from 'mobx-react-lite'
import { DateField } from '@/components/ui/date-picker'
import { DiamondGlyph, Kbd } from '@/components/pm/glyphs'
import { api } from '@/lib/api/client'
import type { PmSyncEngine } from '@/lib/pm/engine'
import type { PmIssueRow, PmMilestoneRow } from '@/lib/pm/types'
import type { ProjectDetailIssue } from './types'

// ─────────────────────────────────────────────────────────
// Project page — Milestones card: rows with progress bars (overdue amber)
// and the inline create flow. Split out of the page in Round M (verbatim
// move); `msProgress` is the same helper the page used to own.
// ─────────────────────────────────────────────────────────

export interface ProjectMilestonesProps {
  projectId: string
  engine: PmSyncEngine | null
  /** REST detail merged with the live engine rows, sorted (the page computes this). */
  milestones: PmMilestoneRow[]
  /** The REST payload's issue rows — the REST-mode source for milestone progress. */
  restIssues: ProjectDetailIssue[]
  /** Refetches the lazy REST detail (REST mode; sync mode refetches on ack). */
  invalidate: () => void
}

export const ProjectMilestones = observer(function ProjectMilestones({
  projectId,
  engine,
  milestones,
  restIssues,
  invalidate,
}: ProjectMilestonesProps) {
  const [addMs, setAddMs] = useState(false)
  const [msName, setMsName] = useState('')
  const [msDate, setMsDate] = useState('')

  const addMilestone = () => {
    if (!msName.trim()) return
    if (engine) engine.createMilestone(projectId, msName.trim(), msDate || null) // onFlushed refetches on ack
    else void api.post('/api/v1/pm/milestones', { project_id: projectId, name: msName.trim(), target_date: msDate || null }).then(invalidate)
    setMsName(''); setMsDate(''); setAddMs(false)
  }

  // Milestone completion fraction: issues attached to it, weight = estimate ?? 1.
  const msProgress = (msId: string): number => {
    const rows = engine
      ? [...engine.store.issues.values()].filter((i) => i.milestone_id === msId && !i.deleted_at)
      : restIssues.filter((i) => i.milestone_id === msId)
    if (!rows.length) return 0
    let scope = 0
    let done = 0
    for (const r of rows) {
      const w = (r as PmIssueRow).estimate != null ? Number((r as PmIssueRow).estimate) : 1
      scope += w
      const cat = engine ? engine.store.states.get(r.state_id)?.category : undefined
      const isDone = engine ? cat === 'completed' : Boolean((r as { completed_at?: string | null }).completed_at)
      if (isDone) done += w
    }
    return scope ? done / scope : 0
  }

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 14 }}>
      <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--bord)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <DiamondGlyph size={12} color="var(--yellow)" />
        <span style={{ fontSize: 11.5, fontWeight: 800, flex: 1 }}>Milestones</span>
        <button onClick={() => setAddMs(true)} style={{ background: 'none', border: 'none', color: 'var(--blue)', fontSize: 10.5, fontWeight: 800, cursor: 'pointer' }}>+ Add</button>
      </div>
      {milestones.length === 0 && !addMs && (
        <div className="t-mute" style={{ padding: '16px 14px', fontSize: 11.5 }}>No milestones yet — break the outcome into checkpoints.</div>
      )}
      {milestones.map((m, mi) => {
        const frac = msProgress(m.id)
        const overdue = m.target_date && frac < 1 && new Date(m.target_date) < new Date()
        return (
          <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 10, height: 36, padding: '0 14px', borderBottom: mi < milestones.length - 1 || addMs ? '1px solid var(--bord)' : 'none' }}>
            <DiamondGlyph size={11} color={frac >= 1 ? 'var(--green)' : overdue ? 'var(--yellow)' : 'var(--text-faint)'} />
            <span style={{ flex: 1, fontSize: 12, fontWeight: 750, color: frac >= 1 ? 'var(--text-mute)' : '#fff' }}>{m.name}</span>
            <span style={{ width: 110 }}>
              <div style={{ height: 5, borderRadius: 99, background: 'var(--surf-2)', overflow: 'hidden' }}>
                <div style={{ width: `${frac * 100}%`, height: '100%', background: frac >= 1 ? 'var(--green)' : 'var(--blue)' }} />
              </div>
            </span>
            <span style={{ fontSize: 9.5, fontWeight: 700, color: overdue ? 'var(--yellow)' : 'var(--text-faint)', width: 52, textAlign: 'right' }}>
              {m.target_date ? new Date(m.target_date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—'}
            </span>
          </div>
        )
      })}
      {addMs && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, height: 38, padding: '0 14px' }}>
          <DiamondGlyph size={11} />
          <input autoFocus placeholder="Milestone name…" value={msName} onChange={(e) => setMsName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addMilestone(); if (e.key === 'Escape') setAddMs(false) }}
            style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: '#fff', fontSize: 12, fontWeight: 700, fontFamily: 'inherit' }} />
          <DateField value={msDate} onChange={setMsDate} style={{ height: 26, width: 130, fontSize: 10.5 }} />
          <Kbd>⏎</Kbd>
        </div>
      )}
    </div>
  )
})
