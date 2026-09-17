'use client'

import { useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { useQueryClient } from '@tanstack/react-query'
import { Btn, Icon } from '@/components/proto'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { DateField } from '@/components/ui/date-picker'
import { toast } from '@/components/ui/use-toast'
import { DiamondGlyph, Kbd } from '@/components/pm/glyphs'
import { RichEditor, RichView } from '@/components/pm/editor'
import { api } from '@/lib/api/client'
import { useAttachmentsEnabled } from '@/lib/api/queries/use-pm-files'
import { useIsMobile } from '@/lib/hooks/use-is-mobile'
import { modKey } from '@/lib/pm/files'
import { useAuthStore } from '@/lib/stores/auth.store'
import type { PmSyncEngine } from '@/lib/pm/engine'
import type { PmMilestoneRow, PmStateRow } from '@/lib/pm/types'
import type { ProjectDetailIssue } from './types'

// ─────────────────────────────────────────────────────────
// Project page — Milestones card (Round M, after Linear's project page):
//
//   ◆ Name ▾ · Jul 13 · 11 issues · 100%  ▬▬▬▬  🗑
//     └ folds open to the milestone's description (RichView; click to edit)
//
// Name renames inline, the date is a DateField, the count/percent are
// ISSUE-count based (not estimate points) and skip canceled issues — the
// same rule as the API's computeMilestoneSummary (the list rollup) and
// buildUpdateSnapshot (the update card's "0% → 100%"), so the three never
// disagree. The description saves through milestone.update. The "+ Add"
// flow is unchanged. Sync mode reads the engine graph; REST mode reads the
// detail payload's issue rows (timestamps stand in for state categories
// there).
// ─────────────────────────────────────────────────────────

// ── Progress helper — exported; the projects list's rollup reuses it ──

export interface MilestoneStats {
  /** Live, non-canceled issues on the milestone. */
  issues: number
  /** = `issues` (count-based scope; kept so callers read done/scope). */
  scope: number
  /** Live, non-canceled issues that are completed. */
  done: number
  /** Whole percent (rounded like the update card); 100 only when every issue is completed. */
  pct: number
}

export interface MilestoneStatIssue {
  state_id: string
  completed_at: string | null
  canceled_at: string | null
}

/** Anything with `.get(stateId)` — the mobx store's states map, or null in REST mode. */
export type StateLookup = { get(id: string): PmStateRow | undefined } | null | undefined

export const EMPTY_MILESTONE_STATS: MilestoneStats = { issues: 0, scope: 0, done: 0, pct: 0 }

/**
 * Issue-count based, canceled skipped (Linear's "11 issues · 100%"). With a
 * state map the category decides; without one (REST rows) the lifecycle
 * stamps do — `canceled_at` / `completed_at` are cleared when an issue
 * leaves the category, so they agree with the category rule. Percent is
 * rounded (the update card shows `Math.round(pct * 100)`), but never reads
 * 100 while an issue is still open.
 */
export function milestoneStats(rows: Iterable<MilestoneStatIssue>, states: StateLookup): MilestoneStats {
  let scope = 0
  let done = 0
  for (const r of rows) {
    const cat = states?.get(r.state_id)?.category
    const canceled = cat ? cat === 'canceled' : r.canceled_at != null
    if (canceled) continue
    scope += 1
    const completed = cat ? cat === 'completed' : r.completed_at != null
    if (completed) done += 1
  }
  const pct = scope > 0 ? (done >= scope ? 100 : Math.min(99, Math.round((done / scope) * 100))) : 0
  return { issues: scope, scope, done, pct }
}

type MilestonePatch = { name?: string; target_date?: string | null; description_md?: string | null }

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
  const qc = useQueryClient()
  // Same bar as the API (assertNotGuestTx + project visibility): any member
  // who can see the project edits milestones; guest and auditor seats read.
  const role = useAuthStore((s) => s.currentUser?.role)
  const canEdit = !!role && role !== 'GUEST' && role !== 'AUDITOR'
  const { rich } = useAttachmentsEnabled()

  const [addMs, setAddMs] = useState(false)
  const [msName, setMsName] = useState('')
  const [msDate, setMsDate] = useState('')
  const [deleting, setDeleting] = useState<PmMilestoneRow | null>(null)
  const [deletePending, setDeletePending] = useState(false)

  // ONE pass over the source rows, grouped by milestone (this render body is
  // observed, so a store change re-runs it).
  const statsById = new Map<string, MilestoneStats>()
  {
    const byMilestone = new Map<string, MilestoneStatIssue[]>()
    const rows: Iterable<MilestoneStatIssue & { milestone_id: string | null; deleted_at?: string | null }> = engine
      ? engine.store.issues.values()
      : restIssues
    for (const r of rows) {
      if (!r.milestone_id || r.deleted_at) continue
      const list = byMilestone.get(r.milestone_id)
      if (list) list.push(r)
      else byMilestone.set(r.milestone_id, [r])
    }
    for (const m of milestones) statsById.set(m.id, milestoneStats(byMilestone.get(m.id) ?? [], engine ? engine.store.states : null))
  }

  const refetch = () => qc.invalidateQueries({ queryKey: ['pm', 'project-detail', projectId] })

  const addMilestone = () => {
    if (!msName.trim()) return
    if (engine) engine.createMilestone(projectId, msName.trim(), msDate || null) // onFlushed refetches on ack
    else {
      // `position` appends like the engine does (milestonesForProject().length);
      // the server default 0 would sort a new row among the first ones.
      void api
        .post('/api/v1/pm/milestones', { project_id: projectId, name: msName.trim(), target_date: msDate || null, position: milestones.length })
        .then(invalidate)
        .catch((err: unknown) => toast({ title: 'Couldn’t add milestone', description: err instanceof Error ? err.message : 'Try again', variant: 'destructive' }))
    }
    setMsName(''); setMsDate(''); setAddMs(false)
  }

  /** Engine: optimistic + flushed (resolves at once). REST: PATCH, then the awaited refetch. */
  const patch = async (id: string, fields: MilestonePatch): Promise<void> => {
    if (engine) {
      engine.updateMilestone(id, fields)
      return
    }
    await api.patch(`/api/v1/pm/milestones/${id}`, fields)
    await refetch()
  }

  const confirmDelete = async () => {
    if (!deleting) return
    if (engine) {
      engine.deleteMilestone(deleting.id)
      setDeleting(null)
      return
    }
    setDeletePending(true)
    try {
      await api.post(`/api/v1/pm/milestones/${deleting.id}/delete`, {})
      await refetch()
      setDeleting(null)
    } catch (err) {
      toast({ title: 'Couldn’t delete', description: err instanceof Error ? err.message : 'Try again', variant: 'destructive' })
    } finally {
      setDeletePending(false)
    }
  }

  const deletingIssues = deleting ? statsById.get(deleting.id)?.issues ?? 0 : 0

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 14 }}>
      <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--bord)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <DiamondGlyph size={12} color="var(--yellow)" />
        <span style={{ fontSize: 11.5, fontWeight: 800, flex: 1 }}>Milestones</span>
        {milestones.length > 0 && (
          <span title={`${milestones.filter((m) => (statsById.get(m.id)?.pct ?? 0) >= 100).length} of ${milestones.length} milestones complete`}
            style={{ fontSize: 11, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--text-faint)' }}>
            {milestones.filter((m) => (statsById.get(m.id)?.pct ?? 0) >= 100).length}/{milestones.length}
          </span>
        )}
        {canEdit && (
          <button onClick={() => setAddMs(true)} style={{ background: 'none', border: 'none', color: 'var(--blue)', fontSize: 10.5, fontWeight: 800, cursor: 'pointer' }}>+ Add</button>
        )}
      </div>
      {milestones.length === 0 && !addMs && (
        <div className="t-mute" style={{ padding: '16px 14px', fontSize: 12 }}>
          {canEdit ? 'No milestones yet — break the project into checkpoints with “+ Add”.' : 'No milestones yet.'}
        </div>
      )}
      {milestones.map((m, mi) => (
        <MilestoneRow
          key={m.id}
          m={m}
          stats={statsById.get(m.id) ?? EMPTY_MILESTONE_STATS}
          canEdit={canEdit}
          rich={rich}
          last={mi === milestones.length - 1 && !addMs}
          onPatch={(fields) => patch(m.id, fields)}
          onDelete={() => setDeleting(m)}
        />
      ))}
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

      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title="Delete milestone"
        body={
          deleting
            ? `“${deleting.name}” will be removed from this project.${
                deletingIssues === 1
                  ? ' Its 1 issue stays in the project, unassigned from any milestone.'
                  : deletingIssues > 1
                    ? ` Its ${deletingIssues} issues stay in the project, unassigned from any milestone.`
                    : ''
              } This cannot be undone.`
            : ''
        }
        confirmLabel="Delete"
        danger
        loading={deletePending}
        loadingLabel="Deleting…"
        onConfirm={() => void confirmDelete()}
      />
    </div>
  )
})

// ─── One row ─────────────────────────────────────────────────────────────────

const fmtDate = (d: string | null | undefined) =>
  d ? new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—'

function Dot() {
  return <span aria-hidden style={{ color: 'var(--text-faint)', fontSize: 11, flexShrink: 0 }}>·</span>
}

function MilestoneRow({ m, stats, canEdit, rich, last, onPatch, onDelete }: {
  m: PmMilestoneRow
  stats: MilestoneStats
  canEdit: boolean
  rich: boolean
  last: boolean
  onPatch: (fields: MilestonePatch) => Promise<void>
  onDelete: () => void
}) {
  const mod = modKey()
  const mobile = useIsMobile()
  const [open, setOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [nameDraft, setNameDraft] = useState(m.name)
  // Escape cancels the rename; Chrome then fires blur on the input React is
  // removing, with the pre-Escape closure — this ref keeps that blur from
  // committing the text the user just threw away.
  const renameCancelledRef = useRef(false)
  const [editingDesc, setEditingDesc] = useState(false)
  const [descDraft, setDescDraft] = useState('')
  const [saving, setSaving] = useState(false)
  // REST-mode echo: what we just saved, shown until the awaited refetch
  // carries it (sync mode has the optimistic store row already).
  const [local, setLocal] = useState<MilestonePatch>({})

  const name = local.name ?? m.name
  const targetDate = local.target_date !== undefined ? local.target_date : m.target_date
  const desc = local.description_md !== undefined ? local.description_md ?? '' : m.description_md ?? ''
  const complete = stats.pct >= 100
  const overdue = !!targetDate && !complete && new Date(targetDate) < new Date()
  const tone = complete ? 'var(--green)' : overdue ? 'var(--yellow)' : 'var(--text-faint)'

  const commit = async (fields: MilestonePatch): Promise<boolean> => {
    setLocal((l) => ({ ...l, ...fields }))
    try {
      await onPatch(fields)
      return true
    } catch (err) {
      toast({ title: 'Couldn’t save', description: err instanceof Error ? err.message : 'Try again', variant: 'destructive' })
      return false
    } finally {
      setLocal({})
    }
  }

  const startRename = () => {
    if (!canEdit) return
    renameCancelledRef.current = false
    setNameDraft(name)
    setRenaming(true)
  }
  const cancelRename = () => {
    renameCancelledRef.current = true
    setNameDraft(name)
    setRenaming(false)
  }
  const commitRename = () => {
    if (!renaming || renameCancelledRef.current) return
    setRenaming(false)
    const next = nameDraft.trim()
    if (!next || next === name) return
    void commit({ name: next })
  }

  const startEditDesc = () => {
    if (!canEdit) return
    setDescDraft(desc)
    setEditingDesc(true)
  }
  const cancelDesc = () => {
    setEditingDesc(false)
    setDescDraft(desc)
  }
  const saveDesc = async () => {
    if (saving) return
    setSaving(true)
    try {
      if (descDraft.trim() === desc.trim() || (await commit({ description_md: descDraft }))) setEditingDesc(false)
    } finally {
      setSaving(false)
    }
  }

  const emptyDesc = (
    <div className="t-mute" style={{ fontSize: 12 }}>{canEdit ? 'Add a note for this milestone' : 'No notes yet'}</div>
  )

  // ── Cells — one 40 px line on desktop; on a phone (≤ 760 px) the
  //    `· date · issues · %  ▬▬` meta drops to a second line instead of
  //    squeezing the name to nothing. Built once, composed twice. ──
  const issuesLabel = `${stats.issues} ${stats.issues === 1 ? 'issue' : 'issues'}`
  const nameCell = renaming ? (
    <input
      autoFocus
      aria-label="Milestone name"
      value={nameDraft}
      onChange={(e) => setNameDraft(e.target.value)}
      onBlur={commitRename}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commitRename()
        if (e.key === 'Escape') cancelRename()
      }}
      style={{ flex: '0 1 auto', minWidth: 140, height: 26, padding: '0 6px', background: 'var(--surf-1)', border: '1px solid var(--bord)', borderRadius: 6, outline: 'none', color: '#fff', fontSize: 13, fontWeight: 750, fontFamily: 'inherit' }}
    />
  ) : (
    <span
      data-testid="milestone-name"
      role={canEdit ? 'button' : undefined}
      tabIndex={canEdit ? 0 : undefined}
      title={canEdit ? 'Click to rename' : undefined}
      onClick={startRename}
      onKeyDown={(e) => { if (canEdit && e.key === 'Enter') startRename() }}
      // Hover: a dotted underline says "editable" without the name looking like a field.
      onMouseEnter={(e) => { if (canEdit) { e.currentTarget.style.textDecoration = 'underline dotted'; e.currentTarget.style.textUnderlineOffset = '3px' } }}
      onMouseLeave={(e) => { e.currentTarget.style.textDecoration = 'none' }}
      style={{ fontWeight: 750, color: complete ? 'var(--text-mute)' : '#fff', cursor: canEdit ? 'text' : 'default', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, outline: 'none' }}
    >
      {name}
    </span>
  )
  const toggleCell = (
    <button
      type="button"
      data-testid="milestone-toggle"
      aria-expanded={open}
      aria-label={open ? 'Hide notes' : 'Show notes'}
      title={open ? 'Hide notes' : 'Show notes'}
      onClick={() => setOpen((o) => !o)}
      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 18, height: 18, borderRadius: 4, border: 'none', background: 'transparent', color: 'var(--text-faint)', cursor: 'pointer', flexShrink: 0, padding: 0 }}
    >
      <Icon.chevD size={12} style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .12s ease-out' }} />
    </button>
  )
  const dateCell = canEdit ? (
    <DateField
      value={targetDate ?? ''}
      onChange={(v) => void commit({ target_date: v || null })}
      placeholder="Add date"
      style={{ width: 'auto', height: 24, padding: '0 6px', gap: 5, background: 'transparent', border: '1px solid transparent', borderRadius: 6, fontSize: 11.5, fontWeight: 700, flexShrink: 0 }}
    />
  ) : (
    <span title={overdue ? 'Target date — passed' : 'Target date'} style={{ fontSize: 11.5, fontWeight: 700, color: overdue ? 'var(--yellow)' : 'var(--text-faint)', flexShrink: 0 }}>{fmtDate(targetDate)}</span>
  )
  const progressCell = (
    <span data-testid="milestone-progress" title={stats.issues ? `${stats.done} of ${issuesLabel} done` : 'No issues on this milestone yet'}
      style={{ fontSize: 11.5, fontWeight: 700, fontFamily: 'var(--font-mono)', color: complete ? 'var(--green)' : 'var(--text-faint)', whiteSpace: 'nowrap', flexShrink: 0 }}>
      {`${issuesLabel} · ${stats.pct}%`}
    </span>
  )
  // Bar: `--green` on the `--surf-2` track — the same fill as the header's
  // bar and the list's ring, so "done" reads as one colour everywhere.
  const barCell = (
    <span aria-hidden style={mobile ? { flex: '1 1 60px', minWidth: 60 } : { width: 90, flexShrink: 0 }}>
      <div style={{ height: 4, borderRadius: 99, background: 'var(--surf-2)', overflow: 'hidden' }}>
        <div style={{ width: `${stats.pct}%`, height: '100%', background: 'var(--green)', transition: 'width .2s ease-out' }} />
      </div>
    </span>
  )
  const trashCell = canEdit ? (
    <button
      type="button"
      title="Delete milestone"
      aria-label={`Delete ${name}`}
      onClick={onDelete}
      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, borderRadius: 6, background: 'transparent', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', flexShrink: 0, padding: 0 }}
      onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--coral)' }}
      onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-faint)' }}
    >
      <Icon.trash size={12} />
    </button>
  ) : null

  return (
    <div data-milestone-row={m.id} data-pct={stats.pct} style={{ borderBottom: last ? 'none' : '1px solid var(--bord)' }}>
      {mobile ? (
        <div style={{ padding: '7px 14px 8px', fontSize: 13, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 26, minWidth: 0 }}>
            <DiamondGlyph size={12} color={tone} />
            {nameCell}
            {toggleCell}
            <span style={{ flex: 1 }} />
            {trashCell}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3, paddingLeft: 20, minWidth: 0, flexWrap: 'wrap' }}>
            <Dot />
            {dateCell}
            <Dot />
            {progressCell}
            {barCell}
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 40, padding: '0 14px', fontSize: 13, minWidth: 0 }}>
          <DiamondGlyph size={12} color={tone} />
          {nameCell}
          {toggleCell}
          <Dot />
          {dateCell}
          <Dot />
          {progressCell}
          <span style={{ flex: 1 }} />
          {barCell}
          {trashCell}
        </div>
      )}

      {open && (
        <div data-testid="milestone-description" style={{ padding: '0 14px 12px 34px' }}>
          {editingDesc ? (
            <>
              {rich ? (
                <RichEditor
                  value={descDraft}
                  onChange={setDescDraft}
                  onSubmit={() => void saveDesc()}
                  placeholder="Describe this milestone — markdown supported"
                  minHeight={80}
                  autoFocus
                  compact
                />
              ) : (
                <textarea
                  autoFocus
                  className="input"
                  value={descDraft}
                  onChange={(e) => setDescDraft(e.target.value)}
                  placeholder="Describe this milestone — markdown supported"
                  style={{ width: '100%', minHeight: 90, resize: 'vertical', fontSize: 12.5, lineHeight: 1.6, padding: 10 }}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void saveDesc()
                    if (e.key === 'Escape') cancelDesc()
                  }}
                />
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, justifyContent: 'flex-end' }}>
                <Btn kind="ghost" size="sm" onClick={cancelDesc}>Cancel</Btn>
                <Btn kind="primary" size="sm" onClick={() => void saveDesc()} disabled={saving}>
                  Save <Kbd style={{ marginLeft: 5, background: 'rgba(255,255,255,.18)', border: 'none', color: '#fff' }}>{mod}↵</Kbd>
                </Btn>
              </div>
            </>
          ) : (
            <div
              onClick={(e) => {
                if ((e.target as HTMLElement).closest?.('a, img')) return
                startEditDesc()
              }}
              style={{ cursor: canEdit ? 'text' : 'default', minHeight: 22 }}
            >
              {rich ? (
                <RichView value={desc} empty={emptyDesc} />
              ) : desc ? (
                <div style={{ fontSize: 12.5, lineHeight: 1.65, color: 'var(--text)', whiteSpace: 'pre-wrap' }}>{desc}</div>
              ) : (
                emptyDesc
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
