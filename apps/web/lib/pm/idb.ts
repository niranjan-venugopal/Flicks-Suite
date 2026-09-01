import { openDB, type IDBPDatabase } from 'idb'
import type { PendingMutation } from './types'

/**
 * FSE IndexedDB persistence (PRD v6 §3.1/§3.8). One database per
 * (tenant, user) — company switch = store switch with its own cursor. The
 * local copy is a DISPOSABLE CACHE: any corruption path deletes the DB and
 * re-bootstraps (worst case is a refresh, never corruption).
 */

// v2: projects layer stores (Sprint 36) · v3: cycles (Sprint 37). The
// upgrade callback creates any missing store, so upgrades happen in place.
const VERSION = 3
const TABLE_STORES = [
  'pm_teams',
  'pm_team_memberships',
  'pm_workflow_states',
  'pm_labels',
  'pm_users_lite',
  'pm_issues',
  'pm_issue_labels',
  'pm_issue_subscribers',
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
  try {
    return await openDB(dbName(tenantId, userId), VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta')
        if (!db.objectStoreNames.contains('pending')) {
          db.createObjectStore('pending', { keyPath: 'clientMutationId' })
        }
        for (const s of TABLE_STORES) {
          if (!db.objectStoreNames.contains(s)) db.createObjectStore(s)
        }
      },
      blocked() {
        /* another tab holds an old version — proceed; reads still work */
      },
    })
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

export async function loadSnapshot(db: PmDb): Promise<{
  cursor: number
  tables: Record<string, Record<string, unknown>[]>
  pending: PendingMutation[]
} | null> {
  try {
    const cursor = ((await db.get('meta', 'cursor')) as number | undefined) ?? null
    if (cursor == null) return null
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
    const pending = (pendingRaw as PendingMutation[]).sort(
      (a, b) => a.enqueuedAt - b.enqueuedAt,
    )
    return { cursor, tables, pending }
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
