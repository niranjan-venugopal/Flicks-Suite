import { and, eq, sql } from 'drizzle-orm';
import { lostReasons } from '@flicks/db/schema';
import type { Db } from '@flicks/db';

/**
 * Default lost reasons (PRD v5 §4.1). Migration 0032 seeded these once for
 * the tenants that existed when it ran; every tenant created afterwards had an
 * empty `lost_reasons` table, so the "Mark as lost" dialog rendered zero
 * options and could never be confirmed. Round I heals this at read/write time
 * (house rule 8 — never leave a dead end).
 */
export const DEFAULT_LOST_REASONS: ReadonlyArray<string> = [
  'Price',
  'Competitor',
  'No budget',
  'No response',
  'Bad timing',
  'Not a fit',
];

/**
 * Seed the six default reasons for a tenant that has none. Must run inside a
 * tenant transaction (`withTenant`) so RLS + the explicit tenant predicate
 * scope every read, and so the advisory lock is released with the tx.
 *
 * Idempotent and race-safe: a cheap fast-path read short-circuits the common
 * case; otherwise a per-tenant `pg_advisory_xact_lock` serialises concurrent
 * first hits (two tabs opening the Lost dialog at once) so exactly one seeder
 * inserts and the losers re-check after it commits. Tenants that already have
 * any live reason — custom or archived-but-restored — are never touched.
 */
export async function ensureDefaultLostReasons(tx: Db, tenantId: string): Promise<void> {
  const [any] = await tx
    .select({ id: lostReasons.id })
    .from(lostReasons)
    .where(and(eq(lostReasons.tenant_id, tenantId), eq(lostReasons.archived, false)))
    .limit(1);
  if (any) return;

  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`lost_reasons:${tenantId}`}))`);
  const [again] = await tx
    .select({ id: lostReasons.id })
    .from(lostReasons)
    .where(and(eq(lostReasons.tenant_id, tenantId), eq(lostReasons.archived, false)))
    .limit(1);
  if (again) return;

  await tx.insert(lostReasons).values(
    DEFAULT_LOST_REASONS.map((label, i) => ({ tenant_id: tenantId, label, display_order: i, archived: false })),
  );
}
