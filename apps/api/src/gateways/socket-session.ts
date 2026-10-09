import { eq } from 'drizzle-orm';
import type { DbAdmin } from '@flicks/db';
import { tenants } from '@flicks/db/schema';
import type { JwtPayload } from '@flicks/shared/types';

/**
 * Round R R2 — what a socket handshake must refuse beyond a bad signature.
 *
 * The HTTP side gets these from JwtStrategy (challenge tokens are never
 * sessions) and RolesGuard (a suspended company answers TENANT_SUSPENDED on
 * every request); the gateways verify the JWT themselves, so they apply the
 * same two rules here before joining any room.
 */
export function socketSessionProblem(payload: JwtPayload & { scope?: string }): string | null {
  if (payload.scope) return 'challenge token presented as a session';
  return null;
}

export async function tenantIsSuspended(dbAdmin: DbAdmin, tenantId: string): Promise<boolean> {
  const [t] = await dbAdmin
    .select({ status: tenants.status })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  return t?.status === 'suspended';
}
