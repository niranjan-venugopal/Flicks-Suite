import 'dotenv/config';
import * as crypto from 'crypto';
import { eq } from 'drizzle-orm';
import { dbAdmin } from '@flicks/db';
import { users, authOtps, consentRecords } from '@flicks/db/schema';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from '../modules/auth/auth.service';
import { ConsentService } from '../modules/consent/consent.service';
import { TERMS_VERSION } from '@flicks/shared/constants';

/**
 * PRD v4 §3 — consent ledger + signup clickwrap (Sprint 16).
 * Real-Postgres integration tests following the house pattern.
 */

const rid = () => crypto.randomBytes(4).toString('hex');
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

const config = {
  get: (key: string, fallback?: unknown) =>
    ((
      {
        JWT_SECRET: 'test-secret-test-secret-test-secret',
        JWT_ACCESS_EXPIRY: '15m',
        JWT_REFRESH_EXPIRY: '7d',
        JWT_ISSUER: 'flicks-suite',
        JWT_AUDIENCE: 'flicks-suite-api',
      } as Record<string, unknown>
    )[key] ?? fallback),
} as unknown as import('@nestjs/config').ConfigService;

const consentSvc = new ConsentService(dbAdmin as never, config);
const notifications = { sendEmail: async () => {} } as never;
const audit = { log: async () => {} } as never;
const totp = { isEnforced: () => false } as never;
const jwt = new JwtService({ secret: 'test-secret' });
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

/** Seed a fresh unconsumed OTP row so verifyOtp can run for `email`. */
async function seedOtp(email: string): Promise<string> {
  const code = '123456';
  await dbAdmin.insert(authOtps).values({
    email,
    otp_hash: sha256(code),
    expires_at: new Date(Date.now() + 10 * 60 * 1000),
  });
  return code;
}

describe('Consent ledger (PRD v4 §3)', () => {
  const cleanupUsers: string[] = [];

  afterAll(async () => {
    for (const id of cleanupUsers) {
      await dbAdmin.delete(users).where(eq(users.id, id));
    }
    await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  });

  it('append-only ledger: latest row per type wins; withdrawal is a new row', async () => {
    const [u] = await dbAdmin
      .insert(users)
      .values({ email: `ledger-${rid()}@test.test`, full_name: 'Ledger T' })
      .returning();
    cleanupUsers.push(u!.id);

    await consentSvc.record(u!.id, [{ type: 'analytics', granted: true }], {
      source: 'banner',
      regionCode: 'IN',
      ip: '1.2.3.4',
    });
    expect(await consentSvc.analyticsGranted(u!.id)).toBe(true);

    await consentSvc.record(u!.id, [{ type: 'analytics', granted: false }], {
      source: 'settings',
    });
    expect(await consentSvc.analyticsGranted(u!.id)).toBe(false);

    const rows = await dbAdmin
      .select()
      .from(consentRecords)
      .where(eq(consentRecords.user_id, u!.id));
    expect(rows).toHaveLength(2); // append-only — no update in place
    // ip stored only as a hash, never raw
    expect(rows.every((r) => r.ip_hash !== '1.2.3.4')).toBe(true);
  });

  it('banner sync writes only when state differs from the latest row', async () => {
    const [u] = await dbAdmin
      .insert(users)
      .values({ email: `sync-${rid()}@test.test`, full_name: 'Sync T' })
      .returning();
    cleanupUsers.push(u!.id);

    const first = await consentSvc.syncBannerChoice(u!.id, true, { regionCode: 'US' });
    expect(first.written).toBe(true);
    const repeat = await consentSvc.syncBannerChoice(u!.id, true, { regionCode: 'US' });
    expect(repeat.written).toBe(false); // dedupe — repeat logins add nothing
    const change = await consentSvc.syncBannerChoice(u!.id, false, { regionCode: 'US' });
    expect(change.written).toBe(true);
  });

  it('requiresReacceptance: true without a terms row, false after acceptance at the current version', async () => {
    const [u] = await dbAdmin
      .insert(users)
      .values({ email: `reacc-${rid()}@test.test`, full_name: 'Reacc T' })
      .returning();
    cleanupUsers.push(u!.id);

    expect(await consentSvc.requiresReacceptance(u!.id)).toBe(true);
    await consentSvc.record(u!.id, [{ type: 'terms_privacy', granted: true }], {
      source: 'settings',
    });
    expect(await consentSvc.requiresReacceptance(u!.id)).toBe(false);
    const latest = await consentSvc.latest(u!.id);
    expect(latest.terms_privacy?.policy_version).toBe(TERMS_VERSION);
  });

  it('unsubscribe token round-trips and writes a marketing withdrawal row', async () => {
    const [u] = await dbAdmin
      .insert(users)
      .values({ email: `unsub-${rid()}@test.test`, full_name: 'Unsub T' })
      .returning();
    cleanupUsers.push(u!.id);
    await consentSvc.record(u!.id, [{ type: 'marketing_email', granted: true }], {
      source: 'signup',
    });
    expect(await consentSvc.marketingAllowed(u!.id)).toBe(true);

    const token = consentSvc.mintUnsubscribeToken(u!.id);
    const res = await consentSvc.unsubscribe(token);
    expect(res.email).toContain('unsub-');
    expect(await consentSvc.marketingAllowed(u!.id)).toBe(false);

    // Tampered token rejected
    await expect(consentSvc.unsubscribe(token.slice(0, -4) + 'AAAA')).rejects.toThrow();
  });

  it('signup clickwrap: verify-otp REJECTS a new account without terms_privacy, creates + ledgers with it', async () => {
    const email = `signup-${rid()}@test.test`;

    // Without consents → rejected, no user created.
    let code = await seedOtp(email);
    await expect(authService.verifyOtp(email, code)).rejects.toThrow(/Terms/i);
    const none = await dbAdmin.select().from(users).where(eq(users.email, email));
    expect(none).toHaveLength(0);

    // With the clickwrap → account + ledger rows (terms + marketing).
    code = await seedOtp(email);
    await authService.verifyOtp(email, code, undefined, '9.9.9.9', 'jest', [
      { type: 'terms_privacy', granted: true },
      { type: 'marketing_email', granted: false },
    ], 'IN');
    const [created] = await dbAdmin.select().from(users).where(eq(users.email, email));
    expect(created).toBeDefined();
    cleanupUsers.push(created!.id);

    const latest = await consentSvc.latest(created!.id);
    expect(latest.terms_privacy?.granted).toBe(true);
    expect(latest.marketing_email?.granted).toBe(false);
    expect(await consentSvc.requiresReacceptance(created!.id)).toBe(false);

    // Existing user logging in again needs NO consents.
    code = await seedOtp(email);
    await expect(authService.verifyOtp(email, code)).resolves.toBeDefined();
  });
});
