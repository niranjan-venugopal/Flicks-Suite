/**
 * Sprint 13 §E — TOTP brute-force lockout + single-use backup codes.
 * Exercises the REAL AuthService.enrollTotp / confirmTotpEnrollment /
 * completeTotpChallenge with a real TotpService (otplib).
 */
import 'dotenv/config';
import { db, dbAdmin } from '@flicks/db';
import { users } from '@flicks/db/schema';
import { eq } from 'drizzle-orm';
import { authenticator } from 'otplib';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AuthService } from '../modules/auth/auth.service';
import { ConsentService } from '../modules/consent/consent.service';
import { TotpService } from '../modules/auth/totp.service';
import type { AuditService } from '../modules/audit/audit.service';
import type { NotificationsService } from '../modules/notifications/notifications.service';

const rid = () => Math.random().toString(36).slice(2, 8);
const audit = { log: async () => {} } as unknown as AuditService;
const notifications = { sendEmail: async () => {} } as unknown as NotificationsService;

const config = {
  get: (key: string, fallback?: unknown) =>
    (({
      NODE_ENV: 'test',
      JWT_SECRET: 'test-secret',
      JWT_ACCESS_EXPIRY: '15m',
      JWT_REFRESH_EXPIRY: '7d',
      JWT_ISSUER: 'flicks-suite',
      JWT_AUDIENCE: 'flicks-suite-api',
      TOTP_SECRET: '', // key null → secret stored/verified in clear (test only)
    } as Record<string, unknown>)[key] ?? fallback),
} as unknown as ConfigService;

const jwt = new JwtService({ secret: 'test-secret' });
const totp = new TotpService(config);
const consentSvc = new ConsentService(dbAdmin as never, config);
const authService = new AuthService(
  dbAdmin as never,
  dbAdmin as never,
  jwt,
  config,
  { emit: () => true } as never,
  notifications,
  audit,
  totp,

  consentSvc,
);

/** Enrol a fresh platform-admin user and return its 10 backup codes. */
async function enrol(): Promise<{ userId: string; backupCodes: string[] }> {
  const [u] = await dbAdmin
    .insert(users)
    .values({
      email: `totp-${rid()}@test.test`,
      full_name: 'TOTP User',
      status: 'active',
      is_platform_admin: true,
    })
    .returning();
  const userId = u!.id;
  const { secret } = await authService.enrollTotp(userId);
  const { backupCodes } = await authService.confirmTotpEnrollment(
    userId,
    authenticator.generate(secret),
  );
  return { userId, backupCodes };
}

const challenge = (userId: string) =>
  jwt.sign({ sub: userId, scope: 'totp_challenge', tenantId: null, membershipId: null, role: null });

describe('TOTP security — lockout + backup codes (Sprint 13 §E)', () => {
  const created: string[] = [];

  afterAll(async () => {
    for (const id of created) await dbAdmin.delete(users).where(eq(users.id, id));
    await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.().catch(() => {});
    await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.().catch(() => {});
  });

  it('issues 10 backup codes at enrolment', async () => {
    const { userId, backupCodes } = await enrol();
    created.push(userId);
    expect(backupCodes).toHaveLength(10);
    expect(new Set(backupCodes).size).toBe(10); // all unique
  });

  it('accepts a single-use backup code and refuses its reuse', async () => {
    const { userId, backupCodes } = await enrol();
    created.push(userId);
    const token = challenge(userId);

    const ok = (await authService.completeTotpChallenge(token, backupCodes[0]!)) as {
      accessToken?: string;
    };
    expect(ok.accessToken).toBeTruthy();

    // Same code a second time is rejected.
    await expect(authService.completeTotpChallenge(token, backupCodes[0]!)).rejects.toThrow(
      /invalid/i,
    );
  });

  it('locks the account after 5 failed attempts (even a valid backup code is refused)', async () => {
    const { userId, backupCodes } = await enrol();
    created.push(userId);
    const token = challenge(userId);

    for (let i = 0; i < 5; i++) {
      await expect(authService.completeTotpChallenge(token, '000000')).rejects.toThrow();
    }
    // Now locked: a valid backup code is still refused by the lockout gate.
    await expect(authService.completeTotpChallenge(token, backupCodes[0]!)).rejects.toThrow(
      /try again|locked/i,
    );
  });
});
