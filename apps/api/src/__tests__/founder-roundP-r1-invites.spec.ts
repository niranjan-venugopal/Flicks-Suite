/**
 * Founder round P — R1 go-live fixes: invites, re-adding the same person,
 * directory status fields, "Skip for now" for owners, OTP delivery failure.
 *
 *  R1.1  Resend invite — a fresh 7-day link, one `employee_invitations` ledger
 *        row per send (resent_count = ordinal), reminder subject, 429 inside
 *        60 s, 409 once they have submitted / seat deactivated / removed, and
 *        a missing seat is self-healed instead of erroring.
 *  R1.2  Re-adding the same person by work email no longer hits the raw
 *        `employees_tenant_work_email_unique` text: pending → update + re-send
 *        (`reinvited: true`); active → 409 ALREADY_EMPLOYEE; archived → re-hired
 *        IN PLACE (same id, history intact); prior hard delete → the deactivated
 *        seat is re-invited and linked; guest/auditor → 409 EXTERNAL_SEAT; no
 *        orphan users row on any 409; Restore and Members → Reactivate relink.
 *  R1.3  listEmployees / getEmployee carry membershipStatus, onboardingStep,
 *        onboardingSubmitted and a real total; next-code counts removed rows.
 *  R1.6  Owners / HR admins may defer the wizard; requestOtp → 503 when the
 *        provider rejects the send.
 *
 * Service-level against the real Postgres, mirroring founder-round21.spec.
 */
import 'dotenv/config';
import * as crypto from 'crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { db, dbAdmin } from '@flicks/db';
import {
  tenants,
  users,
  memberships,
  employees,
  employeeInvitations,
  employmentHistory,
  attendanceRecords,
  departments,
  authOtps,
  authEvents,
} from '@flicks/db/schema';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import {
  ConflictException,
  ForbiddenException,
  HttpException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DatabaseService } from '../core/database/database.service';
import { EmployeesService } from '../modules/employees/employees.service';
import { SettingsService } from '../modules/settings/settings.service';
import { AuthService } from '../modules/auth/auth.service';
import { ConsentService } from '../modules/consent/consent.service';
import { TotpService } from '../modules/auth/totp.service';
import type { AuditService } from '../modules/audit/audit.service';
import { NotificationsService } from '../modules/notifications/notifications.service';
import type { MediaService } from '../modules/media/media.service';

const rid = () => crypto.randomBytes(4).toString('hex');
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

// ─── Stubs ──────────────────────────────────────────────────────────────────
const auditLog = jest.fn(async (_dto: unknown) => undefined);
const audit = { log: auditLog } as unknown as AuditService;
const sendEmail = jest.fn(async (_tpl: unknown, _to: unknown, _props: unknown) => true);
const createInAppNotification = jest.fn(async () => undefined);
const notifications = { sendEmail, createInAppNotification } as unknown as NotificationsService;
// The detailed shape resendInvite / inviteEmployee need (R1.1); each call
// mints a distinct token so the ledger's UNIQUE token_hash never collides.
const issueInviteMagicLinkDetailed = jest.fn(async (_userId: string, _email: string) => {
  const raw = `tok-${rid()}-${rid()}`;
  return {
    url: `http://localhost:3000/verify?token=${raw}`,
    tokenHash: sha256(raw),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  };
});
const authStub = { issueInviteMagicLinkDetailed } as unknown as AuthService;
const emitter = new EventEmitter2();
const dbSvc = new DatabaseService();
const mediaStub = {
  servedUrl: async (k: string | null, l: string | null) => (k ? `signed:${k}` : l),
} as unknown as MediaService;

const employeesService = new EmployeesService(
  dbSvc,
  dbAdmin as never,
  audit,
  notifications,
  emitter,
  new ConfigService({ NODE_ENV: 'test' }),
  authStub,
  mediaStub,
);
const settingsService = new SettingsService(
  db as never,
  dbAdmin as never,
  audit,
  mediaStub,
  { publish: async () => null } as never,
);

// ─── Fixtures ───────────────────────────────────────────────────────────────
let tenantId: string;
let ownerUserId: string;
let ownerEmployeeId: string;
let deptId: string;
const trackedTenants: string[] = [];
const trackedUsers: string[] = [];
const trackedEmails: string[] = [];

const freshEmail = (label: string) => {
  const e = `rp-${label}-${rid()}@t.test`;
  trackedEmails.push(e);
  return e;
};

async function seedUser(email: string, fullName = 'Round P') {
  const [u] = await dbAdmin
    .insert(users)
    .values({ email, full_name: fullName, status: 'active' })
    .returning();
  trackedUsers.push(u!.id);
  return u!.id;
}

async function mkTenant(label: string) {
  const [t] = await dbAdmin
    .insert(tenants)
    .values({ name: `RP ${label} ${rid()}`, slug: `rp-${label}-${rid()}-${Date.now()}`, status: 'active' })
    .returning();
  trackedTenants.push(t!.id);
  return t!.id;
}

const invite = (
  email: string,
  employeeCode: string,
  extra: Record<string, unknown> = {},
  tid = tenantId,
) =>
  employeesService.inviteEmployee(
    { fullName: 'Round Person', email, employeeCode, ...extra } as never,
    ownerUserId,
    tid,
  );

const empRow = async (id: string) => {
  const [row] = await dbAdmin.select().from(employees).where(eq(employees.id, id));
  return row ?? null;
};
const seatOf = async (userId: string, tid = tenantId) => {
  const [m] = await dbAdmin
    .select()
    .from(memberships)
    .where(and(eq(memberships.tenant_id, tid), eq(memberships.user_id, userId)));
  return m ?? null;
};
const ledgerOf = (employeeId: string) =>
  dbAdmin
    .select()
    .from(employeeInvitations)
    .where(eq(employeeInvitations.employee_id, employeeId))
    .orderBy(employeeInvitations.created_at);
/** Pretend the last send happened a while ago so the 60 s window is open. */
const backdateLedger = (employeeId: string) =>
  dbAdmin
    .update(employeeInvitations)
    .set({ created_at: new Date(Date.now() - 5 * 60 * 1000) })
    .where(eq(employeeInvitations.employee_id, employeeId));
/** A working record, so removal archives instead of deleting (round 21). */
const giveHistory = (employeeId: string, tid = tenantId) =>
  dbAdmin.insert(attendanceRecords).values({
    tenant_id: tid,
    employee_id: employeeId,
    attendance_date: '2026-01-05',
    attendance_status: 'present',
  });
const lastEmailProps = () =>
  (sendEmail.mock.calls[sendEmail.mock.calls.length - 1] as unknown as unknown[])[2] as Record<
    string,
    unknown
  >;
const auditActions = () =>
  auditLog.mock.calls.map((c) => (c[0] as { action: string }).action);

beforeAll(async () => {
  tenantId = await mkTenant('a');
  ownerUserId = await seedUser(freshEmail('owner'), 'Owner Person');
  const [ownerEmp] = await dbAdmin
    .insert(employees)
    .values({
      tenant_id: tenantId,
      user_id: ownerUserId,
      employee_code: `OWN-${rid()}`,
      first_name: 'Owner',
      last_name: 'Person',
      work_email: trackedEmails[0]!,
      date_of_joining: '2026-01-01',
      status: 'inactive',
      custom_fields: { onboarding_step: 0 },
    })
    .returning();
  ownerEmployeeId = ownerEmp!.id;
  await dbAdmin.insert(memberships).values({
    tenant_id: tenantId,
    user_id: ownerUserId,
    role: 'owner',
    status: 'active',
    employee_id: ownerEmployeeId,
    accepted_at: new Date(),
  });
  const [d] = await dbAdmin
    .insert(departments)
    .values({ tenant_id: tenantId, name: `Eng ${rid()}` })
    .returning();
  deptId = d!.id;
});

afterAll(async () => {
  for (const t of trackedTenants) await dbAdmin.delete(tenants).where(eq(tenants.id, t));
  if (trackedEmails.length) {
    await dbAdmin.delete(authOtps).where(inArray(authOtps.email, trackedEmails));
    await dbAdmin.delete(authEvents).where(inArray(authEvents.email, trackedEmails));
    // Users provisioned by inviteEmployee itself.
    await dbAdmin.delete(users).where(inArray(users.email, trackedEmails));
  }
  for (const id of trackedUsers) await dbAdmin.delete(users).where(eq(users.id, id));
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.().catch(() => {});
});

beforeEach(() => {
  sendEmail.mockClear();
  auditLog.mockClear();
  issueInviteMagicLinkDetailed.mockClear();
});

// ─── R1.1 Resend invite ─────────────────────────────────────────────────────

describe('R1.1 — resend invite', () => {
  it('the first invite writes ledger row #0 and returns emailSent', async () => {
    const email = freshEmail('first');
    const res = await invite(email, `RS1-${rid()}`);
    expect(res.emailSent).toBe(true);
    expect(res.reinvited).toBeUndefined();
    const rows = await ledgerOf(res.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.resent_count).toBe(0);
    expect(rows[0]!.email).toBe(email);
    expect(rows[0]!.invited_by).toBe(ownerUserId);
    expect(rows[0]!.token_hash).toHaveLength(64);
    expect(lastEmailProps().isReminder).toBeUndefined();
  });

  it('happy path: fresh link, ledger row #1, reminder subject props, audit', async () => {
    const email = freshEmail('resend');
    const res = await invite(email, `RS2-${rid()}`);
    await backdateLedger(res.id);
    sendEmail.mockClear();
    auditLog.mockClear();

    const out = await employeesService.resendInvite(res.id, tenantId, ownerUserId);
    expect(out.data).toEqual({
      employeeId: res.id,
      email,
      resentCount: 1,
      emailSent: true,
    });
    expect(issueInviteMagicLinkDetailed).toHaveBeenCalledWith(res.userId, email);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect((sendEmail.mock.calls[0] as unknown as unknown[])[0]).toBe('welcome-employee');
    expect((sendEmail.mock.calls[0] as unknown as unknown[])[1]).toBe(email);
    expect(lastEmailProps().isReminder).toBe(true);
    expect(String(lastEmailProps().magicLinkUrl)).toMatch(/verify\?token=tok-/);
    const rows = await ledgerOf(res.id);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.resent_count)).toEqual([0, 1]);
    expect(auditActions()).toContain('employee.invite_resent');
  });

  it('429 RESEND_TOO_SOON inside 60 s', async () => {
    const res = await invite(freshEmail('soon'), `RS3-${rid()}`);
    const err = await employeesService
      .resendInvite(res.id, tenantId, ownerUserId)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);
    expect((err as HttpException).getResponse()).toMatchObject({ code: 'RESEND_TOO_SOON' });
    expect((err as HttpException).message).toMatch(/less than a minute/);
    expect(await ledgerOf(res.id)).toHaveLength(1);
  });

  it('409 ALREADY_ONBOARDED once they have submitted the wizard', async () => {
    const res = await invite(freshEmail('submitted'), `RS4-${rid()}`);
    await backdateLedger(res.id);
    await dbAdmin
      .update(employees)
      .set({ custom_fields: { onboarding_step: 5, onboarding_submitted_for_review: true } })
      .where(eq(employees.id, res.id));
    const err = await employeesService
      .resendInvite(res.id, tenantId, ownerUserId)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({ code: 'ALREADY_ONBOARDED' });
    expect((err as ConflictException).message).toMatch(/already accepted their invite and submitted onboarding/);
  });

  it('409 SEAT_DEACTIVATED when the seat was deactivated from Members', async () => {
    const res = await invite(freshEmail('deact'), `RS5-${rid()}`);
    await backdateLedger(res.id);
    await dbAdmin
      .update(memberships)
      .set({ status: 'deactivated' })
      .where(and(eq(memberships.tenant_id, tenantId), eq(memberships.user_id, res.userId!)));
    const err = await employeesService
      .resendInvite(res.id, tenantId, ownerUserId)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({ code: 'SEAT_DEACTIVATED' });
    expect((err as ConflictException).message).toMatch(/Settings → Members/);
  });

  it('409 EMPLOYEE_REMOVED for an archived row', async () => {
    const res = await invite(freshEmail('removed'), `RS6-${rid()}`);
    await backdateLedger(res.id);
    await dbAdmin.update(employees).set({ deleted_at: new Date() }).where(eq(employees.id, res.id));
    const err = await employeesService
      .resendInvite(res.id, tenantId, ownerUserId)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({ code: 'EMPLOYEE_REMOVED' });
    expect((err as ConflictException).message).toMatch(/People → Removed/);
  });

  it('self-heals a legacy row with no user and no seat', async () => {
    const email = freshEmail('legacy');
    const [legacy] = await dbAdmin
      .insert(employees)
      .values({
        tenant_id: tenantId,
        employee_code: `LEG-${rid()}`,
        first_name: 'Legacy',
        last_name: 'Row',
        work_email: email,
        date_of_joining: '2026-02-01',
        status: 'inactive',
        custom_fields: { onboarding_step: 0 },
      })
      .returning();

    const out = await employeesService.resendInvite(legacy!.id, tenantId, ownerUserId);
    expect(out.data.resentCount).toBe(0);
    expect(out.data.emailSent).toBe(true);

    const row = await empRow(legacy!.id);
    expect(row!.user_id).not.toBeNull();
    const seat = await seatOf(row!.user_id!);
    expect(seat).toMatchObject({ status: 'invited', role: 'employee', employee_id: legacy!.id });
    expect(await ledgerOf(legacy!.id)).toHaveLength(1);
  });

  it('bulk: every eligible row when ids are omitted; throttled rows are skipped, not fatal', async () => {
    const tid = await mkTenant('bulk');
    const a = await invite(freshEmail('bulk-a'), `BK-A-${rid()}`, {}, tid);
    const b = await invite(freshEmail('bulk-b'), `BK-B-${rid()}`, {}, tid);
    await backdateLedger(a.id); // b stays inside the window
    sendEmail.mockClear();

    const out = await employeesService.resendInvitesBulk(tid, ownerUserId);
    expect(out.data.sent).toBe(1);
    expect(out.data.skipped).toEqual([
      { employeeId: b.id, email: b.email, reason: expect.stringMatching(/less than a minute/) },
    ]);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect((sendEmail.mock.calls[0] as unknown as unknown[])[1]).toBe(a.email);

    // Explicit ids: unknown ids are reported, the rest proceed.
    await backdateLedger(b.id);
    const bogus = crypto.randomUUID();
    const explicit = await employeesService.resendInvitesBulk(tid, ownerUserId, [b.id, bogus]);
    expect(explicit.data.sent).toBe(1);
    expect(explicit.data.skipped).toEqual([
      { employeeId: bogus, email: '', reason: expect.stringMatching(/not found/i) },
    ]);
  });

  it('bulk: an explicit EMPTY list mails nobody — only an omitted list means everyone', async () => {
    const tid = await mkTenant('bulk-empty');
    const a = await invite(freshEmail('bulk-e'), `BK-E-${rid()}`, {}, tid);
    await backdateLedger(a.id); // eligible, window open — would be mailed by the omitted form
    sendEmail.mockClear();

    const out = await employeesService.resendInvitesBulk(tid, ownerUserId, []);
    expect(out.data).toEqual({ sent: 0, skipped: [] });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(await ledgerOf(a.id)).toHaveLength(1);
  });

  it('welcome-employee: isReminder flips the subject + opening line, same link block', () => {
    const svc = new NotificationsService(
      db as never,
      dbAdmin as never,
      new ConfigService({ NODE_ENV: 'test', RESEND_API_KEY: 're_test' }),
      emitter,
    );
    const render = (props: Record<string, unknown>) =>
      (
        svc as unknown as {
          renderTemplate: (t: string, p: Record<string, unknown>) => { subject: string; html: string };
        }
      ).renderTemplate('welcome-employee', props);
    const base = {
      employeeName: 'Round Person',
      companyName: 'Acme Pvt Ltd',
      magicLinkUrl: 'http://localhost:3000/verify?token=tok-x',
    };
    const first = render(base);
    expect(first.subject).toBe('Welcome to Acme Pvt Ltd — Accept your invite');
    expect(first.html).toContain("You've been invited to join");
    expect(first.html).toContain('verify?token=tok-x');

    const reminder = render({ ...base, isReminder: true });
    expect(reminder.subject).toBe('Reminder: your invite to Acme Pvt Ltd is waiting');
    expect(reminder.html).toContain('still waiting for you');
    expect(reminder.html).not.toContain("You've been invited to join");
    expect(reminder.html).toContain('verify?token=tok-x');
  });
});

// ─── R1.2 Re-adding the same person ─────────────────────────────────────────

describe('R1.2 — re-adding the same person', () => {
  it('a pending invitee re-added from the form is updated and re-invited (reinvited: true)', async () => {
    const email = freshEmail('pending');
    const first = await invite(email, `PD1-${rid()}`);
    await backdateLedger(first.id);
    sendEmail.mockClear();
    auditLog.mockClear();

    const newCode = `PD1B-${rid()}`;
    const again = await employeesService.inviteEmployee(
      {
        fullName: 'Corrected Name',
        email: email.toUpperCase(), // normalised
        employeeCode: newCode,
        departmentId: deptId,
        jobTitle: 'Engineer',
        employmentType: 'contract',
        joiningDate: '2026-11-01',
      } as never,
      ownerUserId,
      tenantId,
    );
    expect(again.id).toBe(first.id);
    expect(again.reinvited).toBe(true);
    expect(again.emailSent).toBe(true);
    expect(again.employeeCode).toBe(newCode);

    const row = await empRow(first.id);
    expect(row).toMatchObject({
      first_name: 'Corrected',
      last_name: 'Name',
      department_id: deptId,
      employment_type: 'contract',
      date_of_joining: '2026-11-01',
      status: 'inactive',
      deleted_at: null,
    });
    expect((row!.custom_fields as Record<string, unknown>).job_title).toBe('Engineer');
    // The directory reads users.full_name — corrected while they never signed in.
    const [u] = await dbAdmin.select().from(users).where(eq(users.id, first.userId!));
    expect(u!.full_name).toBe('Corrected Name');

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(lastEmailProps().isReminder).toBe(true);
    const rows = await ledgerOf(first.id);
    expect(rows.map((r) => r.resent_count)).toEqual([0, 1]);
    expect(auditActions()).toContain('employee.invite_resent');
    // Still exactly one employee row for the address.
    const all = await dbAdmin
      .select({ id: employees.id })
      .from(employees)
      .where(and(eq(employees.tenant_id, tenantId), eq(employees.work_email, email)));
    expect(all).toHaveLength(1);
  });

  it('a re-invite that omits employment type / joining date keeps what HR entered first', async () => {
    const email = freshEmail('pending-keep');
    const first = await invite(email, `PD4-${rid()}`, {
      employmentType: 'contract',
      joiningDate: '2026-11-15',
    });
    await backdateLedger(first.id);

    const again = await invite(email, first.employeeCode);
    expect(again.reinvited).toBe(true);
    expect(await empRow(first.id)).toMatchObject({
      employment_type: 'contract',
      date_of_joining: '2026-11-15',
    });
  });

  it('a pending invitee whose seat Members deactivated → form re-add 409 SEAT_DEACTIVATED, nothing changes', async () => {
    const email = freshEmail('pending-deact');
    const first = await invite(email, `PD3-${rid()}`);
    await backdateLedger(first.id); // window open — the 409 must come from the seat, not the throttle
    await dbAdmin
      .update(memberships)
      .set({ status: 'deactivated' })
      .where(and(eq(memberships.tenant_id, tenantId), eq(memberships.user_id, first.userId!)));
    sendEmail.mockClear();

    const err = await invite(email, `PD3B-${rid()}`, { departmentId: deptId }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({ code: 'SEAT_DEACTIVATED' });
    expect((err as ConflictException).message).toMatch(/Settings → Members/);
    // Same answer as Resend invite; the row, the seat and the ledger are untouched.
    const row = await empRow(first.id);
    expect(row).toMatchObject({ department_id: null, employee_code: first.employeeCode });
    expect(await seatOf(first.userId!)).toMatchObject({ status: 'deactivated' });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(await ledgerOf(first.id)).toHaveLength(1);
  });

  it('a pending invitee re-added within a minute gets 429 and nothing changes', async () => {
    const email = freshEmail('pending-soon');
    const first = await invite(email, `PD2-${rid()}`);
    const err = await invite(email, `PD2B-${rid()}`, { departmentId: deptId }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);
    const row = await empRow(first.id);
    expect(row!.department_id).toBeNull();
    expect(row!.employee_code).toBe(first.employeeCode);
  });

  it('CSV import skips a pending invitee instead of re-mailing them', async () => {
    const pending = freshEmail('csv-pending');
    const fresh = freshEmail('csv-fresh');
    const pendingRes = await invite(pending, `CSV1-${rid()}`);
    // Window open — the skip must come from the pending state, not the throttle.
    await backdateLedger(pendingRes.id);
    sendEmail.mockClear();

    const out = await employeesService.importEmployees(
      {
        rows: [
          { fullName: 'Pending Person', email: pending, employeeCode: `CSV1X-${rid()}` },
          { fullName: 'Fresh Person', email: fresh, employeeCode: `CSV2-${rid()}` },
        ],
      } as never,
      ownerUserId,
      tenantId,
    );
    expect(out.total).toBe(2);
    expect(out.created).toBe(1);
    expect(out.failed).toEqual([]);
    expect(out.skipped).toEqual([
      { row: 1, email: pending, reason: 'already invited — use Resend invite' },
    ]);
    // One email: the fresh row. The pending one was NOT re-mailed.
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect((sendEmail.mock.calls[0] as unknown as unknown[])[1]).toBe(fresh);
  });

  it('an active employee → 409 ALREADY_EMPLOYEE naming their code; no second row', async () => {
    const email = freshEmail('active');
    const first = await invite(email, `AC1-${rid()}`);
    await dbAdmin.update(employees).set({ status: 'active' }).where(eq(employees.id, first.id));
    const err = await invite(email, `AC1B-${rid()}`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({ code: 'ALREADY_EMPLOYEE' });
    expect((err as ConflictException).message).toContain(first.employeeCode);
    expect((err as ConflictException).message).toMatch(/Open their profile instead/);
    const all = await dbAdmin
      .select({ id: employees.id })
      .from(employees)
      .where(and(eq(employees.tenant_id, tenantId), eq(employees.work_email, email)));
    expect(all).toHaveLength(1);
  });

  it('archived → re-hired in place: same id, history + bank details intact, seat invited and linked', async () => {
    const email = freshEmail('rehire');
    const first = await invite(email, `RH1-${rid()}`);
    // They accepted, worked, were removed with history.
    await dbAdmin
      .update(memberships)
      .set({ status: 'active', accepted_at: new Date() })
      .where(and(eq(memberships.tenant_id, tenantId), eq(memberships.user_id, first.userId!)));
    await dbAdmin
      .update(employees)
      .set({
        status: 'active',
        bank_name: 'HDFC',
        custom_fields: {
          onboarding_step: 5,
          onboarding_submitted_for_review: true,
          onboarding_completed_at: '2026-03-01T00:00:00.000Z',
          onboarding_submitted_at: '2026-03-01T00:00:00.000Z',
        },
      })
      .where(eq(employees.id, first.id));
    await giveHistory(first.id);
    const removed = await employeesService.removeEmployee(first.id, tenantId, ownerUserId);
    expect(removed.data.mode).toBe('archive');
    expect(await seatOf(first.userId!)).toMatchObject({ status: 'deactivated', employee_id: null });
    expect((await empRow(first.id))!.deleted_at).not.toBeNull();
    sendEmail.mockClear();
    auditLog.mockClear();

    const newCode = `RH1B-${rid()}`;
    const back = await invite(email, newCode, { departmentId: deptId, joiningDate: '2026-12-01' });
    expect(back.id).toBe(first.id);
    expect((back as { rehired?: boolean }).rehired).toBe(true);
    expect(back.emailSent).toBe(true);
    expect(back.employeeCode).toBe(newCode);

    const row = await empRow(first.id);
    expect(row).toMatchObject({
      deleted_at: null,
      status: 'inactive',
      department_id: deptId,
      date_of_joining: '2026-12-01',
      bank_name: 'HDFC', // kept
      user_id: first.userId,
    });
    expect((row!.custom_fields as Record<string, unknown>)).toMatchObject({
      onboarding_step: 0,
      onboarding_submitted_for_review: false,
      onboarding_rejection_reason: null,
      // The previous stint's wizard timestamps don't read as "submitted".
      onboarding_completed_at: null,
      onboarding_submitted_at: null,
    });
    expect(await employeesService.getMyOnboardingStatus(first.userId!, tenantId)).toMatchObject({
      employeeId: first.id,
      onboardingStep: 0,
      submittedAt: null,
      submittedForReview: false,
    });
    // History survived and a rehire marker was added.
    const att = await dbAdmin.select().from(attendanceRecords).where(eq(attendanceRecords.employee_id, first.id));
    expect(att).toHaveLength(1);
    const hist = await dbAdmin.select().from(employmentHistory).where(eq(employmentHistory.employee_id, first.id));
    expect(hist.some((h) => h.change_type === 'rehire')).toBe(true);
    // Seat → invited, linked, as a plain employee; the link activates it.
    const seat = await seatOf(first.userId!);
    expect(seat).toMatchObject({ status: 'invited', employee_id: first.id, role: 'employee', accepted_at: null });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(lastEmailProps().isReminder).toBeUndefined();
    expect(auditActions()).toContain('employee.rehired');
    const rows = await ledgerOf(first.id);
    expect(rows.map((r) => r.resent_count)).toEqual([0, 1]);
  });

  it('prior hard delete → re-added: the deactivated seat becomes invited with the new employee_id', async () => {
    const email = freshEmail('harddel');
    const first = await invite(email, `HD1-${rid()}`);
    const removed = await employeesService.removeEmployee(first.id, tenantId, ownerUserId);
    expect(removed.data.mode).toBe('delete');
    expect(await empRow(first.id)).toBeNull();
    expect(await seatOf(first.userId!)).toMatchObject({ status: 'deactivated', employee_id: null });

    const back = await invite(email, `HD1B-${rid()}`);
    expect(back.id).not.toBe(first.id);
    expect(back.userId).toBe(first.userId);
    expect(back.reinvited).toBeUndefined();
    const seat = await seatOf(first.userId!);
    expect(seat).toMatchObject({ status: 'invited', employee_id: back.id, role: 'employee', accepted_at: null });
    expect(seat!.invited_by).toBe(ownerUserId);
    expect(await ledgerOf(back.id)).toHaveLength(1);
  });

  it('an unlinked active seat (workspace creator) gets linked to the new row, role kept', async () => {
    const email = freshEmail('creator');
    const uid = await seedUser(email, 'Creator');
    await dbAdmin.insert(memberships).values({
      tenant_id: tenantId,
      user_id: uid,
      role: 'admin',
      status: 'active',
      accepted_at: new Date(),
    });
    const res = await invite(email, `CR1-${rid()}`);
    const seat = await seatOf(uid);
    expect(seat).toMatchObject({ status: 'active', role: 'admin', employee_id: res.id });
  });

  it('a guest seat → 409 EXTERNAL_SEAT and no employee row', async () => {
    const email = freshEmail('guest');
    const uid = await seedUser(email, 'Guest');
    await dbAdmin.insert(memberships).values({
      tenant_id: tenantId,
      user_id: uid,
      role: 'guest',
      status: 'active',
      is_external: true,
    });
    const err = await invite(email, `GS1-${rid()}`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({ code: 'EXTERNAL_SEAT' });
    expect((err as ConflictException).message).toMatch(/Settings → Members/);
    const rows = await dbAdmin
      .select({ id: employees.id })
      .from(employees)
      .where(and(eq(employees.tenant_id, tenantId), eq(employees.work_email, email)));
    expect(rows).toHaveLength(0);
  });

  it('an archived row whose user now holds a guest seat → 409 EXTERNAL_SEAT, row stays archived', async () => {
    const email = freshEmail('rehire-guest');
    const first = await invite(email, `RG1-${rid()}`);
    await giveHistory(first.id);
    await employeesService.removeEmployee(first.id, tenantId, ownerUserId);
    // Brought back as a PM guest in between.
    await dbAdmin
      .update(memberships)
      .set({ role: 'guest', status: 'active', is_external: true })
      .where(and(eq(memberships.tenant_id, tenantId), eq(memberships.user_id, first.userId!)));

    const err = await invite(email, `RG1B-${rid()}`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({ code: 'EXTERNAL_SEAT' });
    expect((await empRow(first.id))!.deleted_at).not.toBeNull();
    expect(await seatOf(first.userId!)).toMatchObject({ role: 'guest', employee_id: null });
  });

  it('a 409 never leaves an orphan users row behind', async () => {
    const taken = await invite(freshEmail('code-owner'), `OC1-${rid()}`);
    const email = freshEmail('orphan');
    await expect(invite(email, taken.employeeCode)).rejects.toThrow(/already in use/);
    const u = await dbAdmin.select({ id: users.id }).from(users).where(eq(users.email, email));
    expect(u).toHaveLength(0);
    // The two pinned employee-code messages still read the same (round 21).
    await giveHistory(taken.id);
    await employeesService.removeEmployee(taken.id, tenantId, ownerUserId);
    await expect(invite(freshEmail('orphan2'), taken.employeeCode)).rejects.toThrow(
      /belongs to a removed employee/i,
    );
  });

  it("the same work email in tenant B is untouched by tenant A's invite", async () => {
    const tidB = await mkTenant('b');
    const email = freshEmail('shared');
    const uid = await seedUser(email, 'Shared Person');
    const [empB] = await dbAdmin
      .insert(employees)
      .values({
        tenant_id: tidB,
        user_id: uid,
        employee_code: `B-${rid()}`,
        first_name: 'Shared',
        last_name: 'Person',
        work_email: email,
        date_of_joining: '2025-01-01',
        status: 'active',
      })
      .returning();
    await dbAdmin.insert(memberships).values({
      tenant_id: tidB,
      user_id: uid,
      role: 'manager',
      status: 'active',
      employee_id: empB!.id,
      accepted_at: new Date(),
    });

    const resA = await invite(email, `A-${rid()}`);
    expect(resA.userId).toBe(uid);
    expect(resA.id).not.toBe(empB!.id);
    expect(await seatOf(uid)).toMatchObject({ status: 'invited', role: 'employee', employee_id: resA.id });
    // B: same row, same status, same seat.
    expect(await empRow(empB!.id)).toMatchObject({ status: 'active', deleted_at: null, work_email: email });
    expect(await seatOf(uid, tidB)).toMatchObject({ status: 'active', role: 'manager', employee_id: empB!.id });
  });

  it('Restore relinks the seat: active when they had accepted, invited otherwise', async () => {
    // Accepted before removal → active again.
    const accepted = await invite(freshEmail('restore-acc'), `RT1-${rid()}`);
    await dbAdmin
      .update(memberships)
      .set({ status: 'active', accepted_at: new Date() })
      .where(and(eq(memberships.tenant_id, tenantId), eq(memberships.user_id, accepted.userId!)));
    await giveHistory(accepted.id);
    await employeesService.removeEmployee(accepted.id, tenantId, ownerUserId);
    const r1 = await employeesService.restoreEmployee(accepted.id, tenantId, ownerUserId);
    expect(r1.data).toMatchObject({ restored: true, seat: 'active' });
    expect(await seatOf(accepted.userId!)).toMatchObject({ status: 'active', employee_id: accepted.id });
    expect((await empRow(accepted.id))!.deleted_at).toBeNull();

    // Never accepted → invited (Resend invite finishes the job).
    const pending = await invite(freshEmail('restore-pend'), `RT2-${rid()}`);
    await giveHistory(pending.id);
    await employeesService.removeEmployee(pending.id, tenantId, ownerUserId);
    const r2 = await employeesService.restoreEmployee(pending.id, tenantId, ownerUserId);
    expect(r2.data).toMatchObject({ restored: true, seat: 'invited' });
    expect(await seatOf(pending.userId!)).toMatchObject({ status: 'invited', employee_id: pending.id });
  });

  it('Restore leaves the seat alone when another LIVE record of the same person already holds it', async () => {
    const email = freshEmail('restore-held');
    const old = await invite(email, `RH2-${rid()}`);
    await giveHistory(old.id);
    await employeesService.removeEmployee(old.id, tenantId, ownerUserId);
    // Re-added meanwhile under a new work email: a second live row for the
    // same user, and the seat points at it.
    const [fresh] = await dbAdmin
      .insert(employees)
      .values({
        tenant_id: tenantId,
        user_id: old.userId!,
        employee_code: `RH2B-${rid()}`,
        first_name: 'Round',
        last_name: 'Person',
        work_email: freshEmail('restore-held-new'),
        date_of_joining: '2026-12-01',
        status: 'inactive',
        custom_fields: { onboarding_step: 0 },
      })
      .returning();
    await dbAdmin
      .update(memberships)
      .set({ status: 'invited', employee_id: fresh!.id })
      .where(and(eq(memberships.tenant_id, tenantId), eq(memberships.user_id, old.userId!)));

    const r = await employeesService.restoreEmployee(old.id, tenantId, ownerUserId);
    expect(r.data).toMatchObject({ restored: true, seat: 'unchanged' });
    expect((await empRow(old.id))!.deleted_at).toBeNull();
    expect(await seatOf(old.userId!)).toMatchObject({ status: 'invited', employee_id: fresh!.id });
    const restoredAudit = auditLog.mock.calls
      .map((c) => c[0] as { action: string; metadata?: Record<string, unknown> })
      .find((c) => c.action === 'employee.restored');
    expect(restoredAudit?.metadata).toMatchObject({ seat: 'unchanged', seatHeldByEmployeeId: fresh!.id });
  });

  it('in-tx unique violations map to 409 DUPLICATE with the friendly text (race path)', () => {
    const run = (err: unknown): unknown => {
      try {
        (
          employeesService as unknown as {
            rethrowInviteWriteError: (e: unknown, code: string) => never;
          }
        ).rethrowInviteWriteError(err, 'EMP042');
      } catch (e) {
        return e;
      }
      return undefined;
    };
    const byEmail = run({ code: '23505', constraint_name: 'employees_tenant_work_email_unique' });
    expect(byEmail).toBeInstanceOf(ConflictException);
    expect((byEmail as ConflictException).getResponse()).toEqual({
      code: 'DUPLICATE',
      message: 'An employee with this work email already exists',
    });
    // node-postgres spelling, and wrapped one level down in `cause`.
    const byCode = run(
      Object.assign(new Error('query failed'), {
        cause: { code: '23505', constraint: 'employees_tenant_code_unique' },
      }),
    );
    expect((byCode as ConflictException).getResponse()).toEqual({
      code: 'DUPLICATE',
      message: 'Employee code EMP042 is already in use',
    });
    const other = run({ code: '23505', constraint_name: 'employee_invitations_token_hash_key' });
    expect((other as ConflictException).getResponse()).toEqual({
      code: 'DUPLICATE',
      message: 'A record with the same value already exists.',
    });
    // Anything else is rethrown untouched.
    const plain = new Error('boom');
    expect(run(plain)).toBe(plain);
  });

  it('Members → Reactivate links the live employee row when employee_id is null', async () => {
    const res = await invite(freshEmail('reactivate'), `RA1-${rid()}`);
    const seat = await seatOf(res.userId!);
    // The state a removal + old-style restore left behind: live row, seat revoked and unlinked.
    await dbAdmin
      .update(memberships)
      .set({ status: 'deactivated', employee_id: null })
      .where(eq(memberships.id, seat!.id));

    const after = await settingsService.setMemberStatus(seat!.id, tenantId, ownerUserId, 'active');
    expect(after.status).toBe('active');
    expect(after.employee_id).toBe(res.id);
    expect(await seatOf(res.userId!)).toMatchObject({ status: 'active', employee_id: res.id });
  });
});

// ─── R1.3 Directory fields, total, next code ────────────────────────────────

describe('R1.3 — directory status fields, real total, next code', () => {
  it('listEmployees carries membershipStatus / onboardingStep / onboardingSubmitted and a real total', async () => {
    const tid = await mkTenant('list');
    const invited = await invite(freshEmail('l-invited'), `L1-${rid()}`, {}, tid);
    const midWizard = await invite(freshEmail('l-mid'), `L2-${rid()}`, {}, tid);
    const submitted = await invite(freshEmail('l-sub'), `L3-${rid()}`, {}, tid);
    await dbAdmin
      .update(memberships)
      .set({ status: 'active', accepted_at: new Date() })
      .where(and(eq(memberships.tenant_id, tid), eq(memberships.user_id, midWizard.userId!)));
    await dbAdmin
      .update(employees)
      .set({ custom_fields: { onboarding_step: 2 } })
      .where(eq(employees.id, midWizard.id));
    await dbAdmin
      .update(employees)
      .set({ custom_fields: { onboarding_step: 5, onboarding_submitted_for_review: true } })
      .where(eq(employees.id, submitted.id));

    const page = await employeesService.listEmployees(tid, { limit: 2 } as never);
    expect(page.data).toHaveLength(2);
    expect(page.pagination).toEqual({ page: 1, limit: 2, total: 3 });

    const all = await employeesService.listEmployees(tid, { limit: 100 } as never);
    expect(all.pagination.total).toBe(3);
    const byId = new Map(all.data.map((r) => [r.id, r]));
    expect(byId.get(invited.id)).toMatchObject({
      membershipStatus: 'invited',
      onboardingStep: 0,
      onboardingSubmitted: false,
    });
    expect(byId.get(midWizard.id)).toMatchObject({
      membershipStatus: 'active',
      onboardingStep: 2,
      onboardingSubmitted: false,
    });
    expect(byId.get(submitted.id)).toMatchObject({
      membershipStatus: 'invited',
      onboardingStep: 5,
      onboardingSubmitted: true,
    });

    // The detail carries the same three fields at the top level.
    const detail = await employeesService.getEmployee(midWizard.id, tid);
    expect(detail).toMatchObject({
      membershipStatus: 'active',
      onboardingStep: 2,
      onboardingSubmitted: false,
    });

    // limit is capped at 100.
    const capped = await employeesService.listEmployees(tid, { limit: 500 } as never);
    expect(capped.pagination.limit).toBe(100);
  });

  it('next-code continues the dominant pattern and counts removed rows', async () => {
    const tid = await mkTenant('code');
    expect((await employeesService.suggestNextEmployeeCode(tid)).data.suggested).toBe('EMP001');

    await invite(freshEmail('c1'), 'EMP001', {}, tid);
    const second = await invite(freshEmail('c2'), 'EMP002', {}, tid);
    expect((await employeesService.suggestNextEmployeeCode(tid)).data.suggested).toBe('EMP003');

    // EMP002 removed with history → archived; the code is still taken.
    await giveHistory(second.id, tid);
    await employeesService.removeEmployee(second.id, tid, ownerUserId);
    const live = await employeesService.listEmployees(tid, {} as never);
    expect(live.data.map((r) => r.employeeCode)).toEqual(['EMP001']);
    expect((await employeesService.suggestNextEmployeeCode(tid)).data.suggested).toBe('EMP003');

    // A workspace on its own scheme keeps counting in that scheme, and
    // steps past a number that is already taken.
    await invite(freshEmail('c3'), 'SPF-014', {}, tid);
    await invite(freshEmail('c4'), 'SPF-015', {}, tid);
    await invite(freshEmail('c5'), 'SPF-016', {}, tid);
    await invite(freshEmail('c6'), 'SPF-018', {}, tid);
    expect((await employeesService.suggestNextEmployeeCode(tid)).data.suggested).toBe('SPF-019');
  });
});

// ─── R1.6 Owner "Skip for now" ──────────────────────────────────────────────

describe('R1.6 — owner / HR admin may skip the wizard for now', () => {
  it('owner: canDefer, defer → deferred, finishing the wizard clears it', async () => {
    const before = await employeesService.getMyOnboardingStatus(ownerUserId, tenantId);
    expect(before).toMatchObject({
      employeeId: ownerEmployeeId,
      onboardingStep: 0,
      submittedForReview: false,
      deferred: false,
      canDefer: true,
    });

    const out = await employeesService.deferMyOnboarding(ownerUserId, tenantId);
    expect(out).toEqual({ data: { deferred: true } });
    const row = await empRow(ownerEmployeeId);
    expect(typeof (row!.custom_fields as Record<string, unknown>).onboarding_deferred_at).toBe('string');

    const mid = await employeesService.getMyOnboardingStatus(ownerUserId, tenantId);
    expect(mid.deferred).toBe(true);
    expect(mid.canDefer).toBe(true);
    expect(auditActions()).toContain('employee.onboarding_deferred');

    // The owner self-completes the wizard later → no longer deferred.
    await employeesService.submitOnboardingStep(
      ownerEmployeeId,
      5,
      { step: 5, submitForReview: true } as never,
      tenantId,
      ownerUserId,
    );
    const after = await employeesService.getMyOnboardingStatus(ownerUserId, tenantId);
    expect(after.deferred).toBe(false);
    expect(after.submittedForReview).toBe(true);
    expect(((await empRow(ownerEmployeeId))!.custom_fields as Record<string, unknown>).onboarding_deferred_at).toBeNull();
  });

  it('a plain employee cannot defer (403) and is told so by canDefer', async () => {
    const res = await invite(freshEmail('defer-emp'), `DF1-${rid()}`);
    const status = await employeesService.getMyOnboardingStatus(res.userId!, tenantId);
    expect(status).toMatchObject({ employeeId: res.id, canDefer: false, deferred: false });
    await expect(employeesService.deferMyOnboarding(res.userId!, tenantId)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(((await empRow(res.id))!.custom_fields as Record<string, unknown>).onboarding_deferred_at).toBeUndefined();
  });

  it('no employee row → nothing to defer, canDefer false', async () => {
    const uid = await seedUser(freshEmail('seat-only'), 'Seat Only');
    await dbAdmin.insert(memberships).values({
      tenant_id: tenantId,
      user_id: uid,
      role: 'admin',
      status: 'active',
    });
    const status = await employeesService.getMyOnboardingStatus(uid, tenantId);
    expect(status).toEqual({
      employeeId: null,
      onboardingStep: 0,
      submittedAt: null,
      submittedForReview: false,
      deferred: false,
      canDefer: false,
    });
  });
});

// ─── C11 requestOtp → 503 when the provider rejects the send ────────────────

describe('C11 — requestOtp surfaces an email delivery failure', () => {
  const otpSend = jest.fn(async (): Promise<boolean> => true);
  const config = {
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
    config,
    { emit: () => true } as never,
    { sendEmail: otpSend } as unknown as NotificationsService,
    audit,
    new TotpService(config),
    new ConsentService(dbAdmin as never, config),
  );

  it('503 EMAIL_DELIVERY_FAILED when sendEmail returns false; 200 when it returns true', async () => {
    const email = freshEmail('otp');
    await seedUser(email, 'OTP Person');

    otpSend.mockResolvedValueOnce(false);
    const err = await authService.requestOtp(email, '127.0.0.1', 'jest', 'signin').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect((err as ServiceUnavailableException).getStatus()).toBe(503);
    expect((err as ServiceUnavailableException).getResponse()).toMatchObject({
      code: 'EMAIL_DELIVERY_FAILED',
      message: "We couldn't send the code right now. Please try again in a minute.",
    });

    const ok = await authService.requestOtp(email, '127.0.0.1', 'jest', 'signin');
    expect(ok.success).toBe(true);
  });

  it('issueInviteMagicLinkDetailed returns the hash of the token in the URL, and the old signature still works', async () => {
    const email = freshEmail('link');
    const uid = await seedUser(email, 'Link Person');
    const detailed = await authService.issueInviteMagicLinkDetailed(uid, email);
    const token = new URL(detailed.url).searchParams.get('token');
    expect(token).toBeTruthy();
    expect(detailed.tokenHash).toBe(sha256(token!));
    expect(detailed.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60 * 1000);
    const [row] = await dbAdmin
      .select()
      .from(authOtps)
      .where(eq(authOtps.magic_link_token, detailed.tokenHash));
    expect(row?.user_id).toBe(uid);

    const url = await authService.issueInviteMagicLink(uid, email);
    expect(url).toMatch(/verify\?token=/);
  });
});
