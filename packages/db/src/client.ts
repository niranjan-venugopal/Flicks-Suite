import { drizzle } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from './schema/index'

// ─── Tenant DB (RLS-enforced, uses app.tenant_id) ────────────────────────────

function createTenantClient() {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL environment variable is required');
  const sql = postgres(url, { max: 10 });
  return drizzle(sql, { schema });
}

// ─── Admin DB (service role, BYPASSRLS for FAM / platform ops) ───────────────

function createAdminClient() {
  const url = process.env['DATABASE_SERVICE_ROLE_URL'];
  if (!url)
    throw new Error(
      'DATABASE_SERVICE_ROLE_URL environment variable is required',
    );
  const sql = postgres(url, { max: 5 });
  return drizzle(sql, { schema });
}

export const db = createTenantClient();
export const dbAdmin = createAdminClient();

export type Db = typeof db;
export type DbAdmin = typeof dbAdmin;

// ─── withTenant helper ────────────────────────────────────────────────────────

/**
 * Runs `callback` inside a transaction where `app.tenant_id` is set for the
 * duration of the transaction so that RLS policies resolve correctly.
 *
 * Usage:
 *   const result = await withTenant(tenantId, (tx) => tx.select().from(employees));
 */
export async function withTenant<T>(
  tenantId: string,
  callback: (tx: Db) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    // Use set_config with a parameterized call — SET LOCAL is scoped to this transaction.
    // set_config(key, value, is_local=true) is safe with parameterized binding.
    await tx.execute(
      sql`SELECT set_config('app.tenant_id', ${tenantId}::text, true)`,
    )
    return callback(tx as unknown as Db)
  })
}
