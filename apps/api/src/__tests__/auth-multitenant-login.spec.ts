/**
 * Multi-workspace login (go-live fix) — a user with MORE THAN ONE active
 * membership used to get a token-less requiresTenantSelection response that
 * no client surface ever implemented: entering a valid OTP silently did
 * nothing. First hit in production by the founder after
 * promote-platform-admin granted the Specflicks FAM membership.
 *
 * The fix auto-selects deterministically: oldest membership first, real
 * workspaces preferred over the Specflicks platform tenant. Platform admins
 * then flow into the FAM TOTP branch as designed.
 */
import 'dotenv/config';
import * as crypto from 'crypto';
import { dbAdmin } from '@flicks/db';
import { authEvents, authOtps, memberships, tenants, users } from '@flicks/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AuthService } from '../modules/auth/auth.service';
import { ConsentService } from '../modules/consent/consent.service';
import { TotpService } from '../modules/auth/totp.service';
import type { AuditService } from '../modules/audit/audit.service';
import type { NotificationsService } from '../modules/notifications/notifications.service';

const SPECFLICKS_TENANT_ID = '00000000-0000-0000-0000-000000000001';
const rid = () => crypto.randomBytes(4).toString('hex');
const audit = { log: async () => {} } as unknown as AuditService;

// Capture the emailed OTP so the tests can complete the code flow.
let lastOtpCode = '';
const sendEmail = jest.fn(async (_tpl: unknown, _to: unknown, props: unknown) => {
  lastOtpCode = String((props as { otpCode?: string }).otpCode ?? '');
});
const notifications = { sendEmail } as unknown as NotificationsService;

const makeConfig = (extra: Record<string, unknown> = {}) =>
  ({
    get: (key: string, fallback?: unknown) =>
      (({
        NODE_ENV: 'test',
        JWT_SECRET: 'test-secret',
        JWT_ISSUER: 'flicks-suite',
        JWT_AUDIENCE: 'flicks-suite-api',
        ...extra,
      } as Record<string, unknown>)[key] ?? fallback),
  } as unknown as ConfigService);

const jwt = new JwtService({ secret: 'test-secret' });
const buildService = (config: ConfigService) =>
  new AuthService(
    dbAdmin as never,
    dbAdmin as never,
    jwt,
    config,
    { emit: () => true } as never,
    notifications,
    audit,
    new TotpService(config),
    new ConsentService(dbAdmin as never, config),
  );

const authService = buildService(makeConfig());
// Separate instance with the FAM second factor ENFORCED (TOTP_SECRET set).
const authServiceTotp = buildService(
  makeConfig({ TOTP_SECRET: crypto.randomBytes(32).toString('hex') }),
);

const trackedEmails: string[] = [];
const trackedUsers: string[] = [];
const trackedTenants: string[] = [];

const freshEmail = () => {
  const e = `multi-${rid()}@login.test`;
  trackedEmails.push(e);
  return e;
};

const makeTenant = async (name: string) => {
  const [t] = await dbAdmin
    .insert(tenants)
    .values({ name, slug: `${name.toLowerCase()}-${rid()}`, status: 'active', currency: 'INR' })
    .returning();
  trackedTenants.push(t!.id);
  return t!.id;
};

const makeUser = async (email: string, isPlatformAdmin = false) => {
  const [u] = await dbAdmin
    .insert(users)
    .values({
      email,
      full_name: 'Multi Login',
      status: 'active',
      is_platform_admin: isPlatformAdmin,
    })
    .returning();
  trackedUsers.push(u!.id);
  return u!.id;
};

const addMembership = async (
  tenantId: string,
  userId: string,
  role: string,
  createdAt: Date,
) => {
  await dbAdmin.insert(memberships).values({
    tenant_id: tenantId,
    user_id: userId,
    role: role as never,
    status: 'active',
    accepted_at: createdAt,
    created_at: createdAt,
  });
};

/** Run the full email-code flow and return the verify response. */
const loginWithCode = async (svc: AuthService, email: string) => {
  await svc.requestOtp(email, '127.0.0.1', 'jest', 'signin');
  expect(lastOtpCode).toMatch(/^\d{6}$/);
  return svc.verifyOtp(email, lastOtpCode, undefined, '127.0.0.1', 'jest');
};

beforeAll(async () => {
  // The Specflicks platform tenant exists in prod (seeded by setup); ensure
  // it here so the preference test is hermetic.
  await dbAdmin
    .insert(tenants)
    .values({
      id: SPECFLICKS_TENANT_ID,
      name: 'Specflicks',
      slug: 'specflicks',
      status: 'active',
    })
    .onConflictDoNothing();
});

afterAll(async () => {
  if (trackedEmails.length) {
    await dbAdmin.delete(authOtps).where(inArray(authOtps.email, trackedEmails));
    await dbAdmin.delete(authEvents).where(inArray(authEvents.email, trackedEmails));
  }
  for (const id of trackedUsers) {
    await dbAdmin.delete(memberships).where(eq(memberships.user_id, id));
    await dbAdmin.delete(users).where(eq(users.id, id));
  }
  for (const id of trackedTenants) await dbAdmin.delete(tenants).where(eq(tenants.id, id));
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
});

beforeEach(() => sendEmail.mockClear());

describe('multi-membership login auto-selection', () => {
  it('two normal workspaces → tokens issued, OLDEST membership active (no dead-end)', async () => {
    const email = freshEmail();
    const userId = await makeUser(email);
    const older = await makeTenant('OlderCo');
    const newer = await makeTenant('NewerCo');
    await addMembership(older, userId, 'owner', new Date('2026-01-01T00:00:00Z'));
    await addMembership(newer, userId, 'owner', new Date('2026-06-01T00:00:00Z'));

    const res = (await loginWithCode(authService, email)) as Record<string, unknown>;
    expect(res.requiresTenantSelection).toBeFalsy();
    expect(res.accessToken).toBeDefined();
    const payload = jwt.decode(res.accessToken as string) as { tenantId: string };
    expect(payload.tenantId).toBe(older);
  });

  it('platform tenant is never auto-picked when a real workspace exists', async () => {
    const email = freshEmail();
    const userId = await makeUser(email);
    // FAM membership is OLDER than the real workspace — preference must
    // still win over age.
    await addMembership(SPECFLICKS_TENANT_ID, userId, 'fam', new Date('2026-01-01T00:00:00Z'));
    const own = await makeTenant('OwnCo');
    await addMembership(own, userId, 'owner', new Date('2026-06-01T00:00:00Z'));

    const res = (await loginWithCode(authService, email)) as Record<string, unknown>;
    expect(res.accessToken).toBeDefined();
    const payload = jwt.decode(res.accessToken as string) as { tenantId: string };
    expect(payload.tenantId).toBe(own);
  });

  it('platform admin with 2 memberships reaches the TOTP enrolment branch', async () => {
    const email = freshEmail();
    const userId = await makeUser(email, true);
    const own = await makeTenant('AdminCo');
    await addMembership(own, userId, 'owner', new Date('2026-01-01T00:00:00Z'));
    await addMembership(SPECFLICKS_TENANT_ID, userId, 'fam', new Date('2026-06-01T00:00:00Z'));

    const res = (await loginWithCode(authServiceTotp, email)) as Record<string, unknown>;
    // Session issued + routed to enrolment — the exact flow the founder was
    // locked out of before the fix.
    expect(res.requiresTotpEnrollment).toBe(true);
    expect(res.accessToken).toBeDefined();
  });
});
