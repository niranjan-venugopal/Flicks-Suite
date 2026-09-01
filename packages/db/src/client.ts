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

// ─── The RLS-bound role every tenant transaction MUST run as ────────────────
//
// Round F (the cross-tenant leads leak): RLS only protects a connection whose
// role is subject to it. If DATABASE_URL is ever pointed at a role with
// BYPASSRLS or superuser (Supabase's default `postgres` connection string is
// exactly that), every policy silently stops applying and queries that lean
// on RLS return EVERY tenant's rows. That is not a theoretical risk — it is
// how one customer's imported leads showed up in every other workspace.
//
// So withTenant no longer trusts the pool's role: each transaction assumes
// the app role via set_config('role', …) in the same round-trip that sets
// app.tenant_id. On a correctly configured pool this is a no-op (the role
// sets itself); on a mis-configured admin/superuser pool it drops privileges
// to the RLS-bound role for the transaction, so isolation holds anyway; and
// if the role cannot be assumed at all the transaction FAILS CLOSED instead
// of leaking. Migration 0060 grants the app role to the admin user so the
// mis-configured case degrades to "safe", not "down".
const APP_ROLE = process.env['DATABASE_APP_ROLE'] ?? 'flicks_app';
if (!/^[a-z_][a-z0-9_]*$/.test(APP_ROLE)) {
  throw new Error(`DATABASE_APP_ROLE must be a plain lowercase role name, got: ${APP_ROLE}`);
}

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
/**
 * Round F — boot-time PROOF that tenant isolation is effective on the tenant
 * pool, run before the API starts serving. Inside a withTenant transaction
 * for a tenant id that owns nothing, counts rows in two always-RLS'd tables:
 * anything visible means RLS is not binding this connection (a BYPASSRLS /
 * superuser DATABASE_URL — how the production cross-tenant leads leak
 * happened) and the caller must refuse to serve. Also surfaces a clear
 * remediation when the app role cannot be assumed at all (fail closed).
 */
export async function assertTenantIsolation(): Promise<{ user: string; appRole: string }> {
  const ZERO = '00000000-0000-0000-0000-000000000000';
  const who = (await db.execute(sql`SELECT current_user AS u`)) as unknown as Array<{ u: string }>;
  const user = who[0]?.u ?? 'unknown';
  try {
    const rows = (await withTenant(ZERO, async (tx) => {
      return (await tx.execute(
        sql`SELECT (SELECT count(*) FROM leads) AS leads, (SELECT count(*) FROM memberships) AS memberships`,
      )) as unknown as Array<{ leads: string | number; memberships: string | number }>;
    })) ?? [];
    const counts = rows[0] ?? { leads: 0, memberships: 0 };
    if (Number(counts.leads) > 0 || Number(counts.memberships) > 0) {
      throw new Error(
        `TENANT ISOLATION IS NOT EFFECTIVE: connected as "${user}", and a tenant ` +
          `transaction for a bogus tenant can read ${counts.leads} leads / ` +
          `${counts.memberships} memberships. Row-Level Security is being bypassed. ` +
          `Point DATABASE_URL at the RLS-bound role "${APP_ROLE}" ` +
          `(postgresql://${APP_ROLE}:<password>@<host>:<port>/<db>) and apply ` +
          `packages/db/drizzle/0060_rls_role_selfheal.sql. Refusing to serve.`,
      );
    }
  } catch (err) {
    const code = (err as { code?: string }).code;
    // Fresh database before migrations: nothing to leak — let boot proceed.
    if (code === '42P01') return { user, appRole: APP_ROLE };
    if (code === '42501' || code === '22023') {
      throw new Error(
        `Tenant transactions cannot assume the RLS-bound role "${APP_ROLE}" ` +
          `(connected as "${user}"): ${(err as Error).message}. Either point ` +
          `DATABASE_URL at ${APP_ROLE} directly, or apply ` +
          `packages/db/drizzle/0060_rls_role_selfheal.sql so "${user}" may ` +
          `assume it. Refusing to serve rather than risk cross-tenant reads.`,
      );
    }
    throw err;
  }
  return { user, appRole: APP_ROLE };
}

export async function withTenant<T>(
  tenantId: string,
  callback: (tx: Db) => Promise<T>,
  userId?: string,
): Promise<T> {
  return db.transaction(async (tx) => {
    // One parameterized round-trip, all transaction-local (pooler-safe):
    //  - role: pin the RLS-bound app role (round F — see APP_ROLE above).
    //    set_config('role', …, true) ≡ SET LOCAL ROLE, and it fails closed
    //    when the pool's user may not assume it.
    //  - app.tenant_id: what every tenant_isolation_* policy reads.
    //  - statement_timeout: a runaway query can't pin this connection.
    //  - app.user_id (when provided): user-scoped policies; folded into the
    //    same statement instead of a second round-trip.
    if (userId) {
      await tx.execute(
        sql`SELECT set_config('role', ${APP_ROLE}, true), set_config('app.tenant_id', ${tenantId}::text, true), set_config('statement_timeout', ${String(TENANT_STATEMENT_TIMEOUT_MS)}, true), set_config('app.user_id', ${userId}::text, true)`,
      )
    } else {
      await tx.execute(
        sql`SELECT set_config('role', ${APP_ROLE}, true), set_config('app.tenant_id', ${tenantId}::text, true), set_config('statement_timeout', ${String(TENANT_STATEMENT_TIMEOUT_MS)}, true)`,
      )
    }
    return callback(tx as unknown as Db)
  })
}
