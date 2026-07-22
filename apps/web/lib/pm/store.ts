import { makeAutoObservable, observable, runInAction } from 'mobx'
import type {
  PmCycleRow,
  PmInitiativeRow,
  PmIssueRow,
  PmLabelRow,
  PmMembershipRow,
  PmMilestoneRow,
  PmProjectRow,
  PmStateRow,
  PmTeamRow,
  PmUpdateRow,
  PmUserLite,
} from './types'

/**
 * FSE in-memory object graph (PRD v6 §3.1). One store per (user, tenant);
 * hydrated from IndexedDB (warm) or bootstrap NDJSON (cold); mutated
 * optimistically by the engine and authoritatively by delta upserts —
 * snapshots always win (last write from the server is the truth).
 */
export class PmStore {
  teams = observable.map<string, PmTeamRow>()
  states = observable.map<string, PmStateRow>()
  labels = observable.map<string, PmLabelRow>()
  users = observable.map<string, PmUserLite>()
  issues = observable.map<string, PmIssueRow>()
  /** team_id → members */
  memberships = observable.map<string, PmMembershipRow[]>()
  /** issue_id → label ids / subscriber user ids */
  issueLabels = observable.map<string, string[]>()
  issueSubscribers = observable.map<string, string[]>()
  // Projects layer (§6)
  projects = observable.map<string, PmProjectRow>()
  milestones = observable.map<string, PmMilestoneRow>()
  projectUpdates = observable.map<string, PmUpdateRow>()
  initiatives = observable.map<string, PmInitiativeRow>()
  /** project_id → team ids / member user ids */
  projectTeams = observable.map<string, string[]>()
  projectMembers = observable.map<string, string[]>()
  /** initiative_id → ordered project ids */
  initiativeProjects = observable.map<string, string[]>()
  cycles = observable.map<string, PmCycleRow>()

  cursor = 0
  hydrated = false
  online = true
  pendingCount = 0

  constructor() {
    makeAutoObservable(this, {
      teams: false,
      states: false,
      labels: false,
      users: false,
      issues: false,
      memberships: false,
      issueLabels: false,
      issueSubscribers: false,
      projects: false,
      milestones: false,
      projectUpdates: false,
      initiatives: false,
      projectTeams: false,
      projectMembers: false,
      initiativeProjects: false,
      cycles: false,
    })
  }

  // ─── derived reads (computed on demand — spike keeps them as methods) ─────

  teamList(): PmTeamRow[] {
    return [...this.teams.values()].filter((t) => !t.deleted_at)
  }

  statesForTeam(teamId: string): PmStateRow[] {
    return [...this.states.values()]
      .filter((s) => s.team_id === teamId)
      .sort((a, b) => a.position - b.position)
  }

  issuesForTeam(teamId: string): PmIssueRow[] {
    return [...this.issues.values()].filter((i) => i.team_id === teamId && !i.deleted_at)
  }

  projectList(): PmProjectRow[] {
    return [...this.projects.values()].filter((p) => !p.deleted_at)
  }

  milestonesForProject(projectId: string): PmMilestoneRow[] {
    return [...this.milestones.values()]
      .filter((m) => m.project_id === projectId)
      .sort((a, b) => a.position - b.position || (a.created_at < b.created_at ? -1 : 1))
  }

  updatesForProject(projectId: string): PmUpdateRow[] {
    return [...this.projectUpdates.values()]
      .filter((u) => u.project_id === projectId)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
  }

  /**
   * §6.1 — computed progress: scope/started/done by estimate points, per-issue
   * fallback weight 1 (degrades to count). Canceled issues excluded. Same
   * formula the server uses for REST responses.
   */
  projectProgress(projectId: string): { scope: number; started: number; done: number } {
    const out = { scope: 0, started: 0, done: 0 }
    for (const i of this.issues.values()) {
      if (i.project_id !== projectId || i.deleted_at) continue
      const cat = this.states.get(i.state_id)?.category
      if (cat === 'canceled') continue
      const w = i.estimate != null ? Number(i.estimate) : 1
      out.scope += w
      if (cat === 'completed') out.done += w
      else if (cat === 'started') out.started += w
    }
    return out
  }

  // ─── writes (engine only) ─────────────────────────────────────────────────

  applyRows(table: string, rows: Record<string, unknown>[]) {
    runInAction(() => {
      for (const row of rows) {
        switch (table) {
          case 'pm_teams':
            this.teams.set(row.id as string, row as unknown as PmTeamRow)
            break
          case 'pm_workflow_states':
            this.states.set(row.id as string, row as unknown as PmStateRow)
            break
          case 'pm_labels':
            this.labels.set(row.id as string, row as unknown as PmLabelRow)
            break
          case 'pm_users_lite':
            this.users.set(row.id as string, row as unknown as PmUserLite)
            break
          case 'pm_issues': {
            const incoming = row as unknown as PmIssueRow
            const existing = this.issues.get(incoming.id)
            // Server snapshot clears the pending badge for this row.
            this.issues.set(incoming.id, { ...existing, ...incoming, _pending: false })
            break
          }
          case 'pm_team_memberships': {
            const m = row as unknown as PmMembershipRow
            const list = this.memberships.get(m.team_id) ?? []
            this.memberships.set(m.team_id, [...list.filter((x) => x.user_id !== m.user_id), m])
            break
          }
          case 'pm_issue_labels': {
            const r = row as { issue_id: string; label_id: string }
            const list = this.issueLabels.get(r.issue_id) ?? []
            if (!list.includes(r.label_id)) this.issueLabels.set(r.issue_id, [...list, r.label_id])
            break
          }
          case 'pm_issue_subscribers': {
            const r = row as { issue_id: string; user_id: string }
            const list = this.issueSubscribers.get(r.issue_id) ?? []
            if (!list.includes(r.user_id)) this.issueSubscribers.set(r.issue_id, [...list, r.user_id])
            break
          }
          case 'pm_projects': {
            const incoming = row as unknown as PmProjectRow
            const existing = this.projects.get(incoming.id)
            this.projects.set(incoming.id, { ...existing, ...incoming, _pending: false })
            break
          }
          case 'pm_project_milestones':
            this.milestones.set(row.id as string, row as unknown as PmMilestoneRow)
            break
          case 'pm_project_updates':
            this.projectUpdates.set(row.id as string, row as unknown as PmUpdateRow)
            break
          case 'pm_initiatives':
            this.initiatives.set(row.id as string, row as unknown as PmInitiativeRow)
            break
          case 'pm_project_teams': {
            const r = row as { project_id: string; team_id: string }
            const list = this.projectTeams.get(r.project_id) ?? []
            if (!list.includes(r.team_id)) this.projectTeams.set(r.project_id, [...list, r.team_id])
            break
          }
          case 'pm_project_members': {
            const r = row as { project_id: string; user_id: string }
            const list = this.projectMembers.get(r.project_id) ?? []
            if (!list.includes(r.user_id)) this.projectMembers.set(r.project_id, [...list, r.user_id])
            break
          }
          case 'pm_cycles':
            this.cycles.set(row.id as string, row as unknown as PmCycleRow)
            break
          case 'pm_initiative_projects': {
            const r = row as { initiative_id: string; project_id: string }
            const list = this.initiativeProjects.get(r.initiative_id) ?? []
            if (!list.includes(r.project_id)) this.initiativeProjects.set(r.initiative_id, [...list, r.project_id])
            break
          }
          default:
            break
        }
      }
    })
  }

  /** Issue-scoped collections replace wholesale for the given issue ids. */
  replaceScopedCollections(table: string, scopeIssueIds: string[], rows: Record<string, unknown>[]) {
    runInAction(() => {
      if (table === 'pm_issue_labels') {
        for (const id of scopeIssueIds) this.issueLabels.set(id, [])
        for (const r of rows as Array<{ issue_id: string; label_id: string }>) {
          const list = this.issueLabels.get(r.issue_id) ?? []
          this.issueLabels.set(r.issue_id, [...list, r.label_id])
        }
      } else if (table === 'pm_issue_subscribers') {
        for (const id of scopeIssueIds) this.issueSubscribers.set(id, [])
        for (const r of rows as Array<{ issue_id: string; user_id: string }>) {
          const list = this.issueSubscribers.get(r.issue_id) ?? []
          this.issueSubscribers.set(r.issue_id, [...list, r.user_id])
        }
      } else if (table === 'pm_project_teams') {
        for (const id of scopeIssueIds) this.projectTeams.set(id, [])
        for (const r of rows as Array<{ project_id: string; team_id: string }>) {
          const list = this.projectTeams.get(r.project_id) ?? []
          this.projectTeams.set(r.project_id, [...list, r.team_id])
        }
      } else if (table === 'pm_project_members') {
        for (const id of scopeIssueIds) this.projectMembers.set(id, [])
        for (const r of rows as Array<{ project_id: string; user_id: string }>) {
          const list = this.projectMembers.get(r.project_id) ?? []
          this.projectMembers.set(r.project_id, [...list, r.user_id])
        }
      } else if (table === 'pm_initiative_projects') {
        for (const id of scopeIssueIds) this.initiativeProjects.set(id, [])
        for (const r of rows as Array<{ initiative_id: string; project_id: string }>) {
          const list = this.initiativeProjects.get(r.initiative_id) ?? []
          this.initiativeProjects.set(r.initiative_id, [...list, r.project_id])
        }
      }
    })
  }

  applyTombstones(table: string, ids: string[]) {
    runInAction(() => {
      for (const id of ids) {
        if (table === 'pm_issues') this.issues.delete(id)
        else if (table === 'pm_teams') {
          // Losing a team (deleted OR visibility revoked, §16) purges every
          // team-scoped row locally — a revoked member keeps nothing.
          this.teams.delete(id)
          this.memberships.delete(id)
          for (const [sid, s] of this.states) if (s.team_id === id) this.states.delete(sid)
          for (const [iid, i] of this.issues) {
            if (i.team_id === id) {
              this.issues.delete(iid)
              this.issueLabels.delete(iid)
              this.issueSubscribers.delete(iid)
            }
          }
        } else if (table === 'pm_workflow_states') this.states.delete(id)
        else if (table === 'pm_labels') this.labels.delete(id)
        else if (table === 'pm_projects') {
          // Losing a project (deleted OR visibility lost) purges its scoped rows.
          this.projects.delete(id)
          this.projectTeams.delete(id)
          this.projectMembers.delete(id)
          for (const [mid, m] of this.milestones) if (m.project_id === id) this.milestones.delete(mid)
          for (const [uid, u] of this.projectUpdates) if (u.project_id === id) this.projectUpdates.delete(uid)
          for (const [iid, list] of this.initiativeProjects) {
            if (list.includes(id)) this.initiativeProjects.set(iid, list.filter((p) => p !== id))
          }
        } else if (table === 'pm_project_milestones') this.milestones.delete(id)
        else if (table === 'pm_project_updates') this.projectUpdates.delete(id)
        else if (table === 'pm_cycles') this.cycles.delete(id)
        else if (table === 'pm_initiatives') {
          this.initiatives.delete(id)
          this.initiativeProjects.delete(id)
        }
      }
    })
  }

  /** Optimistic local patch; returns the pre-image for rollback. */
  patchIssue(id: string, patch: Partial<PmIssueRow>): PmIssueRow | null {
    const prev = this.issues.get(id) ?? null
    runInAction(() => {
      const base = this.issues.get(id)
      if (base) this.issues.set(id, { ...base, ...patch, _pending: true })
    })
    return prev ? { ...prev } : null
  }

  insertIssue(row: PmIssueRow) {
    runInAction(() => this.issues.set(row.id, { ...row, _pending: true }))
  }

  removeIssue(id: string) {
    runInAction(() => this.issues.delete(id))
  }

  restoreIssue(row: PmIssueRow) {
    runInAction(() => this.issues.set(row.id, row))
  }

  setCursor(seq: number) {
    runInAction(() => {
      this.cursor = Math.max(this.cursor, seq)
    })
  }

  setHydrated(v: boolean) {
    runInAction(() => {
      this.hydrated = v
    })
  }

  setOnline(v: boolean) {
    runInAction(() => {
      this.online = v
    })
  }

  setPendingCount(n: number) {
    runInAction(() => {
      this.pendingCount = n
    })
  }

  activeCycleForTeam(teamId: string): PmCycleRow | null {
    for (const c of this.cycles.values()) if (c.team_id === teamId && c.status === 'active') return c
    return null
  }

  /** Triage conveyor rows: triage-category state, not snoozed (§8). */
  triageIssuesForTeam(teamId: string): PmIssueRow[] {
    const now = new Date().toISOString()
    return [...this.issues.values()]
      .filter((i) => {
        if (i.team_id !== teamId || i.deleted_at) return false
        if (i.snoozed_until && i.snoozed_until > now) return false
        return this.states.get(i.state_id)?.category === 'triage'
      })
      .sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
  }

  /** Optimistic project patch; returns the pre-image for undo/rollback. */
  patchProject(id: string, patch: Partial<PmProjectRow>): PmProjectRow | null {
    const prev = this.projects.get(id) ?? null
    runInAction(() => {
      const base = this.projects.get(id)
      if (base) this.projects.set(id, { ...base, ...patch, _pending: true })
    })
    return prev ? { ...prev } : null
  }

  clearAll() {
    runInAction(() => {
      this.teams.clear()
      this.states.clear()
      this.labels.clear()
      this.users.clear()
      this.issues.clear()
      this.memberships.clear()
      this.issueLabels.clear()
      this.issueSubscribers.clear()
      this.projects.clear()
      this.milestones.clear()
      this.projectUpdates.clear()
      this.initiatives.clear()
      this.projectTeams.clear()
      this.projectMembers.clear()
      this.initiativeProjects.clear()
      this.cycles.clear()
      this.cursor = 0
      this.hydrated = false
    })
  }
}
