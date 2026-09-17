/**
 * Founder round L (2026-09-17), item 2 — approval routing + 24 h escalation
 * (implementer B, Phase 1: the approvals module, the sweep, timesheets).
 *
 *   Levels: 0 reporting manager · 1 manager's manager · 2 Owner + HR Admins.
 *   24 calendar hours per level; immediate skip when the reviewer is on
 *   approved full-day leave today; no manager ⇒ level 2 (`no_manager`); no
 *   valid skip-level manager ⇒ level 2 (`no_skip_manager`). May act: the live
 *   manager always, the L1 manager once escalated to them, owner/admin
 *   always, never the applicant (user_id + membership bridge). Queues: direct
 *   reports, items escalated to me, level 2 for owner/admin.
 *
 * Service-level against the real Postgres (founder-round8 harness). Leave /
 * regularization / dashboard integrations are Phase 2 and pinned in the
 * merged founder-roundL.spec.ts.
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
  leaveTypes,
  leaveRequests,
  attendanceRegularizations,
  timesheetPeriods,
} from '@flicks/db/schema';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../core/database/database.service';
import { AuditService } from '../modules/audit/audit.service';
import {
  NotificationsService,
  emailEventForInAppType,
} from '../modules/notifications/notifications.service';
import { ApprovalRoutingService, dateInTimezone } from '../modules/approvals/approval-routing.service';
import { ApprovalEscalationJob, fmtShortDate } from '../jobs/approval-escalation.job';
import { TimesheetService } from '../modules/timesheet/timesheet.service';
import { LeaveService } from '../modules/leave/leave.service';
import { AttendanceService } from '../modules/attendance/attendance.service';
import { DashboardService } from '../modules/dashboard/dashboard.service';
import type { MediaService } from '../modules/media/media.service';

jest.setTimeout(120_000);

const rid = () => crypto.randomBytes(4).toString('hex');
const APP_URL = 'https://app.test';
const H = 3_600_000;

/** Notifications are fire-and-forget by design (house rule 6) — poll. */
async function waitFor(pred: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}
const settle = () => new Promise((r) => setTimeout(r, 150));

type InAppCall = [string, string, string, string, string, { groupKey?: string } | undefined];
type MailCall = [string, string, Record<string, unknown>, { userId?: string; event?: string } | undefined];

const auditStub = { log: async () => {} } as unknown as AuditService;
const createInAppNotification = jest.fn(async () => undefined);
const sendEmail = jest.fn(async () => true);
const notifications = { createInAppNotification, sendEmail } as unknown as NotificationsService;

const dbSvc = new DatabaseService();
const config = new ConfigService({ NODE_ENV: 'test', APP_URL });
const routing = new ApprovalRoutingService(notifications, config);
const job = new ApprovalEscalationJob(dbAdmin as never, dbSvc, routing);
const timesheetService = new TimesheetService(dbAdmin as never, dbSvc, auditStub, notifications, routing);
const leaveService = new LeaveService(dbSvc, auditStub, notifications, config, routing);
const attendanceService = new AttendanceService(dbSvc, dbAdmin as never, auditStub, notifications, config, routing);
const dashboardService = new DashboardService(
  dbSvc,
  { servedUrl: async (k: string | null, l: string | null) => (k ? `signed:${k}` : l) } as unknown as MediaService,
  routing,
);
const realNotifications = new NotificationsService(
  db as never,
  dbAdmin as never,
  config,
  new EventEmitter2(),
);
const renderTemplate = (template: string, props: Record<string, unknown>) =>
  (realNotifications as unknown as {
    renderTemplate: (t: string, p: Record<string, unknown>) => { subject: string; html: string };
  }).renderTemplate(template, props);

const resetSpies = () => {
  createInAppNotification.mockClear();
  sendEmail.mockClear();
};
const inAppCalls = () => createInAppNotification.mock.calls as unknown as InAppCall[];
const mailCalls = () => sendEmail.mock.calls as unknown as MailCall[];

// ─── Fixtures ────────────────────────────────────────────────────────────────

let T1: string;
let T2: string;
const userIds: string[] = [];

type Person = { userId: string; employeeId: string | null; email: string; name: string };
type Role = 'owner' | 'admin' | 'manager' | 'employee' | 'finance' | 'guest';
let owner: Person; // no manager
let admin: Person; // no manager
let mgrB: Person; // → owner
let mgrA: Person; // → mgrB
let empX: Person; // → mgrA
let empY: Person; // → mgrA
let empNoMgr: Person; // no manager
let empSelf: Person; // reporting_manager_id = self
let cycA: Person; // → cycB
let cycB: Person; // → cycA
let peer: Person; // employee → mgrB (never a reviewer of empX)
let fin: Person; // finance seat — never a reviewer
let guest: Person; // guest seat — never a reviewer
let S: Person; // employee row with user_id NULL, bridged only through SU's membership
let SU: Person; // owner seat whose membership.employee_id = S
let Z: Person; // owner of T2
let zEmp: Person; // T2 employee → Z
let leaveTypeId: string;
const today = () => dateInTimezone(new Date(), 'Asia/Kolkata');

// ─── Shared helpers (used across describes) ──────────────────────────────────

const periodRowOf = async (id: string) => {
  const [r] = await dbAdmin.select().from(timesheetPeriods).where(eq(timesheetPeriods.id, id));
  return r!;
};
/** assertMayActTx for `p` on an explicit item (kind timesheet unless given). */
const mayActOn = async (
  p: Person,
  item: { applicantEmployeeId: string; level: number; escalatedTo: string | null },
  roleHint?: string,
  kind: 'leave' | 'regularization' | 'timesheet' = 'timesheet',
) =>
  dbSvc.withTenant(T1, async (tx) => {
    const reviewer = await routing.resolveReviewerTx(tx, T1, p.userId, roleHint);
    return routing.assertMayActTx(tx, T1, reviewer, item, kind);
  });
/** assertMayActTx for `p` on a seeded timesheet period. */
const mayAct = async (p: Person, periodId: string, roleHint?: string) => {
  const row = await periodRowOf(periodId);
  return mayActOn(
    p,
    { applicantEmployeeId: row.employee_id, level: row.escalation_level, escalatedTo: row.escalated_to_employee_id },
    roleHint,
  );
};
/** Current-week period with one 8 h entry, ready to submit. */
const logHours = async (p: Person) => {
  const period = await timesheetService.getMyCurrentPeriod(p.userId, T1);
  await timesheetService.saveEntries(p.userId, T1, {
    timesheetPeriodId: period.id,
    entries: [{ entryDate: period.periodStart, hours: 8, category: 'development', isBillable: true }],
  });
  return period.id;
};

async function mkUser(label: string) {
  const email = `rl-${label.toLowerCase()}-${rid()}@t.test`;
  const [u] = await dbAdmin.insert(users).values({ email, full_name: `${label} Tester`, status: 'active' }).returning();
  userIds.push(u!.id);
  return { id: u!.id, email, name: `${label} Tester` };
}

async function mkPerson(
  tenantId: string,
  label: string,
  role: Role,
  opts: { managerId?: string | null; unlinkedUser?: boolean } = {},
): Promise<Person> {
  const u = await mkUser(label);
  const [e] = await dbAdmin
    .insert(employees)
    .values({
      tenant_id: tenantId,
      user_id: opts.unlinkedUser ? null : u.id,
      employee_code: `RL-${rid()}`,
      first_name: label,
      last_name: 'Tester',
      work_email: u.email,
      date_of_joining: '2026-01-01',
      status: 'active',
      reporting_manager_id: opts.managerId ?? null,
    })
    .returning();
  await dbAdmin
    .insert(memberships)
    .values({ tenant_id: tenantId, user_id: u.id, role, status: 'active', employee_id: e!.id });
  return { userId: u.id, employeeId: e!.id, email: u.email, name: u.name };
}

let periodSeq = 0;
/** A submitted period with explicit routing columns; period_start is unique per employee. */
async function seedPeriod(
  p: Person,
  opts: {
    submittedAt?: Date;
    level?: 0 | 1 | 2;
    escalatedTo?: string | null;
    escalatedAt?: Date | null;
    reason?: 'sla' | 'reviewer_on_leave' | 'no_manager' | 'no_skip_manager' | null;
    routedManager?: string | null;
    status?: 'submitted' | 'draft' | 'approved';
  } = {},
) {
  // Distinct Mondays in Jan–Jun 2026 so the per-employee unique index never trips
  // and none collides with the live current week.
  const start = new Date(Date.UTC(2026, 0, 5 + 7 * (periodSeq++ % 24)));
  const end = new Date(start.getTime() + 6 * 86_400_000);
  const [r] = await dbAdmin
    .insert(timesheetPeriods)
    .values({
      tenant_id: T1,
      employee_id: p.employeeId!,
      period_start: start.toISOString().slice(0, 10),
      period_end: end.toISOString().slice(0, 10),
      status: opts.status ?? 'submitted',
      total_hours: 40,
      total_billable_hours: 30,
      total_non_billable_hours: 10,
      submitted_at: opts.submittedAt ?? new Date(),
      escalation_level: opts.level ?? 0,
      escalated_to_employee_id: opts.escalatedTo ?? null,
      escalated_at: opts.escalatedAt ?? null,
      escalation_reason: opts.reason ?? null,
      routed_manager_employee_id: opts.routedManager ?? null,
    })
    .returning();
  return r!.id;
}

const periodRow = async (id: string) => {
  const [r] = await dbAdmin.select().from(timesheetPeriods).where(eq(timesheetPeriods.id, id));
  return r!;
};

async function approvedLeave(p: Person, opts: { halfDay?: boolean } = {}) {
  const d = today();
  const [r] = await dbAdmin
    .insert(leaveRequests)
    .values({
      tenant_id: T1,
      employee_id: p.employeeId!,
      leave_type_id: leaveTypeId,
      start_date: d,
      end_date: d,
      is_half_day: opts.halfDay ?? false,
      half_day_session: opts.halfDay ? 'first_half' : null,
      total_days: opts.halfDay ? 0.5 : 1,
      status: 'approved',
    })
    .returning();
  return r!.id;
}

beforeAll(async () => {
  const [t] = await dbAdmin
    .insert(tenants)
    .values({ name: `RL-B main ${rid()}`, slug: `rlb-${rid()}-${Date.now()}`, status: 'active', currency: 'INR', timezone: 'Asia/Kolkata' })
    .returning();
  T1 = t!.id;
  const [t2] = await dbAdmin
    .insert(tenants)
    .values({ name: `RL-B other ${rid()}`, slug: `rlb2-${rid()}-${Date.now()}`, status: 'active', currency: 'INR' })
    .returning();
  T2 = t2!.id;

  owner = await mkPerson(T1, 'Owner', 'owner');
  admin = await mkPerson(T1, 'Admin', 'admin');
  mgrB = await mkPerson(T1, 'MgrB', 'manager', { managerId: owner.employeeId });
  mgrA = await mkPerson(T1, 'MgrA', 'manager', { managerId: mgrB.employeeId });
  empX = await mkPerson(T1, 'EmpX', 'employee', { managerId: mgrA.employeeId });
  empY = await mkPerson(T1, 'EmpY', 'employee', { managerId: mgrA.employeeId });
  empNoMgr = await mkPerson(T1, 'NoMgr', 'employee');
  empSelf = await mkPerson(T1, 'SelfLoop', 'employee');
  await dbAdmin.update(employees).set({ reporting_manager_id: empSelf.employeeId! }).where(eq(employees.id, empSelf.employeeId!));
  cycA = await mkPerson(T1, 'CycA', 'manager');
  cycB = await mkPerson(T1, 'CycB', 'manager', { managerId: cycA.employeeId });
  await dbAdmin.update(employees).set({ reporting_manager_id: cycB.employeeId! }).where(eq(employees.id, cycA.employeeId!));
  peer = await mkPerson(T1, 'Peer', 'employee', { managerId: mgrB.employeeId });
  fin = await mkPerson(T1, 'Fin', 'finance');
  guest = await mkPerson(T1, 'Guest', 'guest');
  S = await mkPerson(T1, 'Unlinked', 'owner', { unlinkedUser: true });
  SU = S;
  Z = await mkPerson(T2, 'Zed', 'owner');
  zEmp = await mkPerson(T2, 'ZEmp', 'employee', { managerId: Z.employeeId });

  const [lt] = await dbAdmin
    .insert(leaveTypes)
    .values({ tenant_id: T1, name: 'Casual Leave', code: 'CL', default_quota_days: 12 })
    .returning();
  leaveTypeId = lt!.id;
});

afterAll(async () => {
  for (const t of [T1, T2]) await dbAdmin.delete(tenants).where(eq(tenants.id, t));
  await dbAdmin.delete(users).where(inArray(users.id, userIds));
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
});

// ═════════════════════════════════════════════════════════════════════════════
// 1. Route resolution
// ═════════════════════════════════════════════════════════════════════════════

describe('Round L-B — resolveRouteTx', () => {
  it('empX → L0 mgrA, L1 mgrB, L2 = owner + admin (never the applicant)', async () => {
    const route = await dbSvc.withTenant(T1, (tx) => routing.resolveRouteTx(tx, T1, empX.employeeId!));
    expect(route.applicantUserId).toBe(empX.userId);
    expect(route.l0).toMatchObject({ employeeId: mgrA.employeeId, userId: mgrA.userId, email: mgrA.email, name: 'MgrA Tester' });
    expect(route.l1).toMatchObject({ employeeId: mgrB.employeeId, userId: mgrB.userId, email: mgrB.email, name: 'MgrB Tester' });
    // Raw owner/admin seats of the tenant: owner, admin, the bridged owner seat SU.
    expect(route.l2.map((r) => r.userId).sort()).toEqual([owner.userId, admin.userId, SU.userId].sort());
    // Recipients: L0 → the manager only; L1 → the skip-level manager only.
    expect(routing.recipientsFor(route, 0).map((r) => r.userId)).toEqual([mgrA.userId]);
    expect(routing.recipientsFor(route, 1).map((r) => r.userId)).toEqual([mgrB.userId]);
    expect(routing.recipientsFor(route, 2).map((r) => r.userId).sort()).toEqual([owner.userId, admin.userId, SU.userId].sort());
  });

  it('a self-loop (manager = applicant) has no L0; the applicant is cut from L2', async () => {
    const route = await dbSvc.withTenant(T1, (tx) => routing.resolveRouteTx(tx, T1, empSelf.employeeId!));
    expect(route.l0).toBeNull();
    expect(route.l1).toBeNull();
    expect(route.l2.some((r) => r.userId === empSelf.userId)).toBe(false);
  });

  it('an A ↔ B cycle collapses to one hop: cycA → L0 cycB, no L1', async () => {
    const route = await dbSvc.withTenant(T1, (tx) => routing.resolveRouteTx(tx, T1, cycA.employeeId!));
    expect(route.l0?.employeeId).toBe(cycB.employeeId);
    expect(route.l1).toBeNull();
    const back = await dbSvc.withTenant(T1, (tx) => routing.resolveRouteTx(tx, T1, cycB.employeeId!));
    expect(back.l0?.employeeId).toBe(cycA.employeeId);
    expect(back.l1).toBeNull();
  });

  it('mgrB → L0 owner, no L1; at level 2 the owner is not told twice (already the L0 reviewer)', async () => {
    const route = await dbSvc.withTenant(T1, (tx) => routing.resolveRouteTx(tx, T1, mgrB.employeeId!));
    expect(route.l0?.employeeId).toBe(owner.employeeId);
    expect(route.l1).toBeNull();
    expect(routing.recipientsFor(route, 2).map((r) => r.userId).sort()).toEqual([admin.userId, SU.userId].sort());
  });

  it('a bridged applicant (employees.user_id NULL) resolves through the membership and is cut from L2', async () => {
    const [emp] = await dbAdmin.select({ userId: employees.user_id }).from(employees).where(eq(employees.id, S.employeeId!));
    expect(emp!.userId).toBeNull();
    const route = await dbSvc.withTenant(T1, (tx) => routing.resolveRouteTx(tx, T1, S.employeeId!));
    expect(route.applicantUserId).toBe(SU.userId);
    expect(route.l0).toBeNull();
    expect(route.l2.some((r) => r.userId === SU.userId)).toBe(false);
    expect(route.l2.map((r) => r.userId).sort()).toEqual([owner.userId, admin.userId].sort());
  });

  it('resolveReviewerTx: owner/admin are org-wide, a manager is not, the JWT role hint wins, an outsider has nothing', async () => {
    const o = await dbSvc.withTenant(T1, (tx) => routing.resolveReviewerTx(tx, T1, owner.userId));
    expect(o).toMatchObject({ tenantId: T1, userId: owner.userId, employeeId: owner.employeeId, orgWide: true, role: 'owner' });
    const m = await dbSvc.withTenant(T1, (tx) => routing.resolveReviewerTx(tx, T1, mgrA.userId));
    expect(m).toMatchObject({ employeeId: mgrA.employeeId, orgWide: false, role: 'manager' });
    const hinted = await dbSvc.withTenant(T1, (tx) => routing.resolveReviewerTx(tx, T1, mgrA.userId, 'owner'));
    expect(hinted.orgWide).toBe(true);
    const z = await dbSvc.withTenant(T1, (tx) => routing.resolveReviewerTx(tx, T1, Z.userId));
    expect(z).toMatchObject({ employeeId: null, orgWide: false });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Initial state
// ═════════════════════════════════════════════════════════════════════════════

describe('Round L-B — initialStateTx', () => {
  it('a normal report is born at level 0 with the manager snapshotted', async () => {
    const { state, route } = await dbSvc.withTenant(T1, (tx) => routing.initialStateTx(tx, T1, empX.employeeId!, today()));
    expect(state).toEqual({ level: 0, reason: null, escalatedAt: null, escalatedTo: null, routedManager: mgrA.employeeId });
    expect(route.l0?.employeeId).toBe(mgrA.employeeId);
  });

  it('manager on approved FULL-DAY leave today ⇒ level 1 to the skip-level manager; half-day leave does not count', async () => {
    const full = await approvedLeave(mgrA);
    try {
      expect(await dbSvc.withTenant(T1, (tx) => routing.reviewerOnLeaveTodayTx(tx, T1, mgrA.employeeId!, today()))).toBe(true);
      const { state } = await dbSvc.withTenant(T1, (tx) => routing.initialStateTx(tx, T1, empX.employeeId!, today()));
      expect(state.level).toBe(1);
      expect(state.reason).toBe('reviewer_on_leave');
      expect(state.escalatedTo).toBe(mgrB.employeeId);
      expect(state.routedManager).toBe(mgrA.employeeId);
      expect(state.escalatedAt).toBeInstanceOf(Date);
    } finally {
      await dbAdmin.delete(leaveRequests).where(eq(leaveRequests.id, full));
    }
    const half = await approvedLeave(mgrA, { halfDay: true });
    try {
      expect(await dbSvc.withTenant(T1, (tx) => routing.reviewerOnLeaveTodayTx(tx, T1, mgrA.employeeId!, today()))).toBe(false);
      const { state } = await dbSvc.withTenant(T1, (tx) => routing.initialStateTx(tx, T1, empX.employeeId!, today()));
      expect(state.level).toBe(0);
    } finally {
      await dbAdmin.delete(leaveRequests).where(eq(leaveRequests.id, half));
    }
  });

  it('both the manager AND the skip-level manager on leave ⇒ level 2, reason reviewer_on_leave', async () => {
    const a = await approvedLeave(mgrA);
    const b = await approvedLeave(mgrB);
    try {
      const { state } = await dbSvc.withTenant(T1, (tx) => routing.initialStateTx(tx, T1, empX.employeeId!, today()));
      expect(state).toMatchObject({ level: 2, reason: 'reviewer_on_leave', escalatedTo: null, routedManager: mgrA.employeeId });
    } finally {
      await dbAdmin.delete(leaveRequests).where(inArray(leaveRequests.id, [a, b]));
    }
  });

  it('no manager ⇒ level 2 immediately, reason no_manager; a self-loop is "no manager" too', async () => {
    const { state } = await dbSvc.withTenant(T1, (tx) => routing.initialStateTx(tx, T1, empNoMgr.employeeId!, today()));
    expect(state).toMatchObject({ level: 2, reason: 'no_manager', escalatedTo: null, routedManager: null });
    expect(state.escalatedAt).toBeInstanceOf(Date);
    const self = await dbSvc.withTenant(T1, (tx) => routing.initialStateTx(tx, T1, empSelf.employeeId!, today()));
    expect(self.state).toMatchObject({ level: 2, reason: 'no_manager' });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Queue predicate + may-act guard (real rows on timesheet_periods)
// ═════════════════════════════════════════════════════════════════════════════

describe('Round L-B — queuePredicate + assertMayActTx', () => {
  let P0: string; // empX, level 0 (with mgrA)
  let P1: string; // empX, level 1 → mgrB
  let P2: string; // empNoMgr, level 2 (no_manager)
  let PO: string; // the owner's own, level 2 (no_manager)
  let PS: string; // the bridged S's own, level 2 (no_manager)
  let PX2: string; // empX, level 2 (sla) — the manager still acts

  beforeAll(async () => {
    P0 = await seedPeriod(empX, { routedManager: mgrA.employeeId });
    P1 = await seedPeriod(empX, { level: 1, escalatedTo: mgrB.employeeId, escalatedAt: new Date(), reason: 'sla', routedManager: mgrA.employeeId });
    P2 = await seedPeriod(empNoMgr, { level: 2, escalatedAt: new Date(), reason: 'no_manager' });
    PO = await seedPeriod(owner, { level: 2, escalatedAt: new Date(), reason: 'no_manager' });
    PS = await seedPeriod(S, { level: 2, escalatedAt: new Date(), reason: 'no_manager' });
    PX2 = await seedPeriod(empX, { level: 2, escalatedAt: new Date(), reason: 'sla', routedManager: mgrA.employeeId });
  });

  const queueOf = async (p: Person, roleHint?: string) => {
    const res = await timesheetService.listPending(p.userId, T1, { limit: 100 }, roleHint);
    return res.data.map((r) => r.id).sort();
  };

  it('owner: only level-2 items, never their own; admin: level-2 items including the owner\'s', async () => {
    const o = await queueOf(owner, 'owner');
    expect(o).toEqual([P2, PS, PX2].sort());
    expect(o).not.toContain(P0);
    expect(o).not.toContain(P1);
    expect(o).not.toContain(PO);
    const a = await queueOf(admin, 'admin');
    expect(a).toEqual([P2, PO, PS, PX2].sort());
  });

  it('the direct manager always sees their reports\' items, whatever the level; the skip-level manager only once escalated to them', async () => {
    expect(await queueOf(mgrA, 'manager')).toEqual([P0, P1, PX2].sort());
    expect(await queueOf(mgrB, 'manager')).toEqual([P1]);
    // The bridged owner seat SU is org-wide: level-2 items minus its own.
    expect(await queueOf(SU, 'owner')).toEqual([P2, PO, PX2].sort());
  });

  it('a peer employee, and a user from another tenant, see nothing', async () => {
    expect(await queueOf(peer, 'employee')).toEqual([]);
    expect(await queueOf(Z)).toEqual([]);
  });

  it('the predicate is the same SQL the dashboard will use — pinned directly on timesheet_periods', async () => {
    const ids = await dbSvc.withTenant(T1, async (tx) => {
      const reviewer = await routing.resolveReviewerTx(tx, T1, mgrB.userId, 'manager');
      const rows = await tx
        .select({ id: timesheetPeriods.id })
        .from(timesheetPeriods)
        .where(
          and(
            eq(timesheetPeriods.tenant_id, T1),
            eq(timesheetPeriods.status, 'submitted'),
            routing.queuePredicate(reviewer, timesheetPeriods, timesheetPeriods.employee_id),
          ),
        );
      return rows.map((r) => r.id).sort();
    });
    // mgrB: their direct report peer has nothing submitted; P1 was escalated to them.
    expect(ids).toEqual([P1]);
  });

  it('listPending rows carry the escalation block, routedToMe and status', async () => {
    const res = await timesheetService.listPending(mgrB.userId, T1, {}, 'manager');
    const row = res.data.find((r) => r.id === P1)!;
    expect(row.routedToMe).toBe(true);
    expect(row.status).toBe('submitted');
    expect(row.escalation).toMatchObject({ level: 1, reason: 'sla', toName: 'MgrB Tester' });
    expect(typeof row.escalation?.at).toBe('string');
    const l0 = (await timesheetService.listPending(mgrA.userId, T1, {}, 'manager')).data.find((r) => r.id === P0)!;
    expect(l0.escalation).toBeNull();
  });

  it('assertMayActTx: owner always (org); mgrB 403 before / skip_manager after escalation; mgrA still acts at level 2; the applicant never', async () => {
    expect(await mayAct(owner, P0, 'owner')).toBe('org');
    expect(await mayAct(admin, P0, 'admin')).toBe('org');
    await expect(mayAct(mgrB, P0, 'manager')).rejects.toThrow(ForbiddenException);
    await expect(mayAct(mgrB, P0, 'manager')).rejects.toThrow(/direct reports, or ones escalated to you/);
    expect(await mayAct(mgrB, P1, 'manager')).toBe('skip_manager');
    expect(await mayAct(mgrA, P0, 'manager')).toBe('manager');
    expect(await mayAct(mgrA, P1, 'manager')).toBe('manager');
    expect(await mayAct(mgrA, PX2, 'manager')).toBe('manager');
    await expect(mayAct(peer, P0, 'employee')).rejects.toThrow(ForbiddenException);
    // Self — through employees.user_id …
    await expect(mayAct(empX, P0, 'employee')).rejects.toThrow(/cannot approve your own timesheet/);
    await expect(mayAct(owner, PO, 'owner')).rejects.toThrow(/cannot approve your own timesheet/);
    // … and through the membership bridge (employees.user_id NULL).
    await expect(mayAct(SU, PS, 'owner')).rejects.toThrow(ForbiddenException);
    await expect(mayAct(SU, PS, 'owner')).rejects.toThrow(/cannot approve your own timesheet/);
    expect(await mayAct(owner, PS, 'owner')).toBe('org');
  });

  it('a manager seat is org-wide only by role: a manager with the owner role hint acts anywhere, a manager without an employee row has an empty queue', async () => {
    const noEmpUser = await mkUser('NoEmpMgr');
    await dbAdmin.insert(memberships).values({ tenant_id: T1, user_id: noEmpUser.id, role: 'manager', status: 'active', employee_id: null });
    expect(await timesheetService.listPending(noEmpUser.id, T1, {}, 'manager').then((r) => r.data)).toEqual([]);
    // …but an owner seat without an employee row still holds the L2 queue.
    const noEmpOwner = await mkUser('NoEmpOwner');
    await dbAdmin.insert(memberships).values({ tenant_id: T1, user_id: noEmpOwner.id, role: 'owner', status: 'active', employee_id: null });
    const q = await timesheetService.listPending(noEmpOwner.id, T1, { limit: 100 }, 'owner');
    expect(q.data.map((r) => r.id).sort()).toEqual([P2, PO, PS, PX2].sort());
    // These seats would otherwise join every later "owner + admin" recipient set.
    await dbAdmin.delete(memberships).where(inArray(memberships.user_id, [noEmpUser.id, noEmpOwner.id]));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. The sweep
// ═════════════════════════════════════════════════════════════════════════════

describe('Round L-B — runSweep', () => {
  let stale: string; // empX, submitted 25 h ago
  let fresh: string; // empY, submitted 1 h ago (reviewer-on-leave trigger)
  let orphan: string; // empNoMgr, level 0 legacy row (no manager at all)

  beforeAll(async () => {
    stale = await seedPeriod(empX, { submittedAt: new Date(Date.now() - 25 * H), routedManager: mgrA.employeeId });
  });

  it('level 0 older than 24 h ⇒ level 1 to the skip-level manager (sla) + one in-app + one escaped email; a rerun is a no-op', async () => {
    resetSpies();
    const r = await job.runSweep(new Date());
    expect(r.failed).toBe(0);
    expect(r.byKind.timesheet).toBeGreaterThanOrEqual(1);

    const row = await periodRow(stale);
    expect(row.escalation_level).toBe(1);
    expect(row.escalation_reason).toBe('sla');
    expect(row.escalated_to_employee_id).toBe(mgrB.employeeId);
    expect(row.escalated_at).toBeInstanceOf(Date);
    expect(Date.now() - row.escalated_at!.getTime()).toBeLessThan(60_000);
    expect(row.status).toBe('submitted');

    await waitFor(() => inAppCalls().some((c) => c[1] === 'timesheet.escalated' && c[3].includes(stale)));
    const pings = inAppCalls().filter((c) => c[1] === 'timesheet.escalated' && c[3].includes(stale));
    expect(pings).toHaveLength(1);
    expect(pings[0]![0]).toBe(mgrB.userId);
    expect(pings[0]![2]).toBe(
      `EmpX Tester's timesheet (week of ${fmtShortDate(row.period_start)}, 40h) was escalated to you — no action for 24 hours.`,
    );
    expect(pings[0]![3]).toBe(`/team/timesheets?period=${stale}`);
    expect(pings[0]![4]).toBe(T1);
    expect(pings[0]![5]).toEqual({ groupKey: `timesheet:${stale}` });

    const mails = mailCalls().filter((m) => m[0] === 'approval-escalated' && String(m[2].reviewUrl).includes(stale));
    expect(mails).toHaveLength(1);
    expect(mails[0]![1]).toBe(mgrB.email);
    expect(mails[0]![2]).toMatchObject({
      reviewerName: 'MgrB Tester',
      employeeName: 'EmpX Tester',
      kindLabel: 'timesheet',
      reasonText: 'no action for 24 hours',
      reviewUrl: `${APP_URL}/team/timesheets?period=${stale}`,
    });
    expect(mails[0]![3]).toEqual({ userId: mgrB.userId, event: 'timesheet_submitted' });
    // Nobody else: not the manager who sat on it, not HR yet.
    expect(inAppCalls().some((c) => c[3].includes(stale) && c[0] !== mgrB.userId)).toBe(false);

    // Rerun: nothing moves, nobody is pinged again.
    resetSpies();
    await job.runSweep(new Date());
    await settle();
    const again = await periodRow(stale);
    expect(again.escalation_level).toBe(1);
    expect(again.escalated_at!.getTime()).toBe(row.escalated_at!.getTime());
    expect(inAppCalls().some((c) => c[3].includes(stale))).toBe(false);
    expect(mailCalls().some((m) => String(m[2].reviewUrl).includes(stale))).toBe(false);
  });

  it('level 1 older than 24 h ⇒ level 2: owner + admin told, the two managers are not', async () => {
    await dbAdmin
      .update(timesheetPeriods)
      .set({ escalated_at: new Date(Date.now() - 25 * H) })
      .where(eq(timesheetPeriods.id, stale));
    resetSpies();
    const r = await job.runSweep(new Date());
    expect(r.failed).toBe(0);
    const row = await periodRow(stale);
    expect(row.escalation_level).toBe(2);
    expect(row.escalation_reason).toBe('sla');
    // The L1 stamp is KEPT on 1 → 2: the manager's manager still acts.
    expect(row.escalated_to_employee_id).toBe(mgrB.employeeId);
    expect(Date.now() - row.escalated_at!.getTime()).toBeLessThan(60_000);

    await waitFor(() => inAppCalls().filter((c) => c[1] === 'timesheet.escalated' && c[3].includes(stale)).length >= 3);
    await settle();
    const pings = inAppCalls().filter((c) => c[1] === 'timesheet.escalated' && c[3].includes(stale));
    // owner, admin and the bridged owner seat SU — never mgrA / mgrB / empX.
    expect(pings.map((c) => c[0]).sort()).toEqual([owner.userId, admin.userId, SU.userId].sort());
    const mails = mailCalls().filter((m) => m[0] === 'approval-escalated' && String(m[2].reviewUrl).includes(stale));
    expect(mails.map((m) => m[1]).sort()).toEqual([owner.email, admin.email, SU.email].sort());
    for (const m of mails) expect(m[2].levelLabel).toBe('as Owner / HR Admin');

    // Terminal: a third sweep changes nothing.
    resetSpies();
    await job.runSweep(new Date());
    await settle();
    expect((await periodRow(stale)).escalated_at!.getTime()).toBe(row.escalated_at!.getTime());
    expect(inAppCalls().some((c) => c[3].includes(stale))).toBe(false);

    // Earlier reviewers keep acting "when not closed": the manager's manager
    // still qualifies and still has the row in their queue; so does the
    // reporting manager.
    expect(await mayAct(mgrB, stale, 'manager')).toBe('skip_manager');
    expect(await mayAct(mgrA, stale, 'manager')).toBe('manager');
    expect((await timesheetService.listPending(mgrB.userId, T1, { limit: 100 }, 'manager')).data.map((r) => r.id)).toContain(stale);
    expect((await timesheetService.listTeam(mgrB.userId, T1, { status: 'submitted', limit: 100 }, 'manager')).data.map((r) => r.id)).toContain(stale);
  });

  it('the manager on approved full-day leave today ⇒ skipped immediately (reviewer_on_leave), no 24 h wait', async () => {
    fresh = await seedPeriod(empY, { submittedAt: new Date(Date.now() - H), routedManager: mgrA.employeeId });
    const leave = await approvedLeave(mgrA);
    try {
      resetSpies();
      const r = await job.runSweep(new Date());
      expect(r.failed).toBe(0);
      const row = await periodRow(fresh);
      expect(row.escalation_level).toBe(1);
      expect(row.escalation_reason).toBe('reviewer_on_leave');
      expect(row.escalated_to_employee_id).toBe(mgrB.employeeId);
      await waitFor(() => inAppCalls().some((c) => c[3].includes(fresh)));
      const ping = inAppCalls().find((c) => c[3].includes(fresh))!;
      expect(ping[0]).toBe(mgrB.userId);
      expect(ping[2]).toContain('their manager is on leave today');
    } finally {
      await dbAdmin.delete(leaveRequests).where(eq(leaveRequests.id, leave));
    }
  });

  it('a level-0 row whose applicant has no manager (legacy / manager removed) goes to HR right away (no_manager)', async () => {
    orphan = await seedPeriod(empNoMgr, { submittedAt: new Date(Date.now() - H) });
    resetSpies();
    const r = await job.runSweep(new Date());
    expect(r.failed).toBe(0);
    const row = await periodRow(orphan);
    expect(row.escalation_level).toBe(2);
    expect(row.escalation_reason).toBe('no_manager');
    await waitFor(() => inAppCalls().filter((c) => c[3].includes(orphan)).length >= 3);
    await settle();
    expect(inAppCalls().filter((c) => c[3].includes(orphan)).map((c) => c[0]).sort()).toEqual(
      [owner.userId, admin.userId, SU.userId].sort(),
    );
  });

  it('a stuck level-0 row with no valid skip-level manager (A ↔ B cycle) lands at level 2 as no_skip_manager', async () => {
    const cyc = await seedPeriod(cycA, { submittedAt: new Date(Date.now() - 25 * H), routedManager: cycB.employeeId });
    resetSpies();
    await job.runSweep(new Date());
    const row = await periodRow(cyc);
    expect(row.escalation_level).toBe(2);
    expect(row.escalation_reason).toBe('no_skip_manager');
    expect(row.escalated_to_employee_id).toBeNull();
  });

  it('decided rows are never touched, and the guarded UPDATE refuses a stale previous level', async () => {
    const done = await seedPeriod(peer, { submittedAt: new Date(Date.now() - 30 * H), routedManager: mgrB.employeeId, status: 'approved' });
    await job.runSweep(new Date());
    expect((await periodRow(done)).escalation_level).toBe(0);
    const moved = await dbSvc.withTenant(T1, (tx) =>
      routing.escalateTx(tx, T1, 'timesheet', stale, 0, 'sla', { level: 1, escalatedTo: mgrB.employeeId }),
    );
    expect(moved).toBeNull(); // it is at level 2, not 0
    expect((await periodRow(stale)).escalation_level).toBe(2);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. Timesheets end-to-end on the model
// ═════════════════════════════════════════════════════════════════════════════

describe('Round L-B — timesheets: submit without a manager, review, rework', () => {
  it('submit WITHOUT a reporting manager succeeds (was a 400) — level 2 no_manager, owner + admin told, and the owner can review', async () => {
    const id = await logHours(empNoMgr);
    resetSpies();
    const res = await timesheetService.submitTimesheet(empNoMgr.userId, T1, { timesheetPeriodId: id });
    expect(res.status).toBe('submitted');
    // Employee-facing: the level only — never the reason, never a name.
    expect(res.escalation).toEqual({ level: 2 });
    expect(res.withLabel).toBe('hr');
    const mine = await timesheetService.getMyCurrentPeriod(empNoMgr.userId, T1);
    expect(mine.escalation).toEqual({ level: 2 });
    expect(mine.withLabel).toBe('hr');
    expect(JSON.stringify(mine)).not.toContain('no_manager');
    const row = await periodRow(id);
    expect(row.escalation_level).toBe(2);
    expect(row.escalation_reason).toBe('no_manager');
    expect(row.approver_id).toBeNull();
    expect(row.routed_manager_employee_id).toBeNull();

    await waitFor(() => inAppCalls().filter((c) => c[1] === 'timesheet.submitted').length >= 3);
    await settle();
    const pings = inAppCalls().filter((c) => c[1] === 'timesheet.submitted');
    expect(pings.map((c) => c[0]).sort()).toEqual([owner.userId, admin.userId, SU.userId].sort());
    for (const c of pings) {
      expect(c[2]).toContain('no reporting manager is set');
      expect(c[3]).toBe(`/team/timesheets?period=${id}`);
      expect(c[5]).toEqual({ groupKey: `timesheet:${id}` });
    }
    const mails = mailCalls().filter((m) => m[0] === 'timesheet-submitted');
    expect(mails.map((m) => m[1]).sort()).toEqual([owner.email, admin.email, SU.email].sort());
    expect(mails.find((m) => m[1] === owner.email)![3]).toEqual({ userId: owner.userId, event: 'timesheet_submitted' });

    // In the owner's queue, not the manager's.
    expect((await timesheetService.listPending(owner.userId, T1, { limit: 100 }, 'owner')).data.map((r) => r.id)).toContain(id);
    expect((await timesheetService.listPending(mgrA.userId, T1, { limit: 100 }, 'manager')).data.map((r) => r.id)).not.toContain(id);

    const ok = await timesheetService.reviewTimesheet(id, owner.userId, T1, { action: 'approve' }, 'owner');
    expect(ok.status).toBe('approved');
    const after = await periodRow(id);
    expect(after.approver_id).toBe(owner.employeeId);
    expect(after.status).toBe('approved');
  });

  it('submit with a manager: level 0 with the manager snapshotted, only the manager told; the skip-level manager is 403, the owner acts directly', async () => {
    const id = await logHours(empX);
    resetSpies();
    const res = await timesheetService.submitTimesheet(empX.userId, T1, { timesheetPeriodId: id });
    expect(res.escalation).toBeNull();
    expect(res.withLabel).toBe('manager');
    const row = await periodRow(id);
    expect(row.escalation_level).toBe(0);
    expect(row.routed_manager_employee_id).toBe(mgrA.employeeId);
    expect(row.approver_id).toBe(mgrA.employeeId);
    await waitFor(() => inAppCalls().some((c) => c[1] === 'timesheet.submitted'));
    await settle();
    const pings = inAppCalls().filter((c) => c[1] === 'timesheet.submitted');
    expect(pings.map((c) => c[0])).toEqual([mgrA.userId]);
    expect(pings[0]![2]).toBe(`EmpX Tester submitted a timesheet for ${row.period_start}.`);

    await expect(
      timesheetService.reviewTimesheet(id, mgrB.userId, T1, { action: 'approve' }, 'manager'),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      timesheetService.getEntries(id, mgrB.userId, T1),
    ).rejects.toThrow(/Not allowed to view this timesheet/);
    // The owner opens it directly: may view and may act.
    const entries = await timesheetService.getEntries(id, owner.userId, T1);
    expect(entries.entries).toHaveLength(1);
    // The applicant never reviews their own.
    await expect(
      timesheetService.reviewTimesheet(id, empX.userId, T1, { action: 'approve' }, 'employee'),
    ).rejects.toThrow(/cannot approve your own timesheet/);

    // Team → Timesheets stays workspace-wide for the owner with the routing flags.
    const team = await timesheetService.listTeam(owner.userId, T1, { status: 'submitted', limit: 100 }, 'owner');
    expect(team.scope).toBe('org');
    const teamRow = team.data.find((r) => r.id === id)!;
    expect(teamRow.routedToMe).toBe(false);
    expect(teamRow.managerName).toBe('MgrA Tester');
    expect(teamRow.escalation).toBeNull();
    const mine = await timesheetService.listTeam(mgrA.userId, T1, { status: 'submitted', limit: 100 }, 'manager');
    expect(mine.scope).toBe('team');
    expect(mine.data.find((r) => r.id === id)!.routedToMe).toBe(true);

    // Rework by the owner (opened directly) resets the escalation fields and
    // clears the approver (recomputed from the route on resubmit); the routed
    // manager is told it was decided on their behalf.
    resetSpies();
    const rework = await timesheetService.reviewTimesheet(id, owner.userId, T1, { action: 'rework', comment: 'Split the meetings out' }, 'owner');
    expect(rework.status).toBe('draft');
    await waitFor(() => inAppCalls().some((c) => c[1] === 'timesheet.reviewed_on_behalf'));
    const behalf = inAppCalls().find((c) => c[1] === 'timesheet.reviewed_on_behalf')!;
    expect(behalf[0]).toBe(mgrA.userId);
    expect(behalf[2]).toBe("Owner Tester sent back for rework EmpX Tester's timesheet on your behalf.");
    expect(behalf[3]).toBe('/team/timesheets');
    expect(behalf[5]).toEqual({ groupKey: `timesheet:${id}` });
    const reset = await periodRow(id);
    expect(reset.status).toBe('draft');
    expect(reset.submitted_at).toBeNull();
    expect(reset.approver_id).toBeNull();
    expect(reset.escalation_level).toBe(0);
    expect(reset.escalated_at).toBeNull();
    expect(reset.escalation_reason).toBeNull();
    expect(reset.escalated_to_employee_id).toBeNull();
    expect(reset.routed_manager_employee_id).toBeNull();

    // Resubmit restarts the clock at level 0 with the manager (approver
    // recomputed from the route — not HR); the manager approves, and nobody
    // is told "on your behalf" for a manager's own decision.
    resetSpies();
    await timesheetService.submitTimesheet(empX.userId, T1, { timesheetPeriodId: id });
    const re = await periodRow(id);
    expect(re.status).toBe('submitted');
    expect(re.escalation_level).toBe(0);
    expect(re.approver_id).toBe(mgrA.employeeId);
    expect(re.routed_manager_employee_id).toBe(mgrA.employeeId);
    expect(Date.now() - re.submitted_at!.getTime()).toBeLessThan(60_000);
    const done = await timesheetService.reviewTimesheet(id, mgrA.userId, T1, { action: 'approve' }, 'manager');
    expect(done.status).toBe('approved');
    expect((await periodRow(id)).approver_id).toBe(mgrA.employeeId);
    await settle();
    expect(inAppCalls().some((c) => c[1] === 'timesheet.reviewed_on_behalf')).toBe(false);
  });

  it('submit while the manager is on approved leave today ⇒ level 1 straight to the skip-level manager, who may act', async () => {
    const id = await logHours(empY);
    const leave = await approvedLeave(mgrA);
    try {
      resetSpies();
      const res = await timesheetService.submitTimesheet(empY.userId, T1, { timesheetPeriodId: id });
      // The employee learns the level, never that their manager is on leave.
      expect(res.escalation).toEqual({ level: 1 });
      expect(res.withLabel).toBe('manager');
      const row = await periodRow(id);
      expect(row.escalated_to_employee_id).toBe(mgrB.employeeId);
      expect(row.routed_manager_employee_id).toBe(mgrA.employeeId);
      await waitFor(() => inAppCalls().some((c) => c[1] === 'timesheet.submitted'));
      await settle();
      const pings = inAppCalls().filter((c) => c[1] === 'timesheet.submitted');
      expect(pings.map((c) => c[0])).toEqual([mgrB.userId]);
      expect(pings[0]![2]).toContain('their manager is on leave today');
      const ok = await timesheetService.reviewTimesheet(id, mgrB.userId, T1, { action: 'reject', comment: 'Hours look off' }, 'manager');
      expect(ok.status).toBe('rejected');
      expect((await periodRow(id)).approver_id).toBe(mgrB.employeeId);
    } finally {
      await dbAdmin.delete(leaveRequests).where(eq(leaveRequests.id, leave));
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5b. Review-round pins — leave + regularization sweeps, the skip-level
//     manager keeps acting at level 2, dashboard timesheets, tenant isolation,
//     reviewer liveness, non-reviewer roles
// ═════════════════════════════════════════════════════════════════════════════

describe('Round L-B — leave + regularization sweeps; earlier reviewers keep acting', () => {
  let leaveId: string;
  let regId: string;

  beforeAll(async () => {
    const [l] = await dbAdmin
      .insert(leaveRequests)
      .values({
        tenant_id: T1,
        employee_id: empX.employeeId!,
        leave_type_id: leaveTypeId,
        start_date: '2026-11-02',
        end_date: '2026-11-03',
        total_days: 2,
        status: 'pending',
        reason: 'Fix-round leave sweep',
        applied_at: new Date(Date.now() - 25 * H),
        routed_manager_employee_id: mgrA.employeeId,
      })
      .returning();
    leaveId = l!.id;
  });

  it('leave: applied_at 25 h ago ⇒ level 1 to mgrB with the leave deep link — and Team → Leave lists it for mgrB', async () => {
    resetSpies();
    const res = await job.runSweep(new Date());
    expect(res.failed).toBe(0);
    expect(res.byKind.leave).toBeGreaterThanOrEqual(1);
    const [row] = await dbAdmin.select().from(leaveRequests).where(eq(leaveRequests.id, leaveId));
    expect(row!.escalation_level).toBe(1);
    expect(row!.escalation_reason).toBe('sla');
    expect(row!.escalated_to_employee_id).toBe(mgrB.employeeId);

    await waitFor(() => inAppCalls().some((c) => c[1] === 'leave.escalated' && c[3].includes(leaveId)));
    const ping = inAppCalls().find((c) => c[1] === 'leave.escalated' && c[3].includes(leaveId))!;
    expect(ping[0]).toBe(mgrB.userId);
    expect(ping[3]).toBe(`/team/leave?request=${leaveId}`);
    expect(ping[2]).toBe("EmpX Tester's leave request (Casual Leave, 2–3 Nov, 2 days) was escalated to you — no action for 24 hours.");
    const mail = mailCalls().find((m) => m[0] === 'approval-escalated' && String(m[2].reviewUrl).includes(leaveId))!;
    expect(mail[1]).toBe(mgrB.email);
    expect(mail[2].summary).toBe('Casual Leave, 2–3 Nov, 2 days');
    expect(mail[3]).toEqual({ userId: mgrB.userId, event: 'leave_requested' });

    // The deep link lands on Team → Leave: a manager's page must list what
    // was escalated to them, not only their direct reports.
    const team = await leaveService.listTeam(mgrB.userId, T1, { status: 'pending', limit: 100 }, 'manager');
    expect(team.scope).toBe('team');
    const teamRow = team.data.find((r) => r.id === leaveId);
    expect(teamRow).toBeDefined();
    expect(teamRow!.routedToMe).toBe(true);
    expect(teamRow!.managerName).toBe('MgrA Tester');
    expect(teamRow!.escalation).toMatchObject({ level: 1, reason: 'sla', toName: 'MgrB Tester' });
    expect((await leaveService.listPending(mgrB.userId, T1, {}, 'manager')).data.map((r) => r.id)).toContain(leaveId);
    // The reporting manager keeps it too (direct report), flagged as escalated.
    const mine = await leaveService.listPending(mgrA.userId, T1, {}, 'manager');
    expect(mine.data.find((r) => r.id === leaveId)!.escalation).toMatchObject({ level: 1, toName: 'MgrB Tester' });
  });

  it('leave: another 25 h ⇒ level 2 — HR told, the L1 stamp kept, mgrB still acts (skip_manager) and mgrA is told on their behalf', async () => {
    await dbAdmin.update(leaveRequests).set({ escalated_at: new Date(Date.now() - 25 * H) }).where(eq(leaveRequests.id, leaveId));
    resetSpies();
    await job.runSweep(new Date());
    const [row] = await dbAdmin.select().from(leaveRequests).where(eq(leaveRequests.id, leaveId));
    expect(row!.escalation_level).toBe(2);
    expect(row!.escalation_reason).toBe('sla');
    expect(row!.escalated_to_employee_id).toBe(mgrB.employeeId);
    await waitFor(() => inAppCalls().filter((c) => c[1] === 'leave.escalated' && c[3].includes(leaveId)).length >= 3);
    await settle();
    expect(
      inAppCalls().filter((c) => c[1] === 'leave.escalated' && c[3].includes(leaveId)).map((c) => c[0]).sort(),
    ).toEqual([owner.userId, admin.userId, SU.userId].sort());

    expect(
      await mayActOn(mgrB, { applicantEmployeeId: empX.employeeId!, level: 2, escalatedTo: row!.escalated_to_employee_id }, 'manager', 'leave'),
    ).toBe('skip_manager');
    expect((await leaveService.listPending(mgrB.userId, T1, {}, 'manager')).data.map((r) => r.id)).toContain(leaveId);
    expect((await leaveService.listTeam(mgrB.userId, T1, { status: 'pending', limit: 100 }, 'manager')).data.map((r) => r.id)).toContain(leaveId);
    // Owner/admin see it as HR's, with the manager chip data intact.
    const ownerTeam = await leaveService.listTeam(owner.userId, T1, { status: 'pending', limit: 100 }, 'owner');
    expect(ownerTeam.data.find((r) => r.id === leaveId)!).toMatchObject({ routedToMe: true, managerName: 'MgrA Tester' });

    // mgrB decides it: the routed manager (mgrA) is told on their behalf.
    resetSpies();
    const ok = await leaveService.reviewLeave(leaveId, mgrB.userId, T1, { action: 'reject', comment: 'Coverage gap' }, 'manager');
    expect(ok.status).toBe('rejected');
    await waitFor(() => inAppCalls().some((c) => c[1] === 'leave.reviewed_on_behalf'));
    await settle();
    const behalf = inAppCalls().filter((c) => c[1] === 'leave.reviewed_on_behalf');
    expect(behalf.map((c) => c[0])).toEqual([mgrA.userId]);
    expect(behalf[0]![2]).toBe("MgrB Tester rejected EmpX Tester's leave request on your behalf.");
    expect(behalf[0]![3]).toBe('/team/leave');
    expect(behalf[0]![5]).toEqual({ groupKey: `leave:${leaveId}` });
  });

  it('regularization: created_at 25 h ago ⇒ level 1 (Inbox deep link) ⇒ level 2; GET :id — owner 200, unrelated manager / foreign caller / other tenant / decided row 404; on-behalf notice on decision', async () => {
    // Seeded HERE (not in beforeAll) so the sweep that moves it is this
    // test's own — the leave test's sweeps above must not consume it first.
    const [r] = await dbAdmin
      .insert(attendanceRegularizations)
      .values({
        tenant_id: T1,
        employee_id: empY.employeeId!,
        attendance_date: '2026-08-03',
        request_type: 'missing_punch',
        reason: 'Fix-round regularization sweep',
        status: 'pending',
        created_at: new Date(Date.now() - 25 * H),
        routed_manager_employee_id: mgrA.employeeId,
      })
      .returning();
    regId = r!.id;
    resetSpies();
    await job.runSweep(new Date());
    let [row] = await dbAdmin.select().from(attendanceRegularizations).where(eq(attendanceRegularizations.id, regId));
    expect(row!.escalation_level).toBe(1);
    expect(row!.escalated_to_employee_id).toBe(mgrB.employeeId);
    await waitFor(() => inAppCalls().some((c) => c[1] === 'regularization.escalated' && c[3].includes(regId)));
    const ping = inAppCalls().find((c) => c[1] === 'regularization.escalated' && c[3].includes(regId))!;
    expect(ping[0]).toBe(mgrB.userId);
    expect(ping[3]).toBe(`/inbox?tab=approvals&request=${regId}`);
    expect(ping[2]).toBe("EmpY Tester's regularization request (missing punch, 3 Aug) was escalated to you — no action for 24 hours.");
    const mail = mailCalls().find((m) => m[0] === 'approval-escalated' && String(m[2].reviewUrl).includes(regId))!;
    expect(mail[3]).toEqual({ userId: mgrB.userId, event: 'regularization_requested' });
    expect((await attendanceService.listPendingRegularizations(mgrB.userId, T1, {}, 'manager')).data.map((r) => r.id)).toContain(regId);

    await dbAdmin.update(attendanceRegularizations).set({ escalated_at: new Date(Date.now() - 25 * H) }).where(eq(attendanceRegularizations.id, regId));
    resetSpies();
    await job.runSweep(new Date());
    [row] = await dbAdmin.select().from(attendanceRegularizations).where(eq(attendanceRegularizations.id, regId));
    expect(row!.escalation_level).toBe(2);
    expect(row!.escalation_reason).toBe('sla');
    expect(row!.escalated_to_employee_id).toBe(mgrB.employeeId);
    await waitFor(() => inAppCalls().filter((c) => c[1] === 'regularization.escalated' && c[3].includes(regId)).length >= 3);

    // GET attendance/regularizations/:id — the "open directly" surface.
    const direct = await attendanceService.getRegularizationForReviewer(regId, owner.userId, T1, 'owner');
    expect(direct).toMatchObject({
      id: regId,
      employeeId: empY.employeeId,
      userId: empY.userId,
      employeeName: 'EmpY Tester',
      attendanceDate: '2026-08-03',
      requestType: 'missing_punch',
      reason: 'Fix-round regularization sweep',
      status: 'pending',
      avatarUrl: null,
      proposedInTime: null,
      proposedOutTime: null,
    });
    expect(direct.escalation).toMatchObject({ level: 2, reason: 'sla', toName: 'MgrB Tester' });
    expect(typeof direct.requestedAt).toBe('string');
    // An unrelated manager, a caller with no seat here, or the wrong tenant: 404, never 403.
    await expect(attendanceService.getRegularizationForReviewer(regId, cycA.userId, T1, 'manager')).rejects.toThrow(NotFoundException);
    await expect(attendanceService.getRegularizationForReviewer(regId, Z.userId, T1)).rejects.toThrow(NotFoundException);
    await expect(attendanceService.getRegularizationForReviewer(regId, owner.userId, T2, 'owner')).rejects.toThrow(NotFoundException);
    const [decided] = await dbAdmin
      .insert(attendanceRegularizations)
      .values({ tenant_id: T1, employee_id: empY.employeeId!, attendance_date: '2026-08-04', request_type: 'missing_punch', reason: 'done', status: 'approved' })
      .returning();
    await expect(attendanceService.getRegularizationForReviewer(decided!.id, owner.userId, T1, 'owner')).rejects.toThrow(NotFoundException);

    // The owner decides it directly: both the routed manager and the skip-level manager are told.
    resetSpies();
    const ok = await attendanceService.reviewRegularization(regId, owner.userId, T1, { action: 'approve', comment: 'Fine' }, 'owner');
    expect(ok.status).toBe('approved');
    await waitFor(() => inAppCalls().filter((c) => c[1] === 'regularization.reviewed_on_behalf').length >= 2);
    await settle();
    const behalf = inAppCalls().filter((c) => c[1] === 'regularization.reviewed_on_behalf');
    expect(behalf.map((c) => c[0]).sort()).toEqual([mgrA.userId, mgrB.userId].sort());
    for (const c of behalf) {
      expect(c[2]).toBe("Owner Tester approved EmpY Tester's regularization request on your behalf.");
      expect(c[3]).toBe('/inbox?tab=approvals');
    }
  });
});

describe('Round L-B — dashboard timesheets, tenant isolation, reviewer liveness, non-reviewer roles', () => {
  it('getAdminOverview: pending.timesheets carries the Inbox row shape and stats.pendingApprovals counts timesheets', async () => {
    const seeded = await seedPeriod(empNoMgr, { level: 2, escalatedAt: new Date(), reason: 'no_manager' });
    const ov = await dashboardService.getAdminOverview(T1, {
      callerUserId: owner.userId, includeOnboarding: false, includeApprovals: true, pendingLimit: 50,
    });
    expect(ov.pending.timesheetCount).toBeGreaterThanOrEqual(1);
    expect(ov.pending.timesheets.length).toBe(Math.min(50, ov.pending.timesheetCount));
    const row = ov.pending.timesheets.find((t) => t.id === seeded)!;
    expect(row).toBeDefined();
    expect(Object.keys(row).sort()).toEqual(
      ['id', 'employeeId', 'userId', 'employeeName', 'employeeCode', 'periodStart', 'periodEnd', 'totalHours', 'totalBillableHours', 'submittedAt', 'avatarUrl', 'escalation'].sort(),
    );
    expect(row).toMatchObject({ employeeId: empNoMgr.employeeId, userId: empNoMgr.userId, employeeName: 'NoMgr Tester', totalHours: 40, totalBillableHours: 30, avatarUrl: null });
    expect(row.escalation).toEqual({ level: 2, reason: 'no_manager', at: expect.any(String), toName: null });
    expect(typeof row.submittedAt).toBe('string');
    expect(ov.stats.pendingApprovals).toBe(
      ov.pending.leaveCount + ov.pending.regularizationCount + ov.pending.timesheetCount + ov.pending.onboardingCount,
    );
    // A manager's team-scoped overview never lists someone else's level-2 item.
    const team = await dashboardService.getAdminOverview(T1, {
      callerUserId: mgrA.userId, includeOnboarding: false, includeApprovals: true, scope: 'team', pendingLimit: 50,
    });
    expect(team.pending.timesheets.map((t) => t.id)).not.toContain(seeded);
  });

  it('a T2 open item is untouched by the sweep and nobody in T2 is told; cross-tenant ids are 404 on review / entries', async () => {
    const [zp] = await dbAdmin
      .insert(timesheetPeriods)
      .values({
        tenant_id: T2, employee_id: zEmp.employeeId!, period_start: '2026-03-02', period_end: '2026-03-08',
        status: 'submitted', total_hours: 40, submitted_at: new Date(Date.now() - H), routed_manager_employee_id: Z.employeeId,
      })
      .returning();
    resetSpies();
    const r = await job.runSweep(new Date());
    expect(r.failed).toBe(0);
    await settle();
    const [row] = await dbAdmin.select().from(timesheetPeriods).where(eq(timesheetPeriods.id, zp!.id));
    expect(row!.escalation_level).toBe(0);
    expect(row!.escalated_at).toBeNull();
    expect(inAppCalls().some((c) => c[0] === Z.userId || c[0] === zEmp.userId || c[4] === T2)).toBe(false);
    expect(mailCalls().some((m) => m[1] === Z.email || m[1] === zEmp.email)).toBe(false);
    await expect(
      timesheetService.reviewTimesheet(zp!.id, owner.userId, T1, { action: 'approve' }, 'owner'),
    ).rejects.toThrow(NotFoundException);
    await expect(timesheetService.getEntries(zp!.id, owner.userId, T1)).rejects.toThrow(NotFoundException);
    // …and the T2 owner's routed queue in T2 holds it as the direct manager, untouched.
    expect((await timesheetService.listPending(Z.userId, T2, { limit: 100 }, 'owner')).data.map((p) => p.id)).toContain(zp!.id);
  });

  it('a DEACTIVATED manager seat cannot act and has an empty queue — and is no reviewer for their reports (HR holds the item)', async () => {
    const p = await seedPeriod(empY, { routedManager: mgrA.employeeId });
    await dbAdmin.update(memberships).set({ status: 'deactivated' }).where(and(eq(memberships.tenant_id, T1), eq(memberships.user_id, mgrA.userId)));
    try {
      expect((await timesheetService.listPending(mgrA.userId, T1, { limit: 100 }, 'manager')).data).toEqual([]);
      await expect(mayAct(mgrA, p, 'manager')).rejects.toThrow(ForbiddenException);
      const reviewer = await dbSvc.withTenant(T1, (tx) => routing.resolveReviewerTx(tx, T1, mgrA.userId, 'manager'));
      expect(reviewer.employeeId).toBeNull();
      const route = await dbSvc.withTenant(T1, (tx) => routing.resolveRouteTx(tx, T1, empY.employeeId!));
      expect(route.l0).toBeNull();
      expect((await timesheetService.listPending(owner.userId, T1, { limit: 100 }, 'owner')).data.map((r) => r.id)).toContain(p);
    } finally {
      await dbAdmin.update(memberships).set({ status: 'active' }).where(and(eq(memberships.tenant_id, T1), eq(memberships.user_id, mgrA.userId)));
    }
    // Back to normal: mgrA is the reviewer again and the owner's queue drops it.
    expect(await mayAct(mgrA, p, 'manager')).toBe('manager');
    expect((await timesheetService.listPending(owner.userId, T1, { limit: 100 }, 'owner')).data.map((r) => r.id)).not.toContain(p);
  });

  it('a manager whose user is suspended, or whose employee row is separated, is no reviewer; an active seat with employee_id NULL still bridges', async () => {
    await dbAdmin.update(users).set({ status: 'suspended' }).where(eq(users.id, mgrA.userId));
    try {
      expect((await dbSvc.withTenant(T1, (tx) => routing.resolveRouteTx(tx, T1, empX.employeeId!))).l0).toBeNull();
    } finally {
      await dbAdmin.update(users).set({ status: 'active' }).where(eq(users.id, mgrA.userId));
    }
    await dbAdmin.update(employees).set({ status: 'separated' }).where(eq(employees.id, mgrA.employeeId!));
    try {
      expect((await dbSvc.withTenant(T1, (tx) => routing.resolveRouteTx(tx, T1, empX.employeeId!))).l0).toBeNull();
    } finally {
      await dbAdmin.update(employees).set({ status: 'active' }).where(eq(employees.id, mgrA.employeeId!));
    }
    expect((await dbSvc.withTenant(T1, (tx) => routing.resolveRouteTx(tx, T1, empX.employeeId!))).l0?.employeeId).toBe(mgrA.employeeId);
    // The employees.user_id fallback: an ACTIVE seat that never got employee_id stamped.
    await dbAdmin.update(memberships).set({ employee_id: null }).where(and(eq(memberships.tenant_id, T1), eq(memberships.user_id, mgrA.userId)));
    try {
      const reviewer = await dbSvc.withTenant(T1, (tx) => routing.resolveReviewerTx(tx, T1, mgrA.userId, 'manager'));
      expect(reviewer.employeeId).toBe(mgrA.employeeId);
    } finally {
      await dbAdmin.update(memberships).set({ employee_id: mgrA.employeeId! }).where(and(eq(memberships.tenant_id, T1), eq(memberships.user_id, mgrA.userId)));
    }
  });

  it('finance and guest seats can never act and have empty queues', async () => {
    const p = await seedPeriod(empY, { routedManager: mgrA.employeeId });
    await expect(mayAct(fin, p, 'finance')).rejects.toThrow(ForbiddenException);
    await expect(mayAct(guest, p, 'guest')).rejects.toThrow(ForbiddenException);
    expect((await timesheetService.listPending(fin.userId, T1, { limit: 100 }, 'finance')).data).toEqual([]);
    expect((await timesheetService.listPending(guest.userId, T1, { limit: 100 }, 'guest')).data).toEqual([]);
  });

  it('level-2 recipients exclude invited / deactivated owner+admin seats and suspended users', async () => {
    const invited = await mkUser('AdminInvited');
    await dbAdmin.insert(memberships).values({ tenant_id: T1, user_id: invited.id, role: 'admin', status: 'invited', employee_id: null });
    const deact = await mkUser('OwnerDeact');
    await dbAdmin.insert(memberships).values({ tenant_id: T1, user_id: deact.id, role: 'owner', status: 'deactivated', employee_id: null });
    const suspended = await mkUser('AdminSuspended');
    await dbAdmin.update(users).set({ status: 'suspended' }).where(eq(users.id, suspended.id));
    await dbAdmin.insert(memberships).values({ tenant_id: T1, user_id: suspended.id, role: 'admin', status: 'active', employee_id: null });
    try {
      const route = await dbSvc.withTenant(T1, (tx) => routing.resolveRouteTx(tx, T1, empX.employeeId!));
      const ids = route.l2.map((r) => r.userId);
      expect(ids).not.toContain(invited.id);
      expect(ids).not.toContain(deact.id);
      expect(ids).not.toContain(suspended.id);
      expect([...ids].sort()).toEqual([owner.userId, admin.userId, SU.userId].sort());
      expect(routing.recipientsFor(route, 2).map((r) => r.userId).sort()).toEqual([owner.userId, admin.userId, SU.userId].sort());
    } finally {
      await dbAdmin.delete(memberships).where(inArray(memberships.user_id, [invited.id, deact.id, suspended.id]));
    }
  });

  it('submitTimesheet never stamps an out-of-tenant approver_id — a foreign reporting_manager_id is "no manager"', async () => {
    await dbAdmin.update(employees).set({ reporting_manager_id: zEmp.employeeId! }).where(eq(employees.id, empSelf.employeeId!));
    try {
      const id = await logHours(empSelf);
      resetSpies();
      const res = await timesheetService.submitTimesheet(empSelf.userId, T1, { timesheetPeriodId: id });
      expect(res.withLabel).toBe('hr');
      const row = await periodRow(id);
      expect(row.approver_id).toBeNull();
      expect(row.escalation_level).toBe(2);
      expect(row.escalation_reason).toBe('no_manager');
      expect(row.routed_manager_employee_id).toBeNull();
      await settle();
      expect(inAppCalls().some((c) => c[0] === Z.userId || c[0] === zEmp.userId)).toBe(false);
    } finally {
      await dbAdmin.update(employees).set({ reporting_manager_id: empSelf.employeeId! }).where(eq(employees.id, empSelf.employeeId!));
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. Templates + preference mapping
// ═════════════════════════════════════════════════════════════════════════════

describe('Round L-B — templates escape every string; in-app types map to the right preference', () => {
  it('approval-escalated: a <script> name is escaped, the href is entity-escaped, the "nothing changes" line is there', () => {
    const reviewUrl = `${APP_URL}/team/timesheets?period=abc-123&x=1`;
    const out = renderTemplate('approval-escalated', {
      reviewerName: 'Jagan <b>S</b>',
      employeeName: '<script>alert("x")</script>',
      kindLabel: 'timesheet',
      summary: 'week 2026-09-07 – 2026-09-13 · <i>40</i>h',
      reasonText: 'no action for 24 hours',
      levelLabel: "as the manager's manager",
      reviewUrl,
    });
    expect(out.html).not.toContain('<script>');
    expect(out.html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(out.html).not.toContain('<b>S</b>');
    expect(out.html).toContain('Jagan &lt;b&gt;S&lt;/b&gt;');
    expect(out.html).not.toContain('<i>40</i>');
    expect(out.html).toContain(`href="${APP_URL}/team/timesheets?period=abc-123&amp;x=1"`);
    expect(out.html).toContain('>Review now</a>');
    expect(out.html).toContain('Nothing changes until you confirm in the app.');
    expect(out.html).toContain("as the manager&#39;s manager".replace('&#39;', "'"));
    expect(out.subject).toBe(`Escalated: <script>alert("x")</script>'s timesheet needs your review`);
  });

  it('coupon-redeemed: subject "Coupon <CODE> applied — <N> free month(s)", body escapes the tenant name and code', () => {
    const one = renderTemplate('coupon-redeemed', {
      tenantName: '<img src=x onerror=alert(1)>',
      code: 'found<er',
      months: 1,
      trialEndsAt: '31 Dec 2026',
      billingUrl: `${APP_URL}/settings/billing`,
    });
    expect(one.subject).toBe('Coupon FOUND<ER applied — 1 free month');
    expect(one.html).not.toContain('<img');
    expect(one.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(one.html).toContain('FOUND&lt;ER');
    expect(one.html).toContain('31 Dec 2026');
    expect(one.html).toContain(`href="${APP_URL}/settings/billing"`);
    const three = renderTemplate('coupon-redeemed', {
      tenantName: 'Acme', code: 'launch3', months: 3, trialEndsAt: '1 Jan 2027', billingUrl: `${APP_URL}/settings/billing`,
    });
    expect(three.subject).toBe('Coupon LAUNCH3 applied — 3 free months');
    expect(three.html).toContain('<strong>3 free months</strong>');
  });

  it('eventForInAppType: approver-side rows (requested / escalated / decided on your behalf) follow the "requested"-side preference of their kind', () => {
    expect(emailEventForInAppType('leave.escalated')).toBe('leave_requested');
    expect(emailEventForInAppType('leave.requested')).toBe('leave_requested');
    expect(emailEventForInAppType('leave.reviewed_on_behalf')).toBe('leave_requested');
    expect(emailEventForInAppType('leave.approved')).toBe('leave_reviewed');
    expect(emailEventForInAppType('regularization.escalated')).toBe('regularization_requested');
    expect(emailEventForInAppType('regularization.reviewed_on_behalf')).toBe('regularization_requested');
    expect(emailEventForInAppType('regularization.rejected')).toBe('regularization_reviewed');
    expect(emailEventForInAppType('timesheet.escalated')).toBe('timesheet_submitted');
    expect(emailEventForInAppType('timesheet.submitted')).toBe('timesheet_submitted');
    expect(emailEventForInAppType('timesheet.reviewed_on_behalf')).toBe('timesheet_submitted');
    expect(emailEventForInAppType('timesheet.approve')).toBe('timesheet_reviewed');
  });
});
