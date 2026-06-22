import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ROLES_KEY } from '../decorators/roles.decorator';
import type { JwtPayload, UserRole } from '@flicks/shared/types';
import { AuditService } from '../../../modules/audit/audit.service';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const req = context
      .switchToHttp()
      .getRequest<Request & { user?: JwtPayload }>();
    const user = req.user;

    if (!user) {
      throw new ForbiddenException('Access denied');
    }

    // Platform admins bypass role checks
    if (user.isPlatformAdmin) {
      return true;
    }

    const roleHierarchy: Record<UserRole, number> = {
      // FAM (Specflicks-internal) sits at the top; `super_admin` is the
      // deprecated legacy name kept at the same level for compat.
      fam: 6,
      super_admin: 6,
      owner: 5,
      admin: 4,
      manager: 3,
      finance: 2,
      employee: 1,
      // Auditor is orthogonal to the hierarchy — it never satisfies a ranked
      // @Roles(...) requirement (HRMS routes). Invoicing access is resolved by
      // the InvoicingGrantGuard via membership_grants instead.
      auditor: 0,
    };

    const userLevel = roleHierarchy[user.role] ?? 0;
    const hasRole = requiredRoles.some((role) => {
      const requiredLevel = roleHierarchy[role] ?? 0;
      return userLevel >= requiredLevel;
    });

    if (!hasRole) {
      await this.logDenied(req, user, requiredRoles);
      throw new ForbiddenException(
        `Insufficient permissions. Required: ${requiredRoles.join(' or ')}`,
      );
    }

    return true;
  }

  /**
   * Record a denied @Roles(...) attempt to the tenant audit log so RBAC probing
   * is visible to Owners/Auditors alongside the invoicing-grant denials emitted
   * by InvoicingGrantGuard. Best-effort — AuditService.log never throws. We skip
   * when there is no tenant context to scope the row to (e.g. the no-user gate
   * above, or a platform-level token without a tenantId).
   */
  private async logDenied(
    req: Request & { user?: JwtPayload },
    user: JwtPayload,
    requiredRoles: UserRole[],
  ): Promise<void> {
    if (!user.tenantId) return;
    await this.audit.log({
      tenantId: user.tenantId,
      actorUserId: user.sub,
      action: 'authz.denied',
      resourceType: 'rbac',
      metadata: {
        reason: 'insufficient_role',
        method: req.method,
        path: req.originalUrl ?? req.url,
        role: user.role,
        requiredRoles,
      },
      ipAddress: req.ip,
      userAgent: req.headers?.['user-agent'],
    });
  }
}
