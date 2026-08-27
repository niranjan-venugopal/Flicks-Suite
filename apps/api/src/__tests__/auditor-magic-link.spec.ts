/**
 * Auditor invite → magic link → verify, exercising the REAL
 * AuthService.issueInviteMagicLink + verifyMagicLink (the Sprint-8 members
 * spec stubbed issueInviteMagicLink, so this closes that gap and guards the
 * one-click auditor onboarding path end-to-end).
 */
import 'dotenv/config';
import { db, dbAdmin } from '@flicks/db';
import { tenants, users, memberships } from '@flicks/db/schema';
import { eq } from 'drizzle-orm';
import { JwtService } from '@nestjs/jwt';
import { DatabaseService } from '../core/database/database.service';
import { AuthService } from '../modules/auth/auth.service';
import { ConsentService } from '../modules/consent/consent.service';
import { MembersService } from '../modules/members/members.service';
import type { AuditService } from '../modules/audit/audit.service';
import type { NotificationsService } from '../modules/notifications/notifications.service';
import { ModuleAccessService } from '../core/auth/module-access.service';

const rid = () => Math.random().toString(36).slice(2, 8);
const audit = { log: async () => {} } as unknown as AuditService;

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
const moduleAccess = new ModuleAccessService(dbSvc);
const members = new MembersService(dbSvc, dbAdmin as never, audit, notifications, authService, moduleAccess, { servedUrl: async (k: string | null, l: string | null) => (k ? `signed:${k}` : l) } as never);

describe('Auditor invite magic link (real verify path)', () => {
  let tenantId: string;
  let ownerId: string;
  let auditorUserId: string;

  beforeAll(async () => {
    const [t] = await dbAdmin
      .insert(tenants)
      .values({ name: `MagCo${rid()}`, slug: `mag-${rid()}-${Date.now()}`, status: 'active' })
      .returning();
    tenantId = t!.id;
    const [o] = await dbAdmin
      .insert(users)
      .values({ email: `owner-${rid()}@test.test`, full_name: 'Owner', status: 'active' })
      .returning();
    ownerId = o!.id;
  });

  afterAll(async () => {
    await dbAdmin.delete(tenants).where(eq(tenants.id, tenantId));
    await dbAdmin.delete(users).where(eq(users.id, ownerId));
    if (auditorUserId) await dbAdmin.delete(users).where(eq(users.id, auditorUserId));
    await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
    await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  });

  it('emails a magic link that verifyMagicLink accepts and activates the membership', async () => {
    captured.length = 0;
    const email = `audit-${rid()}@firm.test`;
    const res = await members.inviteAuditor({ email }, ownerId, tenantId);
    auditorUserId = res.data.membership.user_id;
    expect(res.data.membership.status).toBe('invited');

    expect(captured).toHaveLength(1);
    expect(captured[0]!.template).toBe('auditor-invite');
    const url = String(captured[0]!.props.magicLinkUrl);
    const token = new URL(url).searchParams.get('token')!;
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    const verified = (await authService.verifyMagicLink(token)) as {
      accessToken?: string;
      requiresTenantSelection?: boolean;
    };
    expect(verified.accessToken).toBeTruthy();

    // Accept-on-verify: the invited auditor membership is now active.
    const [m] = await dbAdmin
      .select()
      .from(memberships)
      .where(eq(memberships.id, res.data.membership.id));
    expect(m!.status).toBe('active');
    expect(m!.accepted_at).not.toBeNull();
  });

  it('rejects an unknown token with a 401', async () => {
    await expect(authService.verifyMagicLink('f'.repeat(64))).rejects.toThrow(
      /Invalid or expired/,
    );
  });
});
