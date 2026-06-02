import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { JwtPayload, UserRole } from '@flicks/shared/types';
import { RolesGuard } from './roles.guard';

/**
 * Unit coverage for the authorization guard that enforces @Roles(...). This
 * guard is wired globally in main.ts (after JwtAuthGuard). These cases lock in
 * the role hierarchy + platform-admin bypass so the @Roles decorators across
 * the API can't silently become inert again.
 */
describe('RolesGuard', () => {
  const makeContext = (
    user: Partial<JwtPayload> | undefined,
    requiredRoles: UserRole[] | undefined,
  ): { ctx: ExecutionContext; guard: RolesGuard } => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(requiredRoles),
    } as unknown as Reflector;
    const ctx = {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    } as unknown as ExecutionContext;
    return { ctx, guard: new RolesGuard(reflector) };
  };

  const user = (role: UserRole, isPlatformAdmin = false): Partial<JwtPayload> => ({
    sub: 'u1',
    role,
    isPlatformAdmin,
  });

  it('allows any authenticated request when the route has no @Roles metadata', () => {
    const { ctx, guard } = makeContext(user('employee'), undefined);
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('lets platform admins bypass role checks entirely', () => {
    const { ctx, guard } = makeContext(user('employee', true), ['fam']);
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('rejects an employee hitting an admin-only route', () => {
    const { ctx, guard } = makeContext(user('employee'), ['admin']);
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('rejects a non-fam user hitting a fam-only route (the /fam/* gap)', () => {
    const { ctx, guard } = makeContext(user('owner'), ['fam']);
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('allows a fam user on a fam-only route', () => {
    const { ctx, guard } = makeContext(user('fam'), ['fam']);
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('honours the hierarchy: owner satisfies an admin-only route', () => {
    const { ctx, guard } = makeContext(user('owner'), ['admin']);
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('honours the hierarchy: manager does NOT satisfy an admin-only route', () => {
    const { ctx, guard } = makeContext(user('manager'), ['admin']);
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('denies when there is no authenticated user but roles are required', () => {
    const { ctx, guard } = makeContext(undefined, ['admin']);
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });
});
