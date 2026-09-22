/**
 * Founder round N (2026-09-22) — agent A: employee photos on every HR list.
 *
 * The bug: the photo upload writes `users.avatar_key` ONLY (a private R2 key,
 * `users/<id>/avatar/<uuid>_256.webp`); `users.avatar_url` survives as the
 * legacy public-URL read fallback. Any endpoint that fails to join `users` and
 * sign the key returns no photo, so the web falls back to initials forever —
 * the founder-round8 bug class, hit again on the Team attendance list.
 *
 * This pins the serialization contract on all SIX HR endpoints that render a
 * face, for all three states a person can be in:
 *
 *   keyed   — avatar_key set          ⇒ the SIGNED url
 *   legacy  — avatar_url only, no key ⇒ that legacy url, verbatim
 *   bare    — neither                 ⇒ null (the web draws initials)
 *
 * plus a leak sweep: `avatarKey` / `avatar_key` must never survive into a
 * response, because the R2 key is private and only the signature makes it
 * fetchable.
 *
 *   attendance.listTeamToday              (also carries employeeUserId)
 *   attendance.getRegularizationForReviewer   (was a hard-coded null)
 *   leave.listTeam
 *   timesheet.listTeam
 *   timesheet.getUtilizationReport        (+ its aggregates must not move —
 *                                          the photo columns join the GROUP BY)
 *   dashboard.getActivity
 *   audit.search                          (signs via R2Service alone: audit
 *                                          must NOT import MediaModule, since
 *                                          media → audit → media is a cycle)
 *
 * Service-level against the real Postgres (roundL-b harness; media/R2 stubbed).
 */
import 'dotenv/config';
import 'reflect-metadata';
import * as crypto from 'crypto';
import { eq, inArray } from 'drizzle-orm';
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
  timesheetEntries,
  auditLog,
} from '@flicks/db/schema';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '../core/database/database.service';
import { AuditService } from '../modules/audit/audit.service';
import { NotificationsService } from '../modules/notifications/notifications.service';
import { ApprovalRoutingService } from '../modules/approvals/approval-routing.service';
import { AttendanceService } from '../modules/attendance/attendance.service';
import { LeaveService } from '../modules/leave/leave.service';
import { TimesheetService } from '../modules/timesheet/timesheet.service';
import { DashboardService } from '../modules/dashboard/dashboard.service';
import type { MediaService } from '../modules/media/media.service';
import type { R2Service } from '../core/storage/r2.service';
import { servedAvatarUrl, withSignedAvatars } from '../core/storage/signed-avatar';

jest.setTimeout(120_000);

const rid = () => crypto.randomBytes(4).toString('hex');

// ─── Stubs ───────────────────────────────────────────────────────────────────

/**
 * The media stub is deliberately dumber than the real MediaService: it echoes
 * the key it was handed, so an assertion on `signed:<key>` also proves WHICH
 * key each endpoint passed down (no silent swap of one person's photo for
 * another's). The real 256→64 rewrite is exercised through the R2 path below.
 *
 * It also RECORDS the requested rendition size: `servedUrl`'s default is 256,
 * so an endpoint that forgets the third argument still returns a plausible
 * URL — it just ships a 4x-heavier image to a 28 px list avatar. The size
 * sweep at the bottom of this file is what catches that.
 */
const mediaCalls: Array<{ key: string | null; size: number | undefined }> = [];
const media = {
  servedUrl: async (k: string | null, l: string | null, size?: 256 | 64) => {
    mediaCalls.push({ key: k, size });
    return k ? `signed:${k}` : l;
  },
} as unknown as MediaService;

/** Audit signs with the R2Service alone — here the REAL servedAvatarUrl path. */
const r2On = {
  isConfigured: () => true,
  signedGetUrl: async (k: string) => `signed:${k}`,
} as unknown as R2Service;
const r2Off = { isConfigured: () => false } as unknown as R2Service;
/** A configured bucket whose signer blows up — the read path must survive. */
const r2Angry = {
  isConfigured: () => true,
  signedGetUrl: async () => {
    throw new Error('R2 is having a day');
  },
} as unknown as R2Service;

const auditStub = { log: async () => {} } as unknown as AuditService;
const notifications = {
  createInAppNotification: async () => undefined,
  sendEmail: async () => true,
} as unknown as NotificationsService;

const dbSvc = new DatabaseService();
const config = new ConfigService({ NODE_ENV: 'test', APP_URL: 'https://app.test' });
const routing = new ApprovalRoutingService(notifications, config);

// Every service takes the signer as its LAST, OPTIONAL ctor argument, so the
// dozens of hand-built specs that predate Round N still compile.
const attendanceService = new AttendanceService(dbSvc, dbAdmin as never, auditStub, notifications, config, routing, media);
const leaveService = new LeaveService(dbSvc, auditStub, notifications, config, routing, media);
const timesheetService = new TimesheetService(dbAdmin as never, dbSvc, auditStub, notifications, routing, media);
const dashboardService = new DashboardService(dbSvc, media, routing);
const auditSigned = new AuditService(db as never, dbAdmin as never, dbSvc, r2On);
const auditUnsigned = new AuditService(db as never, dbAdmin as never, dbSvc, r2Off);

// ─── Fixtures ────────────────────────────────────────────────────────────────

type Person = {
  userId: string;
  employeeId: string;
  email: string;
  /** What every endpoint must report for this person. */
  expected: string | null;
};

let T1: string;
let leaveTypeId: string;
const userIds: string[] = [];

let owner: Person; // the org-wide reviewer making every call
let keyed: Person; // avatar_key set
let legacy: Person; // avatar_url only
let bare: Person; // neither
// An invited-but-not-yet-registered employee: employees.user_id IS NULL, so
// there is no `users` row to join to at all. Every avatar join MUST be a LEFT
// join — an INNER one would silently delete this person from the roster, the
// approval queues and the utilization report. That is the regression this
// fixture exists to catch; it is deliberately NOT in `cases()`.
let userless: { employeeId: string };

const LEGACY_URL = 'https://legacy.example/a.png';

async function mkPerson(
  label: string,
  role: 'owner' | 'employee',
  opts: { managerId?: string | null; avatarKey?: string; avatarUrl?: string } = {},
): Promise<Person> {
  const email = `rn-${label}-${rid()}@t.test`;
  const [u] = await dbAdmin
    .insert(users)
    .values({ email, full_name: `${label} Tester`, status: 'active' })
    .returning();
  userIds.push(u!.id);
  // The upload path writes avatar_key through the service role — mirror it.
  const avatarKey = opts.avatarKey ? `users/${u!.id}/avatar/${opts.avatarKey}_256.webp` : null;
  if (avatarKey || opts.avatarUrl) {
    await dbAdmin
      .update(users)
      .set({ avatar_key: avatarKey, avatar_url: opts.avatarUrl ?? null })
      .where(eq(users.id, u!.id));
  }
  const [e] = await dbAdmin
    .insert(employees)
    .values({
      tenant_id: T1,
      user_id: u!.id,
      employee_code: `RN-${rid()}`,
      first_name: label,
      last_name: 'Tester',
      work_email: email,
      date_of_joining: '2026-01-01',
      status: 'active',
      reporting_manager_id: opts.managerId ?? null,
    })
    .returning();
  await dbAdmin
    .insert(memberships)
    .values({ tenant_id: T1, user_id: u!.id, role, status: 'active', employee_id: e!.id });
  return {
    userId: u!.id,
    employeeId: e!.id,
    email,
    expected: avatarKey ? `signed:${avatarKey}` : (opts.avatarUrl ?? null),
  };
}

/** The three photo states, in the order every assertion walks them. */
const cases = () => [
  ['keyed', keyed] as const,
  ['legacy', legacy] as const,
  ['bare', bare] as const,
];

let periodSeq = 0;
const ENTRY_HOURS = { keyed: { billable: 6, nonBillable: 2 }, legacy: { billable: 3, nonBillable: 1 }, bare: { billable: 0, nonBillable: 4 } };
/** The userless invitee's hours — folded into the tenant totals below. */
const USERLESS_HOURS = { billable: 2, nonBillable: 2 };

/** A submitted period for `p` on a distinct 2026 week, plus its two entries. */
async function seedTimesheet(p: Person, hours: { billable: number; nonBillable: number }) {
  const start = new Date(Date.UTC(2026, 0, 5 + 7 * periodSeq++));
  const startISO = start.toISOString().slice(0, 10);
  const endISO = new Date(start.getTime() + 6 * 86_400_000).toISOString().slice(0, 10);
  const [period] = await dbAdmin
    .insert(timesheetPeriods)
    .values({
      tenant_id: T1,
      employee_id: p.employeeId,
      period_start: startISO,
      period_end: endISO,
      status: 'submitted',
      total_hours: hours.billable + hours.nonBillable,
      total_billable_hours: hours.billable,
      total_non_billable_hours: hours.nonBillable,
      submitted_at: new Date(),
    })
    .returning();
  const rows = [
    { billable: true, h: hours.billable },
    { billable: false, h: hours.nonBillable },
  ].filter((r) => r.h > 0);
  if (rows.length) {
    await dbAdmin.insert(timesheetEntries).values(
      rows.map((r) => ({
        tenant_id: T1,
        timesheet_period_id: period!.id,
        employee_id: p.employeeId,
        entry_date: startISO,
        hours: r.h,
        category: 'development' as const,
        is_billable: r.billable,
      })),
    );
  }
  return period!.id;
}

const regIds: Record<string, string> = {};

beforeAll(async () => {
  const [t] = await dbAdmin
    .insert(tenants)
    .values({
      name: `RN Avatars ${rid()}`,
      slug: `rn-av-${rid()}-${Date.now()}`,
      status: 'active',
      currency: 'INR',
      timezone: 'Asia/Kolkata',
    })
    .returning();
  T1 = t!.id;

  owner = await mkPerson('Owner', 'owner');
  keyed = await mkPerson('Keyed', 'employee', { managerId: owner.employeeId, avatarKey: 'abc' });
  legacy = await mkPerson('Legacy', 'employee', { managerId: owner.employeeId, avatarUrl: LEGACY_URL });
  bare = await mkPerson('Bare', 'employee', { managerId: owner.employeeId });

  const [lt] = await dbAdmin
    .insert(leaveTypes)
    .values({ tenant_id: T1, name: 'Casual Leave', code: 'CL', default_quota_days: 12 })
    .returning();
  leaveTypeId = lt!.id;

  for (const [label, p] of cases()) {
    // Leave — Team → Leave.
    await dbAdmin.insert(leaveRequests).values({
      tenant_id: T1,
      employee_id: p.employeeId,
      leave_type_id: leaveTypeId,
      start_date: '2026-11-02',
      end_date: '2026-11-03',
      total_days: 2,
      status: 'pending',
      reason: `RN avatars — ${label}`,
    });
    // Regularization — the reviewer's detail view.
    const [reg] = await dbAdmin
      .insert(attendanceRegularizations)
      .values({
        tenant_id: T1,
        employee_id: p.employeeId,
        attendance_date: '2026-08-03',
        request_type: 'missing_punch',
        reason: `RN avatars — ${label}`,
        status: 'pending',
      })
      .returning();
    regIds[label] = reg!.id;
    // Timesheets — Team list + the utilization report.
    await seedTimesheet(p, ENTRY_HOURS[label as keyof typeof ENTRY_HOURS]);
    // Audit trail — the activity feed and the audit search.
    await dbAdmin.insert(auditLog).values({
      tenant_id: T1,
      actor_user_id: p.userId,
      action: 'employee.updated',
      resource_type: 'employee',
      resource_id: p.employeeId,
    });
  }

  // The no-user-row employee, with one row on every surface that grew an
  // avatar join, so an accidental INNER join shows up as a MISSING PERSON.
  const [ue] = await dbAdmin
    .insert(employees)
    .values({
      tenant_id: T1,
      user_id: null,
      employee_code: `RN-UL-${rid()}`,
      first_name: 'Userless',
      last_name: 'Invitee',
      work_email: `rn-userless-${rid()}@t.test`,
      date_of_joining: '2026-01-01',
      status: 'active',
      reporting_manager_id: owner.employeeId,
    })
    .returning();
  userless = { employeeId: ue!.id };
  await dbAdmin.insert(leaveRequests).values({
    tenant_id: T1,
    employee_id: userless.employeeId,
    leave_type_id: leaveTypeId,
    start_date: '2026-11-02',
    end_date: '2026-11-03',
    total_days: 2,
    status: 'pending',
    reason: 'RN avatars — userless',
  });
  await dbAdmin.insert(attendanceRegularizations).values({
    tenant_id: T1,
    employee_id: userless.employeeId,
    attendance_date: '2026-08-03',
    request_type: 'missing_punch',
    reason: 'RN avatars — userless',
    status: 'pending',
  });
  await seedTimesheet({ employeeId: userless.employeeId } as Person, USERLESS_HOURS);
});

afterAll(async () => {
  await dbAdmin.delete(tenants).where(eq(tenants.id, T1)); // cascades
  if (userIds.length) await dbAdmin.delete(users).where(inArray(users.id, userIds));
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** No response may ever carry the private R2 key, in either spelling. */
function expectNoKeyLeak(payload: unknown) {
  const json = JSON.stringify(payload);
  expect(json).not.toContain('avatarKey');
  expect(json).not.toContain('avatar_key');
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. Attendance
// ═════════════════════════════════════════════════════════════════════════════

describe('Round N — attendance', () => {
  it('listTeamToday signs the photo per person, carries employeeUserId, and never ships the key', async () => {
    const rows = await attendanceService.listTeamToday(owner.userId, T1, 'owner');
    for (const [label, p] of cases()) {
      const row = rows.find((r) => r.employeeId === p.employeeId);
      expect(row).toBeDefined();
      expect([label, row!.avatarUrl]).toEqual([label, p.expected]);
      // The web keys the row to a person by user id (that is what the
      // profile drawer and the presence dot both read).
      expect(row!.employeeUserId).toBe(p.userId);
    }
    expect(rows.find((r) => r.employeeId === keyed.employeeId)!.avatarUrl).toMatch(/^signed:users\/.+_256\.webp$/);
    expect(rows.find((r) => r.employeeId === legacy.employeeId)!.avatarUrl).toBe(LEGACY_URL);
    expect(rows.find((r) => r.employeeId === bare.employeeId)!.avatarUrl).toBeNull();
    expectNoKeyLeak(rows);
  });

  it('getRegularizationForReviewer returns a real signed avatarUrl (was hard-coded null)', async () => {
    for (const [label, p] of cases()) {
      const res = await attendanceService.getRegularizationForReviewer(regIds[label]!, owner.userId, T1, 'owner');
      expect(res.employeeId).toBe(p.employeeId);
      expect([label, res.avatarUrl]).toEqual([label, p.expected]);
      expectNoKeyLeak(res);
      // The detail carries the pair out of the transaction under working
      // names; neither may survive into the response shape the Inbox reads.
      expect(Object.keys(res)).not.toContain('avatarKey');
      expect(Object.keys(res)).not.toContain('avatarUrlRaw');
    }
  });

  // Round N review: the SIBLING of listTeamToday. The Inbox/Team approvals
  // queue projected the requester's name but never their photo — the same bug
  // on the same screen, one endpoint over.
  it('listPendingRegularizations signs the photo per requester and strips the key', async () => {
    const res = await attendanceService.listPendingRegularizations(owner.userId, T1, {}, 'owner');
    for (const [label, p] of cases()) {
      const row = res.data.find((r) => r.employeeId === p.employeeId);
      expect(row).toBeDefined();
      expect([label, row!.avatarUrl]).toEqual([label, p.expected]);
    }
    expectNoKeyLeak(res);
  });

  it('without a MediaService the endpoint degrades to the legacy column, never to the raw key', async () => {
    const noMedia = new AttendanceService(dbSvc, dbAdmin as never, auditStub, notifications, config, routing);
    const rows = await noMedia.listTeamToday(owner.userId, T1, 'owner');
    expect(rows.find((r) => r.employeeId === keyed.employeeId)!.avatarUrl).toBeNull();
    expect(rows.find((r) => r.employeeId === legacy.employeeId)!.avatarUrl).toBe(LEGACY_URL);
    expectNoKeyLeak(rows);
    const queue = await noMedia.listPendingRegularizations(owner.userId, T1, {}, 'owner');
    expect(queue.data.find((r) => r.employeeId === keyed.employeeId)!.avatarUrl).toBeNull();
    expect(queue.data.find((r) => r.employeeId === legacy.employeeId)!.avatarUrl).toBe(LEGACY_URL);
    expectNoKeyLeak(queue);
    const detail = await noMedia.getRegularizationForReviewer(regIds.keyed!, owner.userId, T1, 'owner');
    expect(detail.avatarUrl).toBeNull();
    expectNoKeyLeak(detail);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Leave
// ═════════════════════════════════════════════════════════════════════════════

describe('Round N — leave', () => {
  it('listTeam signs each requester photo and strips the key', async () => {
    const res = await leaveService.listTeam(owner.userId, T1, {}, 'owner');
    for (const [label, p] of cases()) {
      const row = res.data.find((r) => r.employeeId === p.employeeId);
      expect(row).toBeDefined();
      expect([label, row!.avatarUrl]).toEqual([label, p.expected]);
    }
    expectNoKeyLeak(res);
  });

  // Round N review: the approval queue behind the same screen.
  it('listPending signs each requester photo and strips the key', async () => {
    const res = await leaveService.listPending(owner.userId, T1, {}, 'owner');
    for (const [label, p] of cases()) {
      const row = res.data.find((r) => r.employeeId === p.employeeId);
      expect(row).toBeDefined();
      expect([label, row!.avatarUrl]).toEqual([label, p.expected]);
    }
    expectNoKeyLeak(res);
  });

  it('without a MediaService both leave lists degrade to the legacy column', async () => {
    const noMedia = new LeaveService(dbSvc, auditStub, notifications, config, routing);
    for (const res of [
      await noMedia.listTeam(owner.userId, T1, {}, 'owner'),
      await noMedia.listPending(owner.userId, T1, {}, 'owner'),
    ]) {
      expect(res.data.find((r) => r.employeeId === keyed.employeeId)!.avatarUrl).toBeNull();
      expect(res.data.find((r) => r.employeeId === legacy.employeeId)!.avatarUrl).toBe(LEGACY_URL);
      expectNoKeyLeak(res);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Timesheets
// ═════════════════════════════════════════════════════════════════════════════

describe('Round N — timesheets', () => {
  it('listTeam signs each employee photo and strips the key', async () => {
    const res = await timesheetService.listTeam(owner.userId, T1, {}, 'owner');
    for (const [label, p] of cases()) {
      const row = res.data.find((r) => r.employeeId === p.employeeId);
      expect(row).toBeDefined();
      expect([label, row!.avatarUrl]).toEqual([label, p.expected]);
      expect(row!.employeeUserId).toBe(p.userId);
    }
    expectNoKeyLeak(res);
  });

  it('getUtilizationReport signs the photo AND leaves every aggregate untouched by the new GROUP BY', async () => {
    const report = await timesheetService.getUtilizationReport(T1, { from: '2026-01-01', to: '2026-12-31' });
    for (const [label, p] of cases()) {
      const row = report.byEmployee.find((r) => r.employeeId === p.employeeId);
      expect(row).toBeDefined();
      expect([label, row!.avatarUrl]).toEqual([label, p.expected]);
    }
    // avatar_key / avatar_url are functionally dependent on the grouped
    // employee, so adding them to GROUP BY cannot split a person's rows.
    // One row per employee, and the hours are exactly what was seeded.
    const mine = report.byEmployee.filter((r) =>
      [keyed.employeeId, legacy.employeeId, bare.employeeId].includes(r.employeeId!),
    );
    expect(mine).toHaveLength(3);
    const byId = new Map(mine.map((r) => [r.employeeId, r]));
    expect(byId.get(keyed.employeeId)).toMatchObject({ billableHours: 6, nonBillableHours: 2, totalHours: 8, utilization: 0.75 });
    expect(byId.get(legacy.employeeId)).toMatchObject({ billableHours: 3, nonBillableHours: 1, totalHours: 4, utilization: 0.75 });
    expect(byId.get(bare.employeeId)).toMatchObject({ billableHours: 0, nonBillableHours: 4, totalHours: 4, utilization: 0 });
    // The userless invitee has no `users` row at all: with an INNER join their
    // hours would silently vanish from the report. They stay, with a null face.
    const ul = report.byEmployee.find((r) => r.employeeId === userless.employeeId);
    expect(ul).toBeDefined();
    expect(ul!.avatarUrl).toBeNull();
    expect(ul).toMatchObject({ billableHours: 2, nonBillableHours: 2, totalHours: 4 });
    // Tenant totals fold the same numbers: 11 billable of 20.
    expect(report.totals).toMatchObject({ billableHours: 11, nonBillableHours: 9, totalHours: 20 });
    expect(report.totals.utilization).toBeCloseTo(11 / 20, 10);
    expectNoKeyLeak(report);
  });

  // Round N review: the approval queue A flagged — same projection, no photo.
  it('listPending signs each employee photo and strips the key', async () => {
    const res = await timesheetService.listPending(owner.userId, T1, {}, 'owner');
    for (const [label, p] of cases()) {
      const row = res.data.find((r) => r.employeeId === p.employeeId);
      expect(row).toBeDefined();
      expect([label, row!.avatarUrl]).toEqual([label, p.expected]);
      expect(row!.employeeUserId).toBe(p.userId);
    }
    expectNoKeyLeak(res);
  });

  it('without a MediaService both timesheet lists and the report degrade to the legacy column', async () => {
    const noMedia = new TimesheetService(dbAdmin as never, dbSvc, auditStub, notifications, routing);
    for (const res of [
      await noMedia.listTeam(owner.userId, T1, {}, 'owner'),
      await noMedia.listPending(owner.userId, T1, {}, 'owner'),
    ]) {
      expect(res.data.find((r) => r.employeeId === keyed.employeeId)!.avatarUrl).toBeNull();
      expect(res.data.find((r) => r.employeeId === legacy.employeeId)!.avatarUrl).toBe(LEGACY_URL);
      expectNoKeyLeak(res);
    }
    const report = await noMedia.getUtilizationReport(T1, { from: '2026-01-01', to: '2026-12-31' });
    expect(report.byEmployee.find((r) => r.employeeId === keyed.employeeId)!.avatarUrl).toBeNull();
    expect(report.byEmployee.find((r) => r.employeeId === legacy.employeeId)!.avatarUrl).toBe(LEGACY_URL);
    expectNoKeyLeak(report);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Dashboard activity feed
// ═════════════════════════════════════════════════════════════════════════════

describe('Round N — dashboard', () => {
  it('getActivity resolves the actor photo alongside the actor name', async () => {
    const items = await dashboardService.getActivity(T1, { limit: 50 });
    for (const [label, p] of cases()) {
      const item = items.find((i) => i.actorUserId === p.userId);
      expect(item).toBeDefined();
      expect([label, item!.avatarUrl]).toEqual([label, p.expected]);
      expect(item!.actorName).toBe(`${label[0]!.toUpperCase()}${label.slice(1)} Tester`);
    }
    expectNoKeyLeak(items);
  });

  // Round N review: the feed paginates by cursor, and the cursor branch is a
  // SECOND query — one that must hand its rows to the same mapper. A row that
  // skips it keeps `avatarKey` (the private path) and loses its face.
  it('signs the actor photo on the cursor (`before`) branch too', async () => {
    const firstPage = await dashboardService.getActivity(T1, { limit: 1 });
    expect(firstPage).toHaveLength(1);
    const rest = await dashboardService.getActivity(T1, { limit: 50, before: firstPage[0]!.id });
    expect(rest.length).toBeGreaterThan(0);
    expectNoKeyLeak(rest);
    const all = [...firstPage, ...rest];
    for (const [label, p] of cases()) {
      const item = all.find((i) => i.actorUserId === p.userId);
      expect(item).toBeDefined();
      expect([label, item!.avatarUrl]).toEqual([label, p.expected]);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4b. The Inbox approvals queue — dashboard.getAdminOverview
//
// Round N review: `getActivity` was the endpoint Round N changed, but it is the
// SIBLING on the same service that the whole company looks at — the Inbox
// (components/inbox/ApprovalsTab reads exactly these four buckets, each with a
// face). Its four person projections each sign by hand, so the leak sweep and
// the 64 px contract have to be pinned here rather than inferred from the feed.
// ═════════════════════════════════════════════════════════════════════════════

describe('Round N — the Inbox approvals queue carries the same faces', () => {
  /** An onboarding candidate awaiting review — the `withAvatars` bucket. */
  let onboarding: Person;

  beforeAll(async () => {
    onboarding = await mkPerson('Onboard', 'employee', {
      managerId: owner.employeeId,
      avatarKey: 'ob',
    });
    // Submitted for review and not yet active — the exact pair the onboarding
    // bucket filters on. Left out of every other fixture count on purpose.
    await dbAdmin
      .update(employees)
      .set({
        status: 'inactive',
        custom_fields: {
          onboarding_submitted_for_review: true,
          onboarding_submitted_at: '2026-09-01T00:00:00.000Z',
        },
      })
      .where(eq(employees.id, onboarding.employeeId));
  });

  const asOwner = () =>
    dashboardService.getAdminOverview(T1, {
      callerUserId: owner.userId,
      includeOnboarding: true,
      includeApprovals: true,
      pendingLimit: 50,
    });

  it('signs every pending bucket — leave, regularization, timesheet, onboarding', async () => {
    const overview = await asOwner();
    for (const [label, p] of cases()) {
      const leave = overview.pending.leaves.find((r) => r.employeeId === p.employeeId);
      const reg = overview.pending.regularizations.find((r) => r.employeeId === p.employeeId);
      const ts = overview.pending.timesheets.find((r) => r.employeeId === p.employeeId);
      expect([label, leave?.avatarUrl]).toEqual([label, p.expected]);
      expect([label, reg?.avatarUrl]).toEqual([label, p.expected]);
      expect([label, ts?.avatarUrl]).toEqual([label, p.expected]);
    }
    const ob = overview.pending.onboarding.find((r) => r.employeeId === onboarding.employeeId);
    expect(ob).toBeDefined();
    expect(ob!.avatarUrl).toBe(onboarding.expected);
    // `withAvatars` must DELETE the column, not null it: JSON.stringify hides
    // `avatarKey: undefined`, so the sweep below would never see it.
    expect(Object.prototype.hasOwnProperty.call(ob!, 'avatarKey')).toBe(false);
    expectNoKeyLeak(overview);
  });

  it('asks for the 64 px rendition on all four buckets', async () => {
    mediaCalls.length = 0;
    await asOwner();
    // 3 photo states × 3 approval buckets + the onboarding candidate.
    expect(mediaCalls.length).toBeGreaterThanOrEqual(10);
    expect([...new Set(mediaCalls.map((c) => c.size))]).toStrictEqual([64]);
  });

  it('degrades to the legacy column — never the raw key — with no MediaService', async () => {
    // The dashboard takes its signer as a REQUIRED ctor argument, so this can
    // only happen through a cast today; the read path must still answer rather
    // than throw a TypeError at an Inbox that only wanted a picture.
    const noMedia = new DashboardService(dbSvc, undefined as unknown as MediaService, routing);
    const overview = await noMedia.getAdminOverview(T1, {
      callerUserId: owner.userId,
      includeOnboarding: true,
      includeApprovals: true,
      pendingLimit: 50,
    });
    const pick = (p: Person) => overview.pending.leaves.find((r) => r.employeeId === p.employeeId);
    expect(pick(keyed)!.avatarUrl).toBeNull();
    expect(pick(legacy)!.avatarUrl).toBe(LEGACY_URL);
    expect(
      overview.pending.onboarding.find((r) => r.employeeId === onboarding.employeeId)!.avatarUrl,
    ).toBeNull();
    expectNoKeyLeak(overview);

    const feed = await noMedia.getActivity(T1, { limit: 50 });
    expect(feed.find((i) => i.actorUserId === keyed.userId)!.avatarUrl).toBeNull();
    expect(feed.find((i) => i.actorUserId === legacy.userId)!.avatarUrl).toBe(LEGACY_URL);
    expectNoKeyLeak(feed);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. Audit search — signed WITHOUT MediaModule (media → audit would cycle)
// ═════════════════════════════════════════════════════════════════════════════

describe('Round N — audit search', () => {
  it('signs the actor photo through the R2Service alone, asking for the 64 px rendition', async () => {
    const res = await auditSigned.search(T1, { limit: 100 });
    const row = res.data.find((r) => r.actorUserId === keyed.userId)!;
    expect(row).toBeDefined();
    // servedAvatarUrl(size 64) rewrites the stored 256 key — this is the REAL
    // helper, not the echo stub the other endpoints use.
    expect(row.avatarUrl).toBe(`signed:users/${keyed.userId}/avatar/abc_64.webp`);
    expect(res.data.find((r) => r.actorUserId === legacy.userId)!.avatarUrl).toBe(LEGACY_URL);
    expect(res.data.find((r) => r.actorUserId === bare.userId)!.avatarUrl).toBeNull();
    expectNoKeyLeak(res);
  });

  it('falls back to the legacy column when R2 is not configured — never the raw key', async () => {
    const res = await auditUnsigned.search(T1, { limit: 100 });
    expect(res.data.find((r) => r.actorUserId === keyed.userId)!.avatarUrl).toBeNull();
    expect(res.data.find((r) => r.actorUserId === legacy.userId)!.avatarUrl).toBe(LEGACY_URL);
    expect(res.data.find((r) => r.actorUserId === bare.userId)!.avatarUrl).toBeNull();
    expectNoKeyLeak(res);
  });

  it('survives an R2 that is configured but throws, and never rejects the read', async () => {
    const angry = new AuditService(db as never, dbAdmin as never, dbSvc, r2Angry);
    const res = await angry.search(T1, { limit: 100 });
    // The trail still renders; the keyed actor simply loses their face.
    expect(res.data.length).toBeGreaterThanOrEqual(3);
    expect(res.data.find((r) => r.actorUserId === keyed.userId)!.avatarUrl).toBeNull();
    expect(res.data.find((r) => r.actorUserId === legacy.userId)!.avatarUrl).toBe(LEGACY_URL);
    expectNoKeyLeak(res);
  });

  it('signs with no R2Service at all (hand-built AuditService) on the legacy column', async () => {
    const noR2 = new AuditService(db as never, dbAdmin as never, dbSvc);
    const res = await noR2.search(T1, { limit: 100 });
    expect(res.data.find((r) => r.actorUserId === keyed.userId)!.avatarUrl).toBeNull();
    expect(res.data.find((r) => r.actorUserId === legacy.userId)!.avatarUrl).toBe(LEGACY_URL);
    expectNoKeyLeak(res);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. The two cross-cutting contracts: LEFT joins, and the 64 px rendition
// ═════════════════════════════════════════════════════════════════════════════

describe('Round N — the avatar join never narrows a list', () => {
  /**
   * Every endpoint that grew a `users` join must keep the person who has no
   * `users` row — an invited employee whose account does not exist yet. An
   * INNER join would delete them from the roster and from both approval
   * queues, which is a far worse bug than a missing photo.
   */
  it('keeps the userless invitee on every list, with a null photo', async () => {
    const roster = await attendanceService.listTeamToday(owner.userId, T1, 'owner');
    const onRoster = roster.find((r) => r.employeeId === userless.employeeId);
    expect(onRoster).toBeDefined();
    expect(onRoster!.avatarUrl).toBeNull();
    expect(onRoster!.employeeUserId).toBeNull();

    const regQueue = await attendanceService.listPendingRegularizations(owner.userId, T1, {}, 'owner');
    expect(regQueue.data.find((r) => r.employeeId === userless.employeeId)?.avatarUrl).toBeNull();
    expect(regQueue.data.some((r) => r.employeeId === userless.employeeId)).toBe(true);

    for (const res of [
      await leaveService.listTeam(owner.userId, T1, {}, 'owner'),
      await leaveService.listPending(owner.userId, T1, {}, 'owner'),
      await timesheetService.listTeam(owner.userId, T1, {}, 'owner'),
      await timesheetService.listPending(owner.userId, T1, {}, 'owner'),
    ]) {
      const row = res.data.find((r) => r.employeeId === userless.employeeId);
      expect(row).toBeDefined();
      expect(row!.avatarUrl).toBeNull();
    }
  });

  /** Row counts and totals must match a count that never saw the join. */
  it('leaves listTeam pagination totals exactly where they were', async () => {
    const leaveTeam = await leaveService.listTeam(owner.userId, T1, {}, 'owner');
    // 4 requesters seeded (keyed/legacy/bare/userless), none of them the owner.
    expect(leaveTeam.data).toHaveLength(4);
    expect(leaveTeam.pagination.total).toBe(4);
    const tsTeam = await timesheetService.listTeam(owner.userId, T1, {}, 'owner');
    expect(tsTeam.data).toHaveLength(4);
    expect(tsTeam.pagination.total).toBe(4);
    const tsPending = await timesheetService.listPending(owner.userId, T1, {}, 'owner');
    expect(tsPending.data).toHaveLength(4);
    expect(tsPending.pagination.total).toBe(4);
  });

  /**
   * Round N review: the team lists sign OUTSIDE the transaction, on the object
   * the tx returned — so every branch that builds that object has to reach the
   * mapper. A status filter and an offset each take their own path through the
   * query; a row that came back on page 2, or under `?status=`, must arrive
   * signed and without the private key exactly like page 1.
   */
  it('signs (and strips) on the status-filtered and paginated branches', async () => {
    const seenLeave = new Map<string, string | null>();
    for (let page = 1; page <= 4; page++) {
      const res = await leaveService.listTeam(owner.userId, T1, { status: 'pending', page, limit: 1 }, 'owner');
      expectNoKeyLeak(res);
      for (const r of res.data) seenLeave.set(r.employeeId, r.avatarUrl ?? null);
    }
    const seenTs = new Map<string, string | null>();
    for (let page = 1; page <= 4; page++) {
      const res = await timesheetService.listTeam(owner.userId, T1, { status: 'submitted', page, limit: 1 }, 'owner');
      expectNoKeyLeak(res);
      for (const r of res.data) seenTs.set(r.employeeId, r.avatarUrl ?? null);
    }
    for (const [label, p] of cases()) {
      expect([label, seenLeave.get(p.employeeId)]).toEqual([label, p.expected]);
      expect([label, seenTs.get(p.employeeId)]).toEqual([label, p.expected]);
    }

    // A filter that matches nothing must still answer an empty list, never a
    // half-mapped row set.
    const none = await leaveService.listTeam(owner.userId, T1, { status: 'cancelled' }, 'owner');
    expect(none.data).toEqual([]);
    expectNoKeyLeak(none);
  });

  /**
   * The roster short-circuits (`people.length === 0 → return []`) BEFORE the
   * mapper — a manager with nobody under them must get an empty list back, not
   * a crash from a mapper handed `undefined`.
   */
  it('answers an empty roster for a manager with no reports', async () => {
    const rows = await attendanceService.listTeamToday(bare.userId, T1, 'manager');
    expect(rows).toEqual([]);
  });
});

describe('Round N — every list asks for the 64 px rendition', () => {
  /**
   * `MediaService.servedUrl` DEFAULTS to 256. An endpoint that drops the third
   * argument still returns a working URL, so only a direct assertion on the
   * requested size catches it — a 256 rendition behind a 28 px list avatar is
   * ~4x the bytes on every row of every list.
   */
  it('passes size 64 on every call, from every HR endpoint', async () => {
    mediaCalls.length = 0;
    await attendanceService.listTeamToday(owner.userId, T1, 'owner');
    await attendanceService.listPendingRegularizations(owner.userId, T1, {}, 'owner');
    await attendanceService.getRegularizationForReviewer(regIds.keyed!, owner.userId, T1, 'owner');
    await leaveService.listTeam(owner.userId, T1, {}, 'owner');
    await leaveService.listPending(owner.userId, T1, {}, 'owner');
    await timesheetService.listTeam(owner.userId, T1, {}, 'owner');
    await timesheetService.listPending(owner.userId, T1, {}, 'owner');
    await timesheetService.getUtilizationReport(T1, { from: '2026-01-01', to: '2026-12-31' });
    await dashboardService.getActivity(T1, { limit: 50 });
    // The Inbox — four more person projections on the same service.
    await dashboardService.getAdminOverview(T1, {
      callerUserId: owner.userId,
      includeOnboarding: true,
      includeApprovals: true,
      pendingLimit: 50,
    });
    expect(mediaCalls.length).toBeGreaterThan(20);
    // toStrictEqual, NOT toEqual: `toEqual` ignores undefined array items, so
    // an endpoint that OMITS the size argument (the 256 default — exactly the
    // bug this test exists for) would slip through `[64, undefined]`.
    expect([...new Set(mediaCalls.map((c) => c.size))]).toStrictEqual([64]);
    expect(mediaCalls.every((c) => c.size === 64)).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. The shared helper itself (core/storage/signed-avatar)
// ═════════════════════════════════════════════════════════════════════════════

describe('Round N — signed-avatar helper', () => {
  const KEY = 'users/u1/avatar/x_256.webp';

  it('servedAvatarUrl degrades to the legacy url and never returns the raw key', async () => {
    // No R2Service injected at all (hand-built services).
    expect(await servedAvatarUrl(undefined, KEY, LEGACY_URL, 64)).toBe(LEGACY_URL);
    expect(await servedAvatarUrl(undefined, KEY, null, 64)).toBeNull();
    // Configured but unusable.
    expect(await servedAvatarUrl(r2Off, KEY, LEGACY_URL, 64)).toBe(LEGACY_URL);
    expect(await servedAvatarUrl(r2Off, KEY, null, 64)).toBeNull();
    // Configured and throwing — logged, swallowed, falls back.
    await expect(servedAvatarUrl(r2Angry, KEY, LEGACY_URL, 64)).resolves.toBe(LEGACY_URL);
    await expect(servedAvatarUrl(r2Angry, KEY, null, 64)).resolves.toBeNull();
  });

  it('servedAvatarUrl rewrites the stored 256 key for the 64 px rendition, and only then', async () => {
    expect(await servedAvatarUrl(r2On, KEY, null, 64)).toBe('signed:users/u1/avatar/x_64.webp');
    expect(await servedAvatarUrl(r2On, KEY, null, 256)).toBe(`signed:${KEY}`);
    expect(await servedAvatarUrl(r2On, KEY, null)).toBe(`signed:${KEY}`); // the 256 default
  });

  it("withSignedAvatars' Omit<T,'avatarKey'> is honest at runtime", async () => {
    const sign = async (k: string | null, l: string | null) => (k ? `signed:${k}` : l);
    const [withKey] = await withSignedAvatars(sign, [{ id: 'a', avatarKey: KEY, avatarUrl: null }]);
    expect(Object.prototype.hasOwnProperty.call(withKey!, 'avatarKey')).toBe(false);
    expect(withKey).toEqual({ id: 'a', avatarUrl: `signed:${KEY}` });

    // A row that never carried the column must not sprout `avatarKey: undefined`
    // — JSON.stringify would hide it, so the leak sweep would never see it.
    const [noKey] = await withSignedAvatars(sign, [{ id: 'b', avatarUrl: LEGACY_URL }]);
    expect(Object.prototype.hasOwnProperty.call(noKey!, 'avatarKey')).toBe(false);
    expect(Object.keys(noKey!).sort()).toEqual(['avatarUrl', 'id']);
    expect(noKey!.avatarUrl).toBe(LEGACY_URL);

    expect(await withSignedAvatars(sign, [])).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. Tenant isolation — the security contract of the new `users` join
//    (founder round N security review of agent A's change)
//
// `users` is a PLATFORM-GLOBAL table: it has no tenant_id, and every row of
// every workspace lives in it. Round N joined it onto seven read paths, so the
// question that decides whether this change is safe is not "does the photo
// render" but "which `users` row can this join reach".
//
// Two things keep it bounded, and BOTH are pinned below because either can be
// undone by a one-word edit:
//
//   1. migration 0010 — `users` is ENABLE + FORCE RLS with `tenant_members_users`:
//      a tenant connection sees a user ONLY if that user holds a membership in
//      current_setting('app.tenant_id'). Every one of these reads runs inside
//      `withTenant`, which assumes the RLS-bound app role. Move any of them to
//      `dbAdmin` and the join silently reaches every workspace's faces — these
//      tests fail if that ever happens. (scripts/diagnose-rls.sh CANNOT catch
//      it: its sweep only visits tables that have a tenant_id column, and
//      `users` has none.)
//
//   2. the join key is always an id off a row that is ALREADY tenant-scoped —
//      `employees.user_id` from a `tenant_id`-predicated employee, or
//      `audit_log.actor_user_id` from a `tenant_id`-predicated audit row.
//
// The invariant the founder rule reduces to: **a photo may never be exposed
// where the same person's NAME is not already exposed.** The audit trail is
// the sharp edge — `actor_user_id` is a global FK, so a tenant-1 audit row can
// legitimately name a user who is not a tenant-1 member (a platform-admin
// action, or someone whose seat was removed). Those rows already render a null
// actor name; they must now also render a null photo.
// ═════════════════════════════════════════════════════════════════════════════

/** A raw R2 key in a payload — the signed form is always `signed:users/…`. */
const RAW_AVATAR_KEY = /"users\/[0-9a-f-]{36}\/avatar\//;

/** No response may ship the private object path as a value, on any branch. */
function expectNoRawKeyValue(payload: unknown) {
  expect(JSON.stringify(payload) ?? '').not.toMatch(RAW_AVATAR_KEY);
}

/** A seat in an arbitrary tenant with an arbitrary role (mkPerson is T1-only). */
async function mkSeat(
  tenantId: string,
  label: string,
  role: 'owner' | 'admin' | 'manager' | 'finance' | 'employee',
  opts: { managerId?: string | null; avatarKey?: string } = {},
): Promise<Person> {
  const email = `rn-sec-${label}-${rid()}@t.test`;
  const [u] = await dbAdmin
    .insert(users)
    .values({ email, full_name: `${label} Tester`, status: 'active' })
    .returning();
  userIds.push(u!.id);
  const avatarKey = opts.avatarKey ? `users/${u!.id}/avatar/${opts.avatarKey}_256.webp` : null;
  if (avatarKey) {
    await dbAdmin.update(users).set({ avatar_key: avatarKey }).where(eq(users.id, u!.id));
  }
  const [e] = await dbAdmin
    .insert(employees)
    .values({
      tenant_id: tenantId,
      user_id: u!.id,
      employee_code: `RN-S-${rid()}`,
      first_name: label,
      last_name: 'Tester',
      work_email: email,
      date_of_joining: '2026-01-01',
      status: 'active',
      reporting_manager_id: opts.managerId ?? null,
    })
    .returning();
  await dbAdmin
    .insert(memberships)
    .values({ tenant_id: tenantId, user_id: u!.id, role, status: 'active', employee_id: e!.id });
  return { userId: u!.id, employeeId: e!.id, email, expected: avatarKey ? `signed:${avatarKey}` : null };
}

describe('Round N — the users join never crosses a tenant', () => {
  let T2: string;
  let foreign: Person; // a member of T2 ONLY, with a photo
  let departedUserId: string; // a user with a photo and no membership anywhere
  let foreignRegId: string;

  beforeAll(async () => {
    const [t] = await dbAdmin
      .insert(tenants)
      .values({
        name: `RN Avatars T2 ${rid()}`,
        slug: `rn-av2-${rid()}-${Date.now()}`,
        status: 'active',
        currency: 'INR',
        timezone: 'Asia/Kolkata',
      })
      .returning();
    T2 = t!.id;
    foreign = await mkSeat(T2, 'Foreign', 'employee', { avatarKey: 'foreign' });

    // T2's own rows on every surface that grew an avatar join.
    const [lt2] = await dbAdmin
      .insert(leaveTypes)
      .values({ tenant_id: T2, name: 'Casual Leave', code: 'CL', default_quota_days: 12 })
      .returning();
    await dbAdmin.insert(leaveRequests).values({
      tenant_id: T2,
      employee_id: foreign.employeeId,
      leave_type_id: lt2!.id,
      start_date: '2026-11-02',
      end_date: '2026-11-03',
      total_days: 2,
      status: 'pending',
      reason: 'RN avatars — foreign tenant',
    });
    const [reg2] = await dbAdmin
      .insert(attendanceRegularizations)
      .values({
        tenant_id: T2,
        employee_id: foreign.employeeId,
        attendance_date: '2026-08-03',
        request_type: 'missing_punch',
        reason: 'RN avatars — foreign tenant',
        status: 'pending',
      })
      .returning();
    foreignRegId = reg2!.id;
    const [p2] = await dbAdmin
      .insert(timesheetPeriods)
      .values({
        tenant_id: T2,
        employee_id: foreign.employeeId,
        period_start: '2026-03-02',
        period_end: '2026-03-08',
        status: 'submitted',
        total_hours: 8,
        total_billable_hours: 8,
        total_non_billable_hours: 0,
        submitted_at: new Date(),
      })
      .returning();
    await dbAdmin.insert(timesheetEntries).values({
      tenant_id: T2,
      timesheet_period_id: p2!.id,
      employee_id: foreign.employeeId,
      entry_date: '2026-03-02',
      hours: 8,
      category: 'development' as const,
      is_billable: true,
    });

    // Someone who held a seat here and no longer does: the audit row survives
    // the membership (that is the point of an audit trail), so `actor_user_id`
    // still points at a real, photographed user that this tenant may not see.
    const [gone] = await dbAdmin
      .insert(users)
      .values({ email: `rn-sec-gone-${rid()}@t.test`, full_name: 'Departed Tester', status: 'active' })
      .returning();
    departedUserId = gone!.id;
    userIds.push(departedUserId);
    await dbAdmin
      .update(users)
      .set({ avatar_key: `users/${departedUserId}/avatar/gone_256.webp` })
      .where(eq(users.id, departedUserId));

    // Two tenant-1 audit rows whose actor is NOT a tenant-1 member. Written
    // with dbAdmin exactly as a platform-admin action or a pre-offboarding
    // write would have left them behind.
    for (const actor of [foreign.userId, departedUserId]) {
      await dbAdmin.insert(auditLog).values({
        tenant_id: T1,
        actor_user_id: actor,
        action: 'employee.updated',
        resource_type: 'employee',
        resource_id: keyed.employeeId,
      });
    }
  });

  afterAll(async () => {
    // T1's audit rows still reference T2's user; the file-level afterAll drops
    // T1 (cascading those rows) before it deletes `userIds`, so order holds.
    await dbAdmin.delete(tenants).where(eq(tenants.id, T2));
  });

  it('keeps tenant 2 people — and their photos — out of every tenant 1 list', async () => {
    const lists = {
      roster: await attendanceService.listTeamToday(owner.userId, T1, 'owner'),
      regQueue: await attendanceService.listPendingRegularizations(owner.userId, T1, {}, 'owner'),
      leaveTeam: await leaveService.listTeam(owner.userId, T1, { limit: 100 }, 'owner'),
      leavePending: await leaveService.listPending(owner.userId, T1, { limit: 100 }, 'owner'),
      tsTeam: await timesheetService.listTeam(owner.userId, T1, { limit: 100 }, 'owner'),
      tsPending: await timesheetService.listPending(owner.userId, T1, { limit: 100 }, 'owner'),
      utilization: await timesheetService.getUtilizationReport(T1, { from: '2026-01-01', to: '2026-12-31' }),
      // The Inbox: four person projections, the ones an approver stares at.
      inbox: await dashboardService.getAdminOverview(T1, {
        callerUserId: owner.userId,
        includeOnboarding: true,
        includeApprovals: true,
        pendingLimit: 50,
      }),
    };
    const json = JSON.stringify(lists);
    // Neither the person, nor their rows, nor — the Round N addition — the
    // signed URL that would let the caller FETCH their face.
    expect(json).not.toContain(foreign.employeeId);
    expect(json).not.toContain(foreign.userId);
    expect(json).not.toContain(foreign.email);
    expect(json).not.toContain('Foreign Tester');
    expect(json).not.toContain('avatar/foreign');
    expectNoKeyLeak(lists);
    expectNoRawKeyValue(lists);

    // Sanity: the same call DOES carry tenant 1's own photographed people, so
    // the assertions above are not passing on an empty payload.
    expect(lists.roster.find((r) => r.employeeId === keyed.employeeId)?.avatarUrl).toBe(keyed.expected);
    expect(lists.utilization.byEmployee.some((r) => r.avatarUrl === keyed.expected)).toBe(true);
  });

  it('gives an audit actor from another tenant no name AND no photo', async () => {
    // The ROW belongs to tenant 1 and must stay visible — it is the actor's
    // identity that RLS withholds, and the photo must be withheld with it.
    const audit = await auditSigned.search(T1, { limit: 200 });
    for (const actorId of [foreign.userId, departedUserId]) {
      const row = audit.data.find((r) => r.actorUserId === actorId);
      expect(row).toBeDefined();
      expect(row!.actorName).toBeNull();
      expect(row!.actorEmail).toBeNull();
      expect(row!.avatarUrl).toBeNull();
    }

    const feed = await dashboardService.getActivity(T1, { limit: 200 });
    for (const actorId of [foreign.userId, departedUserId]) {
      const item = feed.find((i) => i.actorUserId === actorId);
      expect(item).toBeDefined();
      expect(item!.actorName).toBeNull();
      expect(item!.avatarUrl).toBeNull();
    }

    const json = JSON.stringify({ audit, feed });
    expect(json).not.toContain('avatar/foreign');
    expect(json).not.toContain('avatar/gone');
    expect(json).not.toContain('Departed Tester');
    expectNoRawKeyValue({ audit, feed });
  });

  it('never serves a photo for anyone whose name it withholds', async () => {
    // The founder invariant, asserted over whole payloads rather than named
    // rows: a face is never MORE exposed than the identity beside it.
    const audit = await auditSigned.search(T1, { limit: 200 });
    for (const row of audit.data) {
      if (row.avatarUrl !== null) expect(row.actorName).not.toBeNull();
    }
    const feed = await dashboardService.getActivity(T1, { limit: 200 });
    for (const item of feed) {
      if (item.avatarUrl !== null) expect(item.actorName).not.toBeNull();
    }
    expect(audit.data.some((r) => r.avatarUrl !== null)).toBe(true);
  });

  it("refuses a tenant 2 regularization to tenant 1's owner, photo and all", async () => {
    await expect(
      attendanceService.getRegularizationForReviewer(foreignRegId, owner.userId, T1, 'owner'),
    ).rejects.toThrow(/Regularization not found/);
  });

  // ─── the predicates, not the connection, are what scope these reads ───────
  //
  // Every read above runs through `withTenant`, which pins the RLS-bound app
  // role — so `employees` and `users` are already filtered to this workspace
  // before the query's own predicates are read. That makes it impossible to
  // tell a query that IS scoped from one that merely RUNS on a scoped
  // connection. These re-run the same reads on a connection RLS does not bind
  // (the round-F posture the CRM half of Round N pins for its own reads).
  //
  // The fixture is the case house rule 2 warns about: `employee_id` is a plain
  // FK and FK checks BYPASS RLS, so a tenant-1 row can legitimately be written
  // pointing at a tenant-2 employee. Round N hung a FACE off exactly that
  // join, so the predicate on it is what decides whether such a row renders as
  // "nobody" or as another workspace's employee, photo included.
  describe('with RLS not binding the connection (the round-F posture)', () => {
    /** `withTenant` replaced by the service-role connection: no role, no context. */
    const rlsOff = {
      withTenant: async <T>(_tenantId: string, cb: (tx: never) => Promise<T>) =>
        cb(dbAdmin as never),
    } as unknown as DatabaseService;
    const rlsOffLeave = new LeaveService(rlsOff, auditStub, notifications, config, routing, media);
    const rlsOffTimesheet = new TimesheetService(dbAdmin as never, rlsOff, auditStub, notifications, routing, media);

    let orphanLeaveId: string;

    beforeAll(async () => {
      // A TENANT 1 leave request whose employee lives in tenant 2, and the
      // same shape for timesheets. Seeded last so no count another test pins
      // can move.
      const [orphan] = await dbAdmin
        .insert(leaveRequests)
        .values({
          tenant_id: T1,
          employee_id: foreign.employeeId,
          leave_type_id: leaveTypeId,
          start_date: '2026-11-02',
          end_date: '2026-11-03',
          total_days: 2,
          status: 'pending',
          reason: 'RN avatars — orphan row',
        })
        .returning();
      orphanLeaveId = orphan!.id;
      await seedTimesheet({ employeeId: foreign.employeeId } as Person, { billable: 5, nonBillable: 0 });
    });

    it('a tenant 1 row pointing at another workspace has no name AND no photo', async () => {
      const team = await rlsOffLeave.listTeam(owner.userId, T1, { limit: 100 }, 'owner');
      const orphan = team.data.find((r) => r.id === orphanLeaveId);
      // The ROW is tenant 1's and stays visible — it is the PERSON on it that
      // belongs to another workspace and must not resolve.
      expect(orphan).toBeDefined();
      expect(orphan!.employeeName).toBeNull();
      expect(orphan!.avatarUrl).toBeNull();
      const json = JSON.stringify(team);
      expect(json).not.toContain('Foreign Tester');
      expect(json).not.toContain('avatar/foreign');
      expectNoKeyLeak(team);
      expectNoRawKeyValue(team);
      // Sanity: with the connection wide open, tenant 1's own faces still
      // resolve — the assertions above are not passing on an empty list.
      expect(team.data.find((r) => r.employeeId === keyed.employeeId)!.avatarUrl).toBe(keyed.expected);
    });

    it('the utilization report keeps the hours and drops the borrowed face', async () => {
      const report = await rlsOffTimesheet.getUtilizationReport(T1, { from: '2026-01-01', to: '2026-12-31' });
      const row = report.byEmployee.find((r) => r.employeeId === foreign.employeeId);
      expect(row).toBeDefined();
      // Tenant 1's hours are tenant 1's, whoever logged them…
      expect(row!.totalHours).toBe(5);
      // …but the person behind them belongs to another workspace.
      expect(row!.name).toBeNull();
      expect(row!.avatarUrl).toBeNull();
      const json = JSON.stringify(report);
      expect(json).not.toContain('Foreign Tester');
      expect(json).not.toContain('avatar/foreign');
      expectNoRawKeyValue(report);
    });

    it('never reaches the other workspace’s OWN rows, with or without RLS', async () => {
      // T2's leave request and timesheet period exist (seeded above) — the
      // tenant predicate on the driving table is what keeps them out.
      const team = await rlsOffLeave.listTeam(owner.userId, T1, { limit: 100 }, 'owner');
      expect(team.data.some((r) => r.reason === 'RN avatars — foreign tenant')).toBe(false);
      const tsTeam = await rlsOffTimesheet.listTeam(owner.userId, T1, { limit: 100 }, 'owner');
      expect(tsTeam.data.some((r) => r.periodStart === '2026-03-02')).toBe(false);
      expect(JSON.stringify(tsTeam)).not.toContain('avatar/foreign');
    });
  });
});

describe("Round N — the photo respects the caller's scope", () => {
  let mgr: Person; // a manager of exactly one person
  let report: Person; // that person, photographed
  let fin: Person; // a finance seat: roster yes, leave detail no

  beforeAll(async () => {
    // Declared AFTER the fixture counts this file asserts elsewhere, and
    // deliberately WITHOUT leave / timesheet / audit rows, so the seats below
    // cannot move any total another test pins.
    mgr = await mkSeat(T1, 'Mgr', 'manager');
    report = await mkSeat(T1, 'Report', 'employee', { managerId: mgr.employeeId, avatarKey: 'rep' });
    fin = await mkSeat(T1, 'Fin', 'finance');
  });

  it('shows a manager their own reports — and nobody else — with faces', async () => {
    const rows = await attendanceService.listTeamToday(mgr.userId, T1, 'manager');
    expect(rows.map((r) => r.employeeId)).toEqual([report.employeeId]);
    expect(rows[0]!.avatarUrl).toBe(report.expected);
    // The org's other photographed people never reach this manager's payload.
    const json = JSON.stringify(rows);
    expect(json).not.toContain(keyed.employeeId);
    expect(json).not.toContain('avatar/abc'); // `keyed`'s object path
    expectNoKeyLeak(rows);
    expectNoRawKeyValue(rows);
  });

  it('gives a manager no rows — and no photos — from outside their team', async () => {
    // `report` has no leave / timesheet rows, so these queues are empty for
    // this manager: every row in them would belong to somebody else's team.
    for (const res of [
      await leaveService.listTeam(mgr.userId, T1, { limit: 100 }, 'manager'),
      await leaveService.listPending(mgr.userId, T1, { limit: 100 }, 'manager'),
      await timesheetService.listTeam(mgr.userId, T1, { limit: 100 }, 'manager'),
      await timesheetService.listPending(mgr.userId, T1, { limit: 100 }, 'manager'),
    ]) {
      expect(res.data).toEqual([]);
    }
    const regQueue = await attendanceService.listPendingRegularizations(mgr.userId, T1, {}, 'manager');
    expect(regQueue.data).toEqual([]);
  });

  it('runs the may-act guard BEFORE it hands over the requester’s photo', async () => {
    // `keyed` reports to the owner, not to this manager. The refusal must be
    // the same 404 it always was — never a row that happens to carry a face.
    await expect(
      attendanceService.getRegularizationForReviewer(regIds.keyed!, mgr.userId, T1, 'manager'),
    ).rejects.toThrow(/Regularization not found/);
    // …and the same for a finance seat, which reviews nothing at all.
    await expect(
      attendanceService.getRegularizationForReviewer(regIds.keyed!, fin.userId, T1, 'finance'),
    ).rejects.toThrow(/Regularization not found/);
  });

  it('keeps finance on the roster with faces, but still without leave details', async () => {
    // Round L put finance on `team/today` (roster + "On leave"/expected) while
    // withholding the request behind it. Adding the join must not have moved
    // that line: photos yes, leave payload no. (The positive branch — an
    // approved leave TODAY that the owner can see and finance cannot — is
    // covered with its own fixture in founder-roundL-a.spec.ts.)
    const rows = await attendanceService.listTeamToday(fin.userId, T1, 'finance');
    expect(rows.find((r) => r.employeeId === keyed.employeeId)?.avatarUrl).toBe(keyed.expected);
    for (const r of rows) {
      expect(r.leave).toBeNull();
      expect(r.pendingLeave).toBe(false);
      expect(r.dayKind).not.toBe('half_day_leave');
    }
    expectNoKeyLeak(rows);
    expectNoRawKeyValue(rows);
  });

  it('gives a finance seat no approval rows — and so no photos — to review', async () => {
    for (const res of [
      await leaveService.listTeam(fin.userId, T1, { limit: 100 }, 'finance'),
      await leaveService.listPending(fin.userId, T1, { limit: 100 }, 'finance'),
      await timesheetService.listTeam(fin.userId, T1, { limit: 100 }, 'finance'),
      await timesheetService.listPending(fin.userId, T1, { limit: 100 }, 'finance'),
    ]) {
      expect(res.data).toEqual([]);
    }
  });
});
