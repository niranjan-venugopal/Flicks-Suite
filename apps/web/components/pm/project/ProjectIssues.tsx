'use client'

import Link from 'next/link'
import { observer } from 'mobx-react-lite'
import { useQueryClient } from '@tanstack/react-query'
import { Btn, Icon } from '@/components/proto'
import { PriorityGlyph, StateGlyph } from '@/components/pm/glyphs'
import { issueHref } from '@/lib/pm/nav'
import { issuePrefetchProps } from '@/lib/pm/prefetch'
import type { PmSyncEngine } from '@/lib/pm/engine'
import type { ProjectIssueLite } from './types'

// ─────────────────────────────────────────────────────────
// Project page — embedded Issues card. Split out of the page in Round M
// (verbatim move). The composer modal itself stays on the page.
// ─────────────────────────────────────────────────────────

export interface ProjectIssuesProps {
  projectId: string
  engine: PmSyncEngine | null
  /** Live engine rows in sync mode, REST rows otherwise (the page picks). */
  issues: ProjectIssueLite[]
  /** Opens the IssueComposer (rendered by the page). */
  onNewIssue: () => void
  /** True only for a genuinely team-less workspace (the page computes this). */
  newIssueDisabled: boolean
}

export const ProjectIssues = observer(function ProjectIssues({
  projectId,
  engine,
  issues,
  onNewIssue,
  newIssueDisabled,
}: ProjectIssuesProps) {
  const qc = useQueryClient()
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ padding: '8px 10px 8px 14px', borderBottom: '1px solid var(--bord)', display: 'flex', alignItems: 'center' }}>
        <span style={{ fontSize: 12.5, fontWeight: 800, flex: 1 }}>Issues · {issues.length}</span>
        {/* Round E — a real button (the old text link read as decoration),
            and never dead while teams are still loading: the composer
            loads its own team list on open, so only a genuinely
            team-less workspace disables it. */}
        <Btn
          kind="secondary"
          size="sm"
          icon={<Icon.plus size={12} />}
          onClick={onNewIssue}
          disabled={newIssueDisabled}
        >
          New issue
        </Btn>
      </div>
      {issues.length === 0 && <div className="t-mute" style={{ padding: '16px 14px', fontSize: 12.5 }}>No issues attached — set a project on issues from the list or detail page.</div>}
      {issues.map((i) => {
        const st = engine?.store.states.get(i.state_id)
        const team = engine?.store.teams.get(i.team_id)
        // Round L (7) — a client-side <Link>, not a plain <a href>: the
        // anchor was a FULL document reload (JS re-parse, /me gate,
        // engine restart) — the "2 seconds to open an issue". The route
        // prefetches in the viewport; hovering warms the detail query.
        // (8) — the project is the origin Back returns to.
        return (
          <Link key={i.id} href={issueHref(i.id, `/pm/projects/${projectId}`)} data-issue-row={i.id}
            {...issuePrefetchProps(qc, i.id)}
            style={{ display: 'flex', alignItems: 'center', gap: 9, height: 38, minWidth: 0, padding: '0 12px', borderBottom: '1px solid var(--bord)', textDecoration: 'none' }}>
            {st && <StateGlyph cat={st.category} size={13} />}
            <span style={{ fontSize: 10.5, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--text-mute)', width: 58, flexShrink: 0 }}>
              {team?.key ?? ''}-{i.number}
            </span>
            <PriorityGlyph p={i.priority} size={13} />
            <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 700, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{i.title}</span>
          </Link>
        )
      })}
    </div>
  )
})
