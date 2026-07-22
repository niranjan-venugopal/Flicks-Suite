import { io, type Socket } from 'socket.io-client'
import { rankBetween } from '@flicks/shared/pm'
import { api } from '@/lib/api/client'
import { PmStore } from './store'
import { openPmDb, destroyPmDb, loadSnapshot, persistTables, persistPending, type PmDb } from './idb'
import type { PendingMutation, PmIssueRow, PmProjectRow, PmUpdateRow } from './types'

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'
const FLUSH_DEBOUNCE_MS = 250
const PERSIST_DEBOUNCE_MS = 400
const POLL_FALLBACK_MS = 30_000

interface DeltaResponse {
  upserts: Record<string, unknown>
  tombstones: Record<string, string[]>
  latest_seq: number
  min_seq_horizon: number
}

/**
 * FSE client engine (PRD v6 §3). Owns the store, IndexedDB persistence, the
 * /sync socket, the delta puller and the optimistic mutation queue. One engine
 * per (tenant, user); constructed by PmProvider when the pm_sync_engine flag
 * is on. Design notes:
 * - Optimistic apply happens synchronously in the store (<50ms budget); the
 *   network flush is debounced and batched.
 * - Every queued mutation carries an inverse patch; a rejection rolls back
 *   exactly that patch and surfaces a toast via onReject.
 * - Seq-race healing: any ping ≤ cursor still pulls with since = seq - 1;
 *   snapshot deltas are idempotent so overlap is harmless.
 * - The queue persists in IndexedDB and replays in order on reconnect;
 *   duplicates are no-ops server-side (idempotency ledger).
 */
export class PmSyncEngine {
  readonly store = new PmStore()
  private db: PmDb | null = null
  private socket: Socket | null = null
  private queue: PendingMutation[] = []
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private flushing = false
  private pulling = false
  private destroyed = false

  /** Undo/redo (§3.7): last 50 local actions; entries emit NORMAL mutations. */
  private undoStack: Array<{ undo: () => void; redo: () => void }> = []
  private redoStack: Array<{ undo: () => void; redo: () => void }> = []

  onReject: ((message: string) => void) | null = null

  constructor(
    private readonly tenantId: string,
    private readonly userId: string,
  ) {}

  // ─── lifecycle ────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.db = await openPmDb(this.tenantId, this.userId)
    let snapshot = this.db ? await loadSnapshot(this.db) : null
    // Disposable-cache doctrine (§3.8): bootstrap always yields ≥1 team, so a
    // snapshot without teams is poisoned (e.g. persisted during a failed
    // session) — and delta can never repair it because the cursor is already
    // past the seeding events. Discard and cold-boot instead of rendering an
    // empty workspace forever.
    if (snapshot && (snapshot.tables.pm_teams ?? []).length === 0) {
      this.db?.close()
      this.db = null
      await destroyPmDb(this.tenantId, this.userId)
      this.db = await openPmDb(this.tenantId, this.userId)
      snapshot = null
    }
    if (snapshot) {
      // WARM boot: render from the local cache instantly, then catch up.
      for (const [table, rows] of Object.entries(snapshot.tables)) {
        this.store.applyRows(table, rows)
      }
      this.queue = snapshot.pending
      this.store.setPendingCount(this.queue.length)
      this.store.setCursor(snapshot.cursor)
      this.store.setHydrated(true)
      void this.pullDelta()
      void this.flushQueue()
    } else {
      await this.bootstrap()
      // Server-side bootstrap self-seeds the workspace; zero teams here means
      // something is genuinely wrong — surface REST fallback, not a spinner.
      if (this.store.teams.size === 0) throw new Error('BOOTSTRAP_EMPTY')
    }
    this.connectSocket()
    this.pollTimer = setInterval(() => void this.pullDelta(), POLL_FALLBACK_MS)
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.handleOnline)
      window.addEventListener('offline', this.handleOffline)
      this.store.setOnline(navigator.onLine)
    }
  }

  destroy(): void {
    this.destroyed = true
    this.socket?.disconnect()
    if (this.pollTimer) clearInterval(this.pollTimer)
    if (this.flushTimer) clearTimeout(this.flushTimer)
    if (this.persistTimer) clearTimeout(this.persistTimer)
    // Close the IDB connection: a leaked handle blocks any later
    // deleteDatabase (reset/poison recovery) and lets a dead engine's
    // late persists race the live one's.
    this.db?.close()
    this.db = null
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.handleOnline)
      window.removeEventListener('offline', this.handleOffline)
    }
  }

  /** "Reset local data" — wipe the cache and re-bootstrap (§3.7). */
  async reset(): Promise<void> {
    this.queue = []
    this.store.clearAll()
    this.store.setPendingCount(0)
    this.db?.close() // deleteDatabase blocks while our own connection is open
    this.db = null
    await destroyPmDb(this.tenantId, this.userId)
    this.db = await openPmDb(this.tenantId, this.userId)
    await this.bootstrap()
  }

  private handleOnline = () => {
    this.store.setOnline(true)
    void this.flushQueue()
    void this.pullDelta()
  }

  private handleOffline = () => this.store.setOnline(false)

  // ─── bootstrap / delta ───────────────────────────────────────────────────

  private async bootstrap(): Promise<void> {
    const res = await fetch(`${BASE_URL}/api/v1/pm/sync/bootstrap`, { credentials: 'include' })
    if (res.status === 400) throw new Error('SYNC_DISABLED')
    if (!res.ok) throw new Error(`bootstrap failed: ${res.status}`)
    const text = await res.text()
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      const parsed = JSON.parse(line) as
        | { model: string; rows: Record<string, unknown>[] }
        | { latest_seq: number; min_seq_horizon: number }
      if ('model' in parsed) {
        this.store.applyRows(parsed.model, parsed.rows)
      } else {
        this.store.setCursor(parsed.latest_seq)
      }
    }
    this.store.setHydrated(true)
    this.schedulePersist()
  }

  /** Pull a delta. `hintSeq` from a socket ping applies the healing rule. */
  async pullDelta(hintSeq?: number): Promise<void> {
    if (this.pulling || this.destroyed) return
    this.pulling = true
    try {
      const since =
        hintSeq !== undefined && hintSeq <= this.store.cursor
          ? Math.max(0, hintSeq - 1) // healing: a stale-looking ping still re-pulls
          : this.store.cursor
      const res = await api.get<DeltaResponse>(`/api/v1/pm/sync/delta?since=${since}`)
      for (const [table, value] of Object.entries(res.upserts ?? {})) {
        if (table.endsWith('__scope')) continue
        const scope = (res.upserts as Record<string, unknown>)[`${table}__scope`] as string[] | undefined
        if (scope) {
          this.store.replaceScopedCollections(table, scope, value as Record<string, unknown>[])
        } else {
          this.store.applyRows(table, value as Record<string, unknown>[])
        }
      }
      for (const [table, ids] of Object.entries(res.tombstones ?? {})) {
        this.store.applyTombstones(table, ids)
      }
      this.store.setCursor(res.latest_seq)
      this.schedulePersist()
    } catch (err) {
      if (err instanceof Error && /410|RE_BOOTSTRAP/.test(err.message)) {
        await this.reset()
      }
      // network errors: the 30s poll retries
    } finally {
      this.pulling = false
    }
  }

  private connectSocket(): void {
    const socket = io(`${BASE_URL}/sync`, {
      withCredentials: true,
      transports: ['websocket', 'polling'],
      reconnectionDelayMax: 15_000,
    })
    this.socket = socket
    socket.on('seq', (p: { seq: number }) => void this.pullDelta(p.seq))
    socket.on('connect', () => void this.pullDelta())
  }

  // ─── undo / redo ──────────────────────────────────────────────────────────

  private pushUndo(entry: { undo: () => void; redo: () => void }): void {
    this.undoStack.push(entry)
    if (this.undoStack.length > 50) this.undoStack.shift()
    this.redoStack = [] // a fresh action invalidates the redo branch
  }

  undo(): boolean {
    const entry = this.undoStack.pop()
    if (!entry) return false
    entry.undo()
    this.redoStack.push(entry)
    return true
  }

  redo(): boolean {
    const entry = this.redoStack.pop()
    if (!entry) return false
    entry.redo()
    this.undoStack.push(entry)
    return true
  }

  // ─── optimistic mutations ─────────────────────────────────────────────────

  /** Create an issue locally (instant) and queue the server mutation. */
  createIssue(input: {
    team_id: string
    title: string
    state_id?: string
    priority?: number
    assignee_user_id?: string | null
  }): string {
    const id = crypto.randomUUID()
    const team = this.store.teams.get(input.team_id)
    const states = this.store.statesForTeam(input.team_id)
    const stateId =
      input.state_id ??
      team?.default_state_id ??
      states.find((s) => s.category === 'backlog')?.id ??
      states[0]?.id ??
      ''
    const teamIssues = this.store.issuesForTeam(input.team_id)
    const lastBoard = teamIssues.reduce<string | null>(
      (m, i) => (m === null || i.board_rank > m ? i.board_rank : m),
      null,
    )
    const lastBacklog = teamIssues.reduce<string | null>(
      (m, i) => (m === null || i.backlog_rank > m ? i.backlog_rank : m),
      null,
    )
    const now = new Date().toISOString()
    const row: PmIssueRow = {
      id,
      team_id: input.team_id,
      number: 0, // provisional — the server's counter assigns the real one
      title: input.title,
      state_id: stateId,
      priority: input.priority ?? 0,
      estimate: null,
      assignee_user_id: input.assignee_user_id ?? null,
      creator_user_id: this.userId,
      parent_issue_id: null,
      project_id: null,
      milestone_id: null,
      cycle_id: null,
      due_date: null,
      board_rank: rankBetween(lastBoard, null),
      backlog_rank: rankBetween(lastBacklog, null),
      source: 'manual',
      triaged_at: null,
      snoozed_until: null,
      started_at: null,
      completed_at: null,
      canceled_at: null,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    }
    this.store.insertIssue(row)
    this.enqueue({
      clientMutationId: crypto.randomUUID(),
      op: 'issue.create',
      id,
      fields: {
        team_id: input.team_id,
        title: input.title,
        state_id: stateId,
        priority: input.priority,
        assignee_user_id: input.assignee_user_id ?? undefined,
      },
      inverse: { table: 'pm_issues', id, row: null }, // rollback = remove
      enqueuedAt: Date.now(),
    })
    this.pushUndo({
      undo: () => this.deleteIssue(id, { recordUndo: false }),
      redo: () => this.restoreDeletedIssue(id, { recordUndo: false }),
    })
    return id
  }

  deleteIssue(id: string, opts: { recordUndo?: boolean } = {}): void {
    const prev = this.store.issues.get(id)
    if (!prev) return
    const snapshot = { ...prev }
    this.store.patchIssue(id, { deleted_at: new Date().toISOString() })
    this.store.removeIssue(id)
    this.enqueue({
      clientMutationId: crypto.randomUUID(),
      op: 'issue.delete',
      id,
      inverse: { table: 'pm_issues', id, row: snapshot as unknown as Record<string, unknown> },
      enqueuedAt: Date.now(),
    })
    if (opts.recordUndo !== false) {
      this.pushUndo({
        undo: () => this.restoreDeletedIssue(id, { recordUndo: false }),
        redo: () => this.deleteIssue(id, { recordUndo: false }),
      })
    }
  }

  restoreDeletedIssue(id: string, _opts: { recordUndo?: boolean } = {}): void {
    this.enqueue({
      clientMutationId: crypto.randomUUID(),
      op: 'issue.restore',
      id,
      enqueuedAt: Date.now(),
    })
    // Row re-appears via the authoritative response / delta.
  }

  updateIssue(
    id: string,
    fields: { title?: string; description?: string; due_date?: string | null; estimate?: string | null },
    opts: { recordUndo?: boolean } = {},
  ): void {
    const prev = this.store.patchIssue(id, { ...(fields as Partial<PmIssueRow>), updated_at: new Date().toISOString() })
    this.enqueue({
      clientMutationId: crypto.randomUUID(),
      op: 'issue.update',
      id,
      fields,
      inverse: { table: 'pm_issues', id, row: prev as unknown as Record<string, unknown> | null },
      enqueuedAt: Date.now(),
    })
    if (opts.recordUndo !== false && prev) {
      const inverseFields: Record<string, unknown> = {}
      for (const k of Object.keys(fields)) inverseFields[k] = (prev as unknown as Record<string, unknown>)[k]
      this.pushUndo({
        undo: () => this.updateIssue(id, inverseFields as never, { recordUndo: false }),
        redo: () => this.updateIssue(id, fields, { recordUndo: false }),
      })
    }
  }

  moveIssueState(id: string, stateId: string, opts: { recordUndo?: boolean } = {}): void {
    const prev = this.store.patchIssue(id, { state_id: stateId, updated_at: new Date().toISOString() })
    this.enqueue({
      clientMutationId: crypto.randomUUID(),
      op: 'issue.move_state',
      id,
      fields: { state_id: stateId },
      inverse: { table: 'pm_issues', id, row: prev as unknown as Record<string, unknown> | null },
      enqueuedAt: Date.now(),
    })
    if (opts.recordUndo !== false && prev) {
      const prevStateId = prev.state_id
      this.pushUndo({
        undo: () => this.moveIssueState(id, prevStateId, { recordUndo: false }),
        redo: () => this.moveIssueState(id, stateId, { recordUndo: false }),
      })
    }
  }

  setIssuePriority(id: string, priority: number, opts: { recordUndo?: boolean } = {}): void {
    const prev = this.store.patchIssue(id, { priority })
    this.enqueue({
      clientMutationId: crypto.randomUUID(),
      op: 'issue.set_priority',
      id,
      fields: { priority },
      inverse: { table: 'pm_issues', id, row: prev as unknown as Record<string, unknown> | null },
      enqueuedAt: Date.now(),
    })
    if (opts.recordUndo !== false && prev) {
      const prevPriority = prev.priority
      this.pushUndo({
        undo: () => this.setIssuePriority(id, prevPriority, { recordUndo: false }),
        redo: () => this.setIssuePriority(id, priority, { recordUndo: false }),
      })
    }
  }

  assignIssue(id: string, assigneeUserId: string | null, opts: { recordUndo?: boolean } = {}): void {
    const prev = this.store.patchIssue(id, { assignee_user_id: assigneeUserId })
    this.enqueue({
      clientMutationId: crypto.randomUUID(),
      op: 'issue.assign',
      id,
      fields: { assignee_user_id: assigneeUserId },
      inverse: { table: 'pm_issues', id, row: prev as unknown as Record<string, unknown> | null },
      enqueuedAt: Date.now(),
    })
    if (opts.recordUndo !== false && prev) {
      const prevAssignee = prev.assignee_user_id
      this.pushUndo({
        undo: () => this.assignIssue(id, prevAssignee, { recordUndo: false }),
        redo: () => this.assignIssue(id, assigneeUserId, { recordUndo: false }),
      })
    }
  }

  /** Board/backlog re-rank (fractional index computed by the caller). */
  rankIssue(id: string, rankField: 'board_rank' | 'backlog_rank', rank: string): void {
    const prev = this.store.patchIssue(id, { [rankField]: rank } as never)
    this.enqueue({
      clientMutationId: crypto.randomUUID(),
      op: 'issue.rank',
      id,
      fields: { rank_field: rankField, rank },
      inverse: { table: 'pm_issues', id, row: prev as unknown as Record<string, unknown> | null },
      enqueuedAt: Date.now(),
    })
  }

  /** Bulk apply a property to many issues in ONE queue burst (§9.4, cap 500). */
  bulkApply(ids: string[], apply: (id: string) => void): void {
    for (const id of ids.slice(0, 500)) apply(id)
  }

  setIssueProject(id: string, projectId: string | null, milestoneId?: string | null): void {
    const prev = this.store.patchIssue(id, {
      project_id: projectId,
      milestone_id: projectId ? (milestoneId !== undefined ? milestoneId : this.store.issues.get(id)?.milestone_id ?? null) : null,
      updated_at: new Date().toISOString(),
    })
    this.enqueue({
      clientMutationId: crypto.randomUUID(),
      op: 'issue.set_project',
      id,
      fields: { project_id: projectId, ...(milestoneId !== undefined ? { milestone_id: milestoneId } : {}) },
      inverse: { table: 'pm_issues', id, row: prev as unknown as Record<string, unknown> | null },
      enqueuedAt: Date.now(),
    })
  }

  relateIssues(id: string, relatedIssueId: string, type: 'blocks' | 'duplicate_of' | 'relates_to'): void {
    // duplicate_of also moves the issue to the Duplicate state server-side —
    // optimistically mirror the state hop so the conveyor clears instantly.
    if (type === 'duplicate_of') {
      const issue = this.store.issues.get(id)
      const dup = issue
        ? this.store.statesForTeam(issue.team_id).find((s) => s.category === 'canceled' && s.name === 'Duplicate')
          ?? this.store.statesForTeam(issue.team_id).find((s) => s.category === 'canceled')
        : null
      if (dup) this.store.patchIssue(id, { state_id: dup.id, canceled_at: new Date().toISOString() })
    }
    this.enqueue({
      clientMutationId: crypto.randomUUID(),
      op: 'issue.relate',
      id,
      fields: { related_issue_id: relatedIssueId, type },
      enqueuedAt: Date.now(),
    })
  }

  setIssueCycle(id: string, cycleId: string | null): void {
    const prev = this.store.patchIssue(id, { cycle_id: cycleId, updated_at: new Date().toISOString() })
    this.enqueue({
      clientMutationId: crypto.randomUUID(),
      op: 'issue.set_cycle',
      id,
      fields: { cycle_id: cycleId },
      inverse: { table: 'pm_issues', id, row: prev as unknown as Record<string, unknown> | null },
      enqueuedAt: Date.now(),
    })
  }

  /** Shift+T (§8). Optimistically moves to the team's triage state. */
  sendToTriage(id: string): void {
    const issue = this.store.issues.get(id)
    const triage = issue
      ? this.store.statesForTeam(issue.team_id).find((s) => s.category === 'triage')
      : null
    const prev = triage
      ? this.store.patchIssue(id, { state_id: triage.id, triaged_at: null, updated_at: new Date().toISOString() })
      : null
    this.enqueue({
      clientMutationId: crypto.randomUUID(),
      op: 'issue.send_to_triage',
      id,
      inverse: { table: 'pm_issues', id, row: prev as unknown as Record<string, unknown> | null },
      enqueuedAt: Date.now(),
    })
  }

  triageAccept(id: string, opts: { priority?: number; assignee_user_id?: string | null } = {}): void {
    const issue = this.store.issues.get(id)
    const team = issue ? this.store.teams.get(issue.team_id) : null
    const target = team?.default_state_id
      ?? (issue ? this.store.statesForTeam(issue.team_id).find((s) => s.category === 'backlog')?.id : null)
    const prev = target
      ? this.store.patchIssue(id, {
          state_id: target,
          triaged_at: new Date().toISOString(),
          snoozed_until: null,
          ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
          ...(opts.assignee_user_id !== undefined ? { assignee_user_id: opts.assignee_user_id } : {}),
          updated_at: new Date().toISOString(),
        })
      : null
    this.enqueue({
      clientMutationId: crypto.randomUUID(),
      op: 'issue.triage_accept',
      id,
      fields: { ...opts },
      inverse: { table: 'pm_issues', id, row: prev as unknown as Record<string, unknown> | null },
      enqueuedAt: Date.now(),
    })
  }

  triageDecline(id: string, reason?: string): void {
    const issue = this.store.issues.get(id)
    const canceled = issue
      ? this.store.statesForTeam(issue.team_id).find((s) => s.category === 'canceled')
      : null
    const prev = canceled
      ? this.store.patchIssue(id, { state_id: canceled.id, canceled_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      : null
    this.enqueue({
      clientMutationId: crypto.randomUUID(),
      op: 'issue.triage_decline',
      id,
      fields: reason ? { reason } : {},
      inverse: { table: 'pm_issues', id, row: prev as unknown as Record<string, unknown> | null },
      enqueuedAt: Date.now(),
    })
  }

  snoozeIssue(id: string, until: string | null): void {
    const prev = this.store.patchIssue(id, { snoozed_until: until, updated_at: new Date().toISOString() })
    this.enqueue({
      clientMutationId: crypto.randomUUID(),
      op: 'issue.snooze',
      id,
      fields: { until },
      inverse: { table: 'pm_issues', id, row: prev as unknown as Record<string, unknown> | null },
      enqueuedAt: Date.now(),
    })
  }

  // ─── projects layer (§6) ──────────────────────────────────────────────────

  createProject(input: {
    name: string
    icon?: string | null
    summary?: string | null
    status?: PmProjectRow['status']
    lead_user_id?: string | null
    start_date?: string | null
    target_date?: string | null
    team_ids?: string[]
  }): string {
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    const row: PmProjectRow = {
      id,
      name: input.name,
      summary: input.summary ?? null,
      icon: input.icon ?? null,
      color: null,
      status: input.status ?? 'planned',
      health: 'on_track',
      lead_user_id: input.lead_user_id ?? this.userId,
      start_date: input.start_date ?? null,
      target_date: input.target_date ?? null,
      deal_id: null,
      completed_at: null,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    }
    this.store.applyRows('pm_projects', [{ ...row, _pending: true } as unknown as Record<string, unknown>])
    if (input.team_ids?.length) {
      this.store.replaceScopedCollections(
        'pm_project_teams',
        [id],
        input.team_ids.map((team_id) => ({ project_id: id, team_id })),
      )
    }
    this.enqueue({
      clientMutationId: crypto.randomUUID(),
      op: 'project.create',
      id,
      fields: { ...input },
      inverse: { table: 'pm_projects', id, row: null },
      enqueuedAt: Date.now(),
    })
    return id
  }

  updateProject(
    id: string,
    fields: Partial<Pick<PmProjectRow, 'name' | 'summary' | 'icon' | 'color' | 'status' | 'lead_user_id' | 'start_date' | 'target_date'>>,
  ): void {
    const prev = this.store.patchProject(id, { ...fields, updated_at: new Date().toISOString() })
    this.enqueue({
      clientMutationId: crypto.randomUUID(),
      op: 'project.update',
      id,
      fields,
      inverse: { table: 'pm_projects', id, row: prev as unknown as Record<string, unknown> | null },
      enqueuedAt: Date.now(),
    })
  }

  setProjectTeams(id: string, teamIds: string[]): void {
    this.store.replaceScopedCollections(
      'pm_project_teams',
      [id],
      teamIds.map((team_id) => ({ project_id: id, team_id })),
    )
    this.enqueue({
      clientMutationId: crypto.randomUUID(),
      op: 'project.set_teams',
      id,
      fields: { team_ids: teamIds },
      enqueuedAt: Date.now(),
    })
  }

  /** §6.3 — post a health update; latest health denormalizes locally too. */
  postProjectUpdate(projectId: string, health: PmUpdateRow['health'], bodyMd: string): string {
    const updateId = crypto.randomUUID()
    this.store.applyRows('pm_project_updates', [{
      id: updateId,
      project_id: projectId,
      health,
      body_md: bodyMd,
      author_user_id: this.userId,
      created_at: new Date().toISOString(),
    }])
    this.store.patchProject(projectId, { health })
    this.enqueue({
      clientMutationId: crypto.randomUUID(),
      op: 'project.post_update',
      id: projectId,
      fields: { update_id: updateId, health, body_md: bodyMd },
      enqueuedAt: Date.now(),
    })
    return updateId
  }

  deleteProject(id: string): void {
    const prev = this.store.projects.get(id)
    this.store.applyTombstones('pm_projects', [id])
    this.enqueue({
      clientMutationId: crypto.randomUUID(),
      op: 'project.delete',
      id,
      inverse: { table: 'pm_projects', id, row: prev ? ({ ...prev } as unknown as Record<string, unknown>) : null },
      enqueuedAt: Date.now(),
    })
  }

  createMilestone(projectId: string, name: string, targetDate?: string | null): string {
    const id = crypto.randomUUID()
    const position = this.store.milestonesForProject(projectId).length
    this.store.applyRows('pm_project_milestones', [{
      id, project_id: projectId, name, target_date: targetDate ?? null, position,
      created_at: new Date().toISOString(),
    }])
    this.enqueue({
      clientMutationId: crypto.randomUUID(),
      op: 'milestone.create',
      id,
      fields: { project_id: projectId, name, target_date: targetDate ?? null, position },
      enqueuedAt: Date.now(),
    })
    return id
  }

  updateMilestone(id: string, fields: { name?: string; target_date?: string | null; position?: number }): void {
    const prev = this.store.milestones.get(id)
    if (prev) this.store.applyRows('pm_project_milestones', [{ ...prev, ...fields } as unknown as Record<string, unknown>])
    this.enqueue({
      clientMutationId: crypto.randomUUID(),
      op: 'milestone.update',
      id,
      fields,
      enqueuedAt: Date.now(),
    })
  }

  deleteMilestone(id: string): void {
    this.store.applyTombstones('pm_project_milestones', [id])
    this.enqueue({
      clientMutationId: crypto.randomUUID(),
      op: 'milestone.delete',
      id,
      enqueuedAt: Date.now(),
    })
  }

  createInitiative(input: { name: string; description?: string | null; target_quarter?: string | null }): string {
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    this.store.applyRows('pm_initiatives', [{
      id, name: input.name, description: input.description ?? null, status: 'active',
      owner_user_id: this.userId, target_quarter: input.target_quarter ?? null,
      created_at: now, updated_at: now, deleted_at: null,
    }])
    this.enqueue({
      clientMutationId: crypto.randomUUID(),
      op: 'initiative.create',
      id,
      fields: { ...input },
      enqueuedAt: Date.now(),
    })
    return id
  }

  setInitiativeProjects(id: string, projectIds: string[]): void {
    this.store.replaceScopedCollections(
      'pm_initiative_projects',
      [id],
      projectIds.map((project_id, i) => ({ initiative_id: id, project_id, position: i })),
    )
    this.enqueue({
      clientMutationId: crypto.randomUUID(),
      op: 'initiative.set_projects',
      id,
      fields: { project_ids: projectIds },
      enqueuedAt: Date.now(),
    })
  }

  // ─── queue mechanics ──────────────────────────────────────────────────────

  private enqueue(m: PendingMutation): void {
    this.queue.push(m)
    this.store.setPendingCount(this.queue.length)
    if (this.db) void persistPending(this.db, this.queue)
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = setTimeout(() => void this.flushQueue(), FLUSH_DEBOUNCE_MS)
  }

  async flushQueue(): Promise<void> {
    if (this.flushing || this.destroyed || this.queue.length === 0) return
    if (typeof navigator !== 'undefined' && !navigator.onLine) return
    // Multi-tab: serialize flushes across tabs of the same (tenant, user) so
    // two tabs never race the same idb-persisted queue (duplicates would be
    // idempotent no-ops server-side, but the lock keeps it clean and cheap).
    if (typeof navigator !== 'undefined' && 'locks' in navigator) {
      await navigator.locks.request(
        `fs-pm-flush-${this.tenantId}-${this.userId}`,
        { ifAvailable: true },
        async (lock) => {
          if (lock) await this.flushQueueInner()
        },
      )
      return
    }
    await this.flushQueueInner()
  }

  private async flushQueueInner(): Promise<void> {
    if (this.flushing || this.destroyed || this.queue.length === 0) return
    this.flushing = true
    const batch = this.queue.slice(0, 50)
    try {
      const res = await api.post<{
        results: Array<{ clientMutationId: string; status: string; errorCode?: string; rows?: Record<string, Record<string, unknown>[]> }>
        latest_seq: number
      }>('/api/v1/pm/sync/mutate', {
        items: batch.map(({ clientMutationId, op, id, fields }) => ({ clientMutationId, op, id, fields })),
      })
      const byId = new Map(res.results.map((r) => [r.clientMutationId, r]))
      for (const item of batch) {
        const result = byId.get(item.clientMutationId)
        if (!result) continue
        if (result.status === 'applied' || result.status === 'duplicate') {
          for (const [table, rows] of Object.entries(result.rows ?? {})) {
            this.store.applyRows(table, rows)
          }
        } else {
          // Rejected: roll back exactly this item's optimistic patch.
          if (item.inverse) {
            if (item.inverse.table === 'pm_projects') {
              if (item.inverse.row === null) this.store.applyTombstones('pm_projects', [item.inverse.id])
              else this.store.applyRows('pm_projects', [item.inverse.row])
            } else if (item.inverse.row === null) this.store.removeIssue(item.inverse.id)
            else this.store.restoreIssue(item.inverse.row as unknown as PmIssueRow)
          }
          this.onReject?.(result.errorCode ?? 'Change rejected by the server')
        }
      }
      this.queue = this.queue.filter((q) => !byId.has(q.clientMutationId))
      this.store.setPendingCount(this.queue.length)
      this.store.setCursor(res.latest_seq)
      if (this.db) void persistPending(this.db, this.queue)
      this.schedulePersist()
    } catch {
      // network failure — queue stays; retried on reconnect/next enqueue/poll
    } finally {
      this.flushing = false
      if (this.queue.length > 0 && typeof navigator !== 'undefined' && navigator.onLine) {
        this.flushTimer = setTimeout(() => void this.flushQueue(), FLUSH_DEBOUNCE_MS * 4)
      }
    }
  }

  // ─── persistence ─────────────────────────────────────────────────────────

  private schedulePersist(): void {
    // The destroyed guard matters: a StrictMode-killed engine whose in-flight
    // bootstrap/delta resolves later must never persist its store over the
    // live engine's snapshot.
    if (!this.db || this.destroyed || this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      void this.persistNow()
    }, PERSIST_DEBOUNCE_MS)
  }

  private async persistNow(): Promise<void> {
    if (!this.db || this.destroyed) return
    const s = this.store
    await persistTables(this.db, s.cursor, {
      pm_teams: [...s.teams.entries()].map(([key, row]) => ({ key, row })),
      pm_workflow_states: [...s.states.entries()].map(([key, row]) => ({ key, row })),
      pm_labels: [...s.labels.entries()].map(([key, row]) => ({ key, row })),
      pm_users_lite: [...s.users.entries()].map(([key, row]) => ({ key, row })),
      pm_issues: [...s.issues.entries()].map(([key, row]) => ({ key, row: { ...row, _pending: undefined } })),
      pm_team_memberships: [...s.memberships.entries()].flatMap(([teamId, rows]) =>
        rows.map((row) => ({ key: `${teamId}:${row.user_id}`, row })),
      ),
      pm_issue_labels: [...s.issueLabels.entries()].flatMap(([issueId, labelIds]) =>
        labelIds.map((labelId) => ({ key: `${issueId}:${labelId}`, row: { issue_id: issueId, label_id: labelId } })),
      ),
      pm_issue_subscribers: [...s.issueSubscribers.entries()].flatMap(([issueId, userIds]) =>
        userIds.map((userId) => ({ key: `${issueId}:${userId}`, row: { issue_id: issueId, user_id: userId } })),
      ),
      pm_projects: [...s.projects.entries()].map(([key, row]) => ({ key, row: { ...row, _pending: undefined } })),
      pm_project_milestones: [...s.milestones.entries()].map(([key, row]) => ({ key, row })),
      pm_project_updates: [...s.projectUpdates.entries()].map(([key, row]) => ({ key, row })),
      pm_initiatives: [...s.initiatives.entries()].map(([key, row]) => ({ key, row })),
      pm_project_teams: [...s.projectTeams.entries()].flatMap(([projectId, teamIds]) =>
        teamIds.map((teamId) => ({ key: `${projectId}:${teamId}`, row: { project_id: projectId, team_id: teamId } })),
      ),
      pm_project_members: [...s.projectMembers.entries()].flatMap(([projectId, userIds]) =>
        userIds.map((userId) => ({ key: `${projectId}:${userId}`, row: { project_id: projectId, user_id: userId } })),
      ),
      pm_initiative_projects: [...s.initiativeProjects.entries()].flatMap(([initId, projectIds]) =>
        projectIds.map((projectId, i) => ({ key: `${initId}:${projectId}`, row: { initiative_id: initId, project_id: projectId, position: i } })),
      ),
      pm_cycles: [...s.cycles.entries()].map(([key, row]) => ({ key, row })),
    })
  }
}
