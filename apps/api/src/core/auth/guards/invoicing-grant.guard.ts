import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { and, eq } from 'drizzle-orm';
import { membershipGrants, memberships, tenantModuleToggles } from '@flicks/db/schema';
import type { JwtPayload, UserRole } from '@flicks/shared/types';
import { DatabaseService } from '../../database/database.service';
import {
  REQUIRE_GRANT_KEY,
  type GrantRequirement,
} from '../decorators/require-grant.decorator';

/**
 * Grant guard for the Invoicing module (PRD §3).
 *
 * Standard tenant roles get invoicing access by rank (owner/admin/finance =
 * full; manager/employee = none by default). The `auditor` role is orthogonal:
 * its access is whatever `membership_grants` rows were issued at invite time, so
 * for auditors we consult the grants table for the required module + level
 * (and optional capability).
 *
 * Use AFTER the global JwtAuthGuard (which populates req.user). Endpoints opt in
 * with @RequireGrant(module, level). Endpoints without the decorator are not
 * governed by this guard.
 *
 * NOTE (scaffold): the standard-role matrix here is the §3.3 default. Per-role
 * `opt` elevations (e.g. a manager granted read-only) are also expressed via
 * membership_grants and will be layered in during the auditor sprint.
 */
@Injectable()
export class InvoicingGrantGuard implements CanActivate {
  // owner/admin/finance have full invoicing access by default (§3.3).
  private static readonly FULL_ACCESS_ROLES: ReadonlySet<UserRole> = new Set<UserRole>([
    'owner',
    'admin',
    'finance',
    'super_admin',
    'fam',
  ]);

  constructor(
    private readonly reflector: Reflector,
    private readonly db: DatabaseService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const { user } = context.switchToHttp().getRequest() as {
      user: JwtPayload;
    };

    // Two gates that WIN over any role/grant, checked before the @RequireGrant
    // short-circuit so they cover every invoicing endpoint (not just
    // grant-decorated ones). Platform admins (FAM) bypass — they manage toggles
    // and never read invoice content here.
    //   1. FAM module toggle (§10.1): if invoicing is disabled for this
    //      workspace, nobody — not even an owner — may touch /invoicing/*.
    //   2. Membership liveness (§3.5): a revoked/expired auditor or member
    //      keeps a valid JWT until it expires; re-check status + access window
    //      on every request so revocation takes effect immediately rather than
    //      lingering for the token's TTL.
    if (user && !user.isPlatformAdmin && user.tenantId) {
      const { moduleEnabled, membershipActive } = await this.loadAccessContext(
        user,
        'invoicing',
      );
      if (!moduleEnabled) {
        throw new ForbiddenException(
          'Invoicing is disabled for this workspace by the platform administrator',
        );
      }
      if (!membershipActive) {
        throw new ForbiddenException(
          'Your access to this workspace is no longer active',
        );
      }
    }

    const requirement = this.reflector.getAllAndOverride<GrantRequirement>(
      REQUIRE_GRANT_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!requirement) return true; // not grant-governed

    if (!user) throw new ForbiddenException('Access denied');
    if (user.isPlatformAdmin) return true;

    // Standard roles: hierarchy decides (default matrix §3.3).
    if (InvoicingGrantGuard.FULL_ACCESS_ROLES.has(user.role)) return true;

    // Auditor (and any opt-granted standard role): consult membership_grants.
    const allowed = await this.hasGrant(user, requirement);
    if (!allowed) {
      throw new ForbiddenException(
        `Missing grant: ${requirement.module}:${requirement.level}`,
      );
    }
    return true;
  }

  /**
   * Load the two pre-grant gates in a single tenant-context round-trip:
   *  - moduleEnabled: defaults to ENABLED when no toggle row exists (§10.1).
   *  - membershipActive: the caller's membership must still be `active` and
   *    within its access window (§3.5). Missing/deactivated/expired → false.
   *      (No membershipId on the JWT → treated as not-active for safety.)
   */
  private async loadAccessContext(
    user: JwtPayload,
    module: string,
  ): Promise<{ moduleEnabled: boolean; membershipActive: boolean }> {
    return this.db.withTenant(
      user.tenantId,
      async (tx) => {
        const toggleRows = await tx
          .select({ enabled: tenantModuleToggles.enabled })
          .from(tenantModuleToggles)
          .where(
            and(
              eq(tenantModuleToggles.tenant_id, user.tenantId),
              eq(tenantModuleToggles.module, module),
            ),
          )
          .limit(1);
        const moduleEnabled =
          toggleRows.length === 0 ? true : toggleRows[0]!.enabled;

        let membershipActive = false;
        if (user.membershipId) {
          const memRows = await tx
            .select({
              status: memberships.status,
              expires: memberships.access_expires_at,
            })
            .from(memberships)
            .where(
              and(
                eq(memberships.id, user.membershipId),
                eq(memberships.tenant_id, user.tenantId),
              ),
            )
            .limit(1);
          const m = memRows[0];
          membershipActive =
            !!m &&
            m.status === 'active' &&
            (!m.expires || m.expires.getTime() > Date.now());
        }

        return { moduleEnabled, membershipActive };
      },
      user.sub,
    );
  }

  private async hasGrant(
    user: JwtPayload,
    req: GrantRequirement,
  ): Promise<boolean> {
    if (!user.membershipId) return false;
    const rows = await this.db.withTenant(
      user.tenantId,
      (tx) =>
        tx
          .select()
          .from(membershipGrants)
          .where(
            and(
              eq(membershipGrants.membership_id, user.membershipId),
              eq(membershipGrants.module, req.module),
            ),
          ),
      user.sub,
    );
    const grant = rows[0];
    if (!grant) return false;

    const levelRank: Record<string, number> = { none: 0, view: 1, edit: 2 };
    const has =
      (levelRank[grant.access_level] ?? 0) >= (levelRank[req.level] ?? 99);
    if (!has) return false;

    if (req.capability) {
      const caps = (grant.capabilities ?? {}) as Record<string, boolean>;
      return caps[req.capability] === true;
    }
    return true;
  }
}
