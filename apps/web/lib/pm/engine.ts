import { io, type Socket } from 'socket.io-client'
import { rankBetween } from '@flicks/shared/pm'
import { api, silentRefresh } from '@/lib/api/client'
import { PmStore } from './store'
import { openPmDb, destroyPmDb, loadSnapshot, persistTables, persistPending, type PmDb } from './idb'
import type { PendingMutation, PmIssueRow, PmProjectRow, PmRelationRow, PmUpdateRow } from './types'
import { SOCKET_TRANSPORTS } from '@/lib/realtime'

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'
const FLUSH_DEBOUNCE_MS = 250
const PERSIST_DEBOUNCE_MS = 400
const POLL_FALLBACK_MS = 30_000
// Opening IndexedDB can hang while another tab still holds an older version
// (a `blocked` upgrade). Past this, boot WITHOUT the cache — sync mode still
// works from a cold bootstrap; nothing is persisted until the next load.
const IDB_OPEN_TIMEOUT_MS = 4_000

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

  /**
   * Fires after a flush batch is ACKED by the server, with the applied ops'
   * {op, id}. This is the only react-query coupling point the engine offers:
   * pages that render server-side detail payloads (lazy-loaded description,
   * comments) subscribe and invalidate their query once their row's write is
   * really on the server — replacing refetch-on-a-guessed-timer, which used
   * to race this very flush and revert freshly typed text (founder round C).
   */
  private flushListeners = new Set<(acked: Array<{ op: string; id: string }>) => void>()

  onFlushed(listener: (acked: Array<{ op: string; id: string }>) => void): () => void {
    this.flushListeners.add(listener)
    return () => { this.flushListeners.delete(listener) }
  }

  constructor(
    private readonly tenantId: string,
    private readonly userId: string,
  ) {}

  // ─── lifecycle ────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.db = await Promise.race([
      openPmDb(this.tenantId, this.userId),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), IDB_OPEN_TIMEOUT_MS)),
    ])
    let snapshot = this.db ? await loadSnapshot(this.db) : null
    // The pending queue is carried whether or not a table snapshot exists
    // (Round L — the v4 upgrade clears the cursor; those queued offline
    // mutations must replay, not vanish).
    let pending: PendingMutation[] = snapshot?.pending ?? []
    // Disposable-cache doctrine (§3.8): bootstrap always yields ≥1 team, so a
    // snapshot without teams is poisoned (e.g. persisted during a failed
    // session) — and delta can never repair it because the cursor is already
    // past the seeding events. Discard and cold-boot instead of rendering an
    // empty workspace forever.
    if (snapshot && snapshot.cursor != null && (snapshot.tables.pm_teams ?? []).length === 0) {
      this.db?.close()
      this.db = null
      await destroyPmDb(this.tenantId, this.userId)
      this.db = await openPmDb(this.tenantId, this.userId)
      if (this.db && pending.length) void persistPending(this.db, pending)
      snapshot = null
    }
    if (snapshot && snapshot.cursor != null) {
      // WARM boot: render from the local cache instantly, then catch up.
      for (const [table, rows] of Object.entries(snapshot.tables)) {
        this.store.applyRows(table, rows)
      }
      this.queue = pending
      this.store.setPendingCount(this.queue.length)
      this.store.setCursor(snapshot.cursor)
      this.store.setHydrated(true)
      void this.pullDelta()
      void this.flushQueue()
    } else {
      // COLD boot — the queue (if any) survives it and replays afterwards,
      // mirroring reset().
      this.queue = pending
      this.store.setPendingCount(this.queue.length)
      await this.bootstrap()
      // Server-side bootstrap self-seeds the workspace; zero teams here means
      // something is genuinely wrong — surface REST fallback, not a spinner.
      if (this.store.teams.size === 0) throw new Error('BOOTSTRAP_EMPTY')
      if (this.queue.length) void this.flushQueue()
    }
    pending = []
    this.connectSocket()
    this.pollTimer = setInterval(() => void this.pullDelta(), POLL_FALLBACK_MS)
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.handleOnline)
      window.addEventListener('offline', this.handleOffline)
      this.store.setOnline(navigator.onLine)
    }
    // Round D — faces must not freeze: pm_users_lite only ever arrived via
    // bootstrap, so a WARM boot rendered whatever avatar_url the snapshot
    // captured, forever. An avatar uploaded on the employee profile emits no
    // pm.* sync event, so delta never repairs it either — and signed avatar
    // URLs age out anyway. One small roster fetch per session keeps faces
    // fresh; a failure is harmless (the cached roster + initials stand).
    void this.refreshUsers()
  }

  private async refreshUsers(): Promise<void> {
    try {
      const res = await api.get<{ data: Array<{ id: string; name: string | null; avatar_url: string | null }> }>(
        '/api/v1/pm/users',
      )
      if (this.destroyed) return
      this.store.applyRows('pm_users_lite', res.data as unknown as Record<string, unknown>[])
      this.schedulePersist()
    } catch {
      // offline / racing a logout — the persisted roster keeps rendering
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

  /**
   * "Reset local data" — wipe the cache and re-bootstrap (§3.7). The pending
   * queue SURVIVES the wipe: reset also runs automatically when the server
   * answers a delta pull with 410/RE_BOOTSTRAP (cursor too old), and dropping
   * the queue there silently discarded every unflushed offline mutation
   * (founder round A). Unflushed work is the one thing the server can't give
   * back — the cached rows are all re-fetchable, the queue is not. Optimistic
   * rows for queued creates disappear until the post-reset flush lands, which
   * is honest: the server hasn't seen them yet.
   */
  async reset(): Promise<void> {
    const pending = this.queue
    this.store.clearAll()
    this.store.setPendingCount(pending.length)
    this.db?.close() // deleteDatabase blocks while our own connection is open
    this.db = null
    await destroyPmDb(this.tenantId, this.userId)
    const db = await openPmDb(this.tenantId, this.userId)
    this.db = db
    if (db && pending.length) void persistPending(db, pending)
    await this.bootstrap()
    if (pending.length) void this.flushQueue()
  }

  private handleOnline = () => {
    this.store.setOnline(true)
    void this.flushQueue()
    void this.pullDelta()
  }

  private handleOffline = () => this.store.setOnline(false)

  // ─── bootstrap / delta ───────────────────────────────────────────────────

  private async bootstrap(): Promise<void> {
    let res = await fetch(`${BASE_URL}/api/v1/pm/sync/bootstrap`, { credentials: 'include' })
    // Round E — an expired 15-minute access cookie made this raw fetch 401,
    // and the throw silently downgraded the whole session to REST mode (no
    // board, slower everything). Redeem the refresh cookie once and retry,
    // exactly like every JSON request already does.
    if (res.status === 401 && (await silentRefresh())) {
      res = await fetch(`${BASE_URL}/api/v1/pm/sync/bootstrap`, { credentials: 'include' })
    }
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
      let changed = false
      for (const [table, value] of Object.entries(res.upserts ?? {})) {
        if (table.endsWith('__scope')) continue
        const scope = (res.upserts as Record<string, unknown>)[`${table}__scope`] as string[] | undefined
        if (scope) {
          this.store.replaceScopedCollections(table, scope, value as Record<string, unknown>[])
          changed = true
        } else if ((value as unknown[]).length) {
          this.store.applyRows(table, value as Record<string, unknown>[])
          changed = true
        }
      }
      for (const [table, ids] of Object.entries(res.tombstones ?? {})) {
        if (!ids.length) continue
        this.store.applyTombstones(table, ids)
        changed = true
      }
      this.store.setCursor(res.latest_seq)
      // Round E — persistence used to run UNCONDITIONALLY here, so the 30s
      // fallback poll re-serialized every row into IndexedDB even when the
      // delta was empty: a recurring main-thread stall proportional to
      // workspace size. A cursor-only advance skips the write — the next warm
      // boot simply re-pulls a tiny (idempotent) delta from the older cursor.
      if (changed) this.schedulePersist()
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
      // Polling first, then upgrade — socket.io's own default, and the reason
      // is the production console: an edge that doesn't forward the WebSocket
      // Upgrade header turns a websocket-first connect into a hard failure
      // ("WebSocket is closed before the connection is established"), retried
      // forever. Handshaking over HTTP — which demonstrably works, the REST
      // API goes the same way — and upgrading afterwards degrades silently to
      // long-polling instead. See SOCKET_TRANSPORTS in lib/realtime.ts.
      transports: SOCKET_TRANSPORTS,
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
    description?: string | null
    estimate?: number | string | null
    project_id?: string | null
    milestone_id?: string | null
    due_date?: string | null
    /** Round L — create straight under a parent (was hard-coded to null). */
    parent_issue_id?: string | null
    /** Round L item 6 — draft uploads to bind to the new issue. */
    attachment_ids?: string[]
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
      estimate: input.estimate != null ? String(input.estimate) : null,
      assignee_user_id: input.assignee_user_id ?? null,
      creator_user_id: this.userId,
      parent_issue_id: input.parent_issue_id ?? null,
      project_id: input.project_id ?? null,
      milestone_id: input.milestone_id ?? null,
      cycle_id: null,
      due_date: input.due_date ?? null,
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
        description: input.description ?? undefined,
        estimate: input.estimate ?? undefined,
        project_id: input.project_id ?? undefined,
        milestone_id: input.milestone_id ?? undefined,
        due_date: input.due_date ?? undefined,
        parent_issue_id: input.parent_issue_id ?? undefined,
        attachment_ids: input.attachment_ids?.length ? input.attachment_ids : undefined,
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
    fields: {
      title?: string
      description?: string
      due_date?: string | null
      estimate?: string | null
      /** Round L — re-parent (null clears); the server validates the chain. */
      parent_issue_id?: string | null
      /** Round L item 6 — inline images pasted into the description (drafts to bind); not a row field. */
      attachment_ids?: string[]
    },
    opts: { recordUndo?: boolean } = {},
  ): void {
    // attachment_ids rides the mutation only — never into the store row.
    const { attachment_ids, ...rowPatch } = fields
    const prev = this.store.patchIssue(id, { ...(rowPatch as Partial<PmIssueRow>), updated_at: new Date().toISOString() })
    this.enqueue({
      clientMutationId: crypto.randomUUID(),
      op: 'issue.update',
      id,
      fields: { ...rowPatch, ...(attachment_ids?.length ? { attachment_ids } : {}) },
      inverse: { table: 'pm_issues', id, row: prev as unknown as Record<string, unknown> | null },
      enqueuedAt: Date.now(),
    })
    if (opts.recordUndo !== false && prev) {
      const inverseFields: Record<string, unknown> = {}
      for (const k of Object.keys(rowPatch)) inverseFields[k] = (prev as unknown as Record<string, unknown>)[k]
      this.pushUndo({
        undo: () => this.updateIssue(id, inverseFields as never, { recordUndo: false }),
        redo: () => this.updateIssue(id, rowPatch, { recordUndo: false }),
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
    // Mirrors the server: an implicit milestone survives only when the issue
    // STAYS in the same project — a project move drops it (it belongs to the
    // old project).
    const current = this.store.issues.get(id)
    const impliedMilestone =
      projectId && projectId === current?.project_id
        ? current?.milestone_id ?? null
        : null
    const prev = this.store.patchIssue(id, {
      project_id: projectId,
      milestone_id: projectId
        ? milestoneId !== undefined
          ? milestoneId
          : impliedMilestone
        : null,
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

  setIssueLabels(id: string, labelIds: string[]): void {
    this.store.replaceScopedCollections(
      'pm_issue_labels',
      [id],
      labelIds.map((label_id) => ({ issue_id: id, label_id })),
    )
    this.enqueue({
      clientMutationId: crypto.randomUUID(),
      op: 'issue.set_labels',
      id,
      fields: { label_ids: labelIds },
      enqueuedAt: Date.now(),
    })
  }

  /**
   * Link two issues. Round L — optimistic: a temp relation row appears in
   * the store at once (the delta that follows the ack replaces it with the
   * server row); a rejection removes it again. Stored direction only —
   * "blocked by X" is relateIssues(X, me, 'blocks').
   */
  relateIssues(id: string, relatedIssueId: string, type: 'blocks' | 'duplicate_of' | 'relates_to'): void {
    if (id === relatedIssueId) return
    // Already linked (either the server row or a pending temp) → no-op, the
    // server would ignore the duplicate anyway.
    const existing = this.store
      .relationsForIssue(id)
      .find((r) => r.issue_id === id && r.related_issue_id === relatedIssueId && r.type === type)
    if (existing) return
    const tempId = crypto.randomUUID()
    this.store.insertRelation({ id: tempId, issue_id: id, related_issue_id: relatedIssueId, type })
    // duplicate_of also moves the issue to the Duplicate state server-side —
    // optimistically mirror the state hop so the conveyor clears instantly.
    let prevIssue: PmIssueRow | null = null
    if (type === 'duplicate_of') {
      const issue = this.store.issues.get(id)
      const dup = issue
        ? this.store.statesForTeam(issue.team_id).find((s) => s.category === 'canceled' && s.name === 'Duplicate')
          ?? this.store.statesForTeam(issue.team_id).find((s) => s.category === 'canceled')
        : null
      if (dup) prevIssue = this.store.patchIssue(id, { state_id: dup.id, canceled_at: new Date().toISOString() })
    }
    this.enqueue({
      clientMutationId: crypto.randomUUID(),
      op: 'issue.relate',
      id,
      fields: { related_issue_id: relatedIssueId, type },
      inverse: { table: 'pm_issue_relations', id: tempId, row: null }, // rollback = drop the temp row
      ...(prevIssue
        ? { inverses: [{ table: 'pm_issues', id, row: prevIssue as unknown as Record<string, unknown> }] }
        : {}),
      enqueuedAt: Date.now(),
    })
  }

  /** Round L — remove ONE stored relation; the row comes back on rejection. */
  unrelateIssues(id: string, relatedIssueId: string, type: 'blocks' | 'duplicate_of' | 'relates_to'): void {
    const rows = this.store
      .relationsForIssue(id)
      .filter((r) => r.issue_id === id && r.related_issue_id === relatedIssueId && r.type === type)
    for (const r of rows) this.store.removeRelation(r.id)
    const snapshot: PmRelationRow | null = rows[0] ? { ...rows[0], _pending: undefined } : null
    this.enqueue({
      clientMutationId: crypto.randomUUID(),
      op: 'issue.unrelate',
      id,
      fields: { related_issue_id: relatedIssueId, type },
      inverse: {
        table: 'pm_issue_relations',
        id: snapshot?.id ?? relatedIssueId,
        row: snapshot as unknown as Record<string, unknown> | null,
      },
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
    /** Round M — 0 none · 1 urgent · 2 high · 3 medium · 4 low (issue scale). */
    priority?: number
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
      priority: input.priority ?? 0,
      insights_default: null,
      is_private: false,
      logo_url: null,
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
    fields: Partial<Pick<PmProjectRow, 'name' | 'summary' | 'icon' | 'color' | 'status' | 'lead_user_id' | 'start_date' | 'target_date' | 'priority'>>
      // description_md is lazy (detail-only, not in the sync projection) — it rides the op but is not a PmProjectRow column.
      & { description_md?: string | null },
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
      snapshot: null, // Round M — the server computes it on ack; the delta row replaces this
      created_at: new Date().toISOString(),
      // Client-only, like pm_projects/pm_issues. Anything that wants to mark
      // this row unconfirmed must key on THIS flag, never on `snapshot ===
      // null`: rows posted before 0064 carry a null snapshot forever. The
      // ack/delta row (same id) has no `_pending`, so it clears on replace.
      _pending: true,
    }])
    const prevProject = this.store.patchProject(projectId, { health })
    this.enqueue({
      clientMutationId: crypto.randomUUID(),
      op: 'project.post_update',
      id: projectId,
      fields: { update_id: updateId, health, body_md: bodyMd },
      // Round M review — a server rejection (403 for a guest, 400 on an
      // HTML-only body) drops the optimistic card and puts the health back,
      // instead of leaving a pending row until reload.
      inverse: { table: 'pm_project_updates', id: updateId, row: null },
      ...(prevProject
        ? { inverses: [{ table: 'pm_projects', id: projectId, row: prevProject as unknown as Record<string, unknown> }] }
        : {}),
      enqueuedAt: Date.now(),
    })
    return updateId
  }

  deleteProject(id: string): void {
    const prev = this.store.projects.get(id)
    if (!prev) return
    // Mirror deleteIssue (above), NOT applyTombstones. The tombstone path is
    // for the authoritative delta: store.applyTombstones('pm_projects') purges
    // the project's milestones, health updates, team links, member links and
    // initiative-lane membership as well as the row. The rollback below can
    // only put back what `inverse` holds — the project row — so an optimistic
    // tombstone that the server then rejected (403 from the delete bar, 404 on
    // a stale id) permanently stripped those scoped rows from this browser.
    // Removing just the project hides it exactly the same way, and the real
    // delta tombstone still does the full purge a moment later.
    const snapshot = { ...prev }
    this.store.patchProject(id, { deleted_at: new Date().toISOString() })
    this.store.projects.delete(id)
    this.enqueue({
      clientMutationId: crypto.randomUUID(),
      op: 'project.delete',
      id,
      inverse: { table: 'pm_projects', id, row: snapshot as unknown as Record<string, unknown> },
      enqueuedAt: Date.now(),
    })
  }

  createMilestone(projectId: string, name: string, targetDate?: string | null): string {
    const id = crypto.randomUUID()
    const position = this.store.milestonesForProject(projectId).length
    this.store.applyRows('pm_project_milestones', [{
      id, project_id: projectId, name, description_md: null, target_date: targetDate ?? null, position,
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

  updateMilestone(id: string, fields: { name?: string; target_date?: string | null; position?: number; description_md?: string | null }): void {
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
      const acked: Array<{ op: string; id: string }> = []
      for (const item of batch) {
        const result = byId.get(item.clientMutationId)
        if (!result) continue
        if (result.status === 'applied' || result.status === 'duplicate') {
          acked.push({ op: item.op, id: item.id })
          for (const [table, rows] of Object.entries(result.rows ?? {})) {
            this.store.applyRows(table, rows)
          }
        } else {
          // Rejected: roll back exactly this item's optimistic patch.
          //
          // `row === null` is NOT enough to mean "this was a create". Eleven
          // update ops also produce a null pre-image whenever their lookup
          // failed (sendToTriage on a team with no triage state, patchIssue on
          // an id the store no longer holds, …) — and those are precisely the
          // mutations the server rejects. Treating them as creates removed a
          // real issue from the screen on every such rejection (founder round
          // A, "I watched data disappear"). Undo-the-create is therefore keyed
          // on the OP, the one thing that says what actually happened.
          const wasCreate = item.op.endsWith('.create')
          for (const inv of [item.inverse, ...(item.inverses ?? [])]) {
            if (!inv) continue
            if (inv.table === 'pm_projects') {
              if (wasCreate) this.store.applyTombstones('pm_projects', [inv.id])
              else if (inv.row !== null) this.store.applyRows('pm_projects', [inv.row])
            } else if (inv.table === 'pm_issue_relations') {
              // Round L — relate: drop the temp row; unrelate: put it back.
              if (inv.row === null) this.store.removeRelation(inv.id)
              else this.store.applyRows('pm_issue_relations', [inv.row])
            } else if (inv.table === 'pm_project_updates') {
              // Round M — post_update: drop the optimistic card (row null).
              if (inv.row === null) this.store.applyTombstones('pm_project_updates', [inv.id])
              else this.store.applyRows('pm_project_updates', [inv.row])
            } else if (wasCreate) this.store.removeIssue(inv.id)
            else if (inv.row !== null) this.store.restoreIssue(inv.row as unknown as PmIssueRow)
            // update with no pre-image: nothing was optimistically applied,
            // so there is nothing to undo — surface the rejection and stop.
          }
          this.onReject?.(result.errorCode ?? 'Change rejected by the server')
        }
      }
      this.queue = this.queue.filter((q) => !byId.has(q.clientMutationId))
      this.store.setPendingCount(this.queue.length)
      // Deliberately NOT setCursor(res.latest_seq): that value is the seq
      // head at flush time, but this response carries rows for OUR mutations
      // only. Jumping the cursor over a concurrent event from someone else in
      // the tenant meant the next delta never delivered it — the third stale-
      // client enabler found in founder round A (with the delta window cap
      // and rejected-replay-as-duplicate). A delta pull advances the cursor
      // the honest way: over events it actually returned.
      void this.pullDelta()
      if (this.db) void persistPending(this.db, this.queue)
      this.schedulePersist()
      if (acked.length) {
        for (const listener of this.flushListeners) {
          try { listener(acked) } catch { /* a listener must never break the flush */ }
        }
      }
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
      // Round L — temp (unacked) rows are skipped: a reload replays the queue,
      // and the ack's delta brings the server row.
      pm_issue_relations: [...s.relations.entries()]
        .filter(([, row]) => !row._pending)
        .map(([key, row]) => ({ key, row: { ...row, _pending: undefined } })),
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
