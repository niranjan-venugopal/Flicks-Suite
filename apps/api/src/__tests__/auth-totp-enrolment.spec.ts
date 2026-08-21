/**
 * TOTP enrolment (go-live fix) — the setup page fetches the pending secret on
 * every mount, so enrolment MUST be idempotent: regenerating per call
 * silently invalidated the key users had already added to their
 * authenticator app (the prod "shows a new key every time" loop).
 */
import 'dotenv/config';
import * as crypto from 'crypto';
import { authenticator } from 'otplib';
import { dbAdmin } from '@flicks/db';
import { users } from '@flicks/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { AuthService } from '../modules/auth/auth.service';
import { ConsentService } from '../modules/consent/consent.service';
import { TotpService } from '../modules/auth/totp.service';
import type { AuditService } from '../modules/audit/audit.service';
import type { NotificationsService } from '../modules/notifications/notifications.service';

const rid = () => crypto.randomBytes(4).toString('hex');
const audit = { log: async () => {} } as unknown as AuditService;
const notifications = { sendEmail: jest.fn(async () => {}) } as unknown as NotificationsService;

const config = {
  get: (key: string, fallback?: unknown) =>
    (({
      NODE_ENV: 'test',
      JWT_SECRET: 'test-secret',
      JWT_ISSUER: 'flicks-suite',
      JWT_AUDIENCE: 'flicks-suite-api',
      // Encryption + enforcement live, like production.
      TOTP_SECRET: 'a'.repeat(64),
    } as Record<string, unknown>)[key] ?? fallback),
} as unknown as ConfigService;

const authService = new AuthService(
  dbAdmin as never,
  dbAdmin as never,
  new JwtService({ secret: 'test-secret' }),
  config,
  { emit: () => true } as never,
  notifications,
  audit,
  new TotpService(config),
  new ConsentService(dbAdmin as never, config),
);

const trackedUsers: string[] = [];
const makeAdmin = async () => {
  const [u] = await dbAdmin
    .insert(users)
    .values({
      email: `totp-${rid()}@enrol.test`,
      full_name: 'Totp Enrol',
      status: 'active',
      is_platform_admin: true,
    })
    .returning();
  trackedUsers.push(u!.id);
  return u!.id;
};

afterAll(async () => {
  if (trackedUsers.length) await dbAdmin.delete(users).where(inArray(users.id, trackedUsers));
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
});

describe('TOTP enrolment idempotency', () => {
  it('repeat enrol returns the SAME pending secret; the first key confirms', async () => {
    const userId = await makeAdmin();
    const first = await authService.enrollTotp(userId);
    const second = await authService.enrollTotp(userId);
    expect(second.secret).toBe(first.secret);
    expect(second.otpauthUrl).toBe(first.otpauthUrl);

    // The key added to the authenticator on the FIRST visit still works.
    const res = await authService.confirmTotpEnrollment(
      userId,
      authenticator.generate(first.secret),
    );
    expect(res.ok).toBe(true);
    expect(res.backupCodes).toHaveLength(10);

    const [row] = await dbAdmin
      .select({ enrolledAt: users.totp_enrolled_at })
      .from(users)
      .where(eq(users.id, userId));
    expect(row!.enrolledAt).not.toBeNull();
  });

  it('regenerate mints a new secret and invalidates the old key', async () => {
    const userId = await makeAdmin();
    const first = await authService.enrollTotp(userId);
    const regen = await authService.enrollTotp(userId, { regenerate: true });
    expect(regen.secret).not.toBe(first.secret);

    await expect(
      authService.confirmTotpEnrollment(userId, authenticator.generate(first.secret)),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    const res = await authService.confirmTotpEnrollment(
      userId,
      authenticator.generate(regen.secret),
    );
    expect(res.ok).toBe(true);
  });

  it('enrol after confirmation conflicts (client routes to the challenge flow)', async () => {
    const userId = await makeAdmin();
    const { secret } = await authService.enrollTotp(userId);
    await authService.confirmTotpEnrollment(userId, authenticator.generate(secret));

    await expect(authService.enrollTotp(userId)).rejects.toBeInstanceOf(ConflictException);
  });
});
