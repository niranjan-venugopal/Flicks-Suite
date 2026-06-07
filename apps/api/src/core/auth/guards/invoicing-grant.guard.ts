import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { and, eq } from 'drizzle-orm';
import { membershipGrants } from '@flicks/db/schema';
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
    const requirement = this.reflector.getAllAndOverride<GrantRequirement>(
      REQUIRE_GRANT_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!requirement) return true; // not grant-governed

    const { user } = context.switchToHttp().getRequest() as {
      user: JwtPayload;
    };
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
