import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';
import type { JwtPayload, UserRole } from '@flicks/shared/types';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const { user } = context.switchToHttp().getRequest() as {
      user: JwtPayload;
    };

    if (!user) {
      throw new ForbiddenException('Access denied');
    }

    // Platform admins bypass role checks
    if (user.isPlatformAdmin) {
      return true;
    }

    const roleHierarchy: Record<UserRole, number> = {
      super_admin: 5,
      admin: 4,
      manager: 3,
      finance: 2,
      employee: 1,
    };

    const userLevel = roleHierarchy[user.role] ?? 0;
    const hasRole = requiredRoles.some((role) => {
      const requiredLevel = roleHierarchy[role] ?? 0;
      return userLevel >= requiredLevel;
    });

    if (!hasRole) {
      throw new ForbiddenException(
        `Insufficient permissions. Required: ${requiredRoles.join(' or ')}`,
      );
    }

    return true;
  }
}
