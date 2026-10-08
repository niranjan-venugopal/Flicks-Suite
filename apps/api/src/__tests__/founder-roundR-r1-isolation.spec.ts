/**
 * Round R · R1 — "nothing shared between companies, even by mistake"
 * (founder 2026-10-07) + the workspace-card plan label.
 *
 *  - TenantHeaderGuard: a tab that still believes it is in company A while
 *    the shared cookie now points at B is refused (409 TENANT_MISMATCH);
 *    account routes stay reachable; requests without the header are untouched.
 *  - Socket rooms are company-scoped (tenant:<t>:user:<u>).
 *  - Tenant JSON that used to be browser-cached (dashboard overview, HR
 *    reports) now answers Cache-Control: private, no-store.
 *  - FAM funnel/invoicing is platform-admin only.
 *  - /auth/me's billing summary: trial days left, Pro once paying, the
 *    Specflicks tenant reads as the platform.
 */
import 'dotenv/config';
import 'reflect-metadata';
import * as crypto from 'crypto';
import { ConflictException, type ExecutionContext } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { dbAdmin } from '@flicks/db';
import { subscriptions, tenants } from '@flicks/db/schema';
import type { JwtPayload } from '@flicks/shared/types';
import { TenantHeaderGuard } from '../core/auth/guards/tenant-header.guard';
import { ROLES_KEY } from '../core/auth/decorators/roles.decorator';
import { tenantRoom, tenantUserRoom, userRoom } from '../gateways/rooms';
import { BillingStateService } from '../core/billing/billing-state.service';
import { DashboardController } from '../modules/dashboard/dashboard.controller';
import { ReportsController } from '../modules/reports/reports.controller';
import { FamController } from '../modules/fam/fam.controller';

const rid = () => crypto.randomBytes(4).toString('hex');

describe('TenantHeaderGuard — the tab must be in the company the session is in', () => {
  const guard = new TenantHeaderGuard();
  const ctx = (user: Partial<JwtPayload> | undefined, url: string, header?: string) =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({ user, originalUrl: url, url, headers: header ? { 'x-flicks-tenant': header } : {} }),
      }),
    }) as unknown as ExecutionContext;
  const A = crypto.randomUUID();
  const B = crypto.randomUUID();
  const sessionInB: Partial<JwtPayload> = { sub: 'u', tenantId: B, membershipId: 'm', role: 'employee', isPlatformAdmin: false };

  it('passes without a header, passes when the header matches the session', () => {
    expect(guard.canActivate(ctx(sessionInB, '/api/v1/leave/types'))).toBe(true);
    expect(guard.canActivate(ctx(sessionInB, '/api/v1/leave/types', B))).toBe(true);
  });

  it('refuses a tab still on company A once the session moved to B — 409 TENANT_MISMATCH', () => {
    expect(() => guard.canActivate(ctx(sessionInB, '/api/v1/policies', A))).toThrow(ConflictException);
    try {
      guard.canActivate(ctx(sessionInB, '/api/v1/employees/x/terminate', A));
    } catch (e) {
      expect((e as ConflictException).getResponse()).toMatchObject({ code: 'TENANT_MISMATCH' });
    }
  });

  it('account routes are exempt (they are how the tab learns the truth); public routes and seat-less platform tokens pass', () => {
    for (const url of ['/api/v1/auth/me', '/api/v1/auth/switch-company', '/api/v1/auth/logout', '/api/v1/me/companies?x=1']) {
      expect(guard.canActivate(ctx(sessionInB, url, A))).toBe(true);
    }
    expect(guard.canActivate(ctx(undefined, '/api/v1/public/inv/t', A))).toBe(true);
    expect(guard.canActivate(ctx({ sub: 'fam', isPlatformAdmin: true }, '/api/v1/fam/overview', A))).toBe(true);
    // look-alike prefixes are NOT exempt
    expect(() => guard.canActivate(ctx(sessionInB, '/api/v1/authority/x', A))).toThrow(ConflictException);
    expect(() => guard.canActivate(ctx(sessionInB, '/api/v1/members/x', A))).toThrow(ConflictException);
  });
});

describe('socket rooms are company-scoped', () => {
  it('a company push targets tenant:<t>:user:<u>; only account-level pushes use the plain user room', () => {
    expect(tenantUserRoom('T', 'U')).toBe('tenant:T:user:U');
    expect(tenantRoom('T')).toBe('tenant:T');
    expect(userRoom('U', 'T')).toBe('tenant:T:user:U');
    expect(userRoom('U')).toBe('user:U');
    expect(userRoom('U', null)).toBe('user:U');
  });
});

describe('tenant JSON is never browser-cached; FAM funnel is gated', () => {
  const headersOf = (proto: object) =>
    Object.getOwnPropertyNames(proto)
      .filter((n) => n !== 'constructor')
      .flatMap((n) => (Reflect.getMetadata('__headers__', (proto as Record<string, object>)[n]!) as Array<{ name: string; value: string }> | undefined) ?? []);

  it('dashboard overview and the three HR reports answer private, no-store (no max-age anywhere)', () => {
    for (const proto of [DashboardController.prototype, ReportsController.prototype]) {
      const cc = headersOf(proto).filter((h) => h.name.toLowerCase() === 'cache-control');
      expect(cc.length).toBeGreaterThan(0);
      for (const h of cc) expect(h.value).toBe('private, no-store');
    }
  });

  it('GET fam/funnel/invoicing requires the platform role', () => {
    const proto = FamController.prototype as unknown as Record<string, object>;
    const name = Object.getOwnPropertyNames(proto).find((n) => /invoicing.*funnel|funnel.*invoicing/i.test(n));
    expect(name).toBeDefined();
    expect(Reflect.getMetadata(ROLES_KEY, proto[name!]!)).toEqual(['fam']);
  });
});

describe('/auth/me billing summary (workspace-card label)', () => {
  const svc = new BillingStateService(dbAdmin as never);
  const made: string[] = [];
  const tenant = async (status: 'trialing' | 'active' | 'suspended' = 'trialing') => {
    const [t] = await dbAdmin
      .insert(tenants)
      .values({ name: `RR ${rid()}`, slug: `rr-${rid()}-${Date.now()}`, status })
      .returning();
    made.push(t!.id);
    return t!.id;
  };
  afterAll(async () => {
    for (const id of made) await dbAdmin.delete(tenants).where(eq(tenants.id, id));
  });

  it('a trial says how many days are left; a code-given trial is still a trial, with hasCoupon', async () => {
    const t = await tenant();
    const ends = new Date(Date.now() + 5 * 86_400_000);
    await dbAdmin.insert(subscriptions).values({ tenant_id: t, plan_code: 'beta', status: 'trialing', trial_ends_at: ends });
    const s = await svc.summary(t);
    expect(s.status).toBe('trialing');
    expect(s.planName).toBeNull();
    expect(s.trialDaysLeft).toBeGreaterThanOrEqual(4);
    expect(s.trialDaysLeft).toBeLessThanOrEqual(5);
    expect(s.hasCoupon).toBe(false);
  });

  it('paying → Pro, no trial days; past_due reads as past_due', async () => {
    const paid = await tenant('active');
    await dbAdmin.insert(subscriptions).values({ tenant_id: paid, plan_code: 'beta', status: 'active' });
    expect(await svc.summary(paid)).toMatchObject({ status: 'active', planName: 'Pro', trialDaysLeft: null });
    const due = await tenant('active');
    await dbAdmin.insert(subscriptions).values({ tenant_id: due, plan_code: 'beta', status: 'past_due' });
    expect((await svc.summary(due)).status).toBe('past_due');
  });

  it('no subscription row → the tenant trial; the Specflicks tenant → platform; cached verdicts invalidate', async () => {
    const t = await tenant();
    await dbAdmin.update(tenants).set({ trial_ends_at: new Date(Date.now() - 2 * 86_400_000) }).where(eq(tenants.id, t));
    const s = await svc.summary(t);
    expect(s.status).toBe('trialing');
    expect(s.trialDaysLeft).toBeLessThan(0);
    expect(await svc.isLocked(t)).toBe(true);
    // ended an hour ago: the lock says over, so the card must never read "ends today" (0)
    const hourAgo = await tenant();
    await dbAdmin.update(tenants).set({ trial_ends_at: new Date(Date.now() - 3_600_000) }).where(eq(tenants.id, hourAgo));
    expect((await svc.summary(hourAgo)).trialDaysLeft).toBeLessThanOrEqual(-1);
    expect(await svc.isLocked(hourAgo)).toBe(true);
    expect((await svc.summary('00000000-0000-0000-0000-000000000001')).status).toBe('platform');
    await dbAdmin.insert(subscriptions).values({ tenant_id: t, plan_code: 'beta', status: 'active' });
    // still the cached trial until invalidated
    expect((await svc.summary(t)).status).toBe('trialing');
    svc.invalidate(t);
    expect((await svc.summary(t)).status).toBe('active');
    expect(await svc.isLocked(t)).toBe(false);
  });
});
