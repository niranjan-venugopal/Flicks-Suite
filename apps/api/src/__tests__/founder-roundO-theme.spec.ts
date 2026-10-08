/**
 * Founder round O (2026-10-01) — per-user light theme: users.theme.
 *
 *  0065 — users.theme is ADDed DEFAULT 'dark' (every existing row backfilled
 *         dark) and the default is then flipped to 'light' (new sign-ups are
 *         light); a guarded CHECK pins the three values.
 *  API  — PATCH /auth/me/preferences persists system | light | dark through
 *         the global ValidationPipe contract (unknown values / keys → 400),
 *         is scoped to the caller, is refused under a FAM impersonation JWT,
 *         `{}` is a no-op; GET /auth/me, the verify-otp / select-tenant user
 *         payloads and the DPDP personal export all carry the preference.
 *
 * Service-level against the real Postgres (founder-roundK harness).
 */
import 'dotenv/config';
import * as crypto from 'crypto';
import { eq, sql } from 'drizzle-orm';
import { db, dbAdmin } from '@flicks/db';
import { tenants, users, memberships, authOtps, authEvents } from '@flicks/db/schema';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  BadRequestException,
  ForbiddenException,
  RequestMethod,
  ValidationPipe,
} from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { AuthService } from '../modules/auth/auth.service';
import { AuthController } from '../modules/auth/auth.controller';
import { THEME_OPTIONS, UpdateMePreferencesDto } from '../modules/auth/auth.dto';
import { ConsentService } from '../modules/consent/consent.service';
import type { NotificationsService } from '../modules/notifications/notifications.service';
import type { AuditService } from '../modules/audit/audit.service';
import type { JwtPayload } from '@flicks/shared/types';

jest.setTimeout(90_000);

const rid = () => crypto.randomBytes(4).toString('hex');
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const APP_URL = 'https://app.test';

const auditStub = { log: async () => {} } as unknown as AuditService;
const notifications = {
  createInAppNotification: async () => undefined,
  sendEmail: async () => true,
} as unknown as NotificationsService;

const authConfig = {
  get: (key: string, fallback?: unknown) => {
    const map: Record<string, unknown> = {
      NODE_ENV: 'test',
      APP_URL,
      JWT_SECRET: 'roundo-test-secret',
      JWT_ACCESS_EXPIRY: '15m',
      JWT_REFRESH_EXPIRY: '7d',
      JWT_ISSUER: 'flicks-suite',
      JWT_AUDIENCE: 'flicks-suite-api',
    };
    return map[key] ?? fallback;
  },
} as unknown as ConfigService;
const authService = new AuthService(
  dbAdmin as never,
  dbAdmin as never,
  new JwtService({ secret: 'roundo-test-secret' }),
  authConfig,
  { emit: () => true } as never,
  notifications,
  auditStub,
  { isEnforced: () => false } as never,
  new ConsentService(dbAdmin as never, authConfig),
);
// The controller only needs AuthService for the preferences route; the media /
// module-access / flag services are untouched by it.
const controller = new AuthController(authService, {} as never, {} as never, {} as never, {} as never);

// The global pipe exactly as main.ts configures it.
const pipe = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
  transformOptions: { enableImplicitConversion: true },
});
const bodyMeta = { type: 'body' as const, metatype: UpdateMePreferencesDto };

// ─── Fixtures ────────────────────────────────────────────────────────────────

let T1: string;
const userIds: string[] = [];
type Person = { userId: string; membershipId: string; email: string };
let A: Person; // the caller
let B: Person; // a bystander in the same tenant — must never be touched

async function mkUser(label: string, extra: Partial<typeof users.$inferInsert> = {}) {
  const email = `ro-${label.toLowerCase()}-${rid()}@t.test`;
  const [u] = await dbAdmin
    .insert(users)
    .values({ email, full_name: `${label} Tester`, status: 'active', ...extra })
    .returning();
  userIds.push(u!.id);
  return u!;
}

async function mkPerson(label: string, role: 'owner' | 'employee'): Promise<Person> {
  const u = await mkUser(label);
  const [m] = await dbAdmin
    .insert(memberships)
    .values({ tenant_id: T1, user_id: u.id, role, status: 'active', employee_id: null })
    .returning();
  return { userId: u.id, membershipId: m!.id, email: u.email };
}

const themeOf = async (userId: string) => {
  const [row] = await dbAdmin
    .select({ theme: users.theme, updated_at: users.updated_at })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row!;
};

const jwtFor = (p: Person, extra: Partial<JwtPayload> = {}): JwtPayload =>
  ({
    sub: p.userId,
    email: p.email,
    tenantId: T1,
    membershipId: p.membershipId,
    role: 'employee',
    isPlatformAdmin: false,
    deviceId: '',
    iat: 0,
    exp: 0,
    iss: 'flicks-suite',
    aud: 'flicks-suite-api',
    ...extra,
  }) as JwtPayload;

beforeAll(async () => {
  const [t] = await dbAdmin
    .insert(tenants)
    .values({ name: `RO theme ${rid()}`, slug: `ro-${rid()}-${Date.now()}`, status: 'active', currency: 'INR', timezone: 'Asia/Kolkata' })
    .returning();
  T1 = t!.id;
  A = await mkPerson('Alpha', 'owner');
  B = await mkPerson('Bravo', 'employee');
});

afterAll(async () => {
  await dbAdmin.delete(tenants).where(eq(tenants.id, T1));
  for (const u of userIds) {
    await dbAdmin.delete(authEvents).where(eq(authEvents.user_id, u));
    await dbAdmin.delete(users).where(eq(users.id, u));
  }
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
});

// ═════════════════════════════════════════════════════════════════════════════
// 0065 — column, default, constraint
// ═════════════════════════════════════════════════════════════════════════════

describe('0065 users.theme', () => {
  it('a fresh insert(users) without theme lands light (the post-backfill default)', async () => {
    const u = await mkUser('Fresh');
    expect(u.theme).toBe('light');
    expect((await themeOf(u.id)).theme).toBe('light');
  });

  it("information_schema shows the column default as 'light' (existing rows were backfilled dark by the ADD)", async () => {
    const res = await dbAdmin.execute(
      sql`select column_default, is_nullable from information_schema.columns where table_name = 'users' and column_name = 'theme'`,
    );
    const rows = (Array.isArray(res) ? res : (res as { rows: unknown[] }).rows) as Array<{
      column_default: string;
      is_nullable: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.column_default).toContain('light');
    expect(rows[0]!.is_nullable).toBe('NO');
  });

  it("users_theme_check exists and rejects 'blue'", async () => {
    const res = await dbAdmin.execute(
      sql`select conname from pg_constraint where conname = 'users_theme_check'`,
    );
    const rows = (Array.isArray(res) ? res : (res as { rows: unknown[] }).rows) as unknown[];
    expect(rows).toHaveLength(1);

    const email = `ro-blue-${rid()}@t.test`;
    await expect(
      dbAdmin.insert(users).values({ email, full_name: 'Blue', status: 'active', theme: 'blue' }),
    ).rejects.toThrow(/users_theme_check/);
    const [leak] = await dbAdmin.select({ id: users.id }).from(users).where(eq(users.email, email));
    expect(leak).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// PATCH /auth/me/preferences
// ═════════════════════════════════════════════════════════════════════════════

describe('PATCH /auth/me/preferences', () => {
  it('persists each of system / light / dark and returns the stored value', async () => {
    for (const theme of THEME_OPTIONS) {
      const out = await authService.updatePreferences(A.userId, { theme });
      expect(out).toEqual({ theme });
      expect((await themeOf(A.userId)).theme).toBe(theme);
    }
  });

  it('{} is a no-op (value and updated_at untouched)', async () => {
    await authService.updatePreferences(A.userId, { theme: 'light' });
    const before = await themeOf(A.userId);
    await new Promise((r) => setTimeout(r, 20));
    const out = await authService.updatePreferences(A.userId, {});
    expect(out).toEqual({ theme: 'light' });
    const after = await themeOf(A.userId);
    expect(after.theme).toBe('light');
    expect(after.updated_at.getTime()).toBe(before.updated_at.getTime());
  });

  it("the DTO through the global ValidationPipe accepts the three values + {} and refuses 'blue', '' and extra keys", async () => {
    for (const theme of THEME_OPTIONS) {
      const ok = (await pipe.transform({ theme }, bodyMeta)) as UpdateMePreferencesDto;
      expect(ok.theme).toBe(theme);
    }
    const empty = (await pipe.transform({}, bodyMeta)) as UpdateMePreferencesDto;
    expect(empty.theme).toBeUndefined();

    const bad: Array<Record<string, unknown>> = [
      { theme: 'blue' },
      { theme: '' },
      { theme: 'DARK' },
      { theme: 1 },
      { theme: ['dark'] },
      { theme: 'dark', locale: 'en-IN' },
      { colour: 'dark' },
    ];
    for (const body of bad) {
      await expect(pipe.transform(body, bodyMeta)).rejects.toThrow(BadRequestException);
    }
  });

  it("is scoped to the caller — A's change leaves B untouched", async () => {
    await authService.updatePreferences(B.userId, { theme: 'light' });
    await controller.updateMyPreferences(jwtFor(A), { theme: 'dark' });
    expect((await themeOf(A.userId)).theme).toBe('dark');
    expect((await themeOf(B.userId)).theme).toBe('light');
  });

  it('is refused under a FAM impersonation JWT and leaves the row unchanged', async () => {
    await authService.updatePreferences(A.userId, { theme: 'light' });
    const before = await themeOf(A.userId);
    await expect(
      controller.updateMyPreferences(jwtFor(A, { impersonatorUserId: B.userId }), { theme: 'dark' }),
    ).rejects.toThrow(ForbiddenException);
    const after = await themeOf(A.userId);
    expect(after.theme).toBe('light');
    expect(after.updated_at.getTime()).toBe(before.updated_at.getTime());
    // …while the same call without the impersonation marker goes through.
    await expect(controller.updateMyPreferences(jwtFor(A), { theme: 'dark' })).resolves.toEqual({ theme: 'dark' });
    expect((await themeOf(A.userId)).theme).toBe('dark');
  });

  it('route metadata: PATCH me/preferences', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AuthController.prototype.updateMyPreferences)).toBe('me/preferences');
    expect(Reflect.getMetadata(METHOD_METADATA, AuthController.prototype.updateMyPreferences)).toBe(RequestMethod.PATCH);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Reads that carry the preference
// ═════════════════════════════════════════════════════════════════════════════

describe('theme on the read paths', () => {
  it('GET /auth/me returns theme', async () => {
    await authService.updatePreferences(A.userId, { theme: 'system' });
    const me = await authService.getMe(A.userId, T1);
    expect(me.theme).toBe('system');
    expect(me.id).toBe(A.userId);
  });

  it('the verify-otp user payload carries theme', async () => {
    await authService.updatePreferences(A.userId, { theme: 'dark' });
    await dbAdmin.insert(authOtps).values({
      email: A.email,
      otp_hash: sha256('424242'),
      expires_at: new Date(Date.now() + 10 * 60 * 1000),
    });
    const res = (await authService.verifyOtp(A.email, '424242')) as { user: { id: string; theme?: string } };
    expect(res.user.id).toBe(A.userId);
    expect(res.user.theme).toBe('dark');
  });

  it('the select-tenant payload carries the user + theme', async () => {
    await authService.updatePreferences(A.userId, { theme: 'light' });
    const res = await authService.selectTenant(A.userId, T1);
    expect(res.accessToken).toBeTruthy();
    expect(res.user).toMatchObject({ id: A.userId, email: A.email, theme: 'light' });
  });

  it('the DPDP personal export bundle has profile.theme', async () => {
    await authService.updatePreferences(A.userId, { theme: 'dark' });
    let captured: Buffer | null = null;
    const r2Mock = {
      isConfigured: () => true,
      putObject: async (_k: string, buf: Buffer) => {
        captured = buf;
      },
      signedGetUrl: async () => 'https://signed.example/x.zip',
    } as never;
    const { DataExportService } = await import('../modules/consent/data-export.service');
    const exporter = new DataExportService(
      dbAdmin as never,
      { withTenant: async () => [] } as never,
      r2Mock,
      { sendEmail: async () => true } as never,
      { log: async () => {} } as never,
      { track: () => {} } as never,
    );
    await (exporter as unknown as {
      buildMyExport: (u: string, t: string) => Promise<void>;
    }).buildMyExport(A.userId, T1);

    expect(captured).not.toBeNull();
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(captured!);
    const bundle = JSON.parse(await zip.file('my-data.json')!.async('string'));
    expect(bundle.profile.id).toBe(A.userId);
    expect(bundle.profile.theme).toBe('dark');
  });
});
