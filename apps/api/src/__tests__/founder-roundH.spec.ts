import 'dotenv/config';
import * as crypto from 'crypto';
import { and, eq, gt } from 'drizzle-orm';
import { db, dbAdmin } from '@flicks/db';
import { authOtps, memberships, tenants, users } from '@flicks/db/schema';
import { JwtService } from '@nestjs/jwt';
import type { ExecutionContext } from '@nestjs/common';
import { DatabaseService } from '../core/database/database.service';
import { AuthService } from '../modules/auth/auth.service';
import { ConsentService } from '../modules/consent/consent.service';
import { MembersService } from '../modules/members/members.service';
import { ModuleAccessService } from '../core/auth/module-access.service';
import { GuestScopeGuard, guestPathAllowed } from '../core/auth/guards/guest-scope.guard';
import type { AuditService } from '../modules/audit/audit.service';
import type { NotificationsService } from '../modules/notifications/notifications.service';
import type { JwtPayload } from '@flicks/shared/types';

/**
 * Round H — guest sign-in ("Magic link has already been used") + guest isolation.
 *
 * 1. The magic-link flow is two-step (peek → explicit consume) so mail-security
 *    link scanners can no longer burn the single-use invite token before the
 *    invitee clicks, and a burned/expired link recovers into a fresh sign-in
 *    code for the same address instead of dead-ending.
 * 2. Accepting an invite lands in the workspace that was just accepted, even
 *    when the user owns another workspace (membershipRank would otherwise
 *    drop them into their own and the invited project looked gone).
 * 3. GuestScopeGuard: the API is deny-by-default for the guest role — the
 *    unranked self-service HRMS/platform routes (members roster, org chart,
 *    employee profiles + documents, tenant profile, admin dashboard, audit
 *    feed, attendance/leave/timesheet writes…) are refused and audited.
 */

const rid = () => crypto.randomBytes(4).toString('hex');
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

const auditCalls: Array<Record<string, unknown>> = [];
const audit = {
  log: async (entry: Record<string, unknown>) => {
    auditCalls.push(entry);
  },
} as unknown as AuditService;

const captured: { template: string; to: string; props: Record<string, unknown> }[] = [];
const notifications = {
  sendEmail: async (template: string, to: string, props: Record<string, unknown>) => {
    captured.push({ template, to, props });
  },
} as unknown as NotificationsService;

const config = {
  get: (key: string, fallback?: unknown) => {
    const map: Record<string, unknown> = {
      MAGIC_LINK_BASE_URL: 'http://localhost:3000/verify',
      NODE_ENV: 'test',
      JWT_SECRET: 'test-secret',
      JWT_ACCESS_EXPIRY: '15m',
      JWT_REFRESH_EXPIRY: '7d',
      JWT_ISSUER: 'flicks-suite',
      JWT_AUDIENCE: 'flicks-suite-api',
    };
    return map[key] ?? fallback;
  },
} as unknown as import('@nestjs/config').ConfigService;

const jwt = new JwtService({ secret: 'test-secret' });
const eventEmitter = { emit: () => true } as never;
const totp = { isEnforced: () => false } as never;
const consentSvc = new ConsentService(dbAdmin as never, config);
const authService = new AuthService(
  dbAdmin as never,
  dbAdmin as never,
  jwt,
  config,
  eventEmitter,
  notifications,
  audit,
  totp,
  consentSvc,
);
const dbSvc = new DatabaseService();
const moduleAccess = new ModuleAccessService(dbSvc, dbAdmin as never);
const members = new MembersService(
  dbSvc,
  dbAdmin as never,
  audit,
  notifications,
  authService,
  moduleAccess,
  { servedUrl: async (k: string | null, l: string | null) => (k ? `signed:${k}` : l) } as never,
);

const tokenFromLastInvite = (): string => {
  const mail = [...captured].reverse().find((c) => c.template === 'pm-guest-invite')!;
  return new URL(String(mail.props.magicLinkUrl)).searchParams.get('token')!;
};
const decodeTenant = (accessToken: string): string =>
  (jwt.decode(accessToken) as { tenantId: string }).tenantId;

// ─── 3. GuestScopeGuard ──────────────────────────────────────────────────────

describe('GuestScopeGuard — deny-by-default for guest seats', () => {
  const DENIED = [
    '/api/v1/settings/members',
    '/api/v1/settings/organization',
    '/api/v1/settings/departments',
    '/api/v1/employees/org-chart',
    '/api/v1/employees/3f2a9c1e-0000-4000-8000-000000000001',
    '/api/v1/employees/3f2a9c1e-0000-4000-8000-000000000001/documents/abc/url',
    '/api/v1/dashboard/admin/overview',
    '/api/v1/dashboard/admin/activity?limit=20',
    '/api/v1/attendance/punch-in',
    '/api/v1/leave/apply',
    '/api/v1/timesheet/entries',
    '/api/v1/calendar/events?from=2026-01-01',
    '/api/v1/billing',
    '/api/v1/settings/members/seats',
    '/api/v1/crm/leads',
    '/api/v1/invoices',
    '/api/v1/media/logo', // only the OWN avatar is a guest's
    '/api/v1/members', // 'me' must not prefix-match 'members'
  ];
  const ALLOWED = [
    '/api/v1/auth/me',
    '/api/v1/auth/switch-company',
    '/api/v1/auth/totp/verify',
    '/api/v1/me/companies',
    '/api/v1/me/status',
    '/api/v1/presence?userIds=a,b',
    '/api/v1/notifications/unread',
    '/api/v1/notifications',
    '/api/v1/pm/issues',
    '/api/v1/pm/sync/bootstrap',
    '/api/v1/pm/projects/abc/detail',
    '/api/v1/consents',
    '/api/v1/me/consents',
    '/api/v1/media/avatar',
    '/api/v1/onboarding/create-tenant',
    '/api/v1/feedback',
    '/api/v1/events',
    '/api/v1/employees/me/onboarding-status',
  ];

  it('the path allowlist is exact-or-child-prefix, ignores the api/v1 prefix and query strings', () => {
    for (const p of DENIED) expect({ p, ok: guestPathAllowed(p) }).toEqual({ p, ok: false });
    for (const p of ALLOWED) expect({ p, ok: guestPathAllowed(p) }).toEqual({ p, ok: true });
  });

  let isPublic = false;
  const guard = new GuestScopeGuard({ getAllAndOverride: () => isPublic } as never, audit);
  const ctxFor = (user: Partial<JwtPayload> | undefined, url: string): ExecutionContext =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ user, method: 'GET', originalUrl: url, url, headers: {} }) }),
      getHandler: () => () => {},
      getClass: () => class {},
    }) as unknown as ExecutionContext;
  const allows = async (user: Partial<JwtPayload> | undefined, url: string) => {
    try {
      return await guard.canActivate(ctxFor(user, url));
    } catch {
      return false;
    }
  };
  const guest: Partial<JwtPayload> = { sub: 'u1', role: 'guest', tenantId: '00000000-0000-4000-8000-000000000001', membershipId: 'm1' } as never;

  it('a guest is refused every unranked HRMS/platform route and allowed only its own shell + PM', async () => {
    for (const p of DENIED) expect({ p, ok: await allows(guest, p) }).toEqual({ p, ok: false });
    for (const p of ALLOWED) expect({ p, ok: await allows(guest, p) }).toEqual({ p, ok: true });
  });

  it('every workspace role, platform staff, public routes and unauthenticated requests are untouched', async () => {
    for (const role of ['employee', 'manager', 'finance', 'admin', 'owner', 'auditor'] as const) {
      expect(await allows({ ...guest, role } as never, '/api/v1/settings/members')).toBe(true);
    }
    expect(await allows({ ...guest, isPlatformAdmin: true } as never, '/api/v1/settings/members')).toBe(true);
    expect(await allows(undefined, '/api/v1/settings/members')).toBe(true);
    isPublic = true;
    expect(await allows(guest, '/api/v1/settings/members')).toBe(true);
    isPublic = false;
  });

  it('a refusal is audited as authz.denied / guest_scope', async () => {
    auditCalls.length = 0;
    await allows(guest, '/api/v1/employees/org-chart');
    const denied = auditCalls.find((c) => c.action === 'authz.denied');
    expect(denied).toBeTruthy();
    expect((denied!.metadata as Record<string, unknown>).reason).toBe('guest_scope');
    expect((denied!.metadata as Record<string, unknown>).path).toBe('employees/org-chart');
  });
});

// ─── 1 + 2. Magic link: peek / consume / recover; accept lands where invited ─

describe('Magic link — scanner-proof two-step + recovery + accept-lands-where-invited', () => {
  let tenantX: string; // the guest's OWN workspace (owner)
  let tenantY: string; // the inviting workspace
  let ownerY: string;
  let guestUserId: string;
  const guestEmail = `rh-guest-${rid()}@corp.test`;
  let inviteToken: string;

  beforeAll(async () => {
    const [tX] = await dbAdmin.insert(tenants).values({ name: `RHX${rid()}`, slug: `rh-x-${rid()}`, status: 'active', currency: 'INR' }).returning();
    const [tY] = await dbAdmin.insert(tenants).values({ name: `RHY${rid()}`, slug: `rh-y-${rid()}`, status: 'active', currency: 'INR' }).returning();
    tenantX = tX!.id;
    tenantY = tY!.id;
    const [oY] = await dbAdmin.insert(users).values({ email: `rh-owner-${rid()}@test.test`, full_name: 'Owner Y', status: 'active' }).returning();
    ownerY = oY!.id;
    await dbAdmin.insert(memberships).values({ tenant_id: tenantY, user_id: ownerY, role: 'owner', status: 'active' });
    // The invitee already owns workspace X — the exact "created their own
    // workspace" situation from the founder's report.
    const [g] = await dbAdmin.insert(users).values({ email: guestEmail, full_name: 'Guest Person', status: 'active' }).returning();
    guestUserId = g!.id;
    await dbAdmin.insert(memberships).values({ tenant_id: tenantX, user_id: guestUserId, role: 'owner', status: 'active' });

    captured.length = 0;
    const res = await members.inviteGuest(tenantY, ownerY, { email: guestEmail, projectName: 'Apollo' });
    expect(res.status).toBe('invited');
    expect(res.magicLinkSent).toBe(true);
    inviteToken = tokenFromLastInvite();
    expect(inviteToken).toMatch(/^[0-9a-f]{64}$/);
  });

  afterAll(async () => {
    await dbAdmin.delete(tenants).where(eq(tenants.id, tenantX));
    await dbAdmin.delete(tenants).where(eq(tenants.id, tenantY));
    await dbAdmin.delete(authOtps).where(eq(authOtps.email, guestEmail));
    await dbAdmin.delete(users).where(eq(users.id, guestUserId));
    await dbAdmin.delete(users).where(eq(users.id, ownerY));
    await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
    await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  });

  const inviteRow = async () =>
    (await dbAdmin.select().from(authOtps).where(eq(authOtps.magic_link_token, sha256(inviteToken))).limit(1))[0]!;

  it('peek never consumes: a scanner opening the page twice leaves the token ready', async () => {
    expect(await authService.peekMagicLink(inviteToken)).toEqual({ status: 'ready', email: guestEmail });
    expect(await authService.peekMagicLink(inviteToken)).toEqual({ status: 'ready', email: guestEmail });
    expect((await inviteRow()).consumed_at).toBeNull();
    expect(await authService.peekMagicLink('f'.repeat(64))).toEqual({ status: 'invalid' });
    expect(await authService.peekMagicLink('not-a-token')).toEqual({ status: 'invalid' });
  });

  it('consume signs in, activates the guest membership, and lands in the INVITING workspace (not the one they own)', async () => {
    const result = (await authService.verifyMagicLink(inviteToken)) as { accessToken?: string };
    expect(result.accessToken).toBeTruthy();
    expect(decodeTenant(result.accessToken!)).toBe(tenantY);
    const [m] = await dbAdmin
      .select()
      .from(memberships)
      .where(and(eq(memberships.user_id, guestUserId), eq(memberships.tenant_id, tenantY)));
    expect(m!.status).toBe('active');
    expect(m!.role).toBe('guest');
  });

  it('with nothing left to accept, an ordinary login ranks the owned workspace first (round-7 rule intact)', async () => {
    const url = await authService.issueInviteMagicLink(guestUserId, guestEmail);
    const token = new URL(url).searchParams.get('token')!;
    const result = (await authService.verifyMagicLink(token)) as { accessToken?: string };
    expect(decodeTenant(result.accessToken!)).toBe(tenantX);
  });

  it('a token consumed more than 60s ago is refused — and peek reports it honestly', async () => {
    await dbAdmin
      .update(authOtps)
      .set({ consumed_at: new Date(Date.now() - 5 * 60 * 1000) })
      .where(eq(authOtps.magic_link_token, sha256(inviteToken)));
    await expect(authService.verifyMagicLink(inviteToken)).rejects.toThrow(/already been used/);
    expect(await authService.peekMagicLink(inviteToken)).toEqual({ status: 'consumed', email: guestEmail });
  });

  it('recover turns the burned link into a fresh sign-in code for the same address', async () => {
    captured.length = 0;
    const before = Date.now();
    const res = await authService.recoverMagicLink(inviteToken);
    expect(res).toEqual({ email: guestEmail });
    const otpMail = captured.find((c) => c.template === 'login-otp');
    expect(otpMail?.to).toBe(guestEmail);
    expect(String(otpMail?.props.otpCode)).toMatch(/^\d{6}$/);
    // A fresh short-lived OTP row exists for the address.
    const fresh = await dbAdmin
      .select()
      .from(authOtps)
      .where(and(eq(authOtps.email, guestEmail), gt(authOtps.created_at, new Date(before - 1000))));
    expect(fresh.length).toBeGreaterThanOrEqual(1);
  });

  it('recover refuses unknown tokens', async () => {
    await expect(authService.recoverMagicLink('e'.repeat(64))).rejects.toThrow(/Invalid or expired/);
    await expect(authService.recoverMagicLink('garbage')).rejects.toThrow(/Invalid or expired/);
  });
});
