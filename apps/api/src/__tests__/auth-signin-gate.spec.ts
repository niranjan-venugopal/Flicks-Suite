/**
 * Sign-in gate (UI polish round §C) — an unregistered email must NOT receive
 * an OTP on signin intent: the service throws NOT_REGISTERED (the web client
 * bounces to /onboarding with the email prefilled), writes no auth_otps row,
 * and never calls the mailer. Signup intent keeps the unconditional send —
 * the onboarding wizard uses the same endpoint. "Registered" = a users row
 * exists (invite flows pre-create users; membership status is irrelevant).
 */
import 'dotenv/config';
import * as crypto from 'crypto';
import { db, dbAdmin } from '@flicks/db';
import { authEvents, authOtps, memberships, tenants, users } from '@flicks/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { NotFoundException } from '@nestjs/common';
import { AuthService } from '../modules/auth/auth.service';
import { ConsentService } from '../modules/consent/consent.service';
import { TotpService } from '../modules/auth/totp.service';
import type { AuditService } from '../modules/audit/audit.service';
import type { NotificationsService } from '../modules/notifications/notifications.service';

const rid = () => crypto.randomBytes(4).toString('hex');
const audit = { log: async () => {} } as unknown as AuditService;

const sendEmail = jest.fn(async () => {});
const notifications = { sendEmail } as unknown as NotificationsService;

const config = {
  get: (key: string, fallback?: unknown) =>
    (({
      NODE_ENV: 'test',
      JWT_SECRET: 'test-secret',
      JWT_ISSUER: 'flicks-suite',
      JWT_AUDIENCE: 'flicks-suite-api',
    } as Record<string, unknown>)[key] ?? fallback),
} as unknown as ConfigService;

const jwt = new JwtService({ secret: 'test-secret' });
const authService = new AuthService(
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

const trackedEmails: string[] = [];
const trackedUsers: string[] = [];
let tenantId: string;

const freshEmail = () => {
  const e = `gate-${rid()}@signin.test`;
  trackedEmails.push(e);
  return e;
};

beforeAll(async () => {
  const [t] = await dbAdmin
    .insert(tenants)
    .values({ name: `Gate${rid()}`, slug: `gate-${rid()}-${Date.now()}`, status: 'active', currency: 'INR' })
    .returning();
  tenantId = t!.id;
});

afterAll(async () => {
  if (trackedEmails.length) {
    await dbAdmin.delete(authOtps).where(inArray(authOtps.email, trackedEmails));
    await dbAdmin.delete(authEvents).where(inArray(authEvents.email, trackedEmails));
  }
  await dbAdmin.delete(tenants).where(eq(tenants.id, tenantId));
  for (const id of trackedUsers) await dbAdmin.delete(users).where(eq(users.id, id));
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.().catch(() => {});
});

beforeEach(() => sendEmail.mockClear());

const otpRows = (email: string) =>
  dbAdmin.select().from(authOtps).where(eq(authOtps.email, email));

describe('requestOtp sign-in gate', () => {
  it('signin + unregistered → NOT_REGISTERED, no otp row, no email', async () => {
    const email = freshEmail();
    await expect(authService.requestOtp(email, '127.0.0.1', 'jest', 'signin')).rejects.toMatchObject({
      response: { code: 'NOT_REGISTERED' },
    });
    await expect(authService.requestOtp(email, '127.0.0.1', 'jest', 'signin')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(await otpRows(email)).toHaveLength(0);
    expect(sendEmail).not.toHaveBeenCalled();
    // The refusal is still audited as a failed login.
    const events = await dbAdmin.select().from(authEvents).where(eq(authEvents.email, email));
    expect(events.some((e) => e.event_type === 'login_failed')).toBe(true);
  });

  it('omitted intent defaults to signin (unregistered still refused)', async () => {
    const email = freshEmail();
    await expect(authService.requestOtp(email)).rejects.toMatchObject({
      response: { code: 'NOT_REGISTERED' },
    });
    expect(await otpRows(email)).toHaveLength(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('signup + unregistered → otp row written and email sent (onboarding path)', async () => {
    const email = freshEmail();
    const res = await authService.requestOtp(email, '127.0.0.1', 'jest', 'signup');
    expect(res.success).toBe(true);
    const rows = await otpRows(email);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.user_id).toBeNull(); // no users row yet — verify creates it
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect((sendEmail.mock.calls[0] as unknown as unknown[])[0]).toBe('login-otp');
  });

  it('registered user with zero memberships can still sign in (finishes setup on verify)', async () => {
    const email = freshEmail();
    const [u] = await dbAdmin
      .insert(users)
      .values({ email, full_name: 'No Membership Yet', status: 'active' })
      .returning();
    trackedUsers.push(u!.id);
    const res = await authService.requestOtp(email, '127.0.0.1', 'jest', 'signin');
    expect(res.success).toBe(true);
    const rows = await otpRows(email);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.user_id).toBe(u!.id);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('invited-only membership counts as registered (invite pre-creates the users row)', async () => {
    const email = freshEmail();
    const [u] = await dbAdmin
      .insert(users)
      .values({ email, full_name: 'Invited Person', status: 'active' })
      .returning();
    trackedUsers.push(u!.id);
    await dbAdmin
      .insert(memberships)
      .values({ tenant_id: tenantId, user_id: u!.id, role: 'employee', status: 'invited' });
    const res = await authService.requestOtp(email, '127.0.0.1', 'jest', 'signin');
    expect(res.success).toBe(true);
    expect(await otpRows(email)).toHaveLength(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });
});
