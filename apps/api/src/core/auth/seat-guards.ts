import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { and, eq, ne, sql } from 'drizzle-orm';
import { memberships } from '@flicks/db/schema';
import type { Db } from '@flicks/db';

/**
 * Round Q — who may act on whose workspace seat.
 *
 * One set of rules for every path that removes, off-boards, reinstates,
 * deactivates or re-roles a person (founder 2026-10-06: "only an Owner
 * controls Owner and HR seats"). Before this each path had its own copy —
 * remove had them, offboard / role change / deactivate did not, so an HR
 * admin could promote themselves to Owner or switch an Owner off.
 *
 *  1. Nobody acts on their own seat (no self-removal, self-off-boarding,
 *     self-deactivation or self-promotion mid-request).
 *  2. Owner and HR-admin seats are the Owner's call: only an Owner may act on
 *     them, or give someone either role.
 *  3. Never leave the workspace without an active Owner.
 *
 * Roles always come from the memberships table inside the caller's tenant
 * transaction — never from the client or the token.
 */

export const SENIOR_SEAT_ROLES = ['owner', 'admin'] as const;

export function isSeniorSeat(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

/**
 * Throws when `actorRole` may not perform `verb` on a seat holding
 * `targetRole` (rules 1 and 2). `verb` reads "remove", "off-board",
 * "reinstate", "deactivate", "reactivate", "change the role of".
 */
export function assertMayActOnSeat(opts: {
  actorRole: string | null | undefined;
  targetRole: string | null | undefined;
  isSelf: boolean;
  verb: string;
}): void {
  if (opts.isSelf) {
    throw new BadRequestException(`You cannot ${opts.verb} yourself.`);
  }
  if (isSeniorSeat(opts.targetRole) && opts.actorRole !== 'owner') {
    throw new ForbiddenException(`Only an owner can ${opts.verb} an owner or HR admin.`);
  }
}

/** Rule 2 for role changes: only an Owner hands out the Owner / HR-admin roles. */
export function assertMayGrantRole(opts: {
  actorRole: string | null | undefined;
  newRole: string;
}): void {
  if (isSeniorSeat(opts.newRole) && opts.actorRole !== 'owner') {
    throw new ForbiddenException('Only an owner can make someone an owner or HR admin.');
  }
}

/** The caller's seat role in this tenant (null when they hold none). */
export async function actorSeatRoleTx(
  db: Db,
  tenantId: string,
  userId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.tenant_id, tenantId), eq(memberships.user_id, userId)))
    .limit(1);
  return row?.role ?? null;
}

/**
 * Rule 3: throws when `membershipId` is an Owner seat and no OTHER active
 * Owner exists. Call before anything that deactivates, demotes or
 * off-boards that seat.
 */
export async function assertNotLastOwnerTx(
  db: Db,
  tenantId: string,
  seat: { id: string; role: string },
): Promise<void> {
  if (seat.role !== 'owner') return;
  const [others] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(memberships)
    .where(
      and(
        eq(memberships.tenant_id, tenantId),
        eq(memberships.role, 'owner'),
        eq(memberships.status, 'active'),
        ne(memberships.id, seat.id),
      ),
    );
  if ((others?.n ?? 0) === 0) {
    throw new BadRequestException(
      'This is the workspace’s only owner. Make someone else an owner first.',
    );
  }
}
