import { io, type Socket } from 'socket.io-client'
import { rankBetween } from '@flicks/shared/pm'
import { api } from '@/lib/api/client'
import { PmStore } from './store'
import { openPmDb, destroyPmDb, loadSnapshot, persistTables, persistPending, type PmDb } from './idb'
import type { PendingMutation, PmIssueRow } from './types'

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
    const snapshot = this.db ? await loadSnapshot(this.db) : null
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
            if (item.inverse.row === null) this.store.removeIssue(item.inverse.id)
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
    if (!this.db || this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      void this.persistNow()
    }, PERSIST_DEBOUNCE_MS)
  }

  private async persistNow(): Promise<void> {
    if (!this.db) return
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
    })
  }
}
