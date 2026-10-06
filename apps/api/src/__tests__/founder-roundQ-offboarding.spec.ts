/**
 * Round Q — off-boarding that actually off-boards (founder 2026-10-06).
 *
 * "This in-app notification [Inbox → Approvals → Onboarding: '… finished
 *  self-onboarding and is waiting for approval, 37d ago'] comes to me when I
 *  try to off-board or deactivate a user. If a user is off-boarded it should
 *  automatically get off-boarded and deactivate the user; later the Owner or
 *  HR can delete them. A checkbox: ticked → off-boarded and deactivated
 *  immediately, no notice; unticked → the notice period starts."
 *
 * Root cause: the onboarding flag outlives approval and both queues selected
 * `status <> 'active'`, so every off-boarded (notice / separated) person came
 * back as "waiting for approval" — and Approve flipped them, and their
 * sign-in, back on. Off-boarding itself never touched the seat.
 *
 * Service-level against the real Postgres, mirroring founder-round21.spec.
 */
import 'dotenv/config';
import * as crypto from 'crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { dbAdmin } from '@flicks/db';
import {
  tenants,
  users,
  memberships,
  employees,
  employmentHistory,
  refreshTokens,
} from '@flicks/db/schema';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DatabaseService } from '../core/database/database.service';
import { ModuleAccessService } from '../core/auth/module-access.service';
import { EmployeesService } from '../modules/employees/employees.service';
import { DashboardService } from '../modules/dashboard/dashboard.service';
import { addDaysISO, dateInTimezone } from '../core/common/time';
import type { AuditService } from '../modules/audit/audit.service';
import type { NotificationsService } from '../modules/notifications/notifications.service';
import type { AuthService } from '../modules/auth/auth.service';
import type { MediaService } from '../modules/media/media.service';

const rid = () => crypto.randomBytes(4).toString('hex');
const audited: Array<{ action: string; resourceId?: string }> = [];
const audit = {
  log: async (d: { action: string; resourceId?: string }) => {
    audited.push(d);
  },
} as unknown as AuditService;
const inApp: Array<{ userId: string; type: string; message: string }> = [];
const notifications = {
  createInAppNotification: async (userId: string, type: string, message: string) => {
    inApp.push({ userId, type, message });
  },
  sendEmail: async () => true,
} as unknown as NotificationsService;
const emitter = new EventEmitter2();
const dbSvc = new DatabaseService();
const mediaStub = {
  servedUrl: async (k: string | null, l: string | null) => (k ? `signed:${k}` : l),
} as unknown as MediaService;

const svc = new EmployeesService(
  dbSvc,
  dbAdmin as never,
  audit,
  notifications,
  emitter,
  new ConfigService({ NODE_ENV: 'test' }),
  {} as unknown as AuthService,
  mediaStub,
);
const dashboard = new DashboardService(dbSvc, mediaStub);
const access = new ModuleAccessService(dbSvc, dbAdmin as never);

let tenantId: string;
let otherTenantId: string;
let ownerUserId: string;
let adminUserId: string;
const trackedUsers: string[] = [];
const todayIST = () => dateInTimezone(new Date(), 'Asia/Kolkata');

async function seedPerson(
  label: string,
  opts: { role?: string; status?: string; submitted?: boolean; tenant?: string; noticeDays?: number } = {},
) {
  const tid = opts.tenant ?? tenantId;
  const email = `rq-${label}-${rid()}@t.test`;
  const [u] = await dbAdmin
    .insert(users)
    .values({ email, full_name: `RQ ${label}`, status: 'active' })
    .returning();
  trackedUsers.push(u!.id);
  const [emp] = await dbAdmin
    .insert(employees)
    .values({
      tenant_id: tid,
      employee_code: `Q-${rid()}`,
      first_name: label,
      last_name: 'Seed',
      work_email: email,
      date_of_joining: '2025-01-01',
      status: (opts.status ?? 'active') as never,
      user_id: u!.id,
      notice_period_days: opts.noticeDays ?? 30,
      custom_fields: opts.submitted
        ? { onboarding_submitted_for_review: true, onboarding_submitted_at: '2026-08-30T10:00:00.000Z' }
        : {},
    })
    .returning();
  const [m] = await dbAdmin
    .insert(memberships)
    .values({
      tenant_id: tid,
      user_id: u!.id,
      role: (opts.role ?? 'employee') as never,
      status: opts.status === 'inactive' ? 'invited' : 'active',
      accepted_at: opts.status === 'inactive' ? null : new Date(),
      employee_id: emp!.id,
    })
    .returning();
  return { id: emp!.id, userId: u!.id, membershipId: m!.id, email };
}

async function giveSession(userId: string, tid: string) {
  await dbAdmin.insert(refreshTokens).values({
    user_id: userId,
    tenant_id: tid,
    token_hash: crypto.randomBytes(32).toString('hex'),
    expires_at: new Date(Date.now() + 86_400_000),
  });
}

const empRow = async (id: string) =>
  (await dbAdmin.select().from(employees).where(eq(employees.id, id)))[0]!;
const seatRow = async (id: string) =>
  (await dbAdmin.select().from(memberships).where(eq(memberships.id, id)))[0]!;
const liveTokens = async (userId: string, tid: string) =>
  dbAdmin
    .select()
    .from(refreshTokens)
    .where(and(eq(refreshTokens.user_id, userId), eq(refreshTokens.tenant_id, tid), isNull(refreshTokens.revoked_at)));

async function inInbox(employeeId: string, caller = ownerUserId) {
  const ov = await dashboard.getAdminOverview(tenantId, {
    callerUserId: caller,
    includeOnboarding: true,
    includeApprovals: true,
  });
  return (ov.pending.onboarding as Array<{ employeeId: string }>).some((r) => r.employeeId === employeeId);
}
async function inQueue(employeeId: string) {
  const q = await svc.getOnboardingQueue(tenantId, ownerUserId);
  return q.data.some((r: { id: string }) => r.id === employeeId);
}

beforeAll(async () => {
  const [t] = await dbAdmin
    .insert(tenants)
    .values({ name: `RQ ${rid()}`, slug: `rq-${rid()}-${Date.now()}`, status: 'active' })
    .returning();
  tenantId = t!.id;
  const [t2] = await dbAdmin
    .insert(tenants)
    .values({ name: `RQ2 ${rid()}`, slug: `rq2-${rid()}-${Date.now()}`, status: 'active' })
    .returning();
  otherTenantId = t2!.id;
  ownerUserId = (await seedPerson('owner', { role: 'owner' })).userId;
  adminUserId = (await seedPerson('hr', { role: 'admin' })).userId;
});

afterAll(async () => {
  await dbAdmin.delete(tenants).where(eq(tenants.id, tenantId));
  await dbAdmin.delete(tenants).where(eq(tenants.id, otherTenantId));
  for (const id of trackedUsers) await dbAdmin.delete(users).where(eq(users.id, id));
});

describe('Round Q — the stale "waiting for approval" card', () => {
  it('an approved, self-onboarded person put on notice is NOT waiting for approval (both queues)', async () => {
    // Exactly the founder's case: submitted long ago, approved (active), the
    // flag still true — then off-boarded with notice.
    const p = await seedPerson('siva', { submitted: true });
    expect(await inInbox(p.id)).toBe(false);
    await svc.terminateEmployee(p.id, { reason: 'Resigned' }, adminUserId, tenantId);
    expect((await empRow(p.id)).status).toBe('notice_period');
    expect(await inInbox(p.id)).toBe(false);
    expect(await inQueue(p.id)).toBe(false);
  });

  it('legacy rows already on notice / separated / removed with the flag never show', async () => {
    const notice = await seedPerson('legacy-notice', { submitted: true, status: 'notice_period' });
    const sep = await seedPerson('legacy-sep', { submitted: true, status: 'separated' });
    const removed = await seedPerson('legacy-removed', { submitted: true, status: 'inactive' });
    await dbAdmin.update(employees).set({ deleted_at: new Date() }).where(eq(employees.id, removed.id));
    for (const p of [notice, sep, removed]) {
      expect(await inInbox(p.id)).toBe(false);
      expect(await inQueue(p.id)).toBe(false);
    }
  });

  it('a genuinely pending joiner still shows', async () => {
    const p = await seedPerson('joiner', { submitted: true, status: 'inactive' });
    expect(await inInbox(p.id)).toBe(true);
    expect(await inQueue(p.id)).toBe(true);
  });

  it('Approve / Send back on someone no longer pending → 409 and nothing is reactivated', async () => {
    const p = await seedPerson('stale', { submitted: true });
    await svc.terminateEmployee(p.id, { reason: 'Leaving', immediate: true }, adminUserId, tenantId);
    await expect(svc.approveOnboarding(p.id, ownerUserId, tenantId)).rejects.toMatchObject({
      response: { code: 'NOT_PENDING' },
    });
    await expect(svc.rejectOnboarding(p.id, 'x', ownerUserId, tenantId)).rejects.toMatchObject({
      response: { code: 'NOT_PENDING' },
    });
    expect((await empRow(p.id)).status).toBe('separated');
    expect((await seatRow(p.membershipId)).status).toBe('deactivated');
  });

  it('a pending joiner whose seat was switched off cannot be approved until it is reactivated', async () => {
    const p = await seedPerson('seatoff', { submitted: true, status: 'inactive' });
    await dbAdmin.update(memberships).set({ status: 'deactivated' }).where(eq(memberships.id, p.membershipId));
    await expect(svc.approveOnboarding(p.id, ownerUserId, tenantId)).rejects.toMatchObject({
      response: { code: 'SEAT_DEACTIVATED' },
    });
    await dbAdmin.update(memberships).set({ status: 'invited' }).where(eq(memberships.id, p.membershipId));
    await svc.approveOnboarding(p.id, ownerUserId, tenantId);
    expect((await empRow(p.id)).status).toBe('active');
  });
});

describe('Round Q — off-board immediately', () => {
  it('separates, records the exit, switches the seat off and signs them out of THIS company only', async () => {
    const p = await seedPerson('now');
    await giveSession(p.userId, tenantId);
    // The same person also works for another company — that session survives.
    await dbAdmin.insert(memberships).values({
      tenant_id: otherTenantId,
      user_id: p.userId,
      role: 'employee',
      status: 'active',
    });
    await giveSession(p.userId, otherTenantId);
    expect((await access.liveSeat(tenantId, p.membershipId))?.active).toBe(true);

    const r = await svc.terminateEmployee(
      p.id,
      { reason: 'Terminated for cause', separationType: 'terminated', immediate: true },
      adminUserId,
      tenantId,
    );
    expect(r).toMatchObject({ status: 'separated', immediate: true, lastWorkingDate: todayIST() });

    const row = await empRow(p.id);
    expect(row.status).toBe('separated');
    expect(row.date_of_exit).toBe(todayIST());
    expect(row.exit_reason).toBe('Terminated for cause');
    expect((await seatRow(p.membershipId)).status).toBe('deactivated');
    // Live-seat check (RolesGuard) refuses their very next ranked request.
    expect((await access.liveSeat(tenantId, p.membershipId))?.active).toBe(false);
    expect(await liveTokens(p.userId, tenantId)).toHaveLength(0);
    expect(await liveTokens(p.userId, otherTenantId)).toHaveLength(1);

    const [hist] = await dbAdmin
      .select()
      .from(employmentHistory)
      .where(and(eq(employmentHistory.employee_id, p.id), eq(employmentHistory.change_type, 'separation')))
      .orderBy(desc(employmentHistory.created_at))
      .limit(1);
    expect(hist).toMatchObject({ reason: 'Terminated for cause', effective_from: todayIST() });
    expect(audited.some((a) => a.action === 'employee.separated' && a.resourceId === p.id)).toBe(true);
  });

  it('refuses a second off-boarding of someone already separated', async () => {
    const p = await seedPerson('twice');
    await svc.terminateEmployee(p.id, { reason: 'x', immediate: true }, adminUserId, tenantId);
    await expect(
      svc.terminateEmployee(p.id, { reason: 'x', immediate: true }, adminUserId, tenantId),
    ).rejects.toMatchObject({ response: { code: 'ALREADY_OFFBOARDED' } });
  });
});

describe('Round Q — off-board with a notice period', () => {
  it('defaults the last working day to today + their notice period and keeps them signed in', async () => {
    const p = await seedPerson('notice', { noticeDays: 45 });
    await giveSession(p.userId, tenantId);
    const r = await svc.terminateEmployee(p.id, { reason: 'Resigned' }, adminUserId, tenantId);
    expect(r).toMatchObject({ status: 'notice_period', immediate: false });
    expect(r.lastWorkingDate).toBe(addDaysISO(todayIST(), 45));
    const row = await empRow(p.id);
    expect(row.status).toBe('notice_period');
    expect(row.date_of_exit).toBe(addDaysISO(todayIST(), 45));
    expect((await seatRow(p.membershipId)).status).toBe('active');
    expect(await liveTokens(p.userId, tenantId)).toHaveLength(1);
  });

  it('honours an explicit last working day and refuses one in the past', async () => {
    const p = await seedPerson('explicit');
    const day = addDaysISO(todayIST(), 10);
    const r = await svc.terminateEmployee(p.id, { reason: 'x', lastWorkingDate: day }, adminUserId, tenantId);
    expect(r.lastWorkingDate).toBe(day);
    const q = await seedPerson('past');
    await expect(
      svc.terminateEmployee(q.id, { reason: 'x', lastWorkingDate: '2020-01-01' }, adminUserId, tenantId),
    ).rejects.toThrow(/in the past/);
    expect((await empRow(q.id)).status).toBe('active');
  });

  it('a second "notice" off-boarding is refused; "End notice now" (immediate) finishes it', async () => {
    const p = await seedPerson('endnow');
    await svc.terminateEmployee(p.id, { reason: 'x' }, adminUserId, tenantId);
    await expect(svc.terminateEmployee(p.id, { reason: 'x' }, adminUserId, tenantId)).rejects.toMatchObject({
      response: { code: 'ALREADY_ON_NOTICE' },
    });
    await svc.terminateEmployee(p.id, { reason: 'Left early', immediate: true }, adminUserId, tenantId);
    expect((await empRow(p.id)).status).toBe('separated');
    expect((await empRow(p.id)).date_of_exit).toBe(todayIST());
    expect((await seatRow(p.membershipId)).status).toBe('deactivated');
  });

  it('the notice-period job separates them the day after the last working day — and only then', async () => {
    const due = await seedPerson('due');
    const notYet = await seedPerson('notyet');
    const lastDay = await seedPerson('lastday');
    await giveSession(due.userId, tenantId);
    for (const p of [due, notYet, lastDay]) {
      await svc.terminateEmployee(p.id, { reason: 'Resigned' }, adminUserId, tenantId);
    }
    await dbAdmin.update(employees).set({ date_of_exit: addDaysISO(todayIST(), -1) }).where(eq(employees.id, due.id));
    await dbAdmin.update(employees).set({ date_of_exit: todayIST() }).where(eq(employees.id, lastDay.id));

    inApp.length = 0;
    await svc.completeDueSeparations(new Date());
    expect((await empRow(due.id)).status).toBe('separated');
    expect((await seatRow(due.membershipId)).status).toBe('deactivated');
    expect(await liveTokens(due.userId, tenantId)).toHaveLength(0);
    // Today is still a working day; future dates untouched.
    expect((await empRow(lastDay.id)).status).toBe('notice_period');
    expect((await empRow(notYet.id)).status).toBe('notice_period');
    expect((await seatRow(lastDay.membershipId)).status).toBe('active');
    // Owners / HR are told; the person themselves is not in that list.
    const told = inApp.filter((n) => n.type === 'employee.separated' && n.message.startsWith('due '));
    expect(told.map((n) => n.userId).sort()).toEqual([ownerUserId, adminUserId].sort());

    // Idempotent: a second sweep changes nothing.
    inApp.length = 0;
    await svc.completeDueSeparations(new Date());
    expect(inApp.filter((n) => n.message.startsWith('due '))).toHaveLength(0);
  });

  it('a pre-Round-Q notice (no date_of_exit) uses its separation history date', async () => {
    const p = await seedPerson('legacy', { status: 'notice_period' });
    await dbAdmin.insert(employmentHistory).values({
      tenant_id: tenantId,
      employee_id: p.id,
      change_type: 'separation',
      effective_from: addDaysISO(todayIST(), -3),
      reason: 'old flow',
    });
    await svc.completeDueSeparations(new Date());
    const row = await empRow(p.id);
    expect(row.status).toBe('separated');
    expect(row.date_of_exit).toBe(addDaysISO(todayIST(), -3));
    expect((await seatRow(p.membershipId)).status).toBe('deactivated');
  });
});

describe('Round Q — cancel / reinstate', () => {
  it('cancelling a notice period restores active and clears the dates', async () => {
    const p = await seedPerson('cancel');
    await svc.terminateEmployee(p.id, { reason: 'x' }, adminUserId, tenantId);
    await svc.cancelOffboarding(p.id, adminUserId, tenantId);
    const row = await empRow(p.id);
    expect(row.status).toBe('active');
    expect(row.date_of_exit).toBeNull();
    expect(row.exit_reason).toBeNull();
    expect((await seatRow(p.membershipId)).status).toBe('active');
  });

  it('reinstating a separated person turns their seat back on', async () => {
    const p = await seedPerson('reinstate');
    await svc.terminateEmployee(p.id, { reason: 'x', immediate: true }, adminUserId, tenantId);
    const r = await svc.cancelOffboarding(p.id, ownerUserId, tenantId);
    expect(r.data.seat).toBe('active');
    expect((await empRow(p.id)).status).toBe('active');
    expect((await seatRow(p.membershipId)).status).toBe('active');
    expect((await access.liveSeat(tenantId, p.membershipId))?.active).toBe(true);
  });

  it('refuses someone who is not being off-boarded', async () => {
    const p = await seedPerson('notoff');
    await expect(svc.cancelOffboarding(p.id, adminUserId, tenantId)).rejects.toMatchObject({
      response: { code: 'NOT_OFFBOARDING' },
    });
  });
});

describe('Round Q — who may off-board whom', () => {
  it('nobody off-boards themselves', async () => {
    const me = await seedPerson('selfie', { role: 'admin' });
    await expect(
      svc.terminateEmployee(me.id, { reason: 'x', immediate: true }, me.userId, tenantId),
    ).rejects.toThrow(/cannot off-board yourself/);
  });

  it('an HR admin cannot off-board, reinstate or cancel for an Owner or another HR admin', async () => {
    const owner2 = await seedPerson('owner2', { role: 'owner' });
    const hr2 = await seedPerson('hr2', { role: 'admin' });
    for (const target of [owner2, hr2]) {
      await expect(
        svc.terminateEmployee(target.id, { reason: 'x', immediate: true }, adminUserId, tenantId),
      ).rejects.toThrow(/Only an owner can off-board an owner or HR admin/);
      expect((await empRow(target.id)).status).toBe('active');
    }
    // The Owner can.
    await svc.terminateEmployee(hr2.id, { reason: 'x' }, ownerUserId, tenantId);
    await expect(svc.cancelOffboarding(hr2.id, adminUserId, tenantId)).rejects.toThrow(/Only an owner/);
    await svc.cancelOffboarding(hr2.id, ownerUserId, tenantId);
  });

  it('never the last active Owner', async () => {
    const [t] = await dbAdmin
      .insert(tenants)
      .values({ name: `RQ solo ${rid()}`, slug: `rq-solo-${rid()}-${Date.now()}`, status: 'active' })
      .returning();
    try {
      const a = await seedPerson('ownerA', { role: 'owner', tenant: t!.id });
      const b = await seedPerson('ownerB', { role: 'owner', tenant: t!.id });
      // Two active owners: A may off-board B.
      await svc.terminateEmployee(b.id, { reason: 'x', immediate: true }, a.userId, t!.id);
      // A is now the only active owner. Over HTTP B's switched-off seat would
      // be refused by the live-seat guard first; the service guard is the
      // defence in depth behind it.
      await expect(
        svc.terminateEmployee(a.id, { reason: 'x', immediate: true }, b.userId, t!.id),
      ).rejects.toThrow(/only owner/);
      expect((await empRow(a.id)).status).toBe('active');
    } finally {
      await dbAdmin.delete(tenants).where(eq(tenants.id, t!.id));
    }
  });

  it('someone who never joined is removed, not off-boarded', async () => {
    const p = await seedPerson('invitee', { status: 'inactive' });
    await expect(
      svc.terminateEmployee(p.id, { reason: 'x', immediate: true }, adminUserId, tenantId),
    ).rejects.toMatchObject({ response: { code: 'NOT_JOINED' } });
  });

  it("another company's employee id is not found", async () => {
    const foreign = await seedPerson('foreign', { tenant: otherTenantId });
    await expect(
      svc.terminateEmployee(foreign.id, { reason: 'x', immediate: true }, adminUserId, tenantId),
    ).rejects.toThrow(/not found/i);
    await expect(svc.cancelOffboarding(foreign.id, adminUserId, tenantId)).rejects.toThrow(/not found/i);
    expect((await empRow(foreign.id)).status).toBe('active');
  });
});
