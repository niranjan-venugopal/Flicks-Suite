import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '@flicks/db';
import { assetAssignments, assets } from '@flicks/db/schema';

/**
 * Public facade for the assets module (house rule 3: cross-module imports only
 * via public.ts). The employees module calls these INSIDE its own tenant
 * transaction (removal / removal preview), so they are plain query helpers on
 * the caller's `Db` handle rather than injectable services — no Nest wiring,
 * no import cycle, and RLS applies because the caller's tx already set
 * app.tenant_id. Every query also carries the explicit tenant predicate.
 */

/** Equipment the employee currently holds (open assignments on live assets). */
export async function countOpenAssignmentsTx(db: Db, tenantId: string, employeeId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(assetAssignments)
    .innerJoin(assets, eq(assets.id, assetAssignments.asset_id))
    .where(
      and(
        eq(assetAssignments.tenant_id, tenantId),
        eq(assetAssignments.employee_id, employeeId),
        isNull(assetAssignments.returned_at),
        eq(assets.tenant_id, tenantId),
        isNull(assets.deleted_at),
      ),
    );
  return row?.n ?? 0;
}

/**
 * Every assignment the employee ever had (open or returned). The employees
 * module adds this to the removal footprint: anyone with equipment history is
 * archived (deleted_at), never hard-deleted, so the register keeps its trail.
 */
export async function countAllAssignmentsTx(db: Db, tenantId: string, employeeId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(assetAssignments)
    .where(and(eq(assetAssignments.tenant_id, tenantId), eq(assetAssignments.employee_id, employeeId)));
  return row?.n ?? 0;
}

/** Tag + name of what the employee still holds — for the 409 message and the removal preview. */
export async function listOpenAssignmentsTx(
  db: Db,
  tenantId: string,
  employeeId: string,
): Promise<Array<{ asset_id: string; asset_tag: string; name: string; assigned_at: Date }>> {
  return db
    .select({
      asset_id: assets.id,
      asset_tag: assets.asset_tag,
      name: assets.name,
      assigned_at: assetAssignments.assigned_at,
    })
    .from(assetAssignments)
    .innerJoin(assets, eq(assets.id, assetAssignments.asset_id))
    .where(
      and(
        eq(assetAssignments.tenant_id, tenantId),
        eq(assetAssignments.employee_id, employeeId),
        isNull(assetAssignments.returned_at),
        eq(assets.tenant_id, tenantId),
        isNull(assets.deleted_at),
      ),
    )
    .orderBy(assetAssignments.assigned_at);
}
