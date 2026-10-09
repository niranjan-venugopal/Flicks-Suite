/**
 * Round R · R2 — the FAM support console (founder item 1, 2026-10-07).
 *
 *  - Suspend that really blocks: login skips it, refresh ends it, switching
 *    is refused, every tenant route answers TENANT_SUSPENDED, sessions are
 *    retired, Owners emailed, the previous status comes back on reactivate.
 *  - Find anyone / a person across companies: search, profile, lockout state,
 *    clear lockout, send sign-in link, sign out everywhere.
 *  - Company support: the company's own audit log (+CSV), member actions,
 *    Specflicks-only notes (deny-all for the app role).
 *  - Billing help: extend-trial from max(now, end), free months (repeatable),
 *    the subscription panel's coupon / seats.
 *  - Hardening: FAM 2FA guard + mfa claim, platform admins never paywalled,
 *    challenge tokens never authenticate, 'tenant_selected' finally persists.
 */
import 'dotenv/config';
import 'reflect-metadata';
import * as crypto from 'crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { and, eq, isNull } from 'drizzle-orm';
import { db, dbAdmin } from '@flicks/db';
import {
  authEvents,
  authOtps,
  auditLogPlatform,
  couponCodes,
  couponRedemptions,
  famTenantNotes,
  impersonationSessions,
  memberships,
  refreshTokens,
  subscriptionEvents,
  subscriptions,
  tenants,
  trustedDevices,
  users,
} from '@flicks/db/schema';
import type { JwtPayload } from '@flicks/shared/types';
import { DatabaseService } from '../core/database/database.service';
import { AuditService } from '../modules/audit/audit.service';
import { AuthService } from '../modules/auth/auth.service';
import { TotpService } from '../modules/auth/totp.service';
import { ConsentService } from '../modules/consent/consent.service';
import { resolveSwitchMembership } from '../modules/auth/switch-membership.util';
import { ModuleAccessService } from '../core/auth/module-access.service';
import { RolesGuard } from '../core/auth/guards/roles.guard';
import { BillingGuard } from '../core/auth/guards/billing.guard';
import { FamMfaGuard } from '../core/auth/guards/fam-mfa.guard';
import { JwtStrategy } from '../core/auth/strategies/jwt.strategy';
import { BillingStateService } from '../core/billing/billing-state.service';
import { AnalyticsService } from '../core/analytics/analytics.service';
import { BillingService } from '../modules/billing/billing.service';
import { RazorpayPlatformService } from '../modules/billing/razorpay-platform.service';
import { FamService } from '../modules/fam/fam.service';
import { FamController } from '../modules/fam/fam.controller';
import { FamBillingController } from '../modules/billing/fam-billing.controller';
import { FeedbackController } from '../modules/feedback/feedback.controller';
import { ApiKeysService } from '../modules/public-api/api-keys.service';
import { socketSessionProblem, tenantIsSuspended } from '../gateways/socket-session';
import { authenticator } from 'otplib';
import { BILLING_EXEMPT_KEY } from '../core/auth/decorators/billing-exempt.decorator';
import type { NotificationsService } from '../modules/notifications/notifications.service';
import type { EmployeesPublicService } from '../modules/employees/public';

const rid = () => crypto.randomBytes(4).toString('hex');
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const SPECFLICKS = '00000000-0000-0000-0000-000000000001';
const OTP = '424242';

// ─── wiring (hand-built, real Postgres) ──────────────────────────────────────
const dbSvc = new DatabaseService();
const settings: Record<string, unknown> = {
  JWT_SECRET: 'test-secret',
  // enforced two-factor, as in production — the step-up test needs it
  TOTP_SECRET: 'spec-totp-key',
  OTP_EXPIRY_MINUTES: '10',
  MAX_OTP_ATTEMPTS: '5',
  MAGIC_LINK_BASE_URL: 'http://localhost:3000/verify',
  TRUSTED_SESSION_EXPIRY_DAYS: '180',
};
const config = { get: (k: string, fb?: unknown) => settings[k] ?? fb } as never;
const jwt = new JwtService({ secret: 'test-secret' });
const sendEmail = jest.fn(async () => true);
const notifications = { sendEmail, createInAppNotification: async () => {} } as unknown as NotificationsService;
const audit = new AuditService(db as never, dbAdmin as never, dbSvc);
const emitted: Array<{ event: string; payload: unknown }> = [];
const eventEmitter = { emit: (event: string, payload: unknown) => { emitted.push({ event, payload }); return true; } };
const authService = new AuthService(
  dbAdmin as never,
  dbAdmin as never,
  jwt,
  config,
  eventEmitter as never,
  notifications,
  audit,
  new TotpService(config),
  new ConsentService(dbAdmin as never, config),
);
const analytics = new AnalyticsService(config, dbAdmin as never);
const billingState = new BillingStateService(dbAdmin as never);
const billing = new BillingService(
  dbAdmin as never,
  new RazorpayPlatformService(config),
  billingState,
  audit,
  analytics,
  notifications as never,
);
const resendInvite = jest.fn(async (employeeId: string) => ({
  data: { employeeId, email: 'x@t.test', resentCount: 1, emailSent: true },
}));
const employeesPublic = { resendInvite } as unknown as EmployeesPublicService;
const media = { servedUrl: async (_k: string | null, legacy: string | null) => legacy ?? null } as never;
const fam = new FamService(
  dbAdmin as never,
  audit,
  authService,
  notifications,
  analytics,
  media,
  billing,
  employeesPublic,
  billingState,
  eventEmitter as never,
);
const moduleAccess = new ModuleAccessService(dbSvc, dbAdmin as never);
const actor = (userId: string) => ({ userId, ip: '203.0.113.9', userAgent: 'jest/1.0' });

// ─── fixtures ────────────────────────────────────────────────────────────────
const RUN = rid();
let famUserId: string;
let A: string; // trialing company (will be suspended)
let B: string; // active company
let ownerA: string;
let ownerB: string;
let dual: string; // owner in A, admin in B
let dualEmail: string;
let soloEmail: string;
let solo: string; // only in A
let membershipDualA: string;
let membershipDualB: string;
const madeUsers: string[] = [];
const extraTenants: string[] = [];
/** Postgres `+ N months` clamps to the month's last day; JS setMonth rolls over. */
const addMonthsClamped = (d: Date, n: number) => {
  const r = new Date(d);
  const day = r.getUTCDate();
  r.setUTCDate(1);
  r.setUTCMonth(r.getUTCMonth() + n);
  const last = new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + 1, 0)).getUTCDate();
  r.setUTCDate(Math.min(day, last));
  return r;
};

async function mkUser(label: string, extra: Partial<typeof users.$inferInsert> = {}) {
  const [u] = await dbAdmin
    .insert(users)
    .values({ email: `rr2-${label}-${RUN}@t.test`, full_name: `${label} ${RUN}`, status: 'active', timezone: 'Asia/Kolkata', ...extra })
    .returning();
  madeUsers.push(u!.id);
  return u!;
}
async function seat(tenantId: string, userId: string, role: 'owner' | 'admin' | 'employee' | 'manager', status: 'active' | 'invited' = 'active') {
  const [m] = await dbAdmin
    .insert(memberships)
    .values({ tenant_id: tenantId, user_id: userId, role, status, accepted_at: status === 'active' ? new Date() : null })
    .returning({ id: memberships.id });
  return m!.id;
}
async function otpFor(email: string) {
  await dbAdmin.insert(authOtps).values({ email, otp_hash: sha256(OTP), expires_at: new Date(Date.now() + 600_000) });
}
const decode = (token: string) => jwt.verify(token) as JwtPayload;

beforeAll(async () => {
  const famU = await mkUser('fam', { is_platform_admin: true });
  famUserId = famU.id;
  const [ta] = await dbAdmin
    .insert(tenants)
    .values({ name: `RR2 Alpha ${RUN}`, slug: `rr2-a-${RUN}`, status: 'trialing', gstin: `29ABCDE${RUN.slice(0, 4).toUpperCase()}1Z5`, trial_ends_at: new Date(Date.now() + 5 * 86_400_000) })
    .returning();
  const [tb] = await dbAdmin
    .insert(tenants)
    .values({ name: `RR2 Bravo ${RUN}`, slug: `rr2-b-${RUN}`, status: 'active' })
    .returning();
  A = ta!.id;
  B = tb!.id;
  await dbAdmin.insert(subscriptions).values({ tenant_id: A, plan_code: 'beta', status: 'trialing', trial_ends_at: ta!.trial_ends_at, per_user_price: 499, user_count: 1 });
  await dbAdmin.insert(subscriptions).values({ tenant_id: B, plan_code: 'beta', status: 'active', per_user_price: 499, user_count: 2, mrr_amount: 998 });
  const oa = await mkUser('ownera');
  const ob = await mkUser('ownerb');
  const du = await mkUser('dual');
  const so = await mkUser('solo');
  ownerA = oa.id;
  ownerB = ob.id;
  dual = du.id;
  dualEmail = du.email;
  solo = so.id;
  soloEmail = so.email;
  await seat(A, ownerA, 'owner');
  await seat(B, ownerB, 'owner');
  membershipDualA = await seat(A, dual, 'owner');
  membershipDualB = await seat(B, dual, 'admin');
  await seat(A, solo, 'employee');
});

afterAll(async () => {
  await dbAdmin.delete(tenants).where(eq(tenants.id, A)).catch(() => {});
  await dbAdmin.delete(tenants).where(eq(tenants.id, B)).catch(() => {});
  for (const id of extraTenants) await dbAdmin.delete(tenants).where(eq(tenants.id, id)).catch(() => {});
  for (const id of madeUsers) await dbAdmin.delete(users).where(eq(users.id, id)).catch(() => {});
  await db.$client.end({ timeout: 2 }).catch(() => {});
  await dbAdmin.$client.end({ timeout: 2 }).catch(() => {});
});

// ─── guards & tokens ─────────────────────────────────────────────────────────

describe('hardening: 2FA claim, FAM guard, paywall exemption, challenge tokens', () => {
  const ctx = (user: Partial<JwtPayload> & Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ user, method: 'POST', originalUrl: '/api/v1/fam/x', url: '/api/v1/fam/x', headers: {}, ...extra }) }),
      getHandler: () => ({}),
      getClass: () => ({}),
    }) as unknown as ExecutionContext;

  it('issueTokenPair stamps mfa into the token and the refresh row, and rotation carries it', async () => {
    const [u] = await dbAdmin.select().from(users).where(eq(users.id, famUserId)).limit(1);
    const plain = await authService.issueTokenPair(u!, null, null, null, 'dev-1');
    expect(decode(plain.accessToken).mfa).toBeUndefined();
    const strong = await authService.issueTokenPair(u!, null, null, null, 'dev-1', undefined, undefined, undefined, { mfa: true });
    expect(decode(strong.accessToken).mfa).toBe(true);
    const [row] = await dbAdmin.select({ mfa: refreshTokens.mfa }).from(refreshTokens).where(eq(refreshTokens.token_hash, sha256(strong.refreshToken)));
    expect(row?.mfa).toBe(true);
    const rotated = await authService.refreshToken(strong.refreshToken, 'dev-1');
    expect(decode(rotated.accessToken).mfa).toBe(true);
    const plainRotated = await authService.refreshToken(plain.refreshToken, 'dev-1');
    expect(decode(plainRotated.accessToken).mfa).toBeUndefined();
  });

  it('FamMfaGuard: enforced + platform admin + no mfa → 403 TOTP_REQUIRED; mfa, non-admins and unenforced pass', () => {
    const enforced = new FamMfaGuard({ get: () => 'secret' } as never);
    expect(() => enforced.canActivate(ctx({ sub: 'u', isPlatformAdmin: true }))).toThrow(ForbiddenException);
    try {
      enforced.canActivate(ctx({ sub: 'u', isPlatformAdmin: true }));
    } catch (e) {
      expect((e as ForbiddenException).getResponse()).toMatchObject({ code: 'TOTP_REQUIRED' });
    }
    expect(enforced.canActivate(ctx({ sub: 'u', isPlatformAdmin: true, mfa: true }))).toBe(true);
    expect(enforced.canActivate(ctx({ sub: 'u', isPlatformAdmin: false, role: 'owner' }))).toBe(true);
    const off = new FamMfaGuard({ get: () => undefined } as never);
    expect(off.canActivate(ctx({ sub: 'u', isPlatformAdmin: true }))).toBe(true);
  });

  it('BillingGuard never paywalls a platform admin, whatever role their token carries', async () => {
    const guard = new BillingGuard({ getAllAndOverride: () => undefined } as never, { isLocked: async () => true } as never);
    await expect(guard.canActivate(ctx({ sub: 'u', tenantId: A, role: 'owner', isPlatformAdmin: true }))).resolves.toBe(true);
    await expect(guard.canActivate(ctx({ sub: 'u', tenantId: A, role: 'owner', isPlatformAdmin: false }))).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'BILLING_REQUIRED' }),
    });
  });

  it('a TOTP challenge token never authenticates a request', () => {
    const strategy = new JwtStrategy({ get: (k: string) => ({ JWT_SECRET: 'x', JWT_ISSUER: 'i', JWT_AUDIENCE: 'a' })[k] } as never);
    expect(() => strategy.validate({ sub: 'u', scope: 'totp_challenge' } as never)).toThrow(UnauthorizedException);
    expect(strategy.validate({ sub: 'u' } as never)).toMatchObject({ sub: 'u' });
  });

  it('FamController is billing-exempt and behind the 2FA guard; so are the FAM billing and feedback routes; the support routes exist', () => {
    expect(Reflect.getMetadata(BILLING_EXEMPT_KEY, FamController)).toBe(true);
    const guardsOf = (target: object) => (Reflect.getMetadata('__guards__', target) as Array<{ name?: string }> | undefined)?.map((g) => g.name ?? String(g)) ?? [];
    expect(guardsOf(FamController)).toContain('FamMfaGuard');
    expect(guardsOf(FamBillingController)).toContain('FamMfaGuard');
    const fb = FeedbackController.prototype as unknown as Record<string, object>;
    const famFeedbackRoutes = Object.getOwnPropertyNames(fb).filter((n) => /fam/i.test(n));
    expect(famFeedbackRoutes.length).toBeGreaterThan(0);
    for (const n of famFeedbackRoutes) expect(guardsOf(fb[n]!)).toContain('FamMfaGuard');
    const proto = FamController.prototype as unknown as Record<string, object>;
    for (const m of ['search', 'getUser', 'clearUserLockout', 'sendUserSignInLink', 'signOutUserEverywhere', 'grantFreeMonths', 'getTenantActivity', 'exportTenantActivity', 'listTenantNotes', 'addTenantNote', 'resendMemberInvite', 'signOutMember', 'exportPlatformAudit']) {
      expect(typeof proto[m]).toBe('function');
    }
  });
});

// ─── suspend that really blocks ──────────────────────────────────────────────

describe('suspend that really blocks', () => {
  let dualTokens: { accessToken: string; refreshToken: string };

  it('before: the dual person signs in and lands in Alpha (older membership); Alpha routes work', async () => {
    await otpFor(dualEmail);
    const r = (await authService.verifyOtp(dualEmail, OTP, 'dev-dual')) as { accessToken: string; refreshToken: string };
    dualTokens = { accessToken: r.accessToken, refreshToken: r.refreshToken };
    expect(decode(r.accessToken).tenantId).toBe(A);
    const seatA = await moduleAccess.liveSeat(A, membershipDualA);
    expect(seatA).toMatchObject({ active: true, suspended: false });
  });

  it('suspendTenant saves the previous status, retires every live session, emails the Owners, audits with IP / UA; the platform tenant and a double suspend are refused', async () => {
    sendEmail.mockClear();
    await expect(fam.suspendTenant(SPECFLICKS, actor(famUserId), { reason: 'x' })).rejects.toBeInstanceOf(BadRequestException);
    const liveBefore = await dbAdmin.select({ id: refreshTokens.id }).from(refreshTokens).where(and(eq(refreshTokens.tenant_id, A), isNull(refreshTokens.revoked_at)));
    expect(liveBefore.length).toBeGreaterThan(0);
    const res = await fam.suspendTenant(A, actor(famUserId), { reason: 'Unpaid for 3 cycles' });
    expect(res).toMatchObject({ status: 'suspended', previousStatus: 'trialing' });
    expect(res.sessionsRevoked).toBe(liveBefore.length);
    const [t] = await dbAdmin.select({ status: tenants.status, before: tenants.status_before_suspend }).from(tenants).where(eq(tenants.id, A));
    expect(t).toEqual({ status: 'suspended', before: 'trialing' });
    const liveAfter = await dbAdmin.select({ id: refreshTokens.id }).from(refreshTokens).where(and(eq(refreshTokens.tenant_id, A), isNull(refreshTokens.revoked_at)));
    expect(liveAfter).toHaveLength(0);
    expect(emitted.some((e) => e.event === 'seat.revoked' && (e.payload as { tenantId: string }).tenantId === A)).toBe(true);
    // every active Owner of Alpha (ownerA + dual) got the email, nobody else
    await new Promise((r) => setTimeout(r, 50));
    const suspendMails = sendEmail.mock.calls.filter((c) => (c as unknown[])[0] === 'workspace-suspended');
    expect(new Set(suspendMails.map((c) => (c as unknown[])[1]))).toEqual(new Set([`rr2-ownera-${RUN}@t.test`, dualEmail]));
    const [row] = await dbAdmin.select().from(auditLogPlatform).where(and(eq(auditLogPlatform.target_tenant_id, A), eq(auditLogPlatform.action, 'tenant.suspended')));
    expect(row).toMatchObject({ actor_user_id: famUserId, ip_address: '203.0.113.9', user_agent: 'jest/1.0' });
    expect(row!.metadata).toMatchObject({ reason: 'Unpaid for 3 cycles', previousStatus: 'trialing' });
    await expect(fam.suspendTenant(A, actor(famUserId), { reason: 'again' })).rejects.toBeInstanceOf(ConflictException);
  });

  it('every tenant route refuses the suspended company with TENANT_SUSPENDED (ranked and unranked), account routes stay reachable', async () => {
    const guard = new RolesGuard({ getAllAndOverride: () => undefined } as never, { log: async () => {} } as never, moduleAccess);
    const ranked = new RolesGuard({ getAllAndOverride: () => ['employee'] } as never, { log: async () => {} } as never, moduleAccess);
    const user: Partial<JwtPayload> = { sub: dual, tenantId: A, membershipId: membershipDualA, role: 'owner', isPlatformAdmin: false };
    const ctx = (url: string) =>
      ({
        switchToHttp: () => ({ getRequest: () => ({ user, originalUrl: url, url, method: 'GET', headers: {} }) }),
        getHandler: () => ({}),
        getClass: () => ({}),
      }) as unknown as ExecutionContext;
    for (const g of [guard, ranked]) {
      await expect(g.canActivate(ctx('/api/v1/leave/types'))).rejects.toMatchObject({ response: expect.objectContaining({ code: 'TENANT_SUSPENDED' }) });
    }
    await expect(guard.canActivate(ctx('/api/v1/auth/me'))).resolves.toBe(true);
    await expect(guard.canActivate(ctx('/api/v1/me/companies'))).resolves.toBe(true);
    expect((await moduleAccess.liveSeat(A, membershipDualA))?.suspended).toBe(true);
    expect((await moduleAccess.liveSeat(B, membershipDualB))?.suspended).toBe(false);
  });

  it('refresh of a session scoped to the suspended company ends it; switching into it is refused; login lands elsewhere or nowhere', async () => {
    // a fresh token pair scoped to A (the old one was retired by the suspend)
    const [u] = await dbAdmin.select().from(users).where(eq(users.id, dual)).limit(1);
    const pair = await authService.issueTokenPair(u!, A, membershipDualA, 'owner', 'dev-x');
    await expect(authService.refreshToken(pair.refreshToken, 'dev-x')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'TENANT_SUSPENDED' }),
    });
    const [retired] = await dbAdmin.select({ revoked: refreshTokens.revoked_at }).from(refreshTokens).where(eq(refreshTokens.token_hash, sha256(pair.refreshToken)));
    expect(retired?.revoked).not.toBeNull();
    await expect(resolveSwitchMembership(dbAdmin as never, dual, A)).rejects.toMatchObject({ response: expect.objectContaining({ code: 'TENANT_SUSPENDED' }) });
    await expect(resolveSwitchMembership(dbAdmin as never, dual, B)).resolves.toMatchObject({ activated: false });
    // login: the dual person lands in Bravo now
    await otpFor(dualEmail);
    const r = (await authService.verifyOtp(dualEmail, OTP, 'dev-dual')) as { accessToken: string };
    expect(decode(r.accessToken).tenantId).toBe(B);
    // a person whose only company is suspended gets no company and is told why
    await otpFor(soloEmail);
    const s = (await authService.verifyOtp(soloEmail, OTP, 'dev-solo')) as { needsOnboarding?: boolean; suspendedTenants?: string[]; accessToken: string };
    expect(s.needsOnboarding).toBe(true);
    expect(s.suspendedTenants).toEqual([`RR2 Alpha ${RUN}`]);
    expect(decode(s.accessToken).tenantId).toBe('');
    void dualTokens;
  });

  it('impersonating into a suspended company is refused', async () => {
    await expect(fam.startImpersonation(famUserId, { membershipId: membershipDualA, reason: 'support ticket 12345' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('reactivate restores the previous status (a trial stays a trial), audits, emails the Owners; a non-suspended company is refused', async () => {
    sendEmail.mockClear();
    const res = await fam.reactivateTenant(A, actor(famUserId));
    expect(res.status).toBe('trialing');
    const [t] = await dbAdmin.select({ status: tenants.status, before: tenants.status_before_suspend }).from(tenants).where(eq(tenants.id, A));
    expect(t).toEqual({ status: 'trialing', before: null });
    expect((await moduleAccess.liveSeat(A, membershipDualA))?.suspended).toBe(false);
    await new Promise((r) => setTimeout(r, 50));
    expect(sendEmail.mock.calls.some((c) => (c as unknown[])[0] === 'workspace-reactivated')).toBe(true);
    await expect(fam.reactivateTenant(B, actor(famUserId))).rejects.toBeInstanceOf(ConflictException);
  });
});

// ─── find anyone / a person across companies ────────────────────────────────

describe('find anyone + the person page', () => {
  it('search finds people by email / name and companies by name / slug / GSTIN, never the platform tenant', async () => {
    const byEmail = await fam.search(`rr2-dual-${RUN}`);
    expect(byEmail.users.map((u) => u.id)).toContain(dual);
    expect(byEmail.users.find((u) => u.id === dual)?.companies).toBe(2);
    const byGstin = await fam.search(RUN.slice(0, 4).toUpperCase());
    expect(byGstin.tenants.map((t) => t.id)).toContain(A);
    const bySlug = await fam.search(`rr2-b-${RUN}`);
    expect(bySlug.tenants.map((t) => t.id)).toEqual([B]);
    const platform = await fam.search('specflicks');
    expect(platform.tenants.map((t) => t.id)).not.toContain(SPECFLICKS);
    expect(await fam.search('r')).toEqual({ users: [], tenants: [] });
  });

  it('getUser: companies with their status, live sessions, trusted devices, lockout state', async () => {
    const [u] = await dbAdmin.select().from(users).where(eq(users.id, dual)).limit(1);
    await authService.issueTokenPair(u!, B, membershipDualB, 'admin', 'dev-list', '198.51.100.7', 'Mozilla/5.0 (Macintosh) Chrome/120');
    await dbAdmin.insert(trustedDevices).values({ user_id: dual, device_id: 'dev-list', device_name: 'Chrome · macOS', expires_at: new Date(Date.now() + 86_400_000) });
    const me = await fam.getUser(dual);
    expect(me.email).toBe(dualEmail);
    expect(me.companies.map((c) => c.tenantId).sort()).toEqual([A, B].sort());
    expect(me.companies.find((c) => c.tenantId === B)).toMatchObject({ role: 'admin', status: 'active', tenantStatus: 'active' });
    expect(me.sessions.length).toBeGreaterThan(0);
    expect(me.sessions.find((s) => s.deviceId === 'dev-list')).toMatchObject({ tenantId: B, ipAddress: '198.51.100.7', mfa: false, impersonated: false });
    expect(me.devices.find((d) => d.deviceId === 'dev-list')).toMatchObject({ active: true, deviceName: 'Chrome · macOS' });
    expect(me.lockout).toMatchObject({ locked: false, otpAttemptsExhausted: false });
    await expect(fam.getUser(crypto.randomUUID())).rejects.toBeInstanceOf(NotFoundException);
  });

  it('clear lockout: a person who burnt their code attempts is let back in, audited on both logs', async () => {
    await dbAdmin.insert(authOtps).values({ email: soloEmail, otp_hash: sha256('000000'), attempt_count: 5, expires_at: new Date(Date.now() + 600_000) });
    expect((await authService.lockoutState(soloEmail, solo)).otpAttemptsExhausted).toBe(true);
    await expect(authService.verifyOtp(soloEmail, '000000')).rejects.toThrow(/too many failed attempts/);
    const res = await fam.clearUserLockout(solo, actor(famUserId));
    expect(res).toMatchObject({ ok: true, otpRowsReset: expect.any(Number) });
    expect(res.otpRowsReset).toBeGreaterThanOrEqual(1);
    expect((await authService.lockoutState(soloEmail, solo)).locked).toBe(false);
    const events = await fam.getUserAuthEvents(solo, { page: 1, limit: 10 });
    expect(events.data.find((e) => e.eventType === 'account_unlocked')).toMatchObject({ ipAddress: '203.0.113.9', metadata: expect.objectContaining({ by: 'fam', actorUserId: famUserId }) });
    const [row] = await dbAdmin.select().from(auditLogPlatform).where(and(eq(auditLogPlatform.target_user_id, solo), eq(auditLogPlatform.action, 'fam.user.lockout_cleared')));
    expect(row).toMatchObject({ actor_user_id: famUserId, ip_address: '203.0.113.9' });
  });

  it('send sign-in link: emails a working 30-minute link, bypassing the OTP quota; the link signs the person in', async () => {
    sendEmail.mockClear();
    const res = await fam.sendUserSignInLink(solo, actor(famUserId));
    expect(res.ok).toBe(true);
    const call = sendEmail.mock.calls.find((c) => (c as unknown[])[0] === 'magic-link') as unknown[] | undefined;
    expect(call?.[1]).toBe(soloEmail);
    const url = (call?.[2] as { magicLinkUrl: string }).magicLinkUrl;
    const raw = new URL(url).searchParams.get('token')!;
    expect(raw).toHaveLength(64);
    const peek = await authService.peekMagicLink(raw);
    expect(peek.status).toBe('ready');
    const signedIn = (await authService.verifyMagicLink(raw, 'dev-link')) as { accessToken: string };
    expect(decode(signedIn.accessToken).sub).toBe(solo);
    const events = await fam.getUserAuthEvents(solo, { page: 1, limit: 20 });
    expect(events.data.some((e) => e.eventType === 'magic_link_requested' && (e.metadata as { by?: string })?.by === 'fam')).toBe(true);
    expect(events.data.some((e) => e.eventType === 'magic_link_consumed')).toBe(true);
  });

  it('sign out everywhere: every live session ends, trusted devices are forgotten, sockets told, audited', async () => {
    const live = await authService.listSessionsDetailed(dual);
    expect(live.length).toBeGreaterThan(0);
    emitted.length = 0;
    const res = await fam.signOutUserEverywhere(dual, actor(famUserId));
    expect(res.sessionsRevoked).toBe(live.length);
    expect(res.devicesRevoked).toBeGreaterThanOrEqual(1);
    expect(await authService.listSessionsDetailed(dual)).toHaveLength(0);
    expect((await authService.listTrustedDevices(dual)).every((d) => !d.active)).toBe(true);
    expect(emitted.filter((e) => e.event === 'seat.revoked').map((e) => (e.payload as { tenantId: string }).tenantId).sort()).toEqual([A, B].sort());
    const events = await fam.getUserAuthEvents(dual, { page: 1, limit: 5 });
    expect(events.data[0]).toMatchObject({ eventType: 'token_revoked', metadata: expect.objectContaining({ reason: 'fam_sign_out_everywhere', all_sessions: true }) });
  });

  it("'tenant_selected' finally persists (0070): a company switch shows up in the sign-in history", async () => {
    const [u] = await dbAdmin.select().from(users).where(eq(users.id, dual)).limit(1);
    void u;
    await authService.selectTenant(dual, B, 'dev-sel', { mfa: false });
    const events = await fam.getUserAuthEvents(dual, { page: 1, limit: 5 });
    expect(events.data[0]).toMatchObject({ eventType: 'tenant_selected', metadata: expect.objectContaining({ tenantId: B }) });
    const [row] = await dbAdmin.select().from(authEvents).where(and(eq(authEvents.user_id, dual), eq(authEvents.event_type, 'tenant_selected')));
    expect(row).toBeDefined();
  });
});

// ─── company support tab ─────────────────────────────────────────────────────

describe('company support tab', () => {
  it("the company's own activity log is readable with filters and exported as CSV", async () => {
    await audit.log({ tenantId: B, actorUserId: ownerB, action: 'employee.terminated', resourceType: 'employee', resourceId: crypto.randomUUID(), beforeState: { status: 'active' }, afterState: { status: 'separated' }, ipAddress: '10.0.0.1' });
    await audit.log({ tenantId: B, actorUserId: ownerB, action: 'leave.approved', resourceType: 'leave_request', resourceId: crypto.randomUUID() });
    const all = await fam.getTenantActivity(B, { page: 1, limit: 50 });
    expect(all.pagination.total).toBeGreaterThanOrEqual(2);
    const filtered = await fam.getTenantActivity(B, { action: 'employee.terminated', page: 1, limit: 50 });
    expect(filtered.data.every((r) => r.action === 'employee.terminated')).toBe(true);
    expect(filtered.data[0]).toMatchObject({ actorEmail: `rr2-ownerb-${RUN}@t.test`, ipAddress: '10.0.0.1' });
    const byType = await fam.getTenantActivity(B, { resourceType: 'leave_request', page: 1, limit: 50 });
    expect(byType.data.every((r) => r.resourceType === 'leave_request')).toBe(true);
    const csv = await fam.exportTenantActivityCsv(B, { action: 'employee.terminated' });
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe('when,action,resource_type,resource_id,actor,actor_email,ip,user_agent,before,after');
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines[1]).toContain('employee.terminated');
    // another company's log is never mixed in
    const otherOnly = await fam.getTenantActivity(A, { action: 'employee.terminated', page: 1, limit: 50 });
    expect(otherOnly.pagination.total).toBe(0);
  });

  it('member actions: resend invite goes through the employees facade with the employee id; sign out ends only this company', async () => {
    const [u] = await dbAdmin.select().from(users).where(eq(users.id, dual)).limit(1);
    await authService.issueTokenPair(u!, A, membershipDualA, 'owner', 'dev-a2');
    await authService.issueTokenPair(u!, B, membershipDualB, 'admin', 'dev-b2');
    const res = await fam.signOutMember(B, membershipDualB, actor(famUserId));
    expect(res.sessionsRevoked).toBeGreaterThanOrEqual(1);
    const liveA = await dbAdmin.select({ id: refreshTokens.id }).from(refreshTokens).where(and(eq(refreshTokens.user_id, dual), eq(refreshTokens.tenant_id, A), isNull(refreshTokens.revoked_at)));
    const liveB = await dbAdmin.select({ id: refreshTokens.id }).from(refreshTokens).where(and(eq(refreshTokens.user_id, dual), eq(refreshTokens.tenant_id, B), isNull(refreshTokens.revoked_at)));
    expect(liveA.length).toBeGreaterThanOrEqual(1);
    expect(liveB).toHaveLength(0);
    // an invited seat with an employee record → facade called with that employee id
    const inv = await mkUser('invitee');
    const [emp] = await dbAdmin.execute<{ id: string }>(
      // the employees table needs a few NOT NULL columns; keep it minimal and real
      `INSERT INTO employees (tenant_id, user_id, employee_code, first_name, last_name, work_email, date_of_joining, status, custom_fields)
       VALUES ('${B}', '${inv.id}', 'INV-${RUN}', 'Invitee', 'R', '${inv.email}', '2026-01-01', 'inactive', '{}'::jsonb) RETURNING id` as never,
    ) as unknown as Array<{ id: string }>;
    const [m] = await dbAdmin
      .insert(memberships)
      .values({ tenant_id: B, user_id: inv.id, role: 'employee', status: 'invited', employee_id: emp!.id })
      .returning({ id: memberships.id });
    resendInvite.mockClear();
    await fam.resendMemberInvite(B, m!.id, actor(famUserId));
    expect(resendInvite).toHaveBeenCalledWith(emp!.id, B, famUserId);
    await expect(fam.resendMemberInvite(A, m!.id, actor(famUserId))).rejects.toBeInstanceOf(NotFoundException);
    const members = await fam.listTenantMembers(B);
    expect(members.data.find((x) => x.membershipId === m!.id)).toMatchObject({ employeeId: emp!.id, status: 'invited' });
  });

  it('support notes: add / pin / delete, audited, and invisible to the app role', async () => {
    const { id } = await fam.addTenantNote(B, actor(famUserId), 'Called about GST filing — promised a callback Monday.');
    await fam.addTenantNote(B, actor(famUserId), 'Second note');
    await fam.updateTenantNote(B, id, actor(famUserId), { pinned: true });
    const list = await fam.listTenantNotes(B);
    expect(list.data[0]).toMatchObject({ id, pinned: true, author: `fam ${RUN}` });
    expect(list.data).toHaveLength(2);
    await expect(fam.updateTenantNote(A, id, actor(famUserId), { pinned: false })).rejects.toBeInstanceOf(NotFoundException);
    await fam.deleteTenantNote(B, list.data[1]!.id, actor(famUserId));
    expect((await fam.listTenantNotes(B)).data).toHaveLength(1);
    const actions = (await dbAdmin.select({ a: auditLogPlatform.action }).from(auditLogPlatform).where(eq(auditLogPlatform.target_tenant_id, B))).map((r) => r.a);
    for (const a of ['fam.tenant.note_added', 'fam.tenant.note_updated', 'fam.tenant.note_deleted']) expect(actions).toContain(a);
    // the tenant's own connection (RLS-bound app role) sees nothing — deny-all policy + revoked grant
    const seen = await dbSvc
      .withTenant(B, async (tx) => tx.select({ id: famTenantNotes.id }).from(famTenantNotes))
      .then((rows) => rows.length)
      .catch((e: Error) => (/permission denied/i.test(e.message) ? 'denied' : `error:${e.message}`));
    expect(seen === 0 || seen === 'denied').toBe(true);
  });
});

// ─── billing help ────────────────────────────────────────────────────────────

describe('billing help', () => {
  it('extend-trial on an EXPIRED trial counts from today (the lock lifts), writes a plan-history event, audits with IP', async () => {
    const past = new Date(Date.now() - 30 * 86_400_000);
    await dbAdmin.update(tenants).set({ trial_ends_at: past }).where(eq(tenants.id, A));
    await dbAdmin.update(subscriptions).set({ trial_ends_at: past }).where(eq(subscriptions.tenant_id, A));
    billingState.invalidate(A);
    expect(await billingState.isLocked(A)).toBe(true);
    const res = await fam.extendTrial(A, actor(famUserId), { days: 14 });
    const ends = new Date(res.trialEndsAt!).getTime();
    expect(ends).toBeGreaterThan(Date.now() + 13 * 86_400_000);
    expect(ends).toBeLessThan(Date.now() + 15 * 86_400_000);
    const [sub] = await dbAdmin.select({ t: subscriptions.trial_ends_at }).from(subscriptions).where(eq(subscriptions.tenant_id, A));
    const [ten] = await dbAdmin.select({ t: tenants.trial_ends_at }).from(tenants).where(eq(tenants.id, A));
    expect(Math.abs(sub!.t!.getTime() - ten!.t!.getTime())).toBeLessThan(2000);
    expect(await billingState.isLocked(A)).toBe(false);
    const [ev] = await dbAdmin.select().from(subscriptionEvents).where(and(eq(subscriptionEvents.tenant_id, A), eq(subscriptionEvents.event_type, 'trial.extended')));
    // the plan history is the customer's: no support reason, no staff id
    expect(ev?.metadata).toEqual({ days: 14 });
  });

  it('give free months: a private coupon applied on the company’s behalf, repeatable, refused for a paying workspace', async () => {
    sendEmail.mockClear();
    const before = (await dbAdmin.select({ t: subscriptions.trial_ends_at }).from(subscriptions).where(eq(subscriptions.tenant_id, A)))[0]!.t!;
    const g1 = await fam.grantFreeMonths(A, actor(famUserId), { months: 2, reason: 'Lost invoice — goodwill' });
    expect(g1.code).toMatch(/^FAM-[0-9A-F]{8}$/);
    const after1 = new Date(g1.trialEndsAt!);
    const expected = addMonthsClamped(before, 2);
    expect(Math.abs(after1.getTime() - expected.getTime())).toBeLessThan(2 * 86_400_000);
    const g2 = await fam.grantFreeMonths(A, actor(famUserId), { months: 1, reason: 'Again' });
    expect(g2.code).not.toBe(g1.code);
    const redemptions = await dbAdmin.select().from(couponRedemptions).where(eq(couponRedemptions.tenant_id, A));
    expect(redemptions).toHaveLength(2);
    const panel = await fam.getTenantBilling(A);
    expect(panel.subscription?.coupon).toMatchObject({ code: g2.code, campaign: 'fam-support', months: 1 });
    expect(panel.subscription?.seats).toBeGreaterThanOrEqual(1);
    expect(panel.events.some((e) => e.eventType === 'coupon.redeemed' && (e.metadata as { code?: string })?.code === g1.code)).toBe(true);
    expect(panel.events.find((e) => e.eventType === 'coupon.redeemed')?.metadata).not.toHaveProperty('reason');
    expect(sendEmail.mock.calls.some((c) => (c as unknown[])[0] === 'coupon-redeemed')).toBe(true);
    const [row] = await dbAdmin.select().from(auditLogPlatform).where(and(eq(auditLogPlatform.target_tenant_id, A), eq(auditLogPlatform.action, 'fam.free_months_granted')));
    expect(row).toMatchObject({ ip_address: '203.0.113.9' });
    await dbAdmin.update(subscriptions).set({ razorpay_subscription_id: `sub_${RUN}` }).where(eq(subscriptions.tenant_id, B));
    await expect(fam.grantFreeMonths(B, actor(famUserId), { months: 1, reason: 'x' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(fam.grantFreeMonths(A, actor(famUserId), { months: 13, reason: 'x' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('platform audit log: filters by action / actor / company and exports CSV with IP + user agent', async () => {
    const byAction = await fam.getPlatformAudit({ action: 'free_months', tenantId: A, page: 1, limit: 50 });
    expect(byAction.data.length).toBe(2);
    expect(byAction.data[0]).toMatchObject({ actorEmail: `rr2-fam-${RUN}@t.test`, ipAddress: '203.0.113.9', userAgent: 'jest/1.0' });
    const byActor = await fam.getPlatformAudit({ actor: `rr2-fam-${RUN}`, page: 1, limit: 200 });
    expect(byActor.data.every((r) => r.actorEmail === `rr2-fam-${RUN}@t.test`)).toBe(true);
    const none = await fam.getPlatformAudit({ actor: 'nobody-matches-this', page: 1, limit: 10 });
    expect(none.pagination.total).toBe(0);
    // "^" anchors to the start: the company lifecycle never picks up fam.tenant.note_*
    const loose = await fam.getPlatformAudit({ action: 'tenant.', tenantId: B, page: 1, limit: 50 });
    expect(loose.data.some((r) => r.action.startsWith('fam.tenant.note_'))).toBe(true);
    const anchored = await fam.getPlatformAudit({ action: '^tenant.', tenantId: B, page: 1, limit: 50 });
    expect(anchored.pagination.total).toBe(0);
    const lifecycle = await fam.getPlatformAudit({ action: '^tenant.', tenantId: A, page: 1, limit: 50 });
    expect(lifecycle.data.length).toBeGreaterThan(0);
    expect(lifecycle.data.every((r) => r.action.startsWith('tenant.'))).toBe(true);
    // comma = alternatives (the Billing category)
    const billingCat = await fam.getPlatformAudit({ action: '^fam.free_months,coupon', tenantId: A, page: 1, limit: 50 });
    expect(billingCat.data.filter((r) => r.action === 'fam.free_months_granted')).toHaveLength(2);
    const csv = await fam.exportPlatformAuditCsv({ tenantId: A, action: 'tenant.suspended' });
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe('when,action,actor,actor_email,company,target_tenant_id,target_user_id,ip,user_agent,metadata');
    expect(lines[1]).toContain('tenant.suspended');
    expect(lines[1]).toContain('203.0.113.9');
    const scoped = await fam.getTenantAudit(A, { action: 'tenant.', page: 1, limit: 50 });
    expect(scoped.data.map((r) => r.action)).toEqual(expect.arrayContaining(['tenant.suspended', 'tenant.reactivated', 'tenant.trial.extended']));
  });
});

// ─── adversarial review fixes ───────────────────────────────────────────────

describe('review fixes', () => {
  it('step-up: an enrolled admin whose session lacks the second factor proves the code in place (no sign-out, no loop)', async () => {
    const { secret } = await authService.enrollTotp(famUserId);
    await authService.confirmTotpEnrollment(famUserId, authenticator.generate(secret));
    expect((await authService.getMe(famUserId)).totp).toEqual({ enforced: true, enrolled: true, satisfied: false });
    await expect(authService.stepUpTotp(famUserId, '000000')).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(authService.stepUpTotp(famUserId, authenticator.generate(secret), { ip: '203.0.113.9' })).resolves.toEqual({ ok: true });
    // the controller re-issues the session with the claim; /auth/me then says satisfied
    expect((await authService.getMe(famUserId, undefined, undefined, { mfa: true })).totp.satisfied).toBe(true);
    const events = await fam.getUserAuthEvents(famUserId, { page: 1, limit: 5 });
    expect(events.data[0]).toMatchObject({ eventType: 'login_success', metadata: expect.objectContaining({ step: 'totp_step_up' }) });
  });

  it('/auth/me lists every seat with the company status and logo, not just the current one', async () => {
    const me = await authService.getMe(dual, B);
    const a = me.memberships.find((m) => m.tenantId === A);
    expect(a).toMatchObject({ tenantStatus: 'trialing' });
    expect(a).toHaveProperty('tenantLogoUrl');
  });

  it('socket handshakes refuse a challenge token and a suspended company', async () => {
    expect(socketSessionProblem({ sub: 'u', scope: 'totp_challenge' } as never)).toBeTruthy();
    expect(socketSessionProblem({ sub: 'u', tenantId: A } as never)).toBeNull();
    await dbAdmin.update(tenants).set({ status: 'suspended' }).where(eq(tenants.id, A));
    expect(await tenantIsSuspended(dbAdmin as never, A)).toBe(true);
    await dbAdmin.update(tenants).set({ status: 'trialing' }).where(eq(tenants.id, A));
    expect(await tenantIsSuspended(dbAdmin as never, A)).toBe(false);
  });

  it("a suspended company's API keys stop working, with TENANT_SUSPENDED rather than 'bad key'", async () => {
    const keys = new ApiKeysService(dbAdmin as never, audit);
    const created = await keys.create(B, ownerB, { name: 'rr2', scopes: ['crm:read'] });
    expect((await keys.verify(created.data.key))?.tenantId).toBe(B);
    await dbAdmin.update(tenants).set({ status: 'suspended' }).where(eq(tenants.id, B));
    await expect(keys.verify(created.data.key)).rejects.toMatchObject({ response: expect.objectContaining({ code: 'TENANT_SUSPENDED' }) });
    await dbAdmin.update(tenants).set({ status: 'active' }).where(eq(tenants.id, B));
    expect((await keys.verify(created.data.key))?.tenantId).toBe(B);
  });

  it('self-service coupons: two concurrent redeems of different codes → exactly one wins; support can still grant on top', async () => {
    const [E] = await dbAdmin
      .insert(tenants)
      .values({ name: `RR2 Echo ${RUN}`, slug: `rr2-e-${RUN}`, status: 'trialing', trial_ends_at: new Date(Date.now() + 5 * 86_400_000) })
      .returning();
    extraTenants.push(E!.id);
    await dbAdmin.insert(subscriptions).values({ tenant_id: E!.id, plan_code: 'beta', status: 'trialing', trial_ends_at: E!.trial_ends_at, per_user_price: 499, user_count: 1 });
    const c1 = `RRX1${RUN.toUpperCase()}`;
    const c2 = `RRX2${RUN.toUpperCase()}`;
    await dbAdmin.insert(couponCodes).values([
      { code: c1, campaign: 'spec', months: 1, max_redemptions: 10, created_by: famUserId },
      { code: c2, campaign: 'spec', months: 2, max_redemptions: 10, created_by: famUserId },
    ]);
    const results = await Promise.allSettled([billing.redeemCoupon(E!.id, ownerA, c1), billing.redeemCoupon(E!.id, ownerA, c2)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected' && r.reason instanceof ConflictException)).toHaveLength(1);
    expect(await dbAdmin.select().from(couponRedemptions).where(eq(couponRedemptions.tenant_id, E!.id))).toHaveLength(1);
    await expect(fam.grantFreeMonths(E!.id, actor(famUserId), { months: 1, reason: 'x' })).resolves.toMatchObject({ months: 1 });
    expect(await dbAdmin.select().from(couponRedemptions).where(eq(couponRedemptions.tenant_id, E!.id))).toHaveLength(2);
    // the Owner's billing page shows the LATEST coupon (the grant), like the console
    const state = await billing.state(E!.id);
    expect((state.data as { coupon?: { code: string } | null }).coupon?.code).toMatch(/^FAM-/);
  });

  it('extend trial: refused for a live Razorpay subscription, creates a missing subscription row, slides a canceled period', async () => {
    await expect(fam.extendTrial(B, actor(famUserId), { days: 7 })).rejects.toBeInstanceOf(BadRequestException);
    const [F] = await dbAdmin.insert(tenants).values({ name: `RR2 Foxtrot ${RUN}`, slug: `rr2-f-${RUN}`, status: 'trialing' }).returning();
    extraTenants.push(F!.id);
    const r = await fam.extendTrial(F!.id, actor(famUserId), { days: 14 });
    const [subF] = await dbAdmin.select({ t: subscriptions.trial_ends_at }).from(subscriptions).where(eq(subscriptions.tenant_id, F!.id));
    expect(subF).toBeDefined();
    expect(new Date(r.trialEndsAt!).getTime()).toBeGreaterThan(Date.now() + 13 * 86_400_000);
    const [G] = await dbAdmin.insert(tenants).values({ name: `RR2 Golf ${RUN}`, slug: `rr2-g-${RUN}`, status: 'active' }).returning();
    extraTenants.push(G!.id);
    await dbAdmin.insert(subscriptions).values({
      tenant_id: G!.id, plan_code: 'beta', status: 'canceled', razorpay_subscription_id: `sub_g_${RUN}`,
      current_period_end: new Date(Date.now() - 86_400_000), per_user_price: 499, user_count: 1,
    });
    billingState.invalidate(G!.id);
    expect(await billingState.isLocked(G!.id)).toBe(true);
    await fam.extendTrial(G!.id, actor(famUserId), { days: 10 });
    const [subG] = await dbAdmin.select({ cpe: subscriptions.current_period_end }).from(subscriptions).where(eq(subscriptions.tenant_id, G!.id));
    expect(subG!.cpe!.getTime()).toBeGreaterThan(Date.now() + 9 * 86_400_000);
    expect(await billingState.isLocked(G!.id)).toBe(false);
  });

  it("a support sign-in link never shadows the person's own code, and a new code request leaves the link alive", async () => {
    await otpFor(soloEmail);
    sendEmail.mockClear();
    await fam.sendUserSignInLink(solo, actor(famUserId));
    await expect(authService.verifyOtp(soloEmail, OTP, 'dev-solo-2')).resolves.toMatchObject({ accessToken: expect.any(String) });
    const call = sendEmail.mock.calls.find((c) => (c as unknown[])[0] === 'magic-link') as unknown[];
    const raw = new URL((call[2] as { magicLinkUrl: string }).magicLinkUrl).searchParams.get('token')!;
    await authService.requestOtp(soloEmail, '203.0.113.1', 'jest');
    expect((await authService.peekMagicLink(raw)).status).toBe('ready');
  });

  it('sign out everywhere also ends an impersonation the person is running', async () => {
    const [seatB] = await dbAdmin.select({ id: memberships.id }).from(memberships).where(and(eq(memberships.tenant_id, B), eq(memberships.user_id, ownerB)));
    const imp = (await fam.startImpersonation(famUserId, { membershipId: seatB!.id, reason: 'support ticket 12345' })) as { refreshToken: string };
    await fam.signOutUserEverywhere(famUserId, actor(famUserId));
    await expect(authService.refreshToken(imp.refreshToken, 'dev-imp')).rejects.toBeInstanceOf(UnauthorizedException);
    const [sess] = await dbAdmin.select({ ended: impersonationSessions.ended_at }).from(impersonationSessions).where(eq(impersonationSessions.impersonator_user_id, famUserId));
    expect(sess?.ended).not.toBeNull();
  });
});
