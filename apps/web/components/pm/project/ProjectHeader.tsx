'use client'

import { useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { Icon } from '@/components/proto'
import { DateField } from '@/components/ui/date-picker'
import { HealthChip, PmProgressBar, PM_PRIORITY_LABEL, PM_PROJECT_STATUS_LABEL, PendingDot, PriorityGlyph } from '@/components/pm/glyphs'
import { PmAv, PROJECT_ICONS, ProjectLogo } from '@/components/pm/projects'
import type { PmStore } from '@/lib/pm/store'
import type { PmProjectRow } from '@/lib/pm/types'

// ─────────────────────────────────────────────────────────
// Project page — header card: logo / icon / name, status, health, lead, dates,
// delete, progress bar. Split out of the page in Round M (verbatim move).
// ─────────────────────────────────────────────────────────

export interface ProjectHeaderProps {
  /** Live engine row overlaid on the REST detail (the page merges them). */
  project: PmProjectRow
  /** The REST payload's summary (d.project.summary) — what the header showed before the split. */
  summary: string | null
  progress: { scope: number; started: number; done: number }
  logoUrl: string | null
  leadName: string
  users: PmStore['users'] | null
  mayDelete: boolean
  patchProject: (patch: Partial<PmProjectRow>) => void
  /** Opens the logo crop modal (rendered by the page). */
  onOpenLogo: () => void
  /** Opens the delete confirmation (rendered by the page). */
  onDelete: () => void
}

export const ProjectHeader = observer(function ProjectHeader({
  project,
  summary,
  progress,
  logoUrl,
  leadName,
  users,
  mayDelete,
  patchProject,
  onOpenLogo,
  onDelete,
}: ProjectHeaderProps) {
  // ── Rename / re-icon in place (founder round C) ───────────────────────────
  // The backend and engine accepted {name, icon} since P11; only the header UI
  // was missing. Blank names are dropped client-side to match the server's
  // non-blank guard; an icon outside the stock list is offered as-is so the
  // select doesn't silently rewrite it.
  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  // Escape must not commit: Chrome fires blur on the input React removes,
  // with the pre-Escape draft still in the closure (same guard as milestones).
  const renameCancelledRef = useRef(false)
  const cancelRename = () => { renameCancelledRef.current = true; setEditingName(false) }
  const commitName = () => {
    setEditingName(false)
    if (renameCancelledRef.current) { renameCancelledRef.current = false; return }
    const next = nameDraft.trim()
    if (next && next !== project.name) patchProject({ name: next })
  }
  const currentIcon = project.icon ?? '🎯'
  const iconOptions = PROJECT_ICONS.includes(currentIcon) ? PROJECT_ICONS : [currentIcon, ...PROJECT_ICONS]

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      {/* One line while it fits (founder round E: the delete button wrapped
          under the logo once the name + dates filled the row) — the NAME is
          the only element that gives up width (ellipsis, minWidth 60), so on a
          desktop nothing wraps. Round M lets the row wrap only when even the
          shrunken name can't fit (a 390 px phone), instead of overflowing the
          card and giving the page a horizontal scroll. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, rowGap: 8, flexWrap: 'wrap', marginBottom: 9, minWidth: 0 }}>
        {/* Round E — the project's face: uploaded logo (click to change)
            or the emoji icon picker. */}
        <button
          type="button"
          title={logoUrl ? 'Change or remove the project logo' : 'Upload a project logo'}
          onClick={onOpenLogo}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34, borderRadius: 9, background: 'var(--surf-1)', border: '1px solid var(--bord)', cursor: 'pointer', padding: 0, flexShrink: 0 }}
        >
          {logoUrl ? <ProjectLogo logoUrl={logoUrl} icon={currentIcon} size={30} /> : <Icon.image size={14} style={{ color: 'var(--text-faint)' }} />}
        </button>
        <select
          className="input"
          title="Project icon"
          aria-label="Project icon"
          value={currentIcon}
          onChange={(e) => patchProject({ icon: e.target.value })}
          style={{ height: 30, width: 46, padding: '0 4px', fontSize: 16, flexShrink: 0 }}
        >
          {iconOptions.map((e) => <option key={e}>{e}</option>)}
        </select>
        {editingName ? (
          <input
            autoFocus
            className="input"
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitName()
              if (e.key === 'Escape') cancelRename()
            }}
            style={{ height: 32, flex: '0 1 280px', minWidth: 120, fontSize: 15, fontWeight: 800, letterSpacing: '-0.02em' }}
          />
        ) : (
          <span
            title={project.name}
            onClick={() => { setNameDraft(project.name); setEditingName(true) }}
            style={{ fontSize: 17, fontWeight: 800, letterSpacing: '-0.02em', cursor: 'text', minWidth: 60, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {project.name}
          </span>
        )}
        {project.is_private && (
          <span title="Private project — only members, the lead and owners/admins can see it"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--text-mute)', fontSize: 10, fontWeight: 800, flexShrink: 0 }}>
            <Icon.lock size={12} /> Private
          </span>
        )}
        {project._pending && <PendingDot />}
        <select className="input" title="Project status" aria-label="Project status" value={project.status} onChange={(e) => patchProject({ status: e.target.value as PmProjectRow['status'] })}
          style={{ height: 28, width: 116, fontSize: 11, fontWeight: 800, flexShrink: 0 }}>
          {Object.entries(PM_PROJECT_STATUS_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        {/* Round M — project priority on the issue scale. A native select can't
            hold SVG, so the glyph sits beside it and tracks the value. Rows
            cached before 0064 may lack the column: missing reads as 0. */}
        <span title="Project priority" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
          <PriorityGlyph p={project.priority ?? 0} size={13} />
          <select
            className="input"
            data-testid="project-priority"
            aria-label="Project priority"
            value={project.priority ?? 0}
            onChange={(e) => patchProject({ priority: Number(e.target.value) })}
            style={{ height: 28, width: 104, fontSize: 11, fontWeight: 800, flexShrink: 0 }}
          >
            {PM_PRIORITY_LABEL.map((l, p) => <option key={p} value={p}>{l}</option>)}
          </select>
        </span>
        <HealthChip h={project.health} />
        <span style={{ flex: 1 }} />
        {/* Lead + dates: shrink and wrap on a phone instead of forcing the card wider. */}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 9, flexShrink: 1, minWidth: 0, flexWrap: 'wrap' }}>
          {leadName && (
            <span title={leadName} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700 }}>
              <PmAv name={leadName} src={project.lead_user_id ? users?.get(project.lead_user_id)?.avatar_url : null} size={18} />
              <span style={{ maxWidth: 110, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{leadName}</span>
            </span>
          )}
          <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-mute)', display: 'inline-flex', gap: 5, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>
            <DateField value={project.start_date ?? ''} onChange={(iso) => patchProject({ start_date: iso || null })} style={{ height: 26, width: 112, fontSize: 10 }} />
            →
            <DateField value={project.target_date ?? ''} onChange={(iso) => patchProject({ target_date: iso || null })} style={{ height: 26, width: 112, fontSize: 10 }} />
          </span>
          {mayDelete && (
            <button
              type="button"
              title="Delete project"
              aria-label="Delete project"
              onClick={onDelete}
              style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 7, background: 'var(--surf-1)', border: '1px solid var(--bord)', color: 'var(--text-mute)', cursor: 'pointer' }}
              onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--coral)' }}
              onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-mute)' }}
            >
              <Icon.trash size={14} />
            </button>
          )}
        </span>
      </div>
      {summary && <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)', marginBottom: 10 }}>{summary}</div>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ flex: 1 }}><PmProgressBar {...progress} h={7} /></span>
        <span style={{ fontSize: 10, fontWeight: 800, fontFamily: 'var(--font-mono)', color: 'var(--text-mute)' }}>
          {progress.done} done · {progress.started} started · {progress.scope} scope
        </span>
      </div>
    </div>
  )
})
