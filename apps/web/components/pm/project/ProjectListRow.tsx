'use client'

import type { MouseEvent } from 'react'
import { Icon } from '@/components/proto'
import { DiamondGlyph, HealthChip, PM_PRIORITY_LABEL, PriorityGlyph } from '@/components/pm/glyphs'
import { PmAv, ProjectLogo, TeamKeyChips } from '@/components/pm/projects'
import { useIsMobile } from '@/lib/hooks/use-is-mobile'
import { ProgressRing, progressPct } from './ProgressRing'
import { milestoneStats } from './ProjectMilestones'
import type { PmStore } from '@/lib/pm/store'
import type { PmIssueRow, PmProjectRow, PmTeamRow } from '@/lib/pm/types'

// ─────────────────────────────────────────────────────────
// Round M — ONE projects-list row for both transports (sync store / REST):
// logo · name (+ lock, deal chip) · health · priority glyph · progress ring
// with P% · milestones done/total · lead · target date · team chips · trash.
// 46 px tall, 13.5 px name. The whole row opens the project; the trash
// stops propagation (crm/companies does the same).
//
// Phone (≤ 760 px, the app's `useIsMobile` breakpoint): the fixed columns
// add up to ~460 px, so the row becomes two lines instead of clipping under
// the card's overflow — line 1 keeps logo · name · ring % · trash, line 2
// carries health · priority · milestones · lead · target date · teams.
// ─────────────────────────────────────────────────────────

export interface ProjectProgress {
  scope: number
  started: number
  done: number
}

export interface MilestoneSummary {
  done: number
  total: number
}

export const EMPTY_PROGRESS: ProjectProgress = { scope: 0, started: 0, done: 0 }
export const EMPTY_MILESTONES: MilestoneSummary = { done: 0, total: 0 }

export interface ProjectListRowProps {
  p: PmProjectRow
  progress: ProjectProgress
  milestones: MilestoneSummary
  teamIds: string[]
  teams: Map<string, PmTeamRow>
  leadName: string
  leadAvatarUrl: string | null
  onOpen: () => void
  /** Omitted when the viewer may not delete this project. */
  onDelete?: () => void
}

const MONO = 'var(--font-mono)'

export function ProjectListRow({ p, progress, milestones, teamIds, teams, leadName, leadAvatarUrl, onOpen, onDelete }: ProjectListRowProps) {
  const mobile = useIsMobile()
  const overdue = !!p.target_date && p.status === 'in_progress' && new Date(p.target_date) < new Date()
  const pct = progressPct(progress)
  // Rows cached before 0064 may lack the column — treat missing as 0.
  const priority = p.priority ?? 0
  const allMilestonesDone = milestones.total > 0 && milestones.done === milestones.total
  const points = (n: number) => `${n} ${n === 1 ? 'point' : 'points'}`

  // ── Cells (built once; composed as one line on desktop, two on a phone) ──
  const nameCell = (
    <span style={{ flex: '1 1 160px', minWidth: 0, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={{ fontSize: 13.5, fontWeight: 800, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
      {p.is_private && (
        <span title="Private project" aria-label="Private project" style={{ display: 'inline-flex', flexShrink: 0 }}>
          <Icon.lock size={11} style={{ color: 'var(--text-faint)' }} />
        </span>
      )}
      {p.deal_id && (
        <span title="Created from a CRM deal" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '0 7px', height: 16, borderRadius: 99, background: 'rgba(39,210,128,.1)', border: '1px solid rgba(39,210,128,.35)', fontSize: 9, fontWeight: 800, color: 'var(--green)', flexShrink: 0 }}>
          <Icon.funnel size={9} />deal
        </span>
      )}
    </span>
  )
  const healthCell = <HealthChip h={p.health} small />
  // Priority — hidden at 0 (a same-width spacer keeps the columns aligned).
  const priorityCell = priority > 0 ? (
    <span data-testid="row-priority" data-priority={priority} title={`Priority · ${PM_PRIORITY_LABEL[priority]}`} aria-label={`Priority ${PM_PRIORITY_LABEL[priority]}`}
      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 16, flexShrink: 0 }}>
      <PriorityGlyph p={priority} size={14} />
    </span>
  ) : (
    <span aria-hidden style={{ width: 16, flexShrink: 0 }} />
  )
  // Progress — the ClickUp rollup: ring + whole percent of estimate points done.
  const progressCell = (
    <span title={progress.scope ? `${progress.done} of ${points(progress.scope)} done · ${progress.started} in progress` : 'No issues yet'}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, width: 64, flexShrink: 0 }}>
      <ProgressRing pct={pct} />
      <span style={{ fontSize: 12, fontWeight: 800, fontFamily: MONO, color: pct >= 100 ? 'var(--green)' : 'var(--text-2)' }}>{pct}%</span>
    </span>
  )
  // Milestones — done = milestones at 100 %.
  const milestonesCell = (
    <span data-testid="row-milestones" data-done={milestones.done} data-total={milestones.total}
      title={milestones.total ? `${milestones.done} of ${milestones.total} milestones complete` : 'No milestones'}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, width: 48, flexShrink: 0, fontSize: 11.5, fontWeight: 700, fontFamily: MONO, color: allMilestonesDone ? 'var(--green)' : 'var(--text-faint)' }}>
      {milestones.total > 0 && (
        <>
          <DiamondGlyph size={9} color={allMilestonesDone ? 'var(--green)' : 'var(--text-faint)'} />
          {milestones.done}/{milestones.total}
        </>
      )}
    </span>
  )
  const leadCell = leadName ? (
    <span title={`Lead · ${leadName}`} style={{ display: 'inline-flex', flexShrink: 0 }}><PmAv name={leadName} src={leadAvatarUrl} size={18} /></span>
  ) : (
    <span aria-hidden style={{ width: 18, flexShrink: 0 }} />
  )
  const dateCell = (
    <span title={p.target_date ? (overdue ? 'Target date — passed' : 'Target date') : 'No target date'}
      style={{ fontSize: 11, fontWeight: 700, color: overdue ? 'var(--yellow)' : 'var(--text-faint)', width: 56, textAlign: mobile ? 'left' : 'right', flexShrink: 0 }}>
      {p.target_date ? new Date(p.target_date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—'}
    </span>
  )
  const teamsCell = (
    <span style={{ display: 'inline-flex', justifyContent: 'flex-end', minWidth: mobile ? 0 : 40 }}>
      <TeamKeyChips teamIds={teamIds} teams={teams} />
    </span>
  )
  const trashCell = onDelete ? (
    <button
      type="button"
      title="Delete project"
      aria-label={`Delete ${p.name}`}
      onClick={(e) => { e.stopPropagation(); onDelete() }}
      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, borderRadius: 6, background: 'transparent', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', flexShrink: 0 }}
      onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--coral)' }}
      onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-faint)' }}
    >
      <Icon.trash size={13} />
    </button>
  ) : null

  const rowStyle = { borderBottom: '1px solid var(--bord)', cursor: 'pointer', minWidth: 0, transition: 'background .12s ease-out' } as const
  const hover = {
    onMouseEnter: (e: MouseEvent<HTMLDivElement>) => { e.currentTarget.style.background = 'var(--surf-1)' },
    onMouseLeave: (e: MouseEvent<HTMLDivElement>) => { e.currentTarget.style.background = 'transparent' },
  }

  if (mobile) {
    return (
      <div data-project-row={p.id} onClick={onOpen} style={{ ...rowStyle, padding: '8px 14px 9px' }} {...hover}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 28, minWidth: 0 }}>
          <ProjectLogo logoUrl={p.logo_url} icon={p.icon} size={20} />
          {nameCell}
          {progressCell}
          {trashCell}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4, paddingLeft: 30, minWidth: 0, flexWrap: 'wrap' }}>
          {healthCell}
          {priorityCell}
          {milestonesCell}
          {leadCell}
          {dateCell}
          {teamsCell}
        </div>
      </div>
    )
  }

  return (
    <div data-project-row={p.id} onClick={onOpen} style={{ ...rowStyle, display: 'flex', alignItems: 'center', gap: 12, height: 46, padding: '0 14px' }} {...hover}>
      <ProjectLogo logoUrl={p.logo_url} icon={p.icon} size={20} />
      {nameCell}
      {healthCell}
      {priorityCell}
      {progressCell}
      {milestonesCell}
      {leadCell}
      {dateCell}
      {teamsCell}
      {trashCell}
    </div>
  )
}

// ─── Sync-mode rollup (the REST list ships `milestones` from the server) ─────

/**
 * Milestones done/total for EVERY project in one pass over the issue graph —
 * the same rule as the API's `computeMilestoneSummary` (issue-count based,
 * canceled skipped; done ⇔ scope > 0 and every live issue completed), with
 * `milestoneStats` deciding per milestone exactly as the project page does.
 */
export function projectMilestoneSummaryAll(store: PmStore): Map<string, MilestoneSummary> {
  const byMilestone = new Map<string, PmIssueRow[]>()
  for (const i of store.issues.values()) {
    if (!i.milestone_id || i.deleted_at) continue
    const list = byMilestone.get(i.milestone_id)
    if (list) list.push(i)
    else byMilestone.set(i.milestone_id, [i])
  }
  const out = new Map<string, MilestoneSummary>()
  for (const m of store.milestones.values()) {
    let agg = out.get(m.project_id)
    if (!agg) out.set(m.project_id, (agg = { done: 0, total: 0 }))
    agg.total += 1
    if (milestoneStats(byMilestone.get(m.id) ?? [], store.states).pct === 100) agg.done += 1
  }
  return out
}

// ─── Sorting ─────────────────────────────────────────────────────────────────

export type ProjectSort = 'target' | 'priority' | 'progress' | 'name'

export const PROJECT_SORTS: ReadonlyArray<[ProjectSort, string]> = [
  ['target', 'Target date'],
  ['priority', 'Priority'],
  ['progress', 'Progress'],
  ['name', 'Name'],
]

/** Target date ascending, undated last, name as the tiebreak (the list's long-standing default). */
function byTarget(a: PmProjectRow, b: PmProjectRow): number {
  const ta = a.target_date ?? '9999'
  const tb = b.target_date ?? '9999'
  return ta < tb ? -1 : ta > tb ? 1 : a.name.localeCompare(b.name)
}

/** Priority rank for sorting: 1 urgent … 4 low, then 0 "no priority" last. */
const priorityRank = (p: number | undefined) => (!p ? 5 : p)

export function sortProjects(list: ReadonlyArray<PmProjectRow>, sort: ProjectSort, pctOf: (id: string) => number): PmProjectRow[] {
  const out = [...list]
  switch (sort) {
    case 'priority':
      return out.sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || byTarget(a, b))
    case 'progress':
      return out.sort((a, b) => pctOf(b.id) - pctOf(a.id) || byTarget(a, b))
    case 'name':
      return out.sort((a, b) => a.name.localeCompare(b.name))
    default:
      return out.sort(byTarget)
  }
}
