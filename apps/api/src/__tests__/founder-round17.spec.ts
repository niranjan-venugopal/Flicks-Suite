/**
 * Founder round 17 — employment terms become editable + owner/admin
 * self-onboarding without HR review:
 *
 *  - Probation end, confirmation date and notice period are writable through
 *    PUT /employees/:id (columns shipped in 0001 but no write path ever
 *    existed) and pre-fillable at invite time; the audit snapshot now carries
 *    every org/employment field it silently dropped before.
 *  - An OWNER finishing their own onboarding wizard completes WITHOUT
 *    submitting for review: no reviewer fan-out, no manager email, and they
 *    self-activate (employee + membership) because nobody senior exists to
 *    approve them. The decision is derived from the caller's membership role
 *    inside the transaction — a client flag can never trigger it.
 *  - Everyone else keeps the review path, HR admins included (round 17.1) —
 *    and an admin's own file is routed to the OWNERS, never to a peer admin.
 *  - Send-back deep links point at the wizard's real route.
 *
 * Service-level against the real Postgres, mirroring founder-round5.spec.ts.
 */
import 'dotenv/config';
import * as crypto from 'crypto';
import { eq, and, inArray } from 'drizzle-orm';
import { db, dbAdmin } from '@flicks/db';
import { tenants, users, memberships, employees } from '@flicks/db/schema';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DatabaseService } from '../core/database/database.service';
import { EmployeesService } from '../modules/employees/employees.service';
import type { AuditService } from '../modules/audit/audit.service';
import type { NotificationsService } from '../modules/notifications/notifications.service';
import type { AuthService } from '../modules/auth/auth.service';
import type { MediaService } from '../modules/media/media.service';

const rid = () => crypto.randomBytes(4).toString('hex');
const APP_URL = 'https://app.round17.test';

const auditLog = jest.fn(async () => undefined);
const audit = { log: auditLog } as unknown as AuditService;

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
  new ConfigService({ NODE_ENV: 'test', APP_URL }),
  {
    issueInviteMagicLink: async () => `${APP_URL}/verify?token=stub`,
  } as unknown as AuthService,
  {
    servedUrl: async (k: string | null, l: string | null) => (k ? `signed:${k}` : l),
  } as unknown as MediaService,
);

let tenantId: string;
let ownerAUserId: string; // reviewer — never the submitter
let ownerSelfUserId: string; // owner finishing their own wizard
let founderUserId: string; // founder-shaped row: already active, no custom_fields
let promotedAdminUserId: string; // invited, later promoted to admin
let otherAdminUserId: string; // a second HR admin — must never review a peer
let plainEmpUserId: string; // ordinary employee — keeps the review path
let sentBackUserId: string; // employee whose onboarding gets sent back

let empUpdateId: string;
let empOwnerSelfId: string;
let empFounderId: string;
let empPromotedId: string;
let empPlainId: string;
let empSentBackId: string;
let empAdminEditId: string;

const trackedUserIds: string[] = [];
const invitedEmails: string[] = [];

async function seedUser(email: string) {
  const [u] = await dbAdmin
    .insert(users)
    .values({ email, full_name: 'Round Seventeen', status: 'active' })
    .returning();
  trackedUserIds.push(u!.id);
  return u!.id;
}

async function seedEmployee(values: Record<string, unknown>) {
  const [e] = await dbAdmin
    .insert(employees)
    .values({
      tenant_id: tenantId,
      employee_code: `R17${rid().slice(0, 5).toUpperCase()}`,
      first_name: 'Round',
      last_name: 'Seventeen',
      work_email: `emp-${rid()}@r17.test`,
      date_of_joining: '2026-08-01',
      status: 'inactive',
      ...values,
    } as never)
    .returning();
  return e!.id;
}

async function employeeRow(id: string) {
  const [row] = await dbAdmin
    .select()
    .from(employees)
    .where(eq(employees.id, id));
  return row!;
}

async function membershipRow(userId: string) {
  const [row] = await dbAdmin
    .select()
    .from(memberships)
    .where(
      and(
        eq(memberships.tenant_id, tenantId),
        eq(memberships.user_id, userId),
      ),
    );
  return row!;
}

const inAppTypes = () =>
  createInAppNotification.mock.calls.map((c) => (c as unknown[])[1]);

beforeAll(async () => {
  const [t] = await dbAdmin
    .insert(tenants)
    .values({
      name: `R17Co${rid()}`,
      slug: `r17-${rid()}-${Date.now()}`,
      status: 'active',
      currency: 'INR',
    })
    .returning();
  tenantId = t!.id;

  ownerAUserId = await seedUser(`owner-a-${rid()}@r17.test`);
  ownerSelfUserId = await seedUser(`owner-self-${rid()}@r17.test`);
  founderUserId = await seedUser(`founder-${rid()}@r17.test`);
  promotedAdminUserId = await seedUser(`promoted-${rid()}@r17.test`);
  otherAdminUserId = await seedUser(`other-admin-${rid()}@r17.test`);
  plainEmpUserId = await seedUser(`employee-${rid()}@r17.test`);
  sentBackUserId = await seedUser(`sent-back-${rid()}@r17.test`);

  const seats: Array<
    [string, 'owner' | 'admin' | 'employee', 'active' | 'invited']
  > = [
    [ownerAUserId, 'owner', 'active'],
    [ownerSelfUserId, 'owner', 'active'],
    [founderUserId, 'owner', 'active'],
    // The invited-then-promoted case: role elevated before they ever
    // finished the wizard, membership still 'invited'.
    [promotedAdminUserId, 'admin', 'invited'],
    [otherAdminUserId, 'admin', 'active'],
    [plainEmpUserId, 'employee', 'active'],
    [sentBackUserId, 'employee', 'active'],
  ];

  empUpdateId = await seedEmployee({ notice_period_days: 30 });
  empOwnerSelfId = await seedEmployee({
    user_id: ownerSelfUserId,
    custom_fields: { onboarding_step: 3 },
  });
  // Exactly what onboarding.createTenant seeds today: active, no onboarding
  // state at all — the shape that bounced the founder into the wizard.
  empFounderId = await seedEmployee({
    user_id: founderUserId,
    status: 'active',
  });
  empPromotedId = await seedEmployee({
    user_id: promotedAdminUserId,
    custom_fields: { onboarding_step: 3 },
  });
  empPlainId = await seedEmployee({
    user_id: plainEmpUserId,
    custom_fields: { onboarding_step: 4 },
  });
  empSentBackId = await seedEmployee({
    user_id: sentBackUserId,
    custom_fields: {
      onboarding_step: 5,
      onboarding_submitted_for_review: true,
      onboarding_submitted_at: new Date().toISOString(),
    },
  });
  empAdminEditId = await seedEmployee({
    custom_fields: { onboarding_step: 2 },
  });

  for (const [userId, role, status] of seats) {
    const employeeId =
      userId === ownerSelfUserId
        ? empOwnerSelfId
        : userId === founderUserId
          ? empFounderId
          : userId === promotedAdminUserId
            ? empPromotedId
            : userId === plainEmpUserId
              ? empPlainId
              : userId === sentBackUserId
                ? empSentBackId
                : null;
    await dbAdmin.insert(memberships).values({
      tenant_id: tenantId,
      user_id: userId,
      role,
      status,
      ...(employeeId ? { employee_id: employeeId } : {}),
      ...(status === 'active' ? { accepted_at: new Date() } : {}),
    } as never);
  }
});

afterAll(async () => {
  await dbAdmin.delete(tenants).where(eq(tenants.id, tenantId));
  if (invitedEmails.length)
    await dbAdmin.delete(users).where(inArray(users.email, invitedEmails));
  for (const id of trackedUserIds)
    await dbAdmin.delete(users).where(eq(users.id, id));
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
});

describe('employment terms are writable (probation · confirmation · notice)', () => {
  it('updateEmployee persists all three, including a zero notice period', async () => {
    auditLog.mockClear();

    await employeesService.updateEmployee(
      empUpdateId,
      {
        probationEndDate: '2026-11-30',
        dateOfConfirmation: '2026-12-01',
        // 0 must survive — a truthiness check would silently drop it.
        noticePeriodDays: 0,
      } as never,
      ownerAUserId,
      tenantId,
    );

    const row = await employeeRow(empUpdateId);
    expect(row.probation_end_date).toBe('2026-11-30');
    expect(row.date_of_confirmation).toBe('2026-12-01');
    expect(row.notice_period_days).toBe(0);
  });

  it('audits the employment fields it used to drop', async () => {
    auditLog.mockClear();

    await employeesService.updateEmployee(
      empUpdateId,
      { noticePeriodDays: 45, dateOfJoining: '2026-08-02' } as never,
      ownerAUserId,
      tenantId,
    );

    const entry = (auditLog.mock.calls.at(-1) as unknown[])[0] as {
      action: string;
      beforeState: Record<string, unknown>;
      afterState: Record<string, unknown>;
    };
    expect(entry.action).toBe('employee.updated');
    // Round 17 widened the snapshot: the three new terms plus the six
    // org/employment fields that were editable but never audited.
    for (const key of [
      'probationEndDate',
      'dateOfConfirmation',
      'noticePeriodDays',
      'employeeCode',
      'departmentId',
      'locationId',
      'reportingManagerId',
      'employmentType',
      'dateOfJoining',
    ]) {
      expect(entry.beforeState).toHaveProperty(key);
      expect(entry.afterState).toHaveProperty(key);
    }
    expect(entry.beforeState.noticePeriodDays).toBe(0);
    expect(entry.afterState.noticePeriodDays).toBe(45);
  });

  it('inviteEmployee pre-fills probation + notice, and defaults notice to 30', async () => {
    const withTerms = `invited-terms-${rid()}@r17.test`;
    const withoutTerms = `invited-plain-${rid()}@r17.test`;
    invitedEmails.push(withTerms, withoutTerms);

    const a = await employeesService.inviteEmployee(
      {
        fullName: 'Terms Hire',
        email: withTerms,
        employeeCode: `R17T${rid().slice(0, 4).toUpperCase()}`,
        joiningDate: '2026-09-01',
        probationEndDate: '2026-12-01',
        noticePeriodDays: 45,
      } as never,
      ownerAUserId,
      tenantId,
    );
    const rowA = await employeeRow(a.id);
    expect(rowA.probation_end_date).toBe('2026-12-01');
    expect(rowA.notice_period_days).toBe(45);

    const b = await employeesService.inviteEmployee(
      {
        fullName: 'Plain Hire',
        email: withoutTerms,
        employeeCode: `R17P${rid().slice(0, 4).toUpperCase()}`,
        joiningDate: '2026-09-01',
      } as never,
      ownerAUserId,
      tenantId,
    );
    const rowB = await employeeRow(b.id);
    expect(rowB.probation_end_date).toBeNull();
    // Column default — unchanged behaviour for invites that say nothing.
    expect(rowB.notice_period_days).toBe(30);
  });
});

describe('owner/admin finish onboarding without HR review', () => {
  it('an owner self-completes: activated, nobody notified, not queued', async () => {
    createInAppNotification.mockClear();
    sendEmail.mockClear();
    emitSpy.mockClear();

    const result = await employeesService.submitOnboardingStep(
      empOwnerSelfId,
      5,
      { step: 5, submitForReview: true } as never,
      tenantId,
      ownerSelfUserId,
    );
    expect(result.selfServeCompletion).toBe(true);
    expect(result.allStepsComplete).toBe(true);

    // Nobody reviews an owner — no fan-out, no manager email.
    expect(inAppTypes()).not.toContain('onboarding.submitted');
    const emailEvents = sendEmail.mock.calls.map((c) => (c as unknown[])[0]);
    expect(emailEvents).not.toContain('onboarding-submitted');

    const row = await employeeRow(empOwnerSelfId);
    expect(row.status).toBe('active');
    const custom = row.custom_fields as Record<string, unknown>;
    expect(custom.onboarding_step).toBe(5);
    expect(custom.onboarding_submitted_for_review).toBe(true);
    expect(custom.onboarding_completed_at).toBeTruthy();

    // The directory still refreshes — activation changes the roster.
    expect(emitSpy).toHaveBeenCalledWith('employees.directory.changed', {
      tenantId,
    });

    const queue = await employeesService.getOnboardingQueue(
      tenantId,
      ownerAUserId,
    );
    expect(queue.data.some((r) => r.id === empOwnerSelfId)).toBe(false);
  });

  it('is idempotent on a founder-shaped row (already active, no onboarding state)', async () => {
    createInAppNotification.mockClear();
    sendEmail.mockClear();

    const result = await employeesService.submitOnboardingStep(
      empFounderId,
      5,
      { step: 5, submitForReview: true } as never,
      tenantId,
      founderUserId,
    );
    expect(result.selfServeCompletion).toBe(true);

    const row = await employeeRow(empFounderId);
    expect(row.status).toBe('active');
    expect(
      (row.custom_fields as Record<string, unknown>)
        .onboarding_submitted_for_review,
    ).toBe(true);
    expect(inAppTypes()).not.toContain('onboarding.submitted');
  });

});

describe('HR admins are reviewed by the owner (round 17.1)', () => {
  it('an admin submits for review — no self-activation, owners notified', async () => {
    createInAppNotification.mockClear();

    const result = await employeesService.submitOnboardingStep(
      empPromotedId,
      5,
      { step: 5, submitForReview: true } as never,
      tenantId,
      promotedAdminUserId,
    );
    // HR staff do not sign off their own file.
    expect(result.selfServeCompletion).toBe(false);
    expect(result.allStepsComplete).toBe(true);

    const row = await employeeRow(empPromotedId);
    expect(row.status).toBe('inactive');
    const seat = await membershipRow(promotedAdminUserId);
    expect(seat.status).toBe('invited');

    const recipients = createInAppNotification.mock.calls
      .filter((c) => (c as unknown[])[1] === 'onboarding.submitted')
      .map((c) => (c as unknown[])[0]);
    // Routed to the OWNERS only — a peer admin must not review a colleague.
    expect(recipients).toContain(ownerAUserId);
    expect(recipients).toContain(ownerSelfUserId);
    expect(recipients).not.toContain(otherAdminUserId);
    expect(recipients).not.toContain(promotedAdminUserId);
  });

  it('lands in the owner\'s onboarding queue', async () => {
    const queue = await employeesService.getOnboardingQueue(
      tenantId,
      ownerAUserId,
    );
    expect(queue.data.some((r) => r.id === empPromotedId)).toBe(true);
  });
});

describe('everyone else keeps the HR review path', () => {
  it('an ordinary employee still fans out, stays inactive and lands in the queue', async () => {
    createInAppNotification.mockClear();

    const result = await employeesService.submitOnboardingStep(
      empPlainId,
      5,
      { step: 5, submitForReview: true } as never,
      tenantId,
      plainEmpUserId,
    );
    expect(result.selfServeCompletion).toBe(false);
    expect(result.allStepsComplete).toBe(true);

    const recipients = createInAppNotification.mock.calls
      .filter((c) => (c as unknown[])[1] === 'onboarding.submitted')
      .map((c) => (c as unknown[])[0]);
    expect(recipients).toContain(ownerAUserId);
    // HR reviews ordinary joiners — that's the job; only an admin's OWN
    // file is escalated to the owners.
    expect(recipients).toContain(otherAdminUserId);
    expect(recipients).not.toContain(plainEmpUserId);

    const row = await employeeRow(empPlainId);
    expect(row.status).toBe('inactive');

    const queue = await employeesService.getOnboardingQueue(
      tenantId,
      ownerAUserId,
    );
    expect(queue.data.some((r) => r.id === empPlainId)).toBe(true);
  });

  it('an admin editing someone else never completes or activates them', async () => {
    const result = (await employeesService.adminSubmitEmployeeDetails(
      empAdminEditId,
      2,
      { step: 2, submitForReview: true } as never,
      tenantId,
      ownerAUserId,
    )) as { allStepsComplete?: boolean; selfServeCompletion?: boolean };
    expect(result.allStepsComplete).toBe(false);
    expect(result.selfServeCompletion).toBe(false);

    const row = await employeeRow(empAdminEditId);
    expect(row.status).toBe('inactive');
    expect(
      (row.custom_fields as Record<string, unknown>)
        .onboarding_submitted_for_review,
    ).toBeUndefined();
  });
});

describe('send-back links point at the real wizard route', () => {
  it('in-app link and email resubmit URL both use /onboarding/employee', async () => {
    createInAppNotification.mockClear();
    sendEmail.mockClear();

    await employeesService.rejectOnboarding(
      empSentBackId,
      'Please re-check the bank details',
      ownerAUserId,
      tenantId,
    );

    const ping = createInAppNotification.mock.calls.find(
      (c) => (c as unknown[])[1] === 'onboarding.rejected',
    ) as unknown[] | undefined;
    expect(ping).toBeTruthy();
    // /employees/me/onboarding never existed — it 404'd for every send-back.
    expect(ping![3]).toBe('/onboarding/employee');

    const email = sendEmail.mock.calls.find(
      (c) => (c as unknown[])[0] === 'onboarding-rejected',
    ) as unknown[] | undefined;
    expect(email).toBeTruthy();
    expect((email![2] as { resubmitUrl: string }).resubmitUrl).toBe(
      `${APP_URL}/onboarding/employee`,
    );
  });
});
