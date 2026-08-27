/**
 * Round 11 (founder feedback) — the review-flow plumbing behind the
 * "notification goes nowhere" reports, plus the FAM verification/logo fixes:
 *  - the onboarding-submitted notification deep-links to the exact employee
 *    (and groups per employee) instead of a bare queue URL;
 *  - createTenant NEVER sets verified_at (verification comes only from the
 *    FAM action) and fans a tenant.signup notification out to platform
 *    admins with tenant_id NULL so the FAM shell can see it;
 *  - verifyTenant writes verified_at/by and audits reviewer notes;
 *  - listTenants exposes verifiedAt + a served logoUrl; the verification
 *    queue serves logos and drops verified tenants;
 *  - the onboarding queue → approve flow stays intact around the new review
 *    dialog; getMyCompanies serves signed logos for the switcher.
 */
import 'dotenv/config';
import * as crypto from 'crypto';
import { db, dbAdmin } from '@flicks/db';
import {
  employees,
  memberships,
  notifications as notificationsTable,
  tenants,
  users,
} from '@flicks/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DatabaseService } from '../core/database/database.service';
import { EmployeesService } from '../modules/employees/employees.service';
import { OnboardingService } from '../modules/onboarding/onboarding.service';
import { FamService } from '../modules/fam/fam.service';
import { NotificationsService } from '../modules/notifications/notifications.service';
import type { DbAdmin } from '@flicks/db';
import type { AuditService } from '../modules/audit/audit.service';
import type { AuthService } from '../modules/auth/auth.service';
import type { MediaService } from '../modules/media/media.service';
import type { AnalyticsService } from '../core/analytics/analytics.service';

const rid = () => crypto.randomBytes(4).toString('hex');
const audit = { log: async () => {} } as unknown as AuditService;
const logPlatformSpy = jest.fn(async () => {});
const auditWithPlatform = {
  log: async () => {},
  logPlatform: logPlatformSpy,
} as unknown as AuditService;
const analyticsStub = {
  capture: () => {},
  track: () => {},
} as unknown as AnalyticsService;
const mediaStub = {
  servedUrl: async (k: string | null, l: string | null) => (k ? `signed:${k}` : l),
} as unknown as MediaService;
process.env.EMPLOYEE_DATA_ENC_KEY = 'e'.repeat(64);
const config = new ConfigService({ NODE_ENV: 'test', APP_URL: 'http://localhost:3000' });

const dbSvc = new DatabaseService();
// REAL notifications service — the fan-out specs assert actual DB rows.
const notificationsSvc = new NotificationsService(
  db as never,
  dbAdmin as never,
  config,
  new EventEmitter2(),
);
const inAppSpy = jest.spyOn(notificationsSvc, 'createInAppNotification');
const emailSpy = jest
  .spyOn(notificationsSvc, 'sendEmail')
  .mockResolvedValue(undefined as never);

const employeesService = new EmployeesService(
  dbSvc,
  dbAdmin as never,
  audit,
  notificationsSvc,
  new EventEmitter2(),
  config,
  {} as unknown as AuthService,
  mediaStub,
);
const onboardingService = new OnboardingService(
  dbAdmin as never,
  audit,
  analyticsStub,
  notificationsSvc,
  config,
);
const famService = new FamService(
  dbAdmin as never,
  auditWithPlatform,
  {} as never,
  {} as never,
  analyticsStub as never,
  mediaStub,
);

let tenantId: string;
let ownerUserId: string;
let submitterUserId: string;
let employeeId: string;
let platformAdminId: string;
let ordinaryUserId: string;
let signupTenantId: string | null = null;

beforeAll(async () => {
  const [t] = await dbAdmin
    .insert(tenants)
    .values({
      name: `R11Co${rid()}`,
      slug: `r11-${rid()}-${Date.now()}`,
      status: 'active',
      currency: 'INR',
      logo_key: 'tenants/r11/logo_256.webp',
    })
    .returning();
  tenantId = t!.id;

  const [owner] = await dbAdmin
    .insert(users)
    .values({ email: `owner-${rid()}@r11.test`, full_name: 'R11 Owner', status: 'active' })
    .returning();
  ownerUserId = owner!.id;
  await dbAdmin.insert(memberships).values({
    tenant_id: tenantId,
    user_id: ownerUserId,
    role: 'owner',
    status: 'active',
    accepted_at: new Date(),
  });

  // The submitting employee (bridged user, so the submit path notifies the
  // owner, not the submitter).
  const [subm] = await dbAdmin
    .insert(users)
    .values({ email: `subm-${rid()}@r11.test`, full_name: 'Sub Mitter', status: 'active' })
    .returning();
  submitterUserId = subm!.id;
  const [emp] = await dbAdmin
    .insert(employees)
    .values({
      tenant_id: tenantId,
      employee_code: `R11${rid().slice(0, 4).toUpperCase()}`,
      first_name: 'Sub',
      last_name: 'Mitter',
      work_email: `subm-${rid()}@r11.test`,
      date_of_joining: '2026-08-01',
      user_id: submitterUserId,
      // Not-yet-approved hires are non-active; approveOnboarding flips this.
      status: 'inactive',
      custom_fields: { onboarding_step: 4 },
    })
    .returning();
  employeeId = emp!.id;
  await dbAdmin.insert(memberships).values({
    tenant_id: tenantId,
    user_id: submitterUserId,
    employee_id: employeeId,
    role: 'employee',
    status: 'invited',
  });

  // One platform admin + one ordinary user for the signup fan-out spec.
  const [pa] = await dbAdmin
    .insert(users)
    .values({
      email: `fam-${rid()}@r11.test`,
      full_name: 'Platform Admin',
      status: 'active',
      is_platform_admin: true,
    })
    .returning();
  platformAdminId = pa!.id;
  const [ord] = await dbAdmin
    .insert(users)
    .values({ email: `ord-${rid()}@r11.test`, full_name: 'Ordinary User', status: 'active' })
    .returning();
  ordinaryUserId = ord!.id;
});

afterAll(async () => {
  // Platform notifications (tenant_id NULL) do NOT cascade with tenant
  // deletion — clean them by recipient.
  await dbAdmin
    .delete(notificationsTable)
    .where(
      inArray(notificationsTable.user_id, [
        platformAdminId,
        ordinaryUserId,
        ownerUserId,
        submitterUserId,
      ]),
    );
  if (signupTenantId) {
    await dbAdmin.delete(tenants).where(eq(tenants.id, signupTenantId));
  }
  await dbAdmin.delete(tenants).where(eq(tenants.id, tenantId));
  await dbAdmin
    .delete(users)
    .where(
      inArray(users.id, [ownerUserId, submitterUserId, platformAdminId, ordinaryUserId]),
    );
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
});

describe('round 11 — onboarding review deep link', () => {
  it('submit-for-review notifies reviewers with the employee deep link + group key', async () => {
    inAppSpy.mockClear();
    await employeesService.submitOnboardingStep(
      employeeId,
      5,
      { step: 5, submitForReview: true } as never,
      tenantId,
      submitterUserId,
    );

    const reviewerCall = inAppSpy.mock.calls.find(
      (c) => c[1] === 'onboarding.submitted',
    );
    expect(reviewerCall).toBeDefined();
    expect(reviewerCall![0]).toBe(ownerUserId);
    expect(reviewerCall![3]).toBe(`/employees/onboarding?employee=${employeeId}`);
    expect(reviewerCall![5]).toEqual({ groupKey: `onboarding:${employeeId}` });
  });

  it('queue lists the submission and approve activates + empties it', async () => {
    const queue = await employeesService.getOnboardingQueue(tenantId, ownerUserId);
    expect(queue.data.some((r: { id: string }) => r.id === employeeId)).toBe(true);

    await employeesService.approveOnboarding(employeeId, ownerUserId, tenantId);

    const [row] = await dbAdmin
      .select({ status: employees.status })
      .from(employees)
      .where(eq(employees.id, employeeId));
    expect(row!.status).toBe('active');
    const after = await employeesService.getOnboardingQueue(tenantId, ownerUserId);
    expect(after.data.some((r: { id: string }) => r.id === employeeId)).toBe(false);
  });
});

describe('round 11 — tenant verification is FAM-only, with a signup ping', () => {
  it('createTenant leaves verified_at NULL and fans out to platform admins only', async () => {
    const created = await onboardingService.createTenant(
      {
        name: `R11 Signup ${rid()}`,
        slug: `r11sig-${rid()}`,
        fullName: 'Signup Founder',
        industry: 'SaaS / Software',
        sizeBand: '1-10',
        primaryLocation: { name: 'HQ', timezone: 'Asia/Kolkata' },
      } as never,
      ordinaryUserId,
    );
    signupTenantId = created.id;

    const [t] = await dbAdmin
      .select({ verifiedAt: tenants.verified_at })
      .from(tenants)
      .where(eq(tenants.id, created.id));
    // Codifies item F: nothing on the signup path grants VERIFIED.
    expect(t!.verifiedAt).toBeNull();

    const adminRows = await dbAdmin
      .select()
      .from(notificationsTable)
      .where(
        and(
          eq(notificationsTable.user_id, platformAdminId),
          eq(notificationsTable.type, 'tenant.signup'),
        ),
      );
    expect(adminRows).toHaveLength(1);
    expect(adminRows[0]!.tenant_id).toBeNull(); // visible in the FAM shell
    expect(adminRows[0]!.link_url).toBe(`/fam/verify?tenant=${created.id}`);

    const ownerRows = await dbAdmin
      .select()
      .from(notificationsTable)
      .where(
        and(
          eq(notificationsTable.user_id, ownerUserId),
          eq(notificationsTable.type, 'tenant.signup'),
        ),
      );
    expect(ownerRows).toHaveLength(0); // non-platform-admins get nothing
  });

  it('the queue serves the signup with a logo slot; verifyTenant clears it and audits notes', async () => {
    const before = await famService.getVerificationQueue();
    const queued = before.data.find((r) => r.id === signupTenantId);
    expect(queued).toBeDefined();
    expect(queued).toHaveProperty('logoUrl'); // null here — no logo uploaded

    logPlatformSpy.mockClear();
    const res = await famService.verifyTenant(
      signupTenantId!,
      platformAdminId,
      'GSTIN checked manually',
    );
    expect(res.verifiedAt).toBeTruthy();
    expect(logPlatformSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'tenant.verified',
        targetTenantId: signupTenantId,
        metadata: { notes: 'GSTIN checked manually' },
      }),
    );

    const after = await famService.getVerificationQueue();
    expect(after.data.some((r) => r.id === signupTenantId)).toBe(false);
  });

  it('listTenants exposes verifiedAt and a served logoUrl', async () => {
    const list = await famService.listTenants({ search: 'R11Co', limit: 50 } as never);
    const row = list.data.find((r) => r.id === tenantId);
    expect(row).toBeDefined();
    expect(row!.verifiedAt).toBeNull(); // never verified
    expect(row!.logoUrl).toBe('signed:tenants/r11/logo_256.webp');
  });
});
