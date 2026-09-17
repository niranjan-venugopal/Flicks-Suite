/**
 * Founder round I (2026-09-09) — five production items, one security rule.
 *
 *  1. Closed deals are trackable: GET /crm/deals lists won + lost deals with
 *     outcome, close date, stage/owner/company names and the lost reason;
 *     filters, pagination, tenant isolation, reopen removes from the list.
 *  2. "Mark as lost" never dead-ends: default lost reasons self-heal for
 *     tenants created after migration 0032 (race-safe — N concurrent first
 *     hits seed exactly six), custom reasons are never touched, a note-only
 *     lost is accepted, and a foreign/stray lost_reason_id is rejected.
 *  3. Manager numbers agree: the dashboard's "Direct reports" tile is the
 *     manager-scoped headcount (scope=team) and equals GET /employees/team/me,
 *     which now excludes separated + removed staff. A manager seat without an
 *     employee row has an EMPTY team — never the whole workspace.
 *  4. The leave-request email carries Approve / Reject / Review deep links
 *     (which only open the request — nothing acts until confirmed in the
 *     app), is preference-gated, and escapes every interpolated string.
 *  5. Team leave / timesheets: managers see (and may decide on) ONLY their
 *     direct reports' requests; owner/admin stay workspace-wide. New team
 *     lists for leave (any status, date window) and timesheets (any status,
 *     unstamped approver self-healed on review).
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
  leaveTypes,
  leaveRequests,
  attendanceRegularizations,
  timesheetPeriods,
  pipelines,
  pipelineStages,
  lostReasons,
  deals,
  directoryCompanies,
} from '@flicks/db/schema';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../core/database/database.service';
import { EmployeesService } from '../modules/employees/employees.service';
import { DashboardService } from '../modules/dashboard/dashboard.service';
import { LeaveService } from '../modules/leave/leave.service';
import { AttendanceService } from '../modules/attendance/attendance.service';
import { TimesheetService } from '../modules/timesheet/timesheet.service';
import { ApprovalRoutingService } from '../modules/approvals/approval-routing.service';
import { NotificationsService } from '../modules/notifications/notifications.service';
import { DealsService } from '../modules/crm/deals.service';
import { PipelinesService } from '../modules/crm/pipelines.service';
import { FxService } from '../modules/crm/fx.service';
import { DEFAULT_LOST_REASONS } from '../modules/crm/lost-reasons.seed';
import type { AuditService } from '../modules/audit/audit.service';
import type { AuthService } from '../modules/auth/auth.service';
import type { MediaService } from '../modules/media/media.service';
import type { InvoicingPublicService } from '../modules/invoicing/public';

jest.setTimeout(60_000);

const rid = () => crypto.randomBytes(4).toString('hex');
const APP_URL = 'https://app.roundi.test';

/** Notifications are fire-and-forget by design (house rule 6) — poll. */
async function waitFor(pred: () => boolean, ms = 4000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const audit = { log: async () => {} } as unknown as AuditService;
const createInAppNotification = jest.fn(async () => undefined);
const sendEmail = jest.fn(async () => true);
const notifications = { createInAppNotification, sendEmail } as unknown as NotificationsService;
const media = {
  servedUrl: async (k: string | null, l: string | null) => (k ? `signed:${k}` : l),
} as unknown as MediaService;

const dbSvc = new DatabaseService();
const emitter = new EventEmitter2();
const eventsStub = { publish: jest.fn(async () => 'evt') };

const employeesService = new EmployeesService(
  dbSvc,
  dbAdmin as never,
  audit,
  notifications,
  emitter,
  new ConfigService({ NODE_ENV: 'test' }),
  {} as unknown as AuthService,
  media,
);
const dashboardService = new DashboardService(dbSvc, media);
const leaveService = new LeaveService(
  dbSvc,
  audit,
  notifications,
  new ConfigService({ NODE_ENV: 'test', APP_URL }),
);
const attendanceService = new AttendanceService(dbSvc, dbAdmin as never, audit, notifications);
// Round L: timesheets route through ApprovalRoutingService (same stubbed notifications).
const timesheetService = new TimesheetService(
  dbAdmin as never,
  dbSvc,
  audit,
  notifications,
  new ApprovalRoutingService(notifications, new ConfigService({ NODE_ENV: 'test', APP_URL })),
);
const realNotifications = new NotificationsService(db as never, dbAdmin as never, new ConfigService({ NODE_ENV: 'test', APP_URL }), emitter);

const fx = new FxService(dbAdmin as never, { get: () => undefined } as never);
// The invoicing facade is only used by deal→invoice/quote, which this round
// never exercises.
const invoicingStub = {} as unknown as InvoicingPublicService;
const dealsService = new DealsService(dbSvc, audit, eventsStub as never, fx, emitter, invoicingStub);
const pipelinesService = new PipelinesService(dbSvc, audit);

// ─── Fixtures ────────────────────────────────────────────────────────────────

let T1: string; // main tenant
const extraTenants: string[] = [];
const userIds: string[] = [];

type Person = { userId: string; employeeId: string; email: string };
let O: Person; // owner
let M: Person; // manager with reports
let M2: Person; // manager without reports
let R1: Person; let R2: Person; let R3: Person; // active direct reports of M
let R4: Person; // separated report of M
let R5: Person; // soft-deleted report of M
let X1: Person; let X2: Person; let X3: Person; // unrelated employees (report to M2)
let N: { userId: string }; // manager membership WITHOUT an employee row
let leaveTypeId: string;

async function mkUser(label: string) {
  const email = `ri-${label}-${rid()}@t.test`;
  const [u] = await dbAdmin.insert(users).values({ email, full_name: `${label} Tester`, status: 'active' }).returning();
  userIds.push(u!.id);
  return { id: u!.id, email };
}

async function mkPerson(
  tenantId: string,
  label: string,
  role: 'owner' | 'admin' | 'manager' | 'employee',
  opts: { managerId?: string; status?: 'active' | 'separated'; deleted?: boolean } = {},
): Promise<Person> {
  const u = await mkUser(label);
  const [e] = await dbAdmin
    .insert(employees)
    .values({
      tenant_id: tenantId,
      user_id: u.id,
      employee_code: `RI-${rid()}`,
      first_name: label,
      last_name: 'Tester',
      work_email: u.email,
      date_of_joining: '2026-01-01',
      status: opts.status ?? 'active',
      reporting_manager_id: opts.managerId ?? null,
      ...(opts.deleted ? { deleted_at: new Date() } : {}),
    })
    .returning();
  await dbAdmin.insert(memberships).values({
    tenant_id: tenantId,
    user_id: u.id,
    role,
    status: 'active',
    employee_id: e!.id,
  });
  return { userId: u.id, employeeId: e!.id, email: u.email };
}

async function mkTenant(label: string, withPipeline = true): Promise<string> {
  const [t] = await dbAdmin
    .insert(tenants)
    .values({ name: `RI ${label} ${rid()}`, slug: `ri-${label}-${rid()}-${Date.now()}`, status: 'active', currency: 'INR' })
    .returning();
  if (withPipeline) {
    const [pl] = await dbAdmin.insert(pipelines).values({ tenant_id: t!.id, name: 'Sales', is_default: true }).returning();
    await dbAdmin.insert(pipelineStages).values([
      { tenant_id: t!.id, pipeline_id: pl!.id, name: 'Qualified', display_order: 0, win_probability: 10, stage_type: 'open' },
      { tenant_id: t!.id, pipeline_id: pl!.id, name: 'Proposal', display_order: 1, win_probability: 60, stage_type: 'open' },
      { tenant_id: t!.id, pipeline_id: pl!.id, name: 'Won', display_order: 2, win_probability: 100, stage_type: 'won' },
      { tenant_id: t!.id, pipeline_id: pl!.id, name: 'Lost', display_order: 3, win_probability: 0, stage_type: 'lost' },
    ]);
  }
  return t!.id;
}

async function seedPendingLeave(tenantId: string, p: Person, start: string, end: string, days = 1) {
  const [r] = await dbAdmin
    .insert(leaveRequests)
    .values({
      tenant_id: tenantId,
      employee_id: p.employeeId,
      leave_type_id: leaveTypeId,
      start_date: start,
      end_date: end,
      total_days: days,
      reason: 'Round I fixture',
      status: 'pending',
    })
    .returning();
  return r!.id;
}

async function seedRegularization(tenantId: string, p: Person, date: string) {
  const [r] = await dbAdmin
    .insert(attendanceRegularizations)
    .values({
      tenant_id: tenantId,
      employee_id: p.employeeId,
      attendance_date: date,
      request_type: 'missing_punch',
      reason: 'Round I fixture',
      status: 'pending',
    })
    .returning();
  return r!.id;
}

async function seedPeriod(tenantId: string, p: Person, start: string, end: string, status: 'draft' | 'submitted' | 'approved', approverId: string | null) {
  const [r] = await dbAdmin
    .insert(timesheetPeriods)
    .values({
      tenant_id: tenantId,
      employee_id: p.employeeId,
      period_start: start,
      period_end: end,
      status,
      submitted_at: status === 'submitted' ? new Date() : null,
      approver_id: approverId,
      total_hours: 40,
    })
    .returning();
  return r!.id;
}

const isoPlus = (days: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
/** Next weekday at least `days` ahead (leave needs a business day). */
const weekdayPlus = (days: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

beforeAll(async () => {
  T1 = await mkTenant('main');

  O = await mkPerson(T1, 'Owner', 'owner');
  M = await mkPerson(T1, 'Mgr', 'manager', { managerId: O.employeeId });
  M2 = await mkPerson(T1, 'MgrTwo', 'manager', { managerId: O.employeeId });
  R1 = await mkPerson(T1, 'RepOne', 'employee', { managerId: M.employeeId });
  R2 = await mkPerson(T1, 'RepTwo', 'employee', { managerId: M.employeeId });
  R3 = await mkPerson(T1, 'RepThree', 'employee', { managerId: M.employeeId });
  R4 = await mkPerson(T1, 'RepGone', 'employee', { managerId: M.employeeId, status: 'separated' });
  R5 = await mkPerson(T1, 'RepDeleted', 'employee', { managerId: M.employeeId, deleted: true });
  X1 = await mkPerson(T1, 'OtherOne', 'employee', { managerId: M2.employeeId });
  X2 = await mkPerson(T1, 'OtherTwo', 'employee', { managerId: M2.employeeId });
  X3 = await mkPerson(T1, 'OtherThree', 'employee');
  // A manager seat with no employee record at all.
  const nUser = await mkUser('NoEmp');
  await dbAdmin.insert(memberships).values({ tenant_id: T1, user_id: nUser.id, role: 'manager', status: 'active' });
  N = { userId: nUser.id };

  const [lt] = await dbAdmin
    .insert(leaveTypes)
    .values({ tenant_id: T1, name: 'Casual Leave', code: `CL${rid().slice(0, 3)}`, default_quota_days: 12, is_paid: true, is_active: true })
    .returning();
  leaveTypeId = lt!.id;
});

afterAll(async () => {
  for (const t of [T1, ...extraTenants]) await dbAdmin.delete(tenants).where(eq(tenants.id, t));
  for (const u of userIds) await dbAdmin.delete(users).where(eq(users.id, u));
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Lost reasons self-heal + moveStage validation
// ═════════════════════════════════════════════════════════════════════════════

describe('Round I — lost reasons self-heal (Mark as lost never dead-ends)', () => {
  it('a tenant with zero reasons gets the six defaults, in order, on first read', async () => {
    const t = await mkTenant('heal');
    extraTenants.push(t);
    const before = await dbAdmin.select().from(lostReasons).where(eq(lostReasons.tenant_id, t));
    expect(before).toHaveLength(0);

    const res = await pipelinesService.lostReasons(t);
    expect(res.data.map((r) => r.label)).toEqual([...DEFAULT_LOST_REASONS]);
    expect(res.data.map((r) => r.display_order)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(res.data.every((r) => r.tenant_id === t)).toBe(true);

    // Idempotent: a second read adds nothing.
    await pipelinesService.lostReasons(t);
    const after = await dbAdmin.select().from(lostReasons).where(eq(lostReasons.tenant_id, t));
    expect(after).toHaveLength(6);
  });

  it('eight concurrent first reads seed exactly six (advisory lock serialises the seeders)', async () => {
    const t = await mkTenant('race');
    extraTenants.push(t);
    const results = await Promise.all(Array.from({ length: 8 }, () => pipelinesService.lostReasons(t)));
    for (const r of results) expect(r.data).toHaveLength(6);
    const rows = await dbAdmin.select().from(lostReasons).where(eq(lostReasons.tenant_id, t));
    expect(rows).toHaveLength(6);
  });

  it('the board heals BOTH a missing pipeline and the reasons for a brand-new tenant', async () => {
    const t = await mkTenant('bare', false);
    extraTenants.push(t);
    const board = await dealsService.board(t);
    expect(board.data.pipeline.name).toBe('Sales');
    const rows = await dbAdmin.select().from(lostReasons).where(eq(lostReasons.tenant_id, t));
    expect(rows).toHaveLength(6);
  });

  it('a tenant with its own custom reason is left alone (no defaults appended)', async () => {
    const t = await mkTenant('custom');
    extraTenants.push(t);
    await dbAdmin.insert(lostReasons).values({ tenant_id: t, label: 'Went in-house', display_order: 0 });
    const res = await pipelinesService.lostReasons(t);
    expect(res.data.map((r) => r.label)).toEqual(['Went in-house']);
  });

  it('archived-only tenants heal too, and archived rows stay hidden', async () => {
    const t = await mkTenant('archived');
    extraTenants.push(t);
    await dbAdmin.insert(lostReasons).values({ tenant_id: t, label: 'Old reason', display_order: 0, archived: true });
    const res = await pipelinesService.lostReasons(t);
    expect(res.data.map((r) => r.label)).toEqual([...DEFAULT_LOST_REASONS]);
    expect(res.data.some((r) => r.label === 'Old reason')).toBe(false);
  });

  it('lostReasons() never leaks another tenant\'s rows', async () => {
    const a = await mkTenant('isoA');
    const b = await mkTenant('isoB');
    extraTenants.push(a, b);
    await dbAdmin.insert(lostReasons).values({ tenant_id: a, label: 'Only in A', display_order: 0 });
    const resB = await pipelinesService.lostReasons(b);
    expect(resB.data.some((r) => r.label === 'Only in A')).toBe(false);
    expect(resB.data).toHaveLength(6);
  });
});

describe('Round I — moveStage lost semantics', () => {
  let t: string;
  let lostStage: string;
  let openStage: string;
  let foreignReasonId: string;

  beforeAll(async () => {
    t = await mkTenant('move');
    extraTenants.push(t);
    const stages = await dbAdmin.select().from(pipelineStages).where(eq(pipelineStages.tenant_id, t));
    lostStage = stages.find((s) => s.stage_type === 'lost')!.id;
    openStage = stages.find((s) => s.stage_type === 'open')!.id;
    const other = await mkTenant('moveOther');
    extraTenants.push(other);
    const [fr] = await dbAdmin.insert(lostReasons).values({ tenant_id: other, label: 'Foreign', display_order: 0 }).returning();
    foreignReasonId = fr!.id;
  });

  it('accepts a note-only lost (the dialog\'s Other) and trims it', async () => {
    const d = await dealsService.create(t, O.userId, { title: 'Note only', value_amount: 10 });
    const res = await dealsService.moveStage(t, O.userId, d.data.id, { stage_id: lostStage, lost_reason_note: '  Went silent  ' });
    expect(res.data.status).toBe('lost');
    expect(res.data.lost_reason_id).toBeNull();
    expect(res.data.lost_reason_note).toBe('Went silent');
    expect(res.data.lost_at).not.toBeNull();
  });

  it('accepts a healed default reason and resolves its label on the detail read', async () => {
    const reasons = await pipelinesService.lostReasons(t);
    const price = reasons.data.find((r) => r.label === 'Price')!;
    const d = await dealsService.create(t, O.userId, { title: 'Priced out', value_amount: 10 });
    const res = await dealsService.moveStage(t, O.userId, d.data.id, { stage_id: lostStage, lost_reason_id: price.id });
    expect(res.data.lost_reason_id).toBe(price.id);
    const detail = await dealsService.get(t, d.data.id);
    expect(detail.data.lost_reason_label).toBe('Price');
  });

  it('rejects a lost_reason_id from another tenant (house rule 2) and leaves the deal open', async () => {
    const d = await dealsService.create(t, O.userId, { title: 'Cross-tenant reason', value_amount: 10 });
    await expect(
      dealsService.moveStage(t, O.userId, d.data.id, { stage_id: lostStage, lost_reason_id: foreignReasonId }),
    ).rejects.toBeInstanceOf(BadRequestException);
    const [row] = await dbAdmin.select().from(deals).where(eq(deals.id, d.data.id));
    expect(row!.status).toBe('open');
    expect(row!.stage_id).toBe(openStage);
  });

  it('rejects a random uuid as lost_reason_id', async () => {
    const d = await dealsService.create(t, O.userId, { title: 'Stray reason', value_amount: 10 });
    await expect(
      dealsService.moveStage(t, O.userId, d.data.id, { stage_id: lostStage, lost_reason_id: crypto.randomUUID() }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 1. Closed deals list
// ═════════════════════════════════════════════════════════════════════════════

describe('Round I — closed deals list (GET /crm/deals)', () => {
  let t: string;
  let other: string;
  let wonId: string;
  let lostId: string;
  let openId: string;
  let deletedId: string;
  let otherOwnerLostId: string;
  let priceId: string;
  let companyId: string;

  beforeAll(async () => {
    t = await mkTenant('closed');
    other = await mkTenant('closedOther');
    extraTenants.push(t, other);
    // Deal owners are members of the tenant (RLS on users resolves names
    // through the membership) — mirror the real invariant in the fixture.
    await dbAdmin.insert(memberships).values([
      { tenant_id: t, user_id: O.userId, role: 'owner', status: 'active' },
      { tenant_id: other, user_id: O.userId, role: 'owner', status: 'active' },
    ]);
    const stages = await dbAdmin.select().from(pipelineStages).where(eq(pipelineStages.tenant_id, t));
    const won = stages.find((s) => s.stage_type === 'won')!.id;
    const lost = stages.find((s) => s.stage_type === 'lost')!.id;
    const [co] = await dbAdmin.insert(directoryCompanies).values({ tenant_id: t, name: 'Acme Corp' }).returning();
    companyId = co!.id;
    const reasons = await pipelinesService.lostReasons(t);
    priceId = reasons.data.find((r) => r.label === 'Price')!.id;

    // Won deal (owner O, company Acme).
    const w = await dealsService.create(t, O.userId, { title: 'Acme renewal', value_amount: 5000, company_id: companyId });
    wonId = w.data.id;
    await dealsService.moveStage(t, O.userId, wonId, { stage_id: won });
    // Lost deal with Price + note, closed AFTER the won one.
    await new Promise((r) => setTimeout(r, 20));
    const l = await dealsService.create(t, O.userId, { title: 'Beta pilot 100%', value_amount: 1200 });
    lostId = l.data.id;
    await dealsService.moveStage(t, O.userId, lostId, { stage_id: lost, lost_reason_id: priceId, lost_reason_note: 'Too dear' });
    // Open deal — never in the closed list.
    openId = (await dealsService.create(t, O.userId, { title: 'Still open', value_amount: 1 })).data.id;
    // Lost then deleted — excluded.
    deletedId = (await dealsService.create(t, O.userId, { title: 'Lost then gone', value_amount: 1 })).data.id;
    await dealsService.moveStage(t, O.userId, deletedId, { stage_id: lost });
    await dealsService.remove(t, O.userId, deletedId);
    // Lost deal owned by another member (M is a member of T1, not t — add an
    // explicit membership in t).
    await dbAdmin.insert(memberships).values({ tenant_id: t, user_id: M.userId, role: 'manager', status: 'active' });
    const ol = await dealsService.create(t, M.userId, { title: 'Gamma', value_amount: 7 });
    otherOwnerLostId = ol.data.id;
    await dealsService.moveStage(t, M.userId, otherOwnerLostId, { stage_id: lost, lost_reason_note: 'nah' });
    // A won deal in ANOTHER tenant.
    const oStages = await dbAdmin.select().from(pipelineStages).where(eq(pipelineStages.tenant_id, other));
    const ow = await dealsService.create(other, O.userId, { title: 'Other tenant won', value_amount: 9 });
    await dealsService.moveStage(other, O.userId, ow.data.id, { stage_id: oStages.find((s) => s.stage_type === 'won')!.id });
  });

  it('default = won + lost only, most recently closed first, with names + reason + closed_at', async () => {
    const res = await dealsService.list(t);
    const ids = res.data.map((d) => d.id);
    expect(ids).toContain(wonId);
    expect(ids).toContain(lostId);
    expect(ids).toContain(otherOwnerLostId);
    expect(ids).not.toContain(openId);
    expect(ids).not.toContain(deletedId);
    expect(res.pagination.total).toBe(3);
    expect(res.base_currency).toBe('INR');
    // Ordering: closed date desc → the other-owner lost (latest), then Beta, then Acme.
    expect(ids.indexOf(lostId)).toBeLessThan(ids.indexOf(wonId));

    const lostRow = res.data.find((d) => d.id === lostId)!;
    expect(lostRow.status).toBe('lost');
    expect(lostRow.stage_name).toBe('Lost');
    expect(lostRow.lost_reason_label).toBe('Price');
    expect(lostRow.lost_reason_note).toBe('Too dear');
    expect(lostRow.closed_at).not.toBeNull();
    expect(lostRow.owner_name).toBe('Owner Tester');

    const wonRow = res.data.find((d) => d.id === wonId)!;
    expect(wonRow.status).toBe('won');
    expect(wonRow.stage_name).toBe('Won');
    expect(wonRow.company_name).toBe('Acme Corp');
    expect(wonRow.lost_reason_label).toBeNull();
    expect(new Date(wonRow.closed_at!).getTime()).toBe(new Date(wonRow.won_at!).getTime());
  });

  it('status / owner / q / pipeline filters', async () => {
    expect((await dealsService.list(t, { status: 'won' })).data.map((d) => d.id)).toEqual([wonId]);
    const lostOnly = await dealsService.list(t, { status: 'lost' });
    expect(lostOnly.data.map((d) => d.id).sort()).toEqual([lostId, otherOwnerLostId].sort());
    expect((await dealsService.list(t, { owner_user_id: M.userId })).data.map((d) => d.id)).toEqual([otherOwnerLostId]);
    expect((await dealsService.list(t, { q: 'acme' })).data.map((d) => d.id)).toEqual([wonId]);
    // ILIKE metacharacters are escaped: "%" matches the literal title only.
    expect((await dealsService.list(t, { q: '100%' })).data.map((d) => d.id)).toEqual([lostId]);
    expect((await dealsService.list(t, { q: '_' })).data).toHaveLength(0);
    const [pl] = await dbAdmin.select().from(pipelines).where(eq(pipelines.tenant_id, t));
    expect((await dealsService.list(t, { pipeline_id: pl!.id })).pagination.total).toBe(3);
    expect((await dealsService.list(t, { pipeline_id: crypto.randomUUID() })).pagination.total).toBe(0);
    // status=open is allowed too.
    expect((await dealsService.list(t, { status: 'open' })).data.map((d) => d.id)).toEqual([openId]);
  });

  it('pagination: limit clamps to ≤100, page 2 of limit 1 is the second row, totalPages honest', async () => {
    const p1 = await dealsService.list(t, { limit: 1, page: 1 });
    const p2 = await dealsService.list(t, { limit: 1, page: 2 });
    expect(p1.data).toHaveLength(1);
    expect(p2.data).toHaveLength(1);
    expect(p1.data[0]!.id).not.toBe(p2.data[0]!.id);
    expect(p1.pagination.totalPages).toBe(3);
    expect((await dealsService.list(t, { limit: 5000 })).pagination.limit).toBe(100);
  });

  it('never lists another tenant\'s closed deals', async () => {
    const res = await dealsService.list(other);
    expect(res.pagination.total).toBe(1);
    expect(res.data[0]!.title).toBe('Other tenant won');
    expect(res.data.some((d) => d.id === wonId)).toBe(false);
  });

  it('reopen removes the deal from the closed list and clears the reason', async () => {
    await dealsService.reopen(t, { sub: O.userId, tenantId: t, role: 'owner' } as never, lostId);
    const res = await dealsService.list(t);
    expect(res.data.some((d) => d.id === lostId)).toBe(false);
    const detail = await dealsService.get(t, lostId);
    expect(detail.data.status).toBe('open');
    expect(detail.data.lost_reason_label).toBeNull();
    expect(detail.data.lost_reason_note).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Manager numbers agree
// ═════════════════════════════════════════════════════════════════════════════

describe('Round I — manager scope: dashboard tile == Direct reports page', () => {
  let r1Leave: string;
  let x1Leave: string;

  beforeAll(async () => {
    r1Leave = await seedPendingLeave(T1, R1, weekdayPlus(30), weekdayPlus(30));
    x1Leave = await seedPendingLeave(T1, X1, weekdayPlus(31), weekdayPlus(31));
  });

  it('listMyTeam returns only the active/notice/on-leave reports — separated and removed staff drop out', async () => {
    const team = await employeesService.listMyTeam(M.userId, T1);
    expect(team.total).toBe(3);
    expect(team.data.map((e) => e.id).sort()).toEqual([R1.employeeId, R2.employeeId, R3.employeeId].sort());
    expect(team.data.some((e) => e.id === R4.employeeId)).toBe(false);
    expect(team.data.some((e) => e.id === R5.employeeId)).toBe(false);
  });

  it('manager overview (scope=team): totalEmployees === listMyTeam.total, buckets hold only the reports\' requests', async () => {
    const ov = await dashboardService.getAdminOverview(T1, {
      callerUserId: M.userId, includeOnboarding: false, includeApprovals: true, scope: 'team',
    });
    expect(ov.scope).toBe('team');
    expect(ov.stats.totalEmployees).toBe(3);
    expect(ov.headcount.active).toBe(3);
    expect(ov.pending.leaveCount).toBe(1);
    expect(ov.pending.leaves.map((l) => l.id)).toEqual([r1Leave]);
    expect(ov.stats.pendingApprovals).toBe(1);
  });

  it('owner overview (scope=org, the default) stays workspace-wide for people numbers; the approvals bucket is routed (Round L)', async () => {
    const ov = await dashboardService.getAdminOverview(T1, {
      callerUserId: O.userId, includeOnboarding: false, includeApprovals: true,
    });
    expect(ov.scope).toBe('org');
    // O, M, M2, R1-R3, X1-X3 are active; R4 separated, R5 removed.
    expect(ov.stats.totalEmployees).toBe(9);
    // Round L (founder item 2): both requests sit with their reporting
    // managers (level 0) and are not the owner's until escalated — the
    // workspace-wide Team → Leave list still shows them, `routedToMe: false`.
    expect(ov.pending.leaves.map((l) => l.id)).not.toContain(r1Leave);
    expect(ov.pending.leaves.map((l) => l.id)).not.toContain(x1Leave);
    const team = await leaveService.listTeam(O.userId, T1, { status: 'pending', limit: 100 }, 'owner');
    expect(team.data.find((r) => r.id === r1Leave)!.routedToMe).toBe(false);
    expect(team.data.find((r) => r.id === x1Leave)!.routedToMe).toBe(false);
  });

  it('a manager seat with no employee row has an EMPTY team — never the whole workspace', async () => {
    const ov = await dashboardService.getAdminOverview(T1, {
      callerUserId: N.userId, includeOnboarding: false, includeApprovals: true, scope: 'team',
    });
    expect(ov.stats.totalEmployees).toBe(0);
    expect(ov.pending.leaveCount).toBe(0);
    expect(ov.pending.leaves).toEqual([]);
    const team = await employeesService.listMyTeam(N.userId, T1);
    expect(team.total).toBe(0);
  });
});

describe('Round I — "Your team today" is manager-scoped (attendance/team/today)', () => {
  // Day-boundary note: this asserts the ROSTER (who is listed), not any
  // attendance state, so it is stable across the IST midnight the
  // attendance-selfheal spec is sensitive to.
  it('manager role → direct reports only; owner → whole workspace', async () => {
    const mine = await attendanceService.listTeamToday(M.userId, T1, 'manager');
    expect(mine.map((r) => r.employeeId).sort()).toEqual([R1.employeeId, R2.employeeId, R3.employeeId].sort());
    const all = await attendanceService.listTeamToday(O.userId, T1, 'owner');
    expect(all.some((r) => r.employeeId === X1.employeeId)).toBe(true);
    expect(all.some((r) => r.employeeId === R5.employeeId)).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. Leave / regularization / timesheet scoping + team lists
// ═════════════════════════════════════════════════════════════════════════════

describe('Round I — leave queue + review are scoped to direct reports', () => {
  let r2Leave: string;
  let x2Leave: string;
  let r3Leave: string;

  beforeAll(async () => {
    r2Leave = await seedPendingLeave(T1, R2, weekdayPlus(40), weekdayPlus(40));
    x2Leave = await seedPendingLeave(T1, X2, weekdayPlus(41), weekdayPlus(41));
    r3Leave = await seedPendingLeave(T1, R3, weekdayPlus(42), weekdayPlus(42));
  });

  it('listPending: manager sees only their reports (with and without the role hint); owner sees everyone', async () => {
    const hinted = await leaveService.listPending(M.userId, T1, {}, 'manager');
    const hintedIds = hinted.data.map((r) => r.id);
    expect(hintedIds).toContain(r2Leave);
    expect(hintedIds).toContain(r3Leave);
    expect(hintedIds).not.toContain(x2Leave);
    expect(hinted.data.every((r) => [R1.employeeId, R2.employeeId, R3.employeeId].includes(r.employeeId))).toBe(true);

    const unhinted = await leaveService.listPending(M.userId, T1, {});
    expect(unhinted.data.map((r) => r.id).sort()).toEqual(hintedIds.sort());

    // Round L (founder item 2): the owner's QUEUE is routed — requests that
    // sit with a reporting manager (level 0) are not theirs until escalated
    // (24 h / manager on leave / no manager). They stay reachable on the
    // workspace-wide Team → Leave list, flagged `routedToMe: false`.
    const owner = await leaveService.listPending(O.userId, T1, {}, 'owner');
    const ownerIds = owner.data.map((r) => r.id);
    expect(ownerIds).not.toContain(x2Leave);
    expect(ownerIds).not.toContain(r2Leave);
    const ownerTeam = await leaveService.listTeam(O.userId, T1, { status: 'pending', limit: 100 }, 'owner');
    expect(ownerTeam.scope).toBe('org');
    const x2Row = ownerTeam.data.find((r) => r.id === x2Leave)!;
    expect(x2Row.routedToMe).toBe(false);
    expect(x2Row.managerName).toBe('MgrTwo Tester');
    expect(x2Row.escalation).toBeNull();
    expect(ownerTeam.data.find((r) => r.id === r2Leave)!.routedToMe).toBe(false);

    // A manager seat with no employee row → empty queue, never everything.
    const none = await leaveService.listPending(N.userId, T1, {}, 'manager');
    expect(none.data).toEqual([]);
  });

  it('reviewLeave: 403 for a non-report, ok for a report, owner is workspace-wide', async () => {
    await expect(
      leaveService.reviewLeave(x2Leave, M.userId, T1, { action: 'approve' }, 'manager'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    const [still] = await dbAdmin.select().from(leaveRequests).where(eq(leaveRequests.id, x2Leave));
    expect(still!.status).toBe('pending');

    const ok = await leaveService.reviewLeave(r2Leave, M.userId, T1, { action: 'approve', comment: 'Enjoy' }, 'manager');
    expect(ok.status).toBe('approved');
    const [row] = await dbAdmin.select().from(leaveRequests).where(eq(leaveRequests.id, r2Leave));
    expect(row!.approver_id).toBe(M.employeeId);
    expect(row!.approver_comment).toBe('Enjoy');

    const ownerOk = await leaveService.reviewLeave(x2Leave, O.userId, T1, { action: 'reject', comment: 'No' }, 'owner');
    expect(ownerOk.status).toBe('rejected');
  });

  it('listTeam: statuses, date window, scope, real total', async () => {
    const all = await leaveService.listTeam(M.userId, T1, { status: 'all' }, 'manager');
    expect(all.scope).toBe('team');
    expect(all.data.every((r) => [R1.employeeId, R2.employeeId, R3.employeeId].includes(r.employeeId))).toBe(true);
    expect(all.pagination.total).toBe(all.data.length);
    expect(all.data.some((r) => r.employeeId === X2.employeeId)).toBe(false);

    const approved = await leaveService.listTeam(M.userId, T1, { status: 'approved', from: isoPlus(0) }, 'manager');
    expect(approved.data.map((r) => r.id)).toEqual([r2Leave]);
    expect(approved.data[0]!.approverName).toBe('Mgr Tester');
    expect(approved.data[0]!.approverComment).toBe('Enjoy');
    expect(approved.data[0]!.leaveTypeName).toBe('Casual Leave');

    // Window that ends before the fixtures → nothing.
    const past = await leaveService.listTeam(M.userId, T1, { status: 'all', to: '2020-01-01' }, 'manager');
    expect(past.pagination.total).toBe(0);

    const pending = await leaveService.listTeam(M.userId, T1, { status: 'pending' }, 'manager');
    expect(pending.data.map((r) => r.id)).toContain(r3Leave);

    const owner = await leaveService.listTeam(O.userId, T1, { status: 'rejected' }, 'owner');
    expect(owner.scope).toBe('org');
    expect(owner.data.map((r) => r.id)).toContain(x2Leave);
  });
});

describe('Round I — regularization queue + review follow the same scope', () => {
  let r1Reg: string;
  let x1Reg: string;

  beforeAll(async () => {
    r1Reg = await seedRegularization(T1, R1, isoPlus(-3));
    x1Reg = await seedRegularization(T1, X1, isoPlus(-3));
  });

  it('manager lists only their reports\' regularizations; the owner\'s queue holds neither until escalated (Round L)', async () => {
    const mine = await attendanceService.listPendingRegularizations(M.userId, T1, {}, 'manager');
    expect(mine.data.map((r) => r.id)).toEqual([r1Reg]);
    // Round L: both sit with a reporting manager (level 0) — the owner's
    // routed queue only carries level-2 / no-manager items.
    const all = await attendanceService.listPendingRegularizations(O.userId, T1, {}, 'owner');
    expect(all.data.map((r) => r.id)).not.toContain(r1Reg);
    expect(all.data.map((r) => r.id)).not.toContain(x1Reg);
    // …but the owner may still open either directly (the Inbox deep-link fallback).
    const direct = await attendanceService.getRegularizationForReviewer(x1Reg, O.userId, T1, 'owner');
    expect(direct.id).toBe(x1Reg);
    expect(direct.escalation).toBeNull();
    await expect(
      attendanceService.getRegularizationForReviewer(x1Reg, M.userId, T1, 'manager'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('manager cannot review a non-report\'s regularization; can review their own report\'s', async () => {
    await expect(
      attendanceService.reviewRegularization(x1Reg, M.userId, T1, { action: 'reject', comment: 'x' }, 'manager'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    const ok = await attendanceService.reviewRegularization(r1Reg, M.userId, T1, { action: 'reject', comment: 'later' }, 'manager');
    expect(ok.status).toBe('rejected');
  });
});

describe('Round I — team timesheets + approver self-heal', () => {
  let r1Unstamped: string; // submitted, approver NULL (pre-manager period)
  let r2Stamped: string; // submitted to M
  let r3Draft: string;
  let x1Unstamped: string; // submitted, approver NULL, not M's report

  beforeAll(async () => {
    r1Unstamped = await seedPeriod(T1, R1, '2026-08-03', '2026-08-09', 'submitted', null);
    r2Stamped = await seedPeriod(T1, R2, '2026-08-03', '2026-08-09', 'submitted', M.employeeId);
    r3Draft = await seedPeriod(T1, R3, '2026-08-03', '2026-08-09', 'draft', null);
    x1Unstamped = await seedPeriod(T1, X1, '2026-08-03', '2026-08-09', 'submitted', null);
  });

  it('listTeam: every status for my reports only; listPending is the routed queue (direct reports, Round L)', async () => {
    const team = await timesheetService.listTeam(M.userId, T1, { status: 'all' }, 'manager');
    expect(team.scope).toBe('team');
    expect(team.data.map((r) => r.id).sort()).toEqual([r1Unstamped, r2Stamped, r3Draft].sort());
    expect(team.pagination.total).toBe(3);
    const r1Row = team.data.find((r) => r.id === r1Unstamped)!;
    expect(r1Row.approverId).toBeNull();
    expect(r1Row.approverName).toBeNull();
    expect(team.data.find((r) => r.id === r2Stamped)!.approverName).toBe('Mgr Tester');

    const submitted = await timesheetService.listTeam(M.userId, T1, { status: 'submitted' }, 'manager');
    expect(submitted.data.map((r) => r.id).sort()).toEqual([r1Unstamped, r2Stamped].sort());

    // Round L: the queue is the org chart, not the approver_id stamp — the
    // unstamped period of a direct report is the manager's to review too.
    const pending = await timesheetService.listPending(M.userId, T1, {});
    expect(pending.data.map((r) => r.id).sort()).toEqual([r1Unstamped, r2Stamped].sort());

    const owner = await timesheetService.listTeam(O.userId, T1, { status: 'submitted' }, 'owner');
    expect(owner.scope).toBe('org');
    expect(owner.data.map((r) => r.id)).toContain(x1Unstamped);
  });

  it('review self-heals a NULL approver when the caller is the reporting manager; anyone else stays 403', async () => {
    await expect(
      timesheetService.reviewTimesheet(x1Unstamped, M.userId, T1, { action: 'approve' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    const [xRow] = await dbAdmin.select().from(timesheetPeriods).where(eq(timesheetPeriods.id, x1Unstamped));
    expect(xRow!.approver_id).toBeNull();
    expect(xRow!.status).toBe('submitted');

    const ok = await timesheetService.reviewTimesheet(r1Unstamped, M.userId, T1, { action: 'approve' });
    expect(ok.status).toBe('approved');
    const [row] = await dbAdmin.select().from(timesheetPeriods).where(eq(timesheetPeriods.id, r1Unstamped));
    expect(row!.approver_id).toBe(M.employeeId);
    expect(row!.status).toBe('approved');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Leave email deep links + template escaping
// ═════════════════════════════════════════════════════════════════════════════

describe('Round I — leave-requested email carries deep links and is preference-gated', () => {
  beforeEach(() => { sendEmail.mockClear(); createInAppNotification.mockClear(); });

  it('applyLeave emails the manager with review/approve/reject URLs + reason, gated on leave_requested', async () => {
    const start = weekdayPlus(60);
    const res = await leaveService.applyLeave(R3.userId, T1, {
      leaveTypeId,
      startDate: start,
      endDate: start,
      reason: 'Round I deep link fixture',
    });
    await waitFor(() => sendEmail.mock.calls.some((c) => (c as unknown[])[0] === 'leave-requested'));
    const call = sendEmail.mock.calls.find((c) => (c as unknown[])[0] === 'leave-requested') as unknown as [string, string, Record<string, unknown>, Record<string, unknown> | undefined];
    expect(call[1]).toBe(M.email);
    const props = call[2];
    const reviewUrl = `${APP_URL}/team/leave?request=${res.id}`;
    expect(props.reviewUrl).toBe(reviewUrl);
    expect(props.approveUrl).toBe(`${reviewUrl}&action=approve`);
    expect(props.rejectUrl).toBe(`${reviewUrl}&action=reject`);
    expect(props.reason).toBe('Round I deep link fixture');
    expect(props.employeeName).toBe('RepThree Tester');
    expect(call[3]).toEqual({ userId: M.userId, event: 'leave_requested' });

    // In-app ping deep-links to the same request.
    await waitFor(() => createInAppNotification.mock.calls.some((c) => (c as unknown[])[1] === 'leave.requested'));
    const inApp = createInAppNotification.mock.calls.find((c) => (c as unknown[])[1] === 'leave.requested') as unknown as unknown[];
    expect(inApp[0]).toBe(M.userId);
    expect(inApp[3]).toBe(`/team/leave?request=${res.id}`);
  });

  it('the template escapes names/reasons and the hrefs, and renders both action buttons', () => {
    const svc = realNotifications as unknown as { renderTemplate: (t: string, p: Record<string, unknown>) => { subject: string; html: string } };
    const reviewUrl = `${APP_URL}/team/leave?request=abc`;
    const out = svc.renderTemplate('leave-requested', {
      employeeName: '<img src=x onerror=alert(1)>',
      leaveType: 'Casual & Sick',
      startDate: '2026-09-10',
      endDate: '2026-09-11',
      days: 2,
      reason: 'a <b>bold</b> reason',
      reviewUrl,
      approveUrl: `${reviewUrl}&action=approve`,
      rejectUrl: `${reviewUrl}&action=reject`,
    });
    expect(out.html).not.toContain('<img');
    expect(out.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(out.html).not.toContain('<b>bold</b>');
    expect(out.html).toContain('Casual &amp; Sick');
    expect(out.subject).not.toContain('<img');
    // Hrefs are escaped (& → &amp;) — the browser decodes them back.
    expect(out.html).toContain(`href="${reviewUrl}&amp;action=approve"`);
    expect(out.html).toContain(`href="${reviewUrl}&amp;action=reject"`);
    expect(out.html).toContain(`href="${reviewUrl}"`);
    expect(out.html).toContain('>Approve</a>');
    expect(out.html).toContain('>Reject</a>');
    expect(out.html).toContain('Nothing changes until you confirm in the app.');
  });

  it('without URLs (older callers) the template still renders, minus the buttons', () => {
    const svc = realNotifications as unknown as { renderTemplate: (t: string, p: Record<string, unknown>) => { subject: string; html: string } };
    const out = svc.renderTemplate('leave-requested', {
      employeeName: 'Plain', leaveType: 'CL', startDate: '2026-09-10', endDate: '2026-09-10', days: 1,
    });
    expect(out.html).not.toContain('>Approve</a>');
    expect(out.html).toContain('Plain');
  });
});
