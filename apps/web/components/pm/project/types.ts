import type { PmIssueRow, PmMilestoneRow, PmProjectRow, PmUpdateRow } from '@/lib/pm/types'

// ─────────────────────────────────────────────────────────
// Round M — the project page's data contract, shared by the page
// (app/(app)/pm/projects/[id]/page.tsx) and the cards under this folder.
// Mirrors `GET /api/v1/pm/projects/:id/detail` (projects.service.ts `detail`).
// ─────────────────────────────────────────────────────────

/** One row of the lazy REST issue list. Timestamps are ISO strings on the wire. */
export interface ProjectDetailIssue {
  id: string
  team_id: string
  number: number
  title: string
  state_id: string
  priority: number
  estimate: string | null
  assignee_user_id: string | null
  milestone_id: string | null
  due_date: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
  canceled_at: string | null
}

export interface ProjectDetail {
  project: PmProjectRow & { description_md: string | null; summary: string | null }
  milestones: PmMilestoneRow[]
  updates: PmUpdateRow[]
  team_ids: string[]
  member_ids: string[]
  issues: ProjectDetailIssue[]
  progress: { scope: number; started: number; done: number }
}

/** The issue subset the page's cards render — live engine rows or REST rows. */
export type ProjectIssueLite = Pick<PmIssueRow, 'id' | 'team_id' | 'number' | 'title' | 'state_id' | 'priority'>
