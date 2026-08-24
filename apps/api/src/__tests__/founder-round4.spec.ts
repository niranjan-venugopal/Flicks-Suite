/**
 * Founder round 4 — 180-day trusted-device sessions ("stay signed in"):
 *
 *  - An ordinary (untrusted) login issues the standard 7-day refresh token
 *    and getMe reports deviceTrusted=false → the post-login prompt shows.
 *  - POST /auth/trust-device consent: creates the trusted_devices row
 *    (device_name parsed from the UA), marks the CURRENT refresh token
 *    trusted and extends its expiry to ~180d — the session upgrades in
 *    place, no re-login.
 *  - A fresh login carrying a trusted device id auto-issues a ~180d
 *    refresh token (no re-prompt after logout/login) and deviceTrusted=true.
 *  - Rotation preserves the 180-day window while the device consent is
 *    live, and silently downgrades to 7d once the device row is revoked
 *    (the future "sign out of this device" hook).
 *
 * Service-level against the real Postgres, mirroring founder-round3.spec.ts.
 */
import 'dotenv/config';
import * as crypto from 'crypto';
import { eq, desc } from 'drizzle-orm';
import { db, dbAdmin } from '@flicks/db';
import {
  users,
  authOtps,
  refreshTokens,
  trustedDevices,
} from '@flicks/db/schema';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AuthService } from '../modules/auth/auth.service';
import { TotpService } from '../modules/auth/totp.service';
import { ConsentService } from '../modules/consent/consent.service';
import type { AuditService } from '../modules/audit/audit.service';
import type { NotificationsService } from '../modules/notifications/notifications.service';

const rid = () => crypto.randomBytes(4).toString('hex');
const audit = { log: async () => {} } as unknown as AuditService;

let lastOtpCode = '';
const notifications = {
  sendEmail: jest.fn(async (_tpl: unknown, _to: unknown, props?: unknown) => {
    const code = (props as { otpCode?: string } | undefined)?.otpCode;
    if (code) lastOtpCode = String(code);
    return true;
  }),
  createInAppNotification: jest.fn(async () => undefined),
} as unknown as NotificationsService;

const authConfig = {
  get: (key: string, fallback?: unknown) =>
    (({
      NODE_ENV: 'test',
      JWT_SECRET: 'test-secret',
      JWT_ISSUER: 'flicks-suite',
      JWT_AUDIENCE: 'flicks-suite-api',
    } as Record<string, unknown>)[key] ?? fallback),
} as unknown as ConfigService;
const authService = new AuthService(
  dbAdmin as never,
  dbAdmin as never,
  new JwtService({ secret: 'test-secret' }),
  authConfig,
  { emit: () => true } as never,
  notifications,
  audit,
  new TotpService(authConfig),
  new ConsentService(dbAdmin as never, authConfig),
);

const DAY_MS = 24 * 60 * 60 * 1000;
const CHROME_MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const trackedEmails: string[] = [];
const trackedUserIds: string[] = [];

/** Remaining lifetime (in days) of the newest refresh-token row for a user. */
async function newestTokenDays(userId: string) {
  const [row] = await dbAdmin
    .select()
    .from(refreshTokens)
    .where(eq(refreshTokens.user_id, userId))
    .orderBy(desc(refreshTokens.created_at))
    .limit(1);
  expect(row).toBeTruthy();
  return {
    row: row!,
    days: (row!.expires_at.getTime() - Date.now()) / DAY_MS,
  };
}

async function signupViaOtp(email: string, deviceId?: string) {
  trackedEmails.push(email);
  await authService.requestOtp(email, '127.0.0.1', CHROME_MAC_UA, 'signup');
  expect(lastOtpCode).toMatch(/^\d{6}$/);
  const result = (await authService.verifyOtp(
    email,
    lastOtpCode,
    deviceId,
    '127.0.0.1',
    CHROME_MAC_UA,
    [{ type: 'terms_privacy', granted: true }] as never,
  )) as { refreshToken?: string; user?: { id?: string } };
  expect(result.refreshToken).toBeTruthy();
  expect(result.user?.id).toBeTruthy();
  trackedUserIds.push(result.user!.id!);
  return { userId: result.user!.id!, refreshToken: result.refreshToken! };
}

async function loginViaOtp(email: string, deviceId?: string) {
  await authService.requestOtp(email, '127.0.0.1', CHROME_MAC_UA, 'signin');
  const result = (await authService.verifyOtp(
    email,
    lastOtpCode,
    deviceId,
    '127.0.0.1',
    CHROME_MAC_UA,
  )) as { refreshToken?: string };
  expect(result.refreshToken).toBeTruthy();
  return { refreshToken: result.refreshToken! };
}

afterAll(async () => {
  for (const email of trackedEmails)
    await dbAdmin.delete(authOtps).where(eq(authOtps.email, email));
  for (const id of trackedUserIds)
    await dbAdmin.delete(users).where(eq(users.id, id)); // cascades tokens+devices
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
});

describe('trusted devices: 180-day "stay signed in"', () => {
  const deviceId = crypto.randomUUID();
  let userId: string;
  let currentRefresh: string;

  it('an ordinary login issues a 7-day untrusted token; deviceTrusted=false', async () => {
    const signup = await signupViaOtp(`trust-${rid()}@r4.test`, deviceId);
    userId = signup.userId;
    currentRefresh = signup.refreshToken;

    const { row, days } = await newestTokenDays(userId);
    expect(row.trusted).toBe(false);
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);

    // No consent yet → no device row, prompt should show.
    const me = await authService.getMe(userId, undefined, deviceId);
    expect(me.deviceTrusted).toBe(false);
  });

  it('trust-device consent upgrades the CURRENT session in place to ~180d', async () => {
    const result = await authService.trustDevice(
      userId,
      deviceId,
      currentRefresh,
      '127.0.0.1',
      CHROME_MAC_UA,
    );
    expect(result.trusted).toBe(true);
    expect(result.refreshTtlMs).toBe(180 * DAY_MS);

    // Device row exists with a readable name and a ~180d expiry.
    const [device] = await dbAdmin
      .select()
      .from(trustedDevices)
      .where(eq(trustedDevices.user_id, userId));
    expect(device).toBeTruthy();
    expect(device!.device_id).toBe(deviceId);
    expect(device!.revoked_at).toBeNull();
    expect(device!.device_name).toBe('Chrome · macOS');
    expect(
      (device!.expires_at!.getTime() - Date.now()) / DAY_MS,
    ).toBeGreaterThan(179);

    // The ACTIVE refresh token was marked trusted and extended — no re-login.
    const { row, days } = await newestTokenDays(userId);
    expect(row.trusted).toBe(true);
    expect(days).toBeGreaterThan(179);
    expect(days).toBeLessThan(181);

    const me = await authService.getMe(userId, undefined, deviceId);
    expect(me.deviceTrusted).toBe(true);
  });

  it('rotation preserves the 180-day window while the device is trusted', async () => {
    const rotated = (await authService.refreshToken(
      currentRefresh,
      deviceId,
      '127.0.0.1',
      CHROME_MAC_UA,
    )) as { refreshToken: string; refreshTtlMs: number };
    expect(rotated.refreshTtlMs).toBe(180 * DAY_MS);
    currentRefresh = rotated.refreshToken;

    const { row, days } = await newestTokenDays(userId);
    expect(row.trusted).toBe(true);
    expect(days).toBeGreaterThan(179);
  });

  it('a fresh login on the trusted device auto-issues ~180d — no re-prompt', async () => {
    const email = trackedEmails[0]!;
    const login = await loginViaOtp(email, deviceId);
    currentRefresh = login.refreshToken;

    const { row, days } = await newestTokenDays(userId);
    expect(row.trusted).toBe(true);
    expect(days).toBeGreaterThan(179);

    // Prompt logic: already trusted → the dialog never shows again.
    const me = await authService.getMe(userId, undefined, deviceId);
    expect(me.deviceTrusted).toBe(true);
  });

  it('a login WITHOUT the trusted device id stays on the 7-day window', async () => {
    const email = trackedEmails[0]!;
    const otherDevice = crypto.randomUUID();
    await loginViaOtp(email, otherDevice);

    const { row, days } = await newestTokenDays(userId);
    expect(row.trusted).toBe(false);
    expect(days).toBeLessThan(7.1);

    const me = await authService.getMe(userId, undefined, otherDevice);
    expect(me.deviceTrusted).toBe(false);
  });

  it('revoking the device consent downgrades rotation back to 7d', async () => {
    // The future "sign out of this device" hook: revoke the row directly.
    await dbAdmin
      .update(trustedDevices)
      .set({ revoked_at: new Date() })
      .where(eq(trustedDevices.user_id, userId));

    const rotated = (await authService.refreshToken(
      currentRefresh,
      deviceId,
      '127.0.0.1',
      CHROME_MAC_UA,
    )) as { refreshToken: string; refreshTtlMs: number };
    expect(rotated.refreshTtlMs).toBe(7 * DAY_MS);

    const { row, days } = await newestTokenDays(userId);
    expect(row.trusted).toBe(false);
    expect(days).toBeLessThan(7.1);

    const me = await authService.getMe(userId, undefined, deviceId);
    expect(me.deviceTrusted).toBe(false);
  });
});
