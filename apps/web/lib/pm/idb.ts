import { openDB, type IDBPDatabase } from 'idb'
import type { PendingMutation } from './types'

/**
 * FSE IndexedDB persistence (PRD v6 §3.1/§3.8). One database per
 * (tenant, user) — company switch = store switch with its own cursor. The
 * local copy is a DISPOSABLE CACHE: any corruption path deletes the DB and
 * re-bootstraps (worst case is a refresh, never corruption).
 */

// v2: projects layer stores (Sprint 36) · v3: cycles (Sprint 37) · v4:
// issue relations (Round L). The upgrade callback creates any missing store,
// so upgrades happen in place. A pre-v4 snapshot never held relations, and
// no delta will ever replay the ones that already exist — so the v4 upgrade
// also drops the cursor, which makes the next start a cold bootstrap
// (disposable-cache doctrine: the worst case is one re-download).
const VERSION = 4
const RELATIONS_SINCE = 4
const TABLE_STORES = [
  'pm_teams',
  'pm_team_memberships',
  'pm_workflow_states',
  'pm_labels',
  'pm_users_lite',
  'pm_issues',
  'pm_issue_labels',
  'pm_issue_subscribers',
  'pm_issue_relations',
  'pm_projects',
  'pm_project_teams',
  'pm_project_members',
  'pm_project_milestones',
  'pm_project_updates',
  'pm_initiatives',
  'pm_initiative_projects',
  'pm_cycles',
] as const

export type PmDb = IDBPDatabase

export function dbName(tenantId: string, userId: string): string {
  return `fs-pm-${tenantId}-${userId}`
}

export async function openPmDb(tenantId: string, userId: string): Promise<PmDb | null> {
  if (typeof indexedDB === 'undefined') return null
  // `blocking` fires only after this open has resolved, so the handle is
  // always set by the time it needs closing.
  let handle: PmDb | null = null
  try {
    handle = await openDB(dbName(tenantId, userId), VERSION, {
      upgrade(db, oldVersion, _newVersion, tx) {
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta')
        if (!db.objectStoreNames.contains('pending')) {
          db.createObjectStore('pending', { keyPath: 'clientMutationId' })
        }
        for (const s of TABLE_STORES) {
          if (!db.objectStoreNames.contains(s)) db.createObjectStore(s)
        }
        // Existing (pre-relations) snapshot: forget the cursor so start()
        // cold-boots instead of rendering an empty Relations card forever.
        // The pending queue is untouched — unflushed work survives.
        if (oldVersion > 0 && oldVersion < RELATIONS_SINCE) {
          void tx.objectStore('meta').delete('cursor')
        }
      },
      blocked() {
        /* another tab holds an old version — proceed; reads still work */
      },
      // A NEWER version is opening in another tab: release our handle so the
      // upgrade can proceed instead of parking that tab on its spinner. This
      // engine keeps working against its in-memory store (persists become
      // no-ops on the closed handle) until the page reloads.
      blocking() {
        handle?.close()
      },
    })
    return handle
  } catch {
    // Corrupt/blocked DB → disposable-cache doctrine: destroy and signal cold boot.
    await destroyPmDb(tenantId, userId).catch(() => undefined)
    return null
  }
}

export async function destroyPmDb(tenantId: string, userId: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(dbName(tenantId, userId))
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
    req.onblocked = () => resolve()
  })
}

/**
 * The persisted snapshot. `cursor` is null when there is no usable table
 * snapshot (first run, or the v4 upgrade cleared it) — the PENDING QUEUE is
 * still returned in that case: unflushed offline work is the one thing the
 * server cannot give back, so a missing cursor must never discard it.
 */
export async function loadSnapshot(db: PmDb): Promise<{
  cursor: number | null
  tables: Record<string, Record<string, unknown>[]>
  pending: PendingMutation[]
} | null> {
  try {
    const cursor = ((await db.get('meta', 'cursor')) as number | undefined) ?? null
    const sortPending = (raw: unknown[]) =>
      (raw as PendingMutation[]).sort((a, b) => a.enqueuedAt - b.enqueuedAt)
    if (cursor == null) {
      return { cursor: null, tables: {}, pending: sortPending(await db.getAll('pending')) }
    }
    // Round E — these reads were awaited one-by-one: 17 serialized IndexedDB
    // round trips before the first paint of every warm boot. Issued together
    // they overlap, cutting the hydration wait severalfold on big workspaces.
    const [tableArrays, pendingRaw] = await Promise.all([
      Promise.all(TABLE_STORES.map((s) => db.getAll(s))),
      db.getAll('pending'),
    ])
    const tables: Record<string, Record<string, unknown>[]> = {}
    TABLE_STORES.forEach((s, i) => {
      tables[s] = tableArrays[i] as Record<string, unknown>[]
    })
    return { cursor, tables, pending: sortPending(pendingRaw) }
  } catch {
    return null
  }
}

/** Write-behind persistence: full-table swap per changed store (spike-simple). */
export async function persistTables(
  db: PmDb,
  cursor: number,
  tables: Partial<Record<(typeof TABLE_STORES)[number], Array<{ key: string; row: unknown }>>>,
): Promise<void> {
  let abort: (() => void) | null = null
  try {
    const names = Object.keys(tables) as Array<(typeof TABLE_STORES)[number]>
    const tx = db.transaction(['meta', ...names], 'readwrite')
    abort = () => tx.abort()
    void tx.objectStore('meta').put(cursor, 'cursor')
    for (const name of names) {
      const store = tx.objectStore(name)
      void store.clear()
      // Rows come out of MobX observable maps — structured clone throws
      // DataCloneError on proxies, so snapshot to plain JSON first.
      for (const { key, row } of tables[name]!) void store.put(JSON.parse(JSON.stringify(row)), key)
    }
    await tx.done
    abort = null
  } catch {
    // Best-effort — but NEVER half-commit: without the abort, the queued
    // cursor-put + clears still committed and left a poisoned snapshot
    // (cursor advanced over empty tables) that a warm boot can't repair.
    try {
      abort?.()
    } catch {
      /* already finished */
    }
  }
}

export async function persistPending(db: PmDb, pending: PendingMutation[]): Promise<void> {
  let abort: (() => void) | null = null
  try {
    const tx = db.transaction('pending', 'readwrite')
    abort = () => tx.abort()
    void tx.objectStore('pending').clear()
    for (const p of pending) void tx.objectStore('pending').put(JSON.parse(JSON.stringify(p)))
    await tx.done
    abort = null
  } catch {
    try {
      abort?.()
    } catch {
      /* already finished */
    }
  }
}
