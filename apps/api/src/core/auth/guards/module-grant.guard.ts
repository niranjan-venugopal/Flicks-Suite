import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { JwtPayload, UserRole } from '@flicks/shared/types';
import { DatabaseService } from '../../database/database.service';
import { AuditService } from '../../../modules/audit/audit.service';
import {
  ModuleAccessService,
  LEVEL_RANK,
  type AccessLevel,
} from '../module-access.service';
import {
  REQUIRE_GRANT_KEY,
  type GrantRequirement,
  type GrantModule,
} from '../decorators/require-grant.decorator';

/**
 * Module-parameterized grant guard (PRD v5 §2.3/§13) — one access pipeline for
 * every module instead of a clone per module:
 *
 *  1. FAM module toggle — a disabled module blocks EVERY endpoint of the
 *     module, even for owners (platform admins bypass).
 *  2. Membership liveness — revoked/expired memberships are re-checked per
 *     request so revocation beats the JWT TTL.
 *  3. @RequireGrant(module, level[, capability]) — resolved by
 *     ModuleAccessService: full-access roles pass; otherwise an explicit
 *     membership_grants row WINS over the workspace's role default, which wins
 *     over the built-in role default. That ordering is what makes revocation
 *     possible: writing `crm: none` for a manager now actually denies, where
 *     previously the role default short-circuited before the row was read.
 *
 * Capabilities remain member-level: a role default can grant the level but a
 * capability (invoicing send / record_payment / manage_customers) always needs
 * an explicit row.
 *
 * Subclasses fix only the module name and its display name — the access rules
 * themselves live in ModuleAccessService so the guard, /me and Settings can
 * never disagree.
 */
export abstract class ModuleGrantGuard implements CanActivate {
  protected abstract readonly module: GrantModule;
  protected abstract readonly moduleDisplayName: string;

  constructor(
    protected readonly reflector: Reflector,
    protected readonly db: DatabaseService,
    protected readonly audit: AuditService,
    protected readonly access: ModuleAccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { user?: JwtPayload }>();
    const user = req.user as JwtPayload;

    const requirement = this.reflector.getAllAndOverride<GrantRequirement>(
      REQUIRE_GRANT_KEY,
      [context.getHandler(), context.getClass()],
    );

    // Platform admins bypass tenant access control entirely.
    if (!user || user.isPlatformAdmin) {
      if (!requirement) return true;
      if (!user) throw new ForbiddenException('Access denied');
      return true;
    }
    // No active workspace on the token (mid-switch): nothing tenant-scoped to
    // check, and every downstream service demands a tenantId anyway.
    if (!user.tenantId) return true;

    // ONE transaction covers the toggle, liveness, the live role and the
    // member's grant row — this guard runs on every CRM/PM/invoicing request,
    // so a second round-trip here is a real cost.
    const ctx = await this.access.loadContext(
      user.tenantId,
      user.membershipId,
      this.module,
      user.sub,
      // The FAM toggle follows the CONTROLLER's module; the grant row follows
      // the REQUIREMENT's. They differ for /invoicing/reports and
      // /org-financial/*, which ride the invoicing kill-switch but need their
      // own grants — reading the wrong one would let invoicing:edit unlock
      // financial data.
      requirement?.module ?? this.module,
    );

    if (!ctx.moduleEnabled) {
      await this.logDenied(req, user, 'module_disabled');
      throw new ForbiddenException(
        `${this.moduleDisplayName} is disabled for this workspace by the platform administrator`,
      );
    }
    if (!ctx.membershipActive) {
      await this.logDenied(req, user, 'membership_inactive');
      throw new ForbiddenException('Your access to this workspace is no longer active');
    }

    if (!requirement) return true; // not grant-governed

    // The membership row is the source of truth for the role: a demotion takes
    // effect immediately instead of waiting out the 15-minute access token.
    const role: UserRole = ctx.liveRole ?? user.role;

    let level: AccessLevel;
    let capabilities: Record<string, boolean> = {};
    if (this.access.isFullAccess(requirement.module, role)) {
      level = 'edit';
    } else if (ctx.grant) {
      // Explicit row wins — including an explicit 'none' (revocation).
      level = ctx.grant.level;
      capabilities = ctx.grant.capabilities;
    } else {
      level = await this.access.defaultLevel(
        user.tenantId,
        role,
        requirement.module,
        user.sub,
      );
    }

    const levelOk =
      (LEVEL_RANK[level] ?? 0) >= (LEVEL_RANK[requirement.level] ?? 99);
    const capabilityOk = requirement.capability
      ? capabilities[requirement.capability] === true ||
        this.access.isFullAccess(requirement.module, role)
      : true;

    if (!levelOk || !capabilityOk) {
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
}
