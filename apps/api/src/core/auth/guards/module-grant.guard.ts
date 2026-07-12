import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { and, eq } from 'drizzle-orm';
import { membershipGrants, memberships, tenantModuleToggles } from '@flicks/db/schema';
import type { Request } from 'express';
import type { JwtPayload, UserRole } from '@flicks/shared/types';
import { DatabaseService } from '../../database/database.service';
import { AuditService } from '../../../modules/audit/audit.service';
import {
  REQUIRE_GRANT_KEY,
  type GrantRequirement,
  type GrantModule,
} from '../decorators/require-grant.decorator';

const LEVEL_RANK: Record<string, number> = { none: 0, view: 1, edit: 2 };

/**
 * Module-parameterized grant guard (PRD v5 §2.3/§13) — the generalization of
 * the invoicing guard so every module (invoicing, crm, …) shares one battle-
 * tested access pipeline instead of cloning it:
 *
 *  1. FAM module toggle — disabled module blocks EVERY endpoint of the module,
 *     even for owners (platform admins bypass).
 *  2. Membership liveness — revoked/expired memberships are re-checked per
 *     request so revocation beats the JWT TTL.
 *  3. @RequireGrant(module, level[, capability]) — full-access roles pass;
 *     roles with a module DEFAULT level (e.g. CRM's org-open employees) pass
 *     up to that level; everyone else (auditors, opt-granted roles) consults
 *     membership_grants.
 *
 * Subclasses fix the module name, the full-access role set, and (optionally)
 * per-role default levels. InvoicingGrantGuard keeps its exact v3/v4 behavior
 * as a subclass — its tests are the regression net for this refactor.
 */
export abstract class ModuleGrantGuard implements CanActivate {
  protected abstract readonly module: GrantModule;
  protected abstract readonly fullAccessRoles: ReadonlySet<UserRole>;
  protected abstract readonly moduleDisplayName: string;

  constructor(
    protected readonly reflector: Reflector,
    protected readonly db: DatabaseService,
    protected readonly audit: AuditService,
  ) {}

  /**
   * Default access level a role holds WITHOUT a grant row. Base: none —
   * modules like CRM override this for the org-open SMB default (§13).
   */
  protected defaultLevelForRole(_role: UserRole): 'none' | 'view' | 'edit' {
    return 'none';
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { user?: JwtPayload }>();
    const user = req.user as JwtPayload;

    if (user && !user.isPlatformAdmin && user.tenantId) {
      const { moduleEnabled, membershipActive } = await this.loadAccessContext(user);
      if (!moduleEnabled) {
        await this.logDenied(req, user, 'module_disabled');
        throw new ForbiddenException(
          `${this.moduleDisplayName} is disabled for this workspace by the platform administrator`,
        );
      }
      if (!membershipActive) {
        await this.logDenied(req, user, 'membership_inactive');
        throw new ForbiddenException('Your access to this workspace is no longer active');
      }
    }

    const requirement = this.reflector.getAllAndOverride<GrantRequirement>(
      REQUIRE_GRANT_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!requirement) return true; // not grant-governed

    if (!user) throw new ForbiddenException('Access denied');
    if (user.isPlatformAdmin) return true;
    if (this.fullAccessRoles.has(user.role)) return true;

    // Module default for this role (org-open modules) — no grant row needed.
    const defaultLevel = this.defaultLevelForRole(user.role);
    if ((LEVEL_RANK[defaultLevel] ?? 0) >= (LEVEL_RANK[requirement.level] ?? 99)) {
      if (!requirement.capability) return true;
      // Capabilities are always explicit grants — fall through to the table.
    }

    const allowed = await this.hasGrant(user, requirement);
    if (!allowed) {
      await this.logDenied(req, user, 'missing_grant', requirement);
      throw new ForbiddenException(
        `Missing grant: ${requirement.module}:${requirement.level}`,
      );
    }
    return true;
  }

  /** Best-effort audit of denied access — probing must be visible to owners. */
  protected async logDenied(
    req: Request & { user?: JwtPayload },
    user: JwtPayload | undefined,
    reason: string,
    requirement?: GrantRequirement,
  ): Promise<void> {
    if (!user?.tenantId) return;
    await this.audit.log({
      tenantId: user.tenantId,
      actorUserId: user.sub,
      action: 'authz.denied',
      resourceType: this.module,
      metadata: {
        reason,
        method: req.method,
        path: req.originalUrl ?? req.url,
        role: user.role,
        ...(requirement
          ? {
              module: requirement.module,
              level: requirement.level,
              capability: requirement.capability,
            }
          : {}),
      },
      ipAddress: req.ip,
      userAgent: req.headers?.['user-agent'],
    });
  }

  /** Toggle default = ENABLED when no row exists; liveness per §3.5. */
  protected async loadAccessContext(
    user: JwtPayload,
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
              eq(tenantModuleToggles.module, this.module),
            ),
          )
          .limit(1);
        const moduleEnabled = toggleRows.length === 0 ? true : toggleRows[0]!.enabled;

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

  protected async hasGrant(user: JwtPayload, req: GrantRequirement): Promise<boolean> {
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

    const has =
      (LEVEL_RANK[grant.access_level] ?? 0) >= (LEVEL_RANK[req.level] ?? 99);
    if (!has) return false;

    if (req.capability) {
      const caps = (grant.capabilities ?? {}) as Record<string, boolean>;
      return caps[req.capability] === true;
    }
    return true;
  }
}
