import 'dotenv/config'; // the guard's import chain reaches @flicks/db, which needs DATABASE_URL
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { JwtPayload, UserRole } from '@flicks/shared/types';
import { RolesGuard } from './roles.guard';
import type { AuditService } from '../../../modules/audit/audit.service';

/**
 * Unit coverage for the authorization guard that enforces @Roles(...). This
 * guard is wired globally in main.ts (after JwtAuthGuard). These cases lock in
 * the role hierarchy + platform-admin bypass so the @Roles decorators across
 * the API can't silently become inert again, plus the authz.denied audit trail
 * that mirrors InvoicingGrantGuard's denial logging.
 */
describe('RolesGuard', () => {
  const makeContext = (
    user: Partial<JwtPayload> | undefined,
    requiredRoles: UserRole[] | undefined,
    reqOverrides: Record<string, unknown> = {},
  ): { ctx: ExecutionContext; guard: RolesGuard; audit: { log: jest.Mock } } => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(requiredRoles),
    } as unknown as Reflector;
    const req = {
      user,
      method: 'GET',
      originalUrl: '/api/v1/employees',
      ip: '203.0.113.7',
      headers: { 'user-agent': 'jest' },
      ...reqOverrides,
    };
    const ctx = {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    return {
      ctx,
      guard: new RolesGuard(reflector, audit as unknown as AuditService),
      audit,
    };
  };

  const user = (
    role: UserRole,
    isPlatformAdmin = false,
    tenantId = 't1',
  ): Partial<JwtPayload> => ({
    sub: 'u1',
    role,
    isPlatformAdmin,
    tenantId,
  });

  it('allows any authenticated request when the route has no @Roles metadata', async () => {
    const { ctx, guard } = makeContext(user('employee'), undefined);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('lets platform admins bypass role checks entirely', async () => {
    const { ctx, guard } = makeContext(user('employee', true), ['fam']);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('rejects an employee hitting an admin-only route', async () => {
    const { ctx, guard } = makeContext(user('employee'), ['admin']);
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  it('rejects a non-fam user hitting a fam-only route (the /fam/* gap)', async () => {
    const { ctx, guard } = makeContext(user('owner'), ['fam']);
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  it('allows a fam user on a fam-only route', async () => {
    const { ctx, guard } = makeContext(user('fam'), ['fam']);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('honours the hierarchy: owner satisfies an admin-only route', async () => {
    const { ctx, guard } = makeContext(user('owner'), ['admin']);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('honours the hierarchy: manager does NOT satisfy an admin-only route', async () => {
    const { ctx, guard } = makeContext(user('manager'), ['admin']);
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  it('denies when there is no authenticated user but roles are required', async () => {
    const { ctx, guard } = makeContext(undefined, ['admin']);
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  it('writes an authz.denied audit row when a role check fails', async () => {
    const { ctx, guard, audit } = makeContext(user('employee'), ['admin']);
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 't1',
        actorUserId: 'u1',
        action: 'authz.denied',
        resourceType: 'rbac',
        ipAddress: '203.0.113.7',
        userAgent: 'jest',
        metadata: expect.objectContaining({
          reason: 'insufficient_role',
          method: 'GET',
          path: '/api/v1/employees',
          role: 'employee',
          requiredRoles: ['admin'],
        }),
      }),
    );
  });

  it('does NOT write an audit row when access is granted', async () => {
    const { ctx, guard, audit } = makeContext(user('owner'), ['admin']);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('skips the audit write when the denied principal has no tenant context', async () => {
    const { ctx, guard, audit } = makeContext(
      { sub: 'u1', role: 'employee', isPlatformAdmin: false },
      ['admin'],
    );
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
    expect(audit.log).not.toHaveBeenCalled();
  });
});
