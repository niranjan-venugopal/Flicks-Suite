/**
 * Founder round 5 — onboarding-approval integrity + inbox wiring:
 *
 *  - Final submit fans out an in-app 'onboarding.submitted' notification to
 *    every active owner/admin EXCEPT the submitter, and broadcasts
 *    'employees.directory.changed' for the live tenant-wide refresh.
 *    (Round 17: owner/admin submitters self-complete WITHOUT any fan-out —
 *    covered in founder-round17.spec.ts — so the reviewed submitter here is
 *    a manager, the most senior role that still goes through HR review.)
 *  - Self-approval is blocked: approve/reject of your own onboarding throws
 *    ForbiddenException; the onboarding queue and the dashboard approvals
 *    bucket both hide the caller's own row (invited rows with user_id NULL
 *    stay visible to everyone).
 *  - Approve activates the profile, pings the employee in-app
 *    ('onboarding.approved') and emits the directory-changed broadcast; so
 *    does reject/send-back.
 *  - getAdminOverview gains the pending.onboarding bucket (admin+-gated via
 *    includeOnboarding) counted into stats.pendingApprovals.
 *  - Notification preference mapping: 'onboarding.submitted' now gates on the
 *    dedicated onboarding_submitted preference, review outcomes stay on
 *    onboarding_reviewed.
 *
 * Service-level against the real Postgres, mirroring founder-round3.spec.ts.
 */
import 'dotenv/config';
import * as crypto from 'crypto';
import { eq } from 'drizzle-orm';
import { db, dbAdmin } from '@flicks/db';
import { tenants, users, memberships, employees, designations } from '@flicks/db/schema';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DatabaseService } from '../core/database/database.service';
import { EmployeesService } from '../modules/employees/employees.service';
import { DashboardService } from '../modules/dashboard/dashboard.service';
import { emailEventForInAppType } from '../modules/notifications/notifications.service';
import type { AuditService } from '../modules/audit/audit.service';
import type { NotificationsService } from '../modules/notifications/notifications.service';
import type { AuthService } from '../modules/auth/auth.service';
import type { MediaService } from '../modules/media/media.service';

const rid = () => crypto.randomBytes(4).toString('hex');
const audit = { log: async () => {} } as unknown as AuditService;

const createInAppNotification = jest.fn(async () => undefined);
const sendEmail = jest.fn(async () => true);
const notifications = {
  createInAppNotification,
  sendEmail,
} as unknown as NotificationsService;

const emitter = new EventEmitter2();
const emitSpy = jest.spyOn(emitter, 'emit');

const dbSvc = new DatabaseService();
const employeesService = new EmployeesService(
  dbSvc,
  dbAdmin as never,
  audit,
  notifications,
  emitter,
  new ConfigService({ NODE_ENV: 'test' }),
  {} as unknown as AuthService,
  // MediaService stub: echo the key so specs can assert the avatar pipeline.
  { servedUrl: async (k: string | null, l: string | null) => (k ? `signed:${k}` : l) } as unknown as MediaService,
);
const dashboardService = new DashboardService(
  dbSvc,
  { servedUrl: async (k: string | null, l: string | null) => (k ? `signed:${k}` : l) } as unknown as MediaService,
);

let tenantId: string;
let ownerAUserId: string; // existing owner — the reviewer
let adminBUserId: string; // HR admin — also a reviewer
let managerCUserId: string; // manager — the submitter under review
let empCId: string; // managerC's employee row (pending review)
let invitedEmpId: string; // invited employee, user_id NULL, pending review
const trackedUserIds: string[] = [];

async function seedUser(email: string) {
  const [u] = await dbAdmin
    .insert(users)
    .values({ email, full_name: 'Round Five', status: 'active' })
    .returning();
  trackedUserIds.push(u!.id);
  return u!.id;
}

beforeAll(async () => {
  const [t] = await dbAdmin
    .insert(tenants)
    .values({
      name: `R5Co${rid()}`,
      slug: `r5-${rid()}-${Date.now()}`,
      status: 'active',
      currency: 'INR',
    })
    .returning();
  tenantId = t!.id;

  ownerAUserId = await seedUser(`owner-a-${rid()}@r5.test`);
  adminBUserId = await seedUser(`admin-b-${rid()}@r5.test`);
  managerCUserId = await seedUser(`manager-c-${rid()}@r5.test`);

  // Round 17: owner/admin submitters complete without review, so the
  // submitter under review here is a manager — the most senior role that
  // still needs someone else to approve them.
  const roles: Array<[string, 'owner' | 'admin' | 'manager']> = [
    [ownerAUserId, 'owner'],
    [adminBUserId, 'admin'],
    [managerCUserId, 'manager'],
  ];
  for (const [userId, role] of roles) {
    await dbAdmin.insert(memberships).values({
      tenant_id: tenantId,
      user_id: userId,
      role,
      status: 'active',
      accepted_at: new Date(),
    });
  }

  const [des] = await dbAdmin
    .insert(designations)
    .values({ tenant_id: tenantId, title: 'Engineering Manager', level: 6 })
    .returning();

  const [empC] = await dbAdmin
    .insert(employees)
    .values({
      tenant_id: tenantId,
      employee_code: `R5C${rid().slice(0, 4).toUpperCase()}`,
      first_name: 'Team',
      last_name: 'Manager',
      work_email: `team-manager-${rid()}@r5.test`,
      date_of_joining: '2026-08-01',
      user_id: managerCUserId,
      status: 'inactive',
      designation_id: des!.id,
      custom_fields: { onboarding_step: 5 },
    })
    .returning();
  empCId = empC!.id;

  const [invited] = await dbAdmin
    .insert(employees)
    .values({
      tenant_id: tenantId,
      employee_code: `R5I${rid().slice(0, 4).toUpperCase()}`,
      first_name: 'Invited',
      last_name: 'Joiner',
      work_email: `invited-${rid()}@r5.test`,
      date_of_joining: '2026-08-10',
      status: 'inactive',
      custom_fields: {
        onboarding_submitted_for_review: true,
        onboarding_submitted_at: new Date().toISOString(),
      },
    })
    .returning();
  invitedEmpId = invited!.id;
});

afterAll(async () => {
  await dbAdmin.delete(tenants).where(eq(tenants.id, tenantId));
  for (const id of trackedUserIds)
    await dbAdmin.delete(users).where(eq(users.id, id));
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
});

describe('submit for review: reviewer fan-out excludes the submitter', () => {
  it('notifies owner A and admin B in-app, never owner C himself', async () => {
    createInAppNotification.mockClear();
    emitSpy.mockClear();

    await employeesService.submitOnboardingStep(
      empCId,
      5,
      { step: 5, submitForReview: true } as never,
      tenantId,
      managerCUserId,
    );

    const recipients = createInAppNotification.mock.calls.map(
      (c) => (c as unknown[])[0],
    );
    expect(recipients).toContain(ownerAUserId);
    expect(recipients).toContain(adminBUserId);
    expect(recipients).not.toContain(managerCUserId);

    for (const call of createInAppNotification.mock.calls) {
      const [, type, , linkUrl, notifTenant] = call as unknown[];
      expect(type).toBe('onboarding.submitted');
      // Round 11: deep link straight into the review dialog for this hire.
      expect(linkUrl).toBe(`/employees/onboarding?employee=${empCId}`);
      expect(notifTenant).toBe(tenantId);
    }

    expect(emitSpy).toHaveBeenCalledWith('employees.directory.changed', {
      tenantId,
    });

    const [row] = await dbAdmin
      .select()
      .from(employees)
      .where(eq(employees.id, empCId));
    expect(
      (row!.custom_fields as Record<string, unknown>)
        .onboarding_submitted_for_review,
    ).toBe(true);
  });
});

describe('self-approval is blocked at every layer', () => {
  it('approve/reject own onboarding → ForbiddenException, state unchanged', async () => {
    await expect(
      employeesService.approveOnboarding(empCId, managerCUserId, tenantId),
    ).rejects.toThrow(/own onboarding/);
    await expect(
      employeesService.rejectOnboarding(empCId, 'nope', managerCUserId, tenantId),
    ).rejects.toThrow(/own onboarding/);

    const [row] = await dbAdmin
      .select({ status: employees.status })
      .from(employees)
      .where(eq(employees.id, empCId));
    expect(row!.status).toBe('inactive');
  });

  it('queue hides the caller\'s own row but keeps it for other admins', async () => {
    const forC = await employeesService.getOnboardingQueue(tenantId, managerCUserId);
    expect(forC.data.some((r) => r.id === empCId)).toBe(false);
    // Invited rows (user_id NULL) survive the IS DISTINCT FROM filter.
    expect(forC.data.some((r) => r.id === invitedEmpId)).toBe(true);

    const forA = await employeesService.getOnboardingQueue(tenantId, ownerAUserId);
    expect(forA.data.some((r) => r.id === empCId)).toBe(true);
    expect(forA.data.some((r) => r.id === invitedEmpId)).toBe(true);
  });
});

describe('dashboard approvals bucket (Inbox)', () => {
  it('includes pending onboarding for an admin, excluding their own row', async () => {
    const forA = await dashboardService.getAdminOverview(tenantId, {
      callerUserId: ownerAUserId,
      includeOnboarding: true,
      includeApprovals: true,
    });
    const ids = forA.pending.onboarding.map((o) => o.employeeId);
    expect(ids).toContain(empCId);
    expect(ids).toContain(invitedEmpId);
    expect(forA.pending.onboardingCount).toBe(2);
    expect(forA.stats.pendingApprovals).toBeGreaterThanOrEqual(2);

    const empCRow = forA.pending.onboarding.find((o) => o.employeeId === empCId)!;
    expect(empCRow.employeeName).toBe('Team Manager');
    expect(empCRow.designationTitle).toBe('Engineering Manager');
    expect(empCRow.userId).toBe(managerCUserId);
    expect(empCRow.submittedAt).toBeTruthy();

    const forC = await dashboardService.getAdminOverview(tenantId, {
      callerUserId: managerCUserId,
      includeOnboarding: true,
      includeApprovals: true,
    });
    const idsC = forC.pending.onboarding.map((o) => o.employeeId);
    expect(idsC).not.toContain(empCId);
    expect(idsC).toContain(invitedEmpId);
  });

  it('is empty for non-admin callers (includeOnboarding=false)', async () => {
    const overview = await dashboardService.getAdminOverview(tenantId, {
      callerUserId: ownerAUserId,
      includeOnboarding: false,
      includeApprovals: true,
    });
    expect(overview.pending.onboarding).toEqual([]);
    expect(overview.pending.onboardingCount).toBe(0);
  });
});

describe('approve/reject side-effects', () => {
  it('approve by another admin activates + pings the employee + broadcasts', async () => {
    createInAppNotification.mockClear();
    emitSpy.mockClear();

    const res = await employeesService.approveOnboarding(
      empCId,
      ownerAUserId,
      tenantId,
    );
    expect(res.status).toBe('active');

    const [row] = await dbAdmin
      .select({ status: employees.status })
      .from(employees)
      .where(eq(employees.id, empCId));
    expect(row!.status).toBe('active');

    const approvedPing = createInAppNotification.mock.calls.find(
      (c) => (c as unknown[])[1] === 'onboarding.approved',
    ) as unknown[] | undefined;
    expect(approvedPing).toBeTruthy();
    expect(approvedPing![0]).toBe(managerCUserId);

    expect(emitSpy).toHaveBeenCalledWith('employees.directory.changed', {
      tenantId,
    });
  });

  it('reject/send-back clears the flag and broadcasts too', async () => {
    emitSpy.mockClear();
    await employeesService.rejectOnboarding(
      invitedEmpId,
      'Please re-check bank details',
      ownerAUserId,
      tenantId,
    );

    const [row] = await dbAdmin
      .select()
      .from(employees)
      .where(eq(employees.id, invitedEmpId));
    expect(
      (row!.custom_fields as Record<string, unknown>)
        .onboarding_submitted_for_review,
    ).toBe(false);
    expect(emitSpy).toHaveBeenCalledWith('employees.directory.changed', {
      tenantId,
    });
  });
});

describe('notification preference mapping', () => {
  it("routes 'onboarding.submitted' to its dedicated preference", () => {
    expect(emailEventForInAppType('onboarding.submitted')).toBe(
      'onboarding_submitted',
    );
    expect(emailEventForInAppType('onboarding.approved')).toBe(
      'onboarding_reviewed',
    );
    expect(emailEventForInAppType('onboarding.rejected')).toBe(
      'onboarding_reviewed',
    );
  });
});
