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
    expect(mediaCalls.length).toBeGreaterThan(20);
    expect([...new Set(mediaCalls.map((c) => c.size))]).toEqual([64]);
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
