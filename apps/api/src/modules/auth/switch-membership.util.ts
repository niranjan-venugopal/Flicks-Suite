import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { memberships, type Membership } from '@flicks/db/schema';
import type { DbAdmin } from '@flicks/db';

/**
 * Resolve (and, where appropriate, activate) the membership a user is
 * switching into. Shared by POST /auth/select-tenant and its Invoicing v3
 * alias POST /auth/switch-company (PRD §3.5). Standalone so the Sprint-8
 * integration spec can exercise the exact server-side re-verification rules
 * without standing up the whole AuthService.
 *
 * Rules (never trust the client's tenant_id — PRD §3.5):
 *  - no membership row for (user, tenant)            → 400
 *  - membership deactivated (revoked auditor/member) → 403
 *  - access window (access_expires_at) elapsed       → 403
 *  - status 'invited'                                → activate on switch.
 *    Login (verify-otp / magic-link) already flips invited→active because it
 *    proves email ownership; a switch happens inside a session that was
 *    obtained the same way, so accepting here is equivalent — it covers
 *    invites issued *after* the user's current login (e.g. an auditor invited
 *    to a second company mid-session sees it under My Companies and accepts
 *    by switching into it).
 */
export async function resolveSwitchMembership(
  dbAdmin: DbAdmin,
  userId: string,
  tenantId: string,
): Promise<{ membership: Membership; activated: boolean }> {
  const [membership] = await dbAdmin
    .select()
    .from(memberships)
    .where(
      and(
        eq(memberships.user_id, userId),
        eq(memberships.tenant_id, tenantId),
      ),
    )
    .limit(1);

  if (!membership) {
    throw new BadRequestException('No active membership found for this tenant');
  }
  if (membership.status === 'deactivated') {
    throw new ForbiddenException('Your access to this company has been revoked');
  }
  if (
    membership.access_expires_at &&
    membership.access_expires_at.getTime() < Date.now()
  ) {
    throw new ForbiddenException('Your access window for this company has expired');
  }

  if (membership.status === 'invited') {
    const [activated] = await dbAdmin
      .update(memberships)
      .set({ status: 'active', accepted_at: new Date() })
      .where(eq(memberships.id, membership.id))
      .returning();
    return { membership: activated, activated: true };
  }

  return { membership, activated: false };
}
