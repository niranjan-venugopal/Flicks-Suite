// PM row shapes as shipped by the sync registry (packages/shared/src/pm).
// Issues arrive WITHOUT description — that's lazy-loaded on open.

export interface PmTeamRow {
  id: string
  key: string
  name: string
  icon: string | null
  color: string | null
  is_private: boolean
  timezone: string | null
  cycles_enabled: boolean
  cycle_length_weeks: number
  cooldown_days: number
  cycle_start_dow: number
  cycle_auto_add_started: boolean
  upcoming_cycles: number
  estimate_scale: string
  triage_enabled: boolean
  default_state_id: string | null
  created_at: string
  deleted_at: string | null
}

export interface PmMembershipRow {
  team_id: string
  user_id: string
  is_lead: boolean
  joined_at: string
}

export interface PmStateRow {
  id: string
  team_id: string
  name: string
  color: string
  category: 'triage' | 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled'
  position: number
  is_default_for_category: boolean
}

export interface PmLabelRow {
  id: string
  team_id: string | null
  name: string
  color: string
  description: string | null
}

export interface PmUserLite {
  id: string
  name: string | null
  avatar_url: string | null
}

export interface PmIssueRow {
  id: string
  team_id: string
  number: number
  title: string
  state_id: string
  priority: number
  estimate: string | null
  assignee_user_id: string | null
  creator_user_id: string | null
  parent_issue_id: string | null
  project_id: string | null
  milestone_id: string | null
  cycle_id: string | null
  due_date: string | null
  board_rank: string
  backlog_rank: string
  source: string
  triaged_at: string | null
  snoozed_until: string | null
  started_at: string | null
  completed_at: string | null
  canceled_at: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
  /** client-only: true while a local mutation on this row is unconfirmed */
  _pending?: boolean
}

export interface PmProjectRow {
  id: string
  name: string
  summary: string | null
  icon: string | null
  color: string | null
  status: 'backlog' | 'planned' | 'in_progress' | 'paused' | 'completed' | 'canceled'
  health: 'on_track' | 'at_risk' | 'off_track'
  lead_user_id: string | null
  start_date: string | null
  target_date: string | null
  deal_id: string | null
  completed_at: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
  _pending?: boolean
}

export interface PmMilestoneRow {
  id: string
  project_id: string
  name: string
  target_date: string | null
  position: number
  created_at: string
}

export interface PmUpdateRow {
  id: string
  project_id: string
  health: 'on_track' | 'at_risk' | 'off_track'
  body_md: string
  author_user_id: string | null
  created_at: string
}

export interface PmInitiativeRow {
  id: string
  name: string
  description: string | null
  status: 'active' | 'completed' | 'paused'
  owner_user_id: string | null
  target_quarter: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export interface PmCycleRow {
  id: string
  team_id: string
  number: number
  starts_at: string
  ends_at: string
  cooldown_ends_at: string
  status: 'upcoming' | 'active' | 'completed'
  created_at: string
}

export interface PendingMutation {
  clientMutationId: string
  op: string
  id: string
  fields?: Record<string, unknown>
  /** inverse patch for rollback-on-reject (table → id → partial row or null=remove) */
  inverse?: { table: string; id: string; row: Record<string, unknown> | null }
  enqueuedAt: number
}
