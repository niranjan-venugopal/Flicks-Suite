import { drizzle } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from './schema/index'

// Under Jest each worker process builds its own pair of pools. At the normal
// sizes (10 + 5) a single worker can hold 15 connections — exactly Supabase's
// session-pooler cap — so parallel suites die with EMAXCONNSESSION when tests
// run against a pooled remote DB. We cap the pools in test, but leave enough
// headroom for legitimately NESTED withTenant transactions (e.g. deal→invoice
// nests invoices.create → resolveForInvoice, two tenant connections deep). With
// jest maxWorkers=2 the worst case is 2 workers × (4 tenant + 3 admin) = 14 < 15.
const IS_TEST =
  !!process.env['JEST_WORKER_ID'] || process.env['NODE_ENV'] === 'test';

// Pool hardening (launch-readiness): bound how long a connection can be held so
// one slow query or a stalled network can't pin a pooled connection until the
// whole pool starves. These are client-side postgres.js options (seconds), so
// they pass through any pooler unchanged. The per-statement cap
// (statement_timeout) is applied inside withTenant via set_config instead of a
// startup parameter, because transaction poolers (e.g. Supabase/Supavisor) can
// reject non-whitelisted startup params.
const POOL_TUNING = {
  idle_timeout: 30, // close a connection idle for 30s
  max_lifetime: 60 * 30, // recycle a connection after 30 min
  connect_timeout: 10, // fail fast (10s) if a connection can't be established
} as const;

// ─── Tenant DB (RLS-enforced, uses app.tenant_id) ────────────────────────────

function createTenantClient() {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL environment variable is required');
  // prepare: false — this pool targets the TRANSACTION-mode pooler
  // (Supavisor :6543), which does not support named prepared statements.
  // postgres.js defaults to prepare:true; pin it off per Supabase guidance.
  const sql = postgres(url, {
    max: IS_TEST ? 4 : 10,
    prepare: false,
    ...POOL_TUNING,
  });
  return drizzle(sql, { schema });
}

// ─── Admin DB (service role, BYPASSRLS for FAM / platform ops) ───────────────

function createAdminClient() {
  const url = process.env['DATABASE_SERVICE_ROLE_URL'];
  if (!url)
    throw new Error(
      'DATABASE_SERVICE_ROLE_URL environment variable is required',
    );
  const sql = postgres(url, { max: IS_TEST ? 3 : 5, ...POOL_TUNING });
  return drizzle(sql, { schema });
}

// Per-statement cap applied to every tenant transaction (see POOL_TUNING note).
// 30s is far above any legitimate window/limit-bounded app query, so it only
// ever fires on a runaway/pathological one — releasing the pooled connection
// instead of letting it hang.
const TENANT_STATEMENT_TIMEOUT_MS = 30_000;

export const db = createTenantClient();
export const dbAdmin = createAdminClient();

export type Db = typeof db;
export type DbAdmin = typeof dbAdmin;

// ─── withTenant helper ────────────────────────────────────────────────────────

/**
 * Runs `callback` inside a transaction where `app.tenant_id` (and, when
 * provided, `app.user_id`) is set for the duration of the transaction so that
 * RLS policies resolve correctly.
 *
 * `userId` is optional and backward-compatible: tenant-isolation policies only
 * read `app.tenant_id`. User-scoped policies (e.g. the auditor company-switcher
 * `memberships` self-visibility policy) read `app.user_id`; pass it for those
 * reads. When omitted, `app.user_id` is left unset and resolves to NULL.
 *
 * Usage:
 *   const result = await withTenant(tenantId, (tx) => tx.select().from(employees));
 *   const mine   = await withTenant(tenantId, (tx) => …, userId);
 */
export async function withTenant<T>(
  tenantId: string,
  callback: (tx: Db) => Promise<T>,
  userId?: string,
): Promise<T> {
  return db.transaction(async (tx) => {
    // Use set_config with a parameterized call — SET LOCAL is scoped to this transaction.
    // set_config(key, value, is_local=true) is safe with parameterized binding.
    // The statement_timeout is set LOCAL in the same round-trip (pooler-safe;
    // no extra latency) so a runaway query can't pin this connection.
    await tx.execute(
      sql`SELECT set_config('app.tenant_id', ${tenantId}::text, true), set_config('statement_timeout', ${String(TENANT_STATEMENT_TIMEOUT_MS)}, true)`,
    )
    if (userId) {
      await tx.execute(
        sql`SELECT set_config('app.user_id', ${userId}::text, true)`,
      )
    }
    return callback(tx as unknown as Db)
  })
}
