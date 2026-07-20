import { makeAutoObservable, observable, runInAction } from 'mobx'
import type {
  PmIssueRow,
  PmLabelRow,
  PmMembershipRow,
  PmStateRow,
  PmTeamRow,
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
      }
    })
  }

  applyTombstones(table: string, ids: string[]) {
    runInAction(() => {
      for (const id of ids) {
        if (table === 'pm_issues') this.issues.delete(id)
        else if (table === 'pm_teams') this.teams.delete(id)
        else if (table === 'pm_workflow_states') this.states.delete(id)
        else if (table === 'pm_labels') this.labels.delete(id)
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
      this.cursor = 0
      this.hydrated = false
    })
  }
}
