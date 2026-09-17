/**
 * Founder round K (2026-09-09) — self-service Edit profile + the regularization
 * deep link.
 *
 *  Fix B — PUT /employees/me writes personal phone / personal email / current
 *          address / the primary emergency contact (trimmed, lower-cased,
 *          merged JSON, deterministic ORDER BY created_at ASC upsert, null
 *          deletes) and never touches users.phone; 404 for a seat without an
 *          employee row or a foreign tenant; audit names the sections only;
 *          the global ValidationPipe keeps the nested address intact and
 *          refuses HR-managed fields; GET /employees/:id redacts the personal
 *          block for peers; POST /auth/logout-others keeps the current device
 *          and the cookie-matched row; GET /auth/me carries lastLoginAt.
 *  Fix C — the manager's regularization notice deep-links to Inbox →
 *          Approvals with the request selected (in-app + email reviewUrl,
 *          owner fan-out included), decision notices open the requester's
 *          log on that day, the templates escape every string, self-approval
 *          is blocked through the membership bridge, and the admin overview
 *          lists up to 50 pending regularizations for the Inbox.
 *
 * Service-level against the real Postgres (founder-round8 harness).
 */
import 'dotenv/config';
import * as crypto from 'crypto';
import { and, eq } from 'drizzle-orm';
import { db, dbAdmin } from '@flicks/db';
import {
  tenants,
  users,
  memberships,
  employees,
  emergencyContacts,
  attendanceRegularizations,
  refreshTokens,
  authEvents,
  auditLog,
} from '@flicks/db/schema';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { BadRequestException, ForbiddenException, NotFoundException, ValidationPipe } from '@nestjs/common';
import { DatabaseService } from '../core/database/database.service';
import { AuditService } from '../modules/audit/audit.service';
import {
  EmployeesService,
  canViewPersonalBlock,
  redactForViewer,
} from '../modules/employees/employees.service';
import { SelfUpdateEmployeeDto } from '../modules/employees/employees.dto';
import { AttendanceService } from '../modules/attendance/attendance.service';
import { DashboardService } from '../modules/dashboard/dashboard.service';
import { AuthService } from '../modules/auth/auth.service';
import { ConsentService } from '../modules/consent/consent.service';
import { NotificationsService } from '../modules/notifications/notifications.service';
import type { MediaService } from '../modules/media/media.service';

jest.setTimeout(90_000);

const rid = () => crypto.randomBytes(4).toString('hex');
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const APP_URL = 'https://app.test';

/** Notifications are fire-and-forget by design (house rule 6) — poll. */
async function waitFor(pred: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}
const settle = () => new Promise((r) => setTimeout(r, 150));

type InAppCall = [string, string, string, string, string, unknown];
type MailCall = [string, string, Record<string, unknown>, unknown];

const auditStub = { log: async () => {} } as unknown as AuditService;
const createInAppNotification = jest.fn(async () => undefined);
const sendEmail = jest.fn(async () => true);
const notifications = { createInAppNotification, sendEmail } as unknown as NotificationsService;
const media = {
  servedUrl: async (k: string | null, l: string | null) => (k ? `signed:${k}` : l),
} as unknown as MediaService;

const dbSvc = new DatabaseService();
const emitter = new EventEmitter2();
// Real audit for the employees service so the employee.self_updated row can
// be read back from audit_log; the attendance audit is detached and stubbed.
const realAudit = new AuditService(db as never, dbAdmin as never, dbSvc);

const employeesService = new EmployeesService(
  dbSvc,
  dbAdmin as never,
  realAudit,
  notifications,
  emitter,
  new ConfigService({ NODE_ENV: 'test' }),
  {} as never,
  media,
);
const attendanceService = new AttendanceService(
  dbSvc,
  dbAdmin as never,
  auditStub,
  notifications,
  new ConfigService({ APP_URL }),
);
const dashboardService = new DashboardService(dbSvc, media);
const realNotifications = new NotificationsService(
  db as never,
  dbAdmin as never,
  new ConfigService({ NODE_ENV: 'test', APP_URL }),
  emitter,
);
const renderTemplate = (template: string, props: Record<string, unknown>) =>
  (realNotifications as unknown as {
    renderTemplate: (t: string, p: Record<string, unknown>) => { subject: string; html: string };
  }).renderTemplate(template, props);

const authConfig = {
  get: (key: string, fallback?: unknown) => {
    const map: Record<string, unknown> = {
      NODE_ENV: 'test',
      APP_URL,
      JWT_SECRET: 'roundk-test-secret',
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
  new JwtService({ secret: 'roundk-test-secret' }),
  authConfig,
  { emit: () => true } as never,
  notifications,
  auditStub,
  { isEnforced: () => false } as never,
  new ConsentService(dbAdmin as never, authConfig),
);

// ─── Fixtures ────────────────────────────────────────────────────────────────

let T1: string;
let T2: string;
const userIds: string[] = [];

type Person = { userId: string; employeeId: string | null; membershipId: string; email: string; name: string };
type Role = 'owner' | 'admin' | 'manager' | 'employee';
let O: Person; // owner (no reporting manager)
let M: Person; // manager (reports to O)
let M2: Person; // another manager (reports to O)
let R1: Person; let R2: Person; let R3: Person; let R4: Person; let R5: Person; let R6: Person; let R7: Person; // M's reports
let Rs: Person[];
let P: Person; // peer — M2's report
let N: Person; // admin seat WITHOUT an employee row
let S: Person; // employee row with user_id NULL, bridged only through SU's membership
let SU: Person; // owner seat whose membership.employee_id = S
let LU: Person; // "sign out other devices" subject (no employee row)
let Z: Person; // owner of T2
let foreignUserId: string; // a user with no membership anywhere

const isoPlus = (days: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

async function mkUser(label: string) {
  const email = `rk-${label.toLowerCase()}-${rid()}@t.test`;
  const [u] = await dbAdmin.insert(users).values({ email, full_name: `${label} Tester`, status: 'active' }).returning();
  userIds.push(u!.id);
  return { id: u!.id, email, name: `${label} Tester` };
}

async function mkPerson(
  tenantId: string,
  label: string,
  role: Role,
  opts: { managerId?: string | null; noEmployee?: boolean; unlinkedUser?: boolean } = {},
): Promise<Person> {
  const u = await mkUser(label);
  let employeeId: string | null = null;
  if (!opts.noEmployee) {
    const [e] = await dbAdmin
      .insert(employees)
      .values({
        tenant_id: tenantId,
        user_id: opts.unlinkedUser ? null : u.id,
        employee_code: `RK-${rid()}`,
        first_name: label,
        last_name: 'Tester',
        work_email: u.email,
        date_of_joining: '2026-01-01',
        status: 'active',
        reporting_manager_id: opts.managerId ?? null,
      })
      .returning();
    employeeId = e!.id;
  }
  const [m] = await dbAdmin
    .insert(memberships)
    .values({ tenant_id: tenantId, user_id: u.id, role, status: 'active', employee_id: employeeId })
    .returning();
  return { userId: u.id, employeeId, membershipId: m!.id, email: u.email, name: u.name };
}

async function seedRegularization(
  p: Person,
  date: string,
  opts: { createdAt?: Date; proposedIn?: Date; proposedOut?: Date } = {},
) {
  const [r] = await dbAdmin
    .insert(attendanceRegularizations)
    .values({
      tenant_id: T1,
      employee_id: p.employeeId!,
      attendance_date: date,
      request_type: 'missing_punch',
      reason: 'Round K fixture — forgot to punch',
      status: 'pending',
      ...(opts.createdAt ? { created_at: opts.createdAt } : {}),
      proposed_in_time: opts.proposedIn ?? null,
      proposed_out_time: opts.proposedOut ?? null,
    })
    .returning();
  return r!.id;
}

const resetSpies = () => {
  createInAppNotification.mockClear();
  sendEmail.mockClear();
};
const inAppCalls = () => createInAppNotification.mock.calls as unknown as InAppCall[];
const mailCalls = () => sendEmail.mock.calls as unknown as MailCall[];

beforeAll(async () => {
  const [t] = await dbAdmin
    .insert(tenants)
    .values({ name: `RK main ${rid()}`, slug: `rk-${rid()}-${Date.now()}`, status: 'active', currency: 'INR', timezone: 'Asia/Kolkata' })
    .returning();
  T1 = t!.id;
  const [t2] = await dbAdmin
    .insert(tenants)
    .values({ name: `RK other ${rid()}`, slug: `rk2-${rid()}-${Date.now()}`, status: 'active', currency: 'INR' })
    .returning();
  T2 = t2!.id;

  O = await mkPerson(T1, 'Owner', 'owner');
  M = await mkPerson(T1, 'Mgr', 'manager', { managerId: O.employeeId });
  M2 = await mkPerson(T1, 'MgrTwo', 'manager', { managerId: O.employeeId });
  R1 = await mkPerson(T1, 'RepOne', 'employee', { managerId: M.employeeId });
  R2 = await mkPerson(T1, 'RepTwo', 'employee', { managerId: M.employeeId });
  R3 = await mkPerson(T1, 'RepThree', 'employee', { managerId: M.employeeId });
  R4 = await mkPerson(T1, 'RepFour', 'employee', { managerId: M.employeeId });
  R5 = await mkPerson(T1, 'RepFive', 'employee', { managerId: M.employeeId });
  R6 = await mkPerson(T1, 'RepSix', 'employee', { managerId: M.employeeId });
  R7 = await mkPerson(T1, 'RepSeven', 'employee', { managerId: M.employeeId });
  Rs = [R1, R2, R3, R4, R5, R6, R7];
  P = await mkPerson(T1, 'Peer', 'employee', { managerId: M2.employeeId });
  N = await mkPerson(T1, 'NoEmp', 'admin', { noEmployee: true });
  S = await mkPerson(T1, 'Unlinked', 'owner', { unlinkedUser: true });
  SU = S; // the same seat: user SU.userId ↔ employee S.employeeId via the membership only
  LU = await mkPerson(T1, 'Logout', 'employee', { noEmployee: true });
  Z = await mkPerson(T2, 'Zed', 'owner');
  foreignUserId = (await mkUser('Foreign')).id;
});

afterAll(async () => {
  for (const t of [T1, T2]) await dbAdmin.delete(tenants).where(eq(tenants.id, t));
  await dbAdmin.delete(authEvents).where(eq(authEvents.user_id, LU.userId));
  for (const u of userIds) await dbAdmin.delete(users).where(eq(users.id, u));
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
});

// ═════════════════════════════════════════════════════════════════════════════
// Fix C — regularization deep link
// ═════════════════════════════════════════════════════════════════════════════

describe('Round K — Fix C: the manager is sent to the request, not to their own log', () => {
  let r1Reg: string;
  let ownerReg: string;
  let sReg: string;
  let pReg: string;
  const r1Date = isoPlus(-2);
  const r2Date = isoPlus(-3);

  it('in-app link is /inbox?tab=approvals&request=<id> and the email carries reviewUrl on the same path', async () => {
    resetSpies();
    const res = await attendanceService.requestRegularization(R1.userId, T1, {
      attendanceDate: r1Date,
      requestType: 'missing_punch',
      reason: 'Forgot to punch in — client visit',
    });
    r1Reg = res.id;
    expect(res.status).toBe('pending');

    await waitFor(() => inAppCalls().some((c) => c[1] === 'regularization.requested'));
    const inApp = inAppCalls().find((c) => c[1] === 'regularization.requested')!;
    expect(inApp[0]).toBe(M.userId);
    expect(inApp[2]).toBe(`RepOne Tester requested a regularization for ${r1Date}.`);
    expect(inApp[3]).toBe(`/inbox?tab=approvals&request=${r1Reg}`);
    expect(inApp[3]).not.toContain('/team/attendance');
    expect(inApp[4]).toBe(T1);

    await waitFor(() => mailCalls().some((m) => m[0] === 'attendance-regularization-requested'));
    const mail = mailCalls().find((m) => m[0] === 'attendance-regularization-requested')!;
    expect(mail[1]).toBe(M.email);
    expect(mail[2].reviewUrl).toBe(`${APP_URL}/inbox?tab=approvals&request=${r1Reg}`);
    expect(mail[2].managerName).toBe('Mgr Tester');
    expect(mail[2].employeeName).toBe('RepOne Tester');
    expect(mail[2].attendanceDate).toBe(r1Date);
    expect(mail[2].requestType).toBe('missing_punch');
    expect(mail[2].reason).toBe('Forgot to punch in — client visit');
    // Exactly one reviewer: the reporting manager.
    await settle();
    expect(inAppCalls().filter((c) => c[1] === 'regularization.requested')).toHaveLength(1);
  });

  it('an owner without a reporting manager fans out to every OTHER owner/admin — same link, never themselves', async () => {
    resetSpies();
    const res = await attendanceService.requestRegularization(O.userId, T1, {
      attendanceDate: isoPlus(-5),
      requestType: 'wrong_time',
      reason: 'Owner forgot to punch out on time',
    });
    ownerReg = res.id;
    // Active owner/admin seats other than O: the admin without an employee
    // row (N) and the bridged owner seat (SU).
    await waitFor(() => inAppCalls().filter((c) => c[1] === 'regularization.requested').length >= 2);
    await settle();
    const pings = inAppCalls().filter((c) => c[1] === 'regularization.requested');
    expect(pings.map((c) => c[0]).sort()).toEqual([N.userId, SU.userId].sort());
    for (const c of pings) expect(c[3]).toBe(`/inbox?tab=approvals&request=${ownerReg}`);
    const mails = mailCalls().filter((m) => m[0] === 'attendance-regularization-requested');
    expect(mails.map((m) => m[1]).sort()).toEqual([N.email, SU.email].sort());
    for (const m of mails) expect(m[2].reviewUrl).toBe(`${APP_URL}/inbox?tab=approvals&request=${ownerReg}`);
    expect(pings.some((c) => c[0] === O.userId)).toBe(false);
    expect(pings.some((c) => c[0] === M.userId)).toBe(false);
  });

  it('a bridged applicant (employees.user_id NULL, seat linked only via the membership) is never asked to review their own request', async () => {
    resetSpies();
    const bridged = await seedRegularization(S, isoPlus(-6));
    await (attendanceService as unknown as {
      notifyManagerOfRegularization: (t: string, e: string, r: string) => Promise<void>;
    }).notifyManagerOfRegularization(T1, S.employeeId!, bridged);
    await settle();
    const pings = inAppCalls().filter((c) => c[1] === 'regularization.requested');
    // S has no reporting manager → owner/admin fan-out: O and N, never the applicant's own seat SU.
    expect(pings.map((c) => c[0]).sort()).toEqual([N.userId, O.userId].sort());
    expect(pings.some((c) => c[0] === SU.userId)).toBe(false);
    const mails = mailCalls().filter((m) => m[0] === 'attendance-regularization-requested');
    expect(mails.some((m) => m[1] === SU.email)).toBe(false);
    for (const c of pings) expect(c[3]).toBe(`/inbox?tab=approvals&request=${bridged}`);
    await dbAdmin.delete(attendanceRegularizations).where(eq(attendanceRegularizations.id, bridged));
  });

  it('a bridged MANAGER (employee row with user_id NULL) still gets the in-app ping through the membership', async () => {
    resetSpies();
    // R7 temporarily reports to the unlinked employee row S, whose seat is SU.
    await dbAdmin.update(employees).set({ reporting_manager_id: S.employeeId! }).where(eq(employees.id, R7.employeeId!));
    const reg = await seedRegularization(R7, isoPlus(-7));
    try {
      await (attendanceService as unknown as {
        notifyManagerOfRegularization: (t: string, e: string, r: string) => Promise<void>;
      }).notifyManagerOfRegularization(T1, R7.employeeId!, reg);
      await settle();
      const pings = inAppCalls().filter((c) => c[1] === 'regularization.requested');
      expect(pings.map((c) => c[0])).toEqual([SU.userId]);
      expect(pings[0]![3]).toBe(`/inbox?tab=approvals&request=${reg}`);
    } finally {
      await dbAdmin.update(employees).set({ reporting_manager_id: M.employeeId! }).where(eq(employees.id, R7.employeeId!));
      await dbAdmin.delete(attendanceRegularizations).where(eq(attendanceRegularizations.id, reg));
    }
  });

  it('requested template: escaped reviewUrl href, a <script> reason escaped, the "nothing changes" line; fallback href without reviewUrl', () => {
    const reviewUrl = `${APP_URL}/inbox?tab=approvals&request=abc-123`;
    const out = renderTemplate('attendance-regularization-requested', {
      managerName: 'Jagan <b>S</b>',
      employeeName: '<img src=x onerror=alert(1)>',
      attendanceDate: '2026-09-01',
      requestType: 'missing_punch',
      reason: '<script>alert("x")</script> & more',
      reviewUrl,
    });
    // Hrefs are escaped (& → &amp;) — the mail client decodes them back.
    expect(out.html).toContain(`href="${APP_URL}/inbox?tab=approvals&amp;request=abc-123"`);
    expect(out.html).toContain('>Review request</a>');
    expect(out.html).not.toContain('<script>');
    expect(out.html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; more');
    expect(out.html).not.toContain('<img');
    expect(out.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(out.html).not.toContain('<b>S</b>');
    expect(out.html).toContain('Jagan &lt;b&gt;S&lt;/b&gt;');
    expect(out.html).toContain('Nothing changes until you confirm in the app.');
    expect(out.html).not.toContain('/team/attendance');
    expect(out.subject).toContain('2026-09-01');

    const fallback = renderTemplate('attendance-regularization-requested', {
      managerName: 'M',
      employeeName: 'E',
      attendanceDate: '2026-09-01',
    });
    expect(fallback.html).toContain(`href="${APP_URL}/inbox?tab=approvals"`);
    expect(fallback.html).toContain('>Review request</a>');
    expect(fallback.html).not.toContain('Reason:');
  });

  it('approved / rejected templates carry "Open attendance" → escaped attendanceUrl and escape name + comment', () => {
    for (const tpl of ['attendance-regularization-approved', 'attendance-regularization-rejected'] as const) {
      const out = renderTemplate(tpl, {
        employeeName: '<i>Rep</i>',
        attendanceDate: '2026-09-01',
        comment: 'see <script>alert(1)</script>',
        attendanceUrl: `${APP_URL}/attendance?date=2026-09-01&view=me`,
      });
      expect(out.html).toContain('>Open attendance</a>');
      expect(out.html).toContain(`href="${APP_URL}/attendance?date=2026-09-01&amp;view=me"`);
      expect(out.html).not.toContain('<i>Rep</i>');
      expect(out.html).toContain('&lt;i&gt;Rep&lt;/i&gt;');
      expect(out.html).not.toContain('<script>');
      expect(out.html).toContain('Comment: see &lt;script&gt;alert(1)&lt;/script&gt;');
      expect(out.subject).toContain(tpl.endsWith('approved') ? 'approved' : 'rejected');

      const plain = renderTemplate(tpl, { employeeName: 'Rep', attendanceDate: '2026-09-01' });
      expect(plain.html).not.toContain('Open attendance');
      expect(plain.html).not.toContain('Comment:');
    }
  });

  it('decision notices deep-link the requester to /attendance?date=<day> (in-app) with attendanceUrl in the email — approve and reject', async () => {
    resetSpies();
    const ok = await attendanceService.reviewRegularization(r1Reg, M.userId, T1, { action: 'approve', comment: 'Fine' }, 'manager');
    expect(ok.status).toBe('approved');
    await waitFor(() => inAppCalls().some((c) => c[1] === 'regularization.approved'));
    const approvedPing = inAppCalls().find((c) => c[1] === 'regularization.approved')!;
    expect(approvedPing[0]).toBe(R1.userId);
    expect(approvedPing[2]).toBe(`Your regularization for ${r1Date} was approved.`);
    expect(approvedPing[3]).toBe(`/attendance?date=${r1Date}`);
    expect(approvedPing[4]).toBe(T1);
    await waitFor(() => mailCalls().some((m) => m[0] === 'attendance-regularization-approved'));
    const approvedMail = mailCalls().find((m) => m[0] === 'attendance-regularization-approved')!;
    expect(approvedMail[1]).toBe(R1.email);
    expect(approvedMail[2].attendanceUrl).toBe(`${APP_URL}/attendance?date=${r1Date}`);
    expect(approvedMail[2].attendanceDate).toBe(r1Date);
    expect(approvedMail[2].employeeName).toBe('RepOne Tester');
    expect(approvedMail[2].comment).toBe('Fine');

    // Reject path — R2 files, M declines.
    resetSpies();
    const r2 = await attendanceService.requestRegularization(R2.userId, T1, {
      attendanceDate: r2Date,
      requestType: 'wrong_time',
      reason: 'Punched out late by mistake',
    });
    await waitFor(() => inAppCalls().some((c) => c[1] === 'regularization.requested'));
    resetSpies();
    const no = await attendanceService.reviewRegularization(r2.id, M.userId, T1, { action: 'reject', comment: 'No' }, 'manager');
    expect(no.status).toBe('rejected');
    await waitFor(() => inAppCalls().some((c) => c[1] === 'regularization.rejected'));
    const rejectedPing = inAppCalls().find((c) => c[1] === 'regularization.rejected')!;
    expect(rejectedPing[0]).toBe(R2.userId);
    expect(rejectedPing[2]).toBe(`Your regularization for ${r2Date} was declined.`);
    expect(rejectedPing[3]).toBe(`/attendance?date=${r2Date}`);
    await waitFor(() => mailCalls().some((m) => m[0] === 'attendance-regularization-rejected'));
    const rejectedMail = mailCalls().find((m) => m[0] === 'attendance-regularization-rejected')!;
    expect(rejectedMail[1]).toBe(R2.email);
    expect(rejectedMail[2].attendanceUrl).toBe(`${APP_URL}/attendance?date=${r2Date}`);
    expect(rejectedMail[2].comment).toBe('No');
  });

  it('self-approval is blocked even when employees.user_id is NULL — the membership bridge resolves the applicant', async () => {
    sReg = await seedRegularization(S, isoPlus(-4));
    const [emp] = await dbAdmin.select({ userId: employees.user_id }).from(employees).where(eq(employees.id, S.employeeId!));
    expect(emp!.userId).toBeNull(); // the fixture really is unlinked
    await expect(
      attendanceService.reviewRegularization(sReg, SU.userId, T1, { action: 'approve' }, 'owner'),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      attendanceService.reviewRegularization(sReg, SU.userId, T1, { action: 'approve' }, 'owner'),
    ).rejects.toThrow(/cannot approve your own regularization/);
    // Rejecting is a review too.
    await expect(
      attendanceService.reviewRegularization(sReg, SU.userId, T1, { action: 'reject', comment: 'x' }),
    ).rejects.toThrow(ForbiddenException);
    const [row] = await dbAdmin.select().from(attendanceRegularizations).where(eq(attendanceRegularizations.id, sReg));
    expect(row!.status).toBe('pending');
    expect(row!.approver_id).toBeNull();
    expect(row!.reviewed_at).toBeNull();
  });

  it('getAdminOverview: pendingLimit 50 lists all 7 pending regularizations of the team, the default stays 5 — same counts, scope and ordering', async () => {
    // One pending request per report with distinct created_at so newest-first is deterministic.
    const now = Date.now();
    const inTime = new Date(`${isoPlus(-10)}T03:30:00.000Z`);
    const outTime = new Date(`${isoPlus(-10)}T12:30:00.000Z`);
    const ids: string[] = [];
    for (let i = 0; i < Rs.length; i++) {
      ids.push(
        await seedRegularization(Rs[i]!, isoPlus(-10 - i), {
          createdAt: new Date(now - (Rs.length - i) * 60_000),
          ...(i === 0 ? { proposedIn: inTime, proposedOut: outTime } : {}),
        }),
      );
    }
    // A pending request outside M's team (M2's report) — visible to the owner only.
    pReg = await seedRegularization(P, isoPlus(-20), { createdAt: new Date(now - 30 * 60_000) });
    const newestFirst = [...ids].reverse();

    const base = { callerUserId: M.userId, includeOnboarding: false, includeApprovals: true, scope: 'team' as const };
    const ov50 = await dashboardService.getAdminOverview(T1, { ...base, pendingLimit: 50 });
    expect(ov50.scope).toBe('team');
    expect(ov50.pending.regularizationCount).toBe(7);
    expect(ov50.pending.regularizations.map((r) => r.id)).toEqual(newestFirst);
    expect(ov50.pending.regularizations.every((r) => Rs.some((p) => p.employeeId === r.employeeId))).toBe(true);
    // Round K rows carry the proposed times (ISO instants) for the Inbox detail.
    const withTimes = ov50.pending.regularizations.find((r) => r.id === ids[0])!;
    expect(withTimes.proposedInTime).toBe(inTime.toISOString());
    expect(withTimes.proposedOutTime).toBe(outTime.toISOString());
    expect(ov50.pending.regularizations.find((r) => r.id === ids[1])!.proposedInTime).toBeNull();

    const ov5 = await dashboardService.getAdminOverview(T1, base);
    expect(ov5.pending.regularizationCount).toBe(7);
    expect(ov5.pending.regularizations).toHaveLength(5);
    expect(ov5.pending.regularizations.map((r) => r.id)).toEqual(newestFirst.slice(0, 5));
    expect(ov5.stats.pendingApprovals).toBe(ov50.stats.pendingApprovals);

    // Clamp: 0 → 1 row, 5000 → 50 (still all 7).
    const ov1 = await dashboardService.getAdminOverview(T1, { ...base, pendingLimit: 0 });
    expect(ov1.pending.regularizations.map((r) => r.id)).toEqual([newestFirst[0]]);
    expect(ov1.pending.regularizationCount).toBe(7);
    const ovBig = await dashboardService.getAdminOverview(T1, { ...base, pendingLimit: 5000 });
    expect(ovBig.pending.regularizations).toHaveLength(7);
    const ovNaN = await dashboardService.getAdminOverview(T1, { ...base, pendingLimit: Number.NaN });
    expect(ovNaN.pending.regularizations).toHaveLength(5);

    // Scope + own-request exclusion untouched by the limit: the team list never
    // shows M2's report or the bridged owner. Round L (founder item 2): the
    // owner's Inbox is ROUTED — M's and M2's reports sit with their managers
    // (level 0) and are not the owner's until escalated; the bridged S has no
    // manager at all, so it is HR's from the start; never the owner's own.
    const teamIds = ov50.pending.regularizations.map((r) => r.id);
    expect(teamIds).not.toContain(pReg);
    expect(teamIds).not.toContain(sReg);
    expect(teamIds).not.toContain(ownerReg);
    const ovOrg = await dashboardService.getAdminOverview(T1, {
      callerUserId: O.userId, includeOnboarding: false, includeApprovals: true, pendingLimit: 50,
    });
    expect(ovOrg.scope).toBe('org');
    const orgIds = ovOrg.pending.regularizations.map((r) => r.id);
    expect(orgIds).toEqual([sReg]);
    for (const id of [...ids, pReg, ownerReg]) expect(orgIds).not.toContain(id);
    expect(ovOrg.pending.regularizationCount).toBe(1);
    expect(ovOrg.pending.regularizations[0]!.escalation).toBeNull();
    const ovOrg5 = await dashboardService.getAdminOverview(T1, {
      callerUserId: O.userId, includeOnboarding: false, includeApprovals: true,
    });
    expect(ovOrg5.pending.regularizationCount).toBe(1);
    expect(ovOrg5.pending.regularizations.map((r) => r.id)).toEqual(orgIds.slice(0, 5));
  });

  it('the bridged request is still reviewable by ANOTHER owner — the guard is about identity, not role', async () => {
    resetSpies();
    const ok = await attendanceService.reviewRegularization(sReg, O.userId, T1, { action: 'approve' }, 'owner');
    expect(ok.status).toBe('approved');
    const [row] = await dbAdmin.select().from(attendanceRegularizations).where(eq(attendanceRegularizations.id, sReg));
    expect(row!.approver_id).toBe(O.employeeId);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Fix B — self-service Edit profile
// ═════════════════════════════════════════════════════════════════════════════

describe('Round K — Fix B: PUT /employees/me writes contact details only', () => {
  it('persists a trimmed personal phone and a lower-cased personal email — and never touches users.phone', async () => {
    await dbAdmin.update(users).set({ phone: '+91 00000 00000' }).where(eq(users.id, R1.userId));
    const res = await employeesService.selfUpdateEmployee(
      R1.userId,
      { personalPhone: '  +91 98765 43210 ', personalEmail: '  RepOne.Home@Example.COM ' },
      T1,
    );
    expect(res.id).toBe(R1.employeeId);
    expect(res.personalPhone).toBe('+91 98765 43210');
    expect(res.personalEmail).toBe('repone.home@example.com');
    const [row] = await dbAdmin
      .select({ phone: employees.personal_phone, email: employees.personal_email, first: employees.first_name, work: employees.work_email })
      .from(employees)
      .where(eq(employees.id, R1.employeeId!));
    expect(row).toEqual({ phone: '+91 98765 43210', email: 'repone.home@example.com', first: 'RepOne', work: R1.email });
    const [u] = await dbAdmin.select({ phone: users.phone }).from(users).where(eq(users.id, R1.userId));
    expect(u!.phone).toBe('+91 00000 00000');
  });

  it("'' (or whitespace) clears a value; an omitted key leaves it alone", async () => {
    const cleared = await employeesService.selfUpdateEmployee(R1.userId, { personalEmail: '   ' }, T1);
    expect(cleared.personalEmail).toBeNull();
    expect(cleared.personalPhone).toBe('+91 98765 43210');
    const again = await employeesService.selfUpdateEmployee(R1.userId, { personalPhone: '' }, T1);
    expect(again.personalPhone).toBeNull();
    expect(again.personalEmail).toBeNull();
    const [row] = await dbAdmin
      .select({ phone: employees.personal_phone, email: employees.personal_email })
      .from(employees)
      .where(eq(employees.id, R1.employeeId!));
    expect(row).toEqual({ phone: null, email: null });
    // Restore for the redaction pins below.
    const back = await employeesService.selfUpdateEmployee(
      R1.userId,
      { personalPhone: '+91 98765 43210', personalEmail: 'repone.home@example.com' },
      T1,
    );
    expect(back.personalPhone).toBe('+91 98765 43210');
    const [u] = await dbAdmin.select({ phone: users.phone }).from(users).where(eq(users.id, R1.userId));
    expect(u!.phone).toBe('+91 00000 00000');
  });

  it('address: merged over the saved JSON across two calls (country + unknown keys kept); a fresh address defaults to IN; null = unchanged', async () => {
    await dbAdmin
      .update(employees)
      .set({ current_address: { line1: 'Old line', city: 'Dubai', country: 'AE', landmark: 'Near the park' } })
      .where(eq(employees.id, R1.employeeId!));

    const first = await employeesService.selfUpdateEmployee(
      R1.userId,
      { currentAddress: { line1: '  12 MG Road ', city: 'Bengaluru' } },
      T1,
    );
    expect(first.currentAddress).toEqual({
      line1: '12 MG Road', line2: null, city: 'Bengaluru', state: null, postal_code: null, country: 'AE', landmark: 'Near the park',
    });

    const second = await employeesService.selfUpdateEmployee(
      R1.userId,
      { currentAddress: { stateCode: ' Karnataka ', postalCode: '560038' } },
      T1,
    );
    expect(second.currentAddress).toEqual({
      line1: '12 MG Road', line2: null, city: 'Bengaluru', state: 'Karnataka', postal_code: '560038', country: 'AE', landmark: 'Near the park',
    });

    // '' clears one key, the rest survives.
    const third = await employeesService.selfUpdateEmployee(R1.userId, { currentAddress: { city: '' } }, T1);
    expect(third.currentAddress).toEqual({
      line1: '12 MG Road', line2: null, city: null, state: 'Karnataka', postal_code: '560038', country: 'AE', landmark: 'Near the park',
    });
    const [row] = await dbAdmin.select({ a: employees.current_address }).from(employees).where(eq(employees.id, R1.employeeId!));
    expect(row!.a).toEqual(third.currentAddress);

    // No prior address → country IN.
    const fresh = await employeesService.selfUpdateEmployee(
      R2.userId,
      { currentAddress: { line1: '4 Park Street', city: 'Kolkata' } },
      T1,
    );
    expect(fresh.currentAddress).toEqual({ line1: '4 Park Street', line2: null, city: 'Kolkata', state: null, postal_code: null, country: 'IN' });

    // null is "unchanged", not "clear".
    const nulled = await employeesService.selfUpdateEmployee(R2.userId, { currentAddress: null }, T1);
    expect(nulled.currentAddress).toEqual(fresh.currentAddress);

    // Blanking every line reads back as "no address" (—), never a country-only blob rendering as "IN".
    const blanked = await employeesService.selfUpdateEmployee(
      R2.userId,
      { currentAddress: { line1: '', line2: '', city: '', stateCode: '', postalCode: '' } },
      T1,
    );
    expect(blanked.currentAddress).toBeNull();
    const [blankRow] = await dbAdmin.select({ a: employees.current_address }).from(employees).where(eq(employees.id, R2.employeeId!));
    expect(blankRow!.a).toBeNull();
  });

  it('emergency contact: insert as primary → same-row update (email lower-cased / cleared) → null deletes; null with nothing there is a no-op', async () => {
    const ins = await employeesService.selfUpdateEmployee(
      R2.userId,
      { emergencyContact: { name: '  Anita Sharma ', relationship: ' Spouse ', phone: ' +91 99999 11111 ', email: ' ANITA@Example.com ' } },
      T1,
    );
    expect(ins.emergencyContacts).toHaveLength(1);
    const c = ins.emergencyContacts[0]!;
    expect(c).toMatchObject({ name: 'Anita Sharma', relationship: 'Spouse', phone: '+91 99999 11111', email: 'anita@example.com', isPrimary: true });

    const upd = await employeesService.selfUpdateEmployee(
      R2.userId,
      { emergencyContact: { name: 'Anita S', relationship: 'Spouse', phone: '+91 99999 22222' } },
      T1,
    );
    expect(upd.emergencyContacts).toHaveLength(1);
    expect(upd.emergencyContacts[0]).toMatchObject({ id: c.id, name: 'Anita S', phone: '+91 99999 22222', email: null, isPrimary: true });
    const rows = await dbAdmin.select().from(emergencyContacts).where(eq(emergencyContacts.employee_id, R2.employeeId!));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tenant_id).toBe(T1);

    // A blank name after trim is refused and nothing changes.
    await expect(
      employeesService.selfUpdateEmployee(R2.userId, { emergencyContact: { name: '   ', relationship: 'Spouse', phone: '+91 99999 33333' } }, T1),
    ).rejects.toThrow(BadRequestException);
    const [still] = await dbAdmin.select().from(emergencyContacts).where(eq(emergencyContacts.employee_id, R2.employeeId!));
    expect(still!.phone).toBe('+91 99999 22222');

    const del = await employeesService.selfUpdateEmployee(R2.userId, { emergencyContact: null }, T1);
    expect(del.emergencyContacts).toEqual([]);
    expect(await dbAdmin.select().from(emergencyContacts).where(eq(emergencyContacts.employee_id, R2.employeeId!))).toHaveLength(0);
    const again = await employeesService.selfUpdateEmployee(R2.userId, { emergencyContact: null }, T1);
    expect(again.emergencyContacts).toEqual([]);
  });

  it('two pre-existing primaries: the OLDEST (created_at ASC) is the one read first, updated and deleted — the newer one survives', async () => {
    const [older] = await dbAdmin
      .insert(emergencyContacts)
      .values({ tenant_id: T1, employee_id: R3.employeeId!, name: 'Older Primary', relationship: 'Parent', phone: '+91 11111 11111', is_primary: true, created_at: new Date('2026-01-01T00:00:00Z') })
      .returning();
    const [newer] = await dbAdmin
      .insert(emergencyContacts)
      .values({ tenant_id: T1, employee_id: R3.employeeId!, name: 'Newer Primary', relationship: 'Sibling', phone: '+91 22222 22222', is_primary: true, created_at: new Date('2026-02-01T00:00:00Z') })
      .returning();
    const [nonPrimary] = await dbAdmin
      .insert(emergencyContacts)
      .values({ tenant_id: T1, employee_id: R3.employeeId!, name: 'Not Primary', relationship: 'Friend', phone: '+91 00000 11111', is_primary: false, created_at: new Date('2025-12-01T00:00:00Z') })
      .returning();

    // Read order: primaries first, oldest first within them.
    const read = await employeesService.getEmployee(R3.employeeId!, T1);
    expect(read.emergencyContacts.map((x) => x.id)).toEqual([older!.id, newer!.id, nonPrimary!.id]);

    const upd = await employeesService.selfUpdateEmployee(
      R3.userId,
      { emergencyContact: { name: 'Updated Primary', relationship: 'Parent', phone: '+91 33333 33333' } },
      T1,
    );
    expect(upd.emergencyContacts.map((x) => x.id)).toEqual([older!.id, newer!.id, nonPrimary!.id]);
    expect(upd.emergencyContacts[0]).toMatchObject({ id: older!.id, name: 'Updated Primary', phone: '+91 33333 33333', isPrimary: true });
    const [newerRow] = await dbAdmin.select().from(emergencyContacts).where(eq(emergencyContacts.id, newer!.id));
    expect(newerRow!.name).toBe('Newer Primary');
    expect(await dbAdmin.select().from(emergencyContacts).where(eq(emergencyContacts.employee_id, R3.employeeId!))).toHaveLength(3);

    const del = await employeesService.selfUpdateEmployee(R3.userId, { emergencyContact: null }, T1);
    expect(del.emergencyContacts.map((x) => x.id)).toEqual([newer!.id, nonPrimary!.id]);
    expect(await dbAdmin.select().from(emergencyContacts).where(eq(emergencyContacts.id, older!.id))).toHaveLength(0);
  });

  it('a seat with no employee row → 404 with the HR message; a caller from another tenant → 404 (both directions); nothing written', async () => {
    await expect(
      employeesService.selfUpdateEmployee(N.userId, { personalPhone: '+91 12345 67890' }, T1),
    ).rejects.toThrow('No employee record is linked to your seat — ask HR');
    await expect(
      employeesService.selfUpdateEmployee(N.userId, { personalPhone: '+91 12345 67890' }, T1),
    ).rejects.toThrow(NotFoundException);
    // T2's owner has no seat in T1; R1 has none in T2.
    await expect(
      employeesService.selfUpdateEmployee(Z.userId, { personalPhone: '+91 55555 55555' }, T1),
    ).rejects.toThrow(NotFoundException);
    await expect(
      employeesService.selfUpdateEmployee(R1.userId, { personalPhone: '+91 55555 55555' }, T2),
    ).rejects.toThrow(NotFoundException);
    const [row] = await dbAdmin.select({ phone: employees.personal_phone }).from(employees).where(eq(employees.id, R1.employeeId!));
    expect(row!.phone).toBe('+91 98765 43210');
    const [z] = await dbAdmin.select({ phone: employees.personal_phone }).from(employees).where(eq(employees.id, Z.employeeId!));
    expect(z!.phone).toBeNull();
  });

  it("RLS: the app role under T2 sees none of T1's emergency contacts", async () => {
    const t1 = await dbSvc.withTenant(T1, (tx) => tx.select({ id: emergencyContacts.id }).from(emergencyContacts), O.userId);
    expect(t1.length).toBeGreaterThanOrEqual(2);
    const t2 = await dbSvc.withTenant(T2, (tx) => tx.select({ id: emergencyContacts.id }).from(emergencyContacts), Z.userId);
    expect(t2).toHaveLength(0);
  });

  it('audit: employee.self_updated names the sections changed and carries no values; an empty body writes no row', async () => {
    const auditRows = () =>
      dbAdmin
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.tenant_id, T1), eq(auditLog.action, 'employee.self_updated'), eq(auditLog.resource_id, R4.employeeId!)));
    expect(await auditRows()).toHaveLength(0);

    await employeesService.selfUpdateEmployee(
      R4.userId,
      {
        personalPhone: '+91 77777 77777',
        personalEmail: 'RepFour.Home@example.com',
        currentAddress: { line1: '9 Secret Lane' },
        emergencyContact: { name: 'Secret Contact', relationship: 'Friend', phone: '+91 88888 88888' },
      },
      T1,
    );
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_user_id).toBe(R4.userId);
    expect(rows[0]!.resource_type).toBe('employee');
    expect(rows[0]!.metadata).toEqual({ fields: ['personalPhone', 'personalEmail', 'currentAddress', 'emergencyContact'] });
    expect(rows[0]!.before_state).toBeNull();
    expect(rows[0]!.after_state).toBeNull();
    const dump = JSON.stringify(rows[0]);
    for (const pii of ['77777', 'repfour.home', 'RepFour.Home', 'Secret Lane', 'Secret Contact', '88888']) expect(dump).not.toContain(pii);

    // A partial body names only what it touched.
    await employeesService.selfUpdateEmployee(R4.userId, { personalPhone: '' }, T1);
    const two = await auditRows();
    expect(two).toHaveLength(2);
    expect(two.map((r) => (r.metadata as { fields: string[] }).fields)).toEqual(
      expect.arrayContaining([['personalPhone']]),
    );

    // Nothing to change → nothing to audit.
    await employeesService.selfUpdateEmployee(R4.userId, {}, T1);
    await employeesService.selfUpdateEmployee(R4.userId, { currentAddress: null }, T1);
    expect(await auditRows()).toHaveLength(2);
  });

  it('the global ValidationPipe keeps nested currentAddress intact, accepts null, and refuses HR-managed / malformed bodies', async () => {
    const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true, transformOptions: { enableImplicitConversion: true } });
    const meta = { type: 'body' as const, metatype: SelfUpdateEmployeeDto };

    const ok = (await pipe.transform(
      {
        personalPhone: '+91 98765 43210',
        personalEmail: 'me@example.com',
        currentAddress: { line1: '12 MG Road', city: 'Bengaluru', stateCode: 'Karnataka', postalCode: '560038' },
        emergencyContact: { name: 'A', relationship: 'Spouse', phone: '+91 99999 11111', email: 'a@example.com' },
      },
      meta,
    )) as SelfUpdateEmployeeDto;
    expect(Array.isArray(ok.currentAddress)).toBe(false);
    expect(ok.currentAddress).toMatchObject({ line1: '12 MG Road', city: 'Bengaluru', stateCode: 'Karnataka', postalCode: '560038' });
    expect(ok.emergencyContact).toMatchObject({ name: 'A', relationship: 'Spouse', phone: '+91 99999 11111', email: 'a@example.com' });
    expect(ok.personalPhone).toBe('+91 98765 43210');

    const bad: Array<Record<string, unknown>> = [
      { firstName: 'Hacker' },
      { workEmail: 'x@y.test' },
      { designationId: crypto.randomUUID() },
      { currentAddress: [] },
      { currentAddress: { foo: 1 } },
      { currentAddress: {} },
      { currentAddress: { line1: 'ok', foo: 'bar' } },
      { personalEmail: 'nope' },
      { personalPhone: 12345 },
      { personalPhone: 'call me maybe' },
      { emergencyContact: [] },
      { emergencyContact: { name: 'A', relationship: 'Spouse' } },
      { emergencyContact: { name: 'A', relationship: 'Spouse', phone: '+91 99999 11111', email: 'bad' } },
      { emergencyContact: { name: 'A', relationship: 'Spouse', phone: '+91 99999 11111', extra: 1 } },
    ];
    for (const body of bad) {
      await expect(pipe.transform(body, meta)).rejects.toThrow(BadRequestException);
    }

    const nulls = (await pipe.transform(
      { currentAddress: null, emergencyContact: null, personalPhone: '', personalEmail: '' },
      meta,
    )) as SelfUpdateEmployeeDto;
    expect(nulls.currentAddress).toBeNull();
    expect(nulls.emergencyContact).toBeNull();
    expect(nulls.personalPhone).toBe('');
    expect(nulls.personalEmail).toBe('');
    const empty = (await pipe.transform({}, meta)) as SelfUpdateEmployeeDto;
    expect(empty.currentAddress).toBeUndefined();
    expect(empty.emergencyContact).toBeUndefined();
  });

  it('GET /employees/:id redaction: a peer gets the personal block nulled + no emergency contacts; direct manager, owner and self see it; input never mutated', async () => {
    await employeesService.selfUpdateEmployee(
      R1.userId,
      { emergencyContact: { name: 'Priya Contact', relationship: 'Sibling', phone: '+91 44444 44444' } },
      T1,
    );
    await dbAdmin
      .update(employees)
      .set({ date_of_birth: '1990-05-05', bank_name: 'HDFC', aadhaar_last4: '1234', pf_uan: '100200300400', blood_group: 'O+' })
      .where(eq(employees.id, R1.employeeId!));
    const record = await employeesService.getEmployee(R1.employeeId!, T1);
    expect(record.personalPhone).toBe('+91 98765 43210');
    expect(record.personalEmail).toBe('repone.home@example.com');
    expect(record.currentAddress).not.toBeNull();
    expect(record.emergencyContacts).toHaveLength(1);
    expect(record.bankName).toBe('HDFC');
    expect(record.hasPan).toBe(false);

    const viewer = async (p: Person, role: string) => ({
      employeeId: await employeesService.getEmployeeIdForUserOrNull(p.userId, T1),
      role,
    });
    const PERSONAL = [
      'personalEmail', 'personalPhone', 'currentAddress', 'permanentAddress', 'dateOfBirth', 'maritalStatus', 'bloodGroup',
      'aadhaarLast4', 'hasPan', 'hasPassport', 'bankName', 'bankBranch', 'bankIfsc', 'bankAccountType', 'bankAccountHolder',
      'hasBankAccount', 'pfUan', 'esicNumber',
    ];

    const peer = redactForViewer(record, await viewer(P, 'employee'));
    expect(peer).not.toBe(record);
    const peerDump = peer as unknown as Record<string, unknown>;
    for (const f of PERSONAL) expect({ f, v: peerDump[f] }).toEqual({ f, v: null });
    expect(peer.emergencyContacts).toEqual([]);
    // Attendance + leave numbers follow the same rule as GET /attendance/employee/:id (refused for a peer).
    expect(peer.thisMonth).toBeNull();
    expect(peer.leaveBalances).toEqual([]);
    for (const f of ['gender', 'nationality', 'customFields']) expect({ f, v: peerDump[f] }).toEqual({ f, v: null });
    expect(record.thisMonth).toBeTruthy();
    // Identity + org data survive for the org chart / directory.
    expect(peer).toMatchObject({
      id: R1.employeeId, firstName: 'RepOne', lastName: 'Tester', workEmail: R1.email, employeeCode: record.employeeCode,
      reportingManagerId: M.employeeId, reportingManagerName: 'Mgr Tester', status: 'active',
    });
    // Pure: the original record is untouched.
    expect(record.personalPhone).toBe('+91 98765 43210');
    expect(record.emergencyContacts).toHaveLength(1);
    expect(record.bankName).toBe('HDFC');

    // A teammate (same manager) and a manager who does NOT manage R1 are peers too.
    expect(redactForViewer(record, await viewer(R2, 'employee')).personalPhone).toBeNull();
    expect(redactForViewer(record, await viewer(M2, 'manager')).personalPhone).toBeNull();
    // Allowed viewers get the very same object.
    expect(redactForViewer(record, await viewer(M, 'manager'))).toBe(record);
    expect(redactForViewer(record, await viewer(O, 'owner'))).toBe(record);
    expect(redactForViewer(record, await viewer(R1, 'employee'))).toBe(record);
    for (const role of ['admin', 'finance', 'fam']) {
      expect({ role, ok: canViewPersonalBlock(record, { employeeId: null, role }) }).toEqual({ role, ok: true });
    }
    // A seat without an employee row / a foreign user resolves to null → peer.
    expect(await employeesService.getEmployeeIdForUserOrNull(N.userId, T1)).toBeNull();
    expect(await employeesService.getEmployeeIdForUserOrNull(Z.userId, T1)).toBeNull();
    expect(await employeesService.getEmployeeIdForUserOrNull(foreignUserId, T1)).toBeNull();
    expect(canViewPersonalBlock(record, { employeeId: null, role: 'employee' })).toBe(false);
    expect(canViewPersonalBlock(record, { employeeId: null, role: 'manager' })).toBe(false);
    expect(canViewPersonalBlock(record, { employeeId: null, role: undefined })).toBe(false);
    // The manager rule needs the manager ROLE, not just the reporting line.
    expect(canViewPersonalBlock(record, { employeeId: M.employeeId, role: 'employee' })).toBe(false);
  });
});

describe('Round K — Fix B: sign out other devices + real last sign-in', () => {
  const tokens: Record<string, string> = {};
  const future = () => new Date(Date.now() + 7 * 86_400_000);
  const seed = async (label: string, deviceId: string | null, opts: { expiresAt?: Date; revokedAt?: Date | null; userId?: string } = {}) => {
    const t = `rk-${label}-${rid()}`;
    tokens[label] = t;
    await dbAdmin.insert(refreshTokens).values({
      user_id: opts.userId ?? LU.userId,
      token_hash: sha256(t),
      device_id: deviceId,
      expires_at: opts.expiresAt ?? future(),
      revoked_at: opts.revokedAt ?? null,
    });
    return t;
  };
  const rowsFor = async (userId: string) => {
    const rows = await dbAdmin
      .select({ hash: refreshTokens.token_hash, deviceId: refreshTokens.device_id, revokedAt: refreshTokens.revoked_at })
      .from(refreshTokens)
      .where(eq(refreshTokens.user_id, userId));
    return Object.fromEntries(rows.map((r) => [r.hash, r]));
  };
  const revokedAt = async (label: string, userId = LU.userId) => (await rowsFor(userId))[sha256(tokens[label]!)]!.revokedAt;

  it('keeps the current device and the cookie-matched NULL-device row, revokes every other LIVE token, counts distinct devices, writes the auth event', async () => {
    await seed('current', 'dev-current');
    await seed('cookie', null);
    await seed('otherA1', 'dev-other-a');
    await seed('otherA2', 'dev-other-a');
    await seed('otherB', 'dev-other-b');
    await seed('noDevice', null);
    await seed('expired', 'dev-expired', { expiresAt: new Date(Date.now() - 86_400_000) });
    await seed('revoked', 'dev-revoked', { revokedAt: new Date(Date.now() - 3_600_000) });
    await seed('foreign', 'dev-foreign', { userId: foreignUserId });

    const res = await authService.logoutOthers(LU.userId, 'dev-current', tokens.cookie);
    // dev-other-a (two rows, one device), dev-other-b, and the NULL bucket.
    expect(res).toEqual({ revokedDevices: 3 });

    expect(await revokedAt('current')).toBeNull();
    expect(await revokedAt('cookie')).toBeNull();
    for (const l of ['otherA1', 'otherA2', 'otherB', 'noDevice']) expect({ l, gone: (await revokedAt(l)) !== null }).toEqual({ l, gone: true });
    expect(await revokedAt('expired')).toBeNull(); // not live → not touched, not counted
    expect(await revokedAt('foreign', foreignUserId)).toBeNull(); // someone else's session
    const [old] = await dbAdmin.select({ r: refreshTokens.revoked_at }).from(refreshTokens).where(eq(refreshTokens.token_hash, sha256(tokens.revoked!)));
    expect(old!.r!.getTime()).toBeLessThan(Date.now() - 3_000_000); // pre-existing revocation kept

    const events = await dbAdmin
      .select()
      .from(authEvents)
      .where(and(eq(authEvents.user_id, LU.userId), eq(authEvents.event_type, 'logout')));
    expect(events).toHaveLength(1);
    expect(events[0]!.device_id).toBe('dev-current');
    expect(events[0]!.metadata).toEqual({ other_devices: true, revokedDevices: 3 });
  });

  it('with no identifier at all → 400 and nothing revoked; with only a device id the NULL-device row is no longer protected; idempotent afterwards', async () => {
    await expect(authService.logoutOthers(LU.userId)).rejects.toThrow(BadRequestException);
    await expect(authService.logoutOthers(LU.userId, '   ', '')).rejects.toThrow(/Could not identify this device/);
    expect(await revokedAt('current')).toBeNull();
    expect(await revokedAt('cookie')).toBeNull();

    const byDevice = await authService.logoutOthers(LU.userId, 'dev-current');
    expect(byDevice).toEqual({ revokedDevices: 1 });
    expect(await revokedAt('current')).toBeNull();
    expect(await revokedAt('cookie')).not.toBeNull();

    // Cookie only (no device id): the current device's row is the only live one left and it does not match the hash → revoked.
    await seed('current2', 'dev-current');
    const byCookie = await authService.logoutOthers(LU.userId, undefined, tokens.current2);
    expect(byCookie).toEqual({ revokedDevices: 1 });
    expect(await revokedAt('current')).not.toBeNull();
    expect(await revokedAt('current2')).toBeNull();

    expect(await authService.logoutOthers(LU.userId, 'dev-current', tokens.current2)).toEqual({ revokedDevices: 0 });
    const events = await dbAdmin
      .select()
      .from(authEvents)
      .where(and(eq(authEvents.user_id, LU.userId), eq(authEvents.event_type, 'logout')));
    expect(events).toHaveLength(4); // the two refusals wrote nothing
  });

  it('getMe returns the real last sign-in time (null before the first login)', async () => {
    const when = new Date('2026-09-08T04:30:00.000Z');
    await dbAdmin.update(users).set({ last_login_at: when }).where(eq(users.id, R1.userId));
    const me = await authService.getMe(R1.userId, T1);
    expect(me.lastLoginAt).toBeInstanceOf(Date);
    expect((me.lastLoginAt as Date).toISOString()).toBe(when.toISOString());
    expect(me.currentMembership?.tenantId).toBe(T1);
    expect(me.currentMembership?.employeeId).toBe(R1.employeeId);
    const fresh = await authService.getMe(N.userId, T1);
    expect(fresh.lastLoginAt).toBeNull();
  });

  it("a signed-out device's stale refresh is a plain 401 that does NOT sign the current device out; replaying a ROTATED token still does", async () => {
    const uid = (await mkUser('Refresh')).id;
    const a = await seed('devA', 'dev-a', { userId: uid });
    const b = await seed('devB', 'dev-b', { userId: uid });
    expect(await authService.logoutOthers(uid, 'dev-a', a)).toEqual({ revokedDevices: 1 });

    // Device B's stale tab refreshes with its revoked cookie: refused, and A is untouched —
    // but the attempt is still on the audit trail.
    await expect(authService.refreshToken(b, 'dev-b')).rejects.toThrow(/Session has ended/);
    expect((await rowsFor(uid))[sha256(a)]!.revokedAt).toBeNull();
    const presented = await dbAdmin
      .select()
      .from(authEvents)
      .where(and(eq(authEvents.user_id, uid), eq(authEvents.event_type, 'token_revoked')));
    expect(presented).toHaveLength(1);
    expect(presented[0]!.metadata).toEqual({ reason: 'revoked_token_presented' });

    // Device A rotates normally and the chain is linked…
    const rotated = await authService.refreshToken(a, 'dev-a');
    expect(rotated.refreshToken).toBeTruthy();
    const [oldRow] = await dbAdmin
      .select({ rotatedTo: refreshTokens.rotated_to, revokedAt: refreshTokens.revoked_at })
      .from(refreshTokens)
      .where(eq(refreshTokens.token_hash, sha256(a)));
    expect(oldRow!.revokedAt).not.toBeNull();
    expect(oldRow!.rotatedTo).not.toBeNull();
    expect((await rowsFor(uid))[sha256(rotated.refreshToken)]!.revokedAt).toBeNull();

    // …so a replay of the ROTATED token is a real reuse: every session of that user goes.
    await expect(authService.refreshToken(a, 'dev-a')).rejects.toThrow(/Token reuse detected/);
    expect((await rowsFor(uid))[sha256(rotated.refreshToken)]!.revokedAt).not.toBeNull();

    await dbAdmin.delete(refreshTokens).where(eq(refreshTokens.user_id, uid));
    await dbAdmin.delete(authEvents).where(eq(authEvents.user_id, uid));
  });
});
