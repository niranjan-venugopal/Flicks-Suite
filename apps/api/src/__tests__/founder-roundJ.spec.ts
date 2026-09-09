/**
 * Founder round J (2026-09-09) — the Teams-style calendar.
 *
 *  Feed   — holidays (location-scoped), my leave (any status), team leave
 *           (teammates + reports + manager; owner/HR admin see everyone;
 *           pending stays private; never the reason), birthdays & work
 *           anniversaries (same scope + self), my CRM calls & meetings (only
 *           with CRM access), and user-authored events / meetings under the
 *           visibility rule (organizer, attendee, company, org-wide).
 *  Events — create / edit / cancel / RSVP with in-tenant attendee checks,
 *           provider host rules, timezone-independent all-day storage,
 *           organizer-only edits, delta notifications with an .ics invite,
 *           the tenant-room `calendar.changed` push, and RLS isolation.
 *  iCal   — timed VEVENTs in UTC, LOCATION/URL/ORGANIZER/ATTENDEE, folding,
 *           tenant X-WR-TIMEZONE, cancelled + declined excluded, members
 *           without an employee row still get a feed.
 *
 * Service-level against the real Postgres (founder-round8 harness).
 */
import 'dotenv/config';
import * as crypto from 'crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db, dbAdmin } from '@flicks/db';
import {
  tenants,
  users,
  memberships,
  membershipGrants,
  employees,
  locations,
  holidays,
  leaveTypes,
  leaveRequests,
  activities,
  calendarEvents,
  calendarEventAttendees,
} from '@flicks/db/schema';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BadRequestException, ForbiddenException, NotFoundException, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import type { JwtPayload, UserRole } from '@flicks/shared/types';
import { DatabaseService } from '../core/database/database.service';
import { ModuleAccessService } from '../core/auth/module-access.service';
import { guestPathAllowed } from '../core/auth/guards/guest-scope.guard';
import { formatRangeInTimezone, isValidTimezone } from '../core/common/time';
import { CalendarService } from '../modules/calendar/calendar.service';
import { MeetingLinksService } from '../modules/calendar/meeting-links.service';
import { CreateCalendarEventDto } from '../modules/calendar/calendar.dto';
import { ActivitiesService } from '../modules/crm/activities.service';
import { CrmPublicService } from '../modules/crm/public';
import { NotificationsService } from '../modules/notifications/notifications.service';
import type { AuditService } from '../modules/audit/audit.service';
import type { MediaService } from '../modules/media/media.service';

jest.setTimeout(90_000);

const rid = () => crypto.randomBytes(4).toString('hex');
const APP_URL = 'https://app.roundj.test';

/** Notifications are fire-and-forget by design (house rule 6) — poll. */
async function waitFor(pred: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}
const settle = () => new Promise((r) => setTimeout(r, 150));

const audit = { log: async () => {} } as unknown as AuditService;
const createInAppNotification = jest.fn(async () => undefined);
const sendEmail = jest.fn(async () => true);
const notifications = { createInAppNotification, sendEmail } as unknown as NotificationsService;
const media = {
  servedUrl: async (k: string | null, l: string | null) => (k ? `signed:${k}` : l),
} as unknown as MediaService;

const dbSvc = new DatabaseService();
const emitter = new EventEmitter2();
const changed: Array<{ tenantId?: string; eventId?: string }> = [];
emitter.on('calendar.changed', (p: { tenantId?: string; eventId?: string }) => changed.push(p));
const eventsStub = { publish: jest.fn(async () => 'evt') };
const presenceStub = { statusOf: jest.fn(async () => 'available') };

const config = new ConfigService({ NODE_ENV: 'test', APP_URL, JWT_SECRET: 'roundj-test-secret', API_URL: 'https://api.roundj.test' });
const moduleAccess = new ModuleAccessService(dbSvc, dbAdmin as never);
const activitiesSvc = new ActivitiesService(dbSvc, audit, eventsStub as never, notifications, presenceStub as never);
const crmPublic = new CrmPublicService(null as never, null as never, null as never, null as never, activitiesSvc);
const meetingLinks = new MeetingLinksService();
const calendar = new CalendarService(
  dbSvc,
  dbAdmin as never,
  config,
  audit,
  notifications,
  eventsStub as never,
  emitter,
  media,
  crmPublic,
  moduleAccess,
  meetingLinks,
);
const realNotifications = new NotificationsService(db as never, dbAdmin as never, config, emitter);

// ─── Fixtures ────────────────────────────────────────────────────────────────

let T1: string;
let T2: string;
const userIds: string[] = [];

type Person = { userId: string; employeeId: string | null; membershipId: string; email: string; name: string };
let O: Person; // owner
let M: Person; // manager (reports to O)
let M2: Person; // manager (reports to O)
let R1: Person; let R2: Person; let R3: Person; // M's reports
let R5: Person; // removed report of M
let X1: Person; // M2's report, CRM access revoked
let N: Person; // owner seat, no employee row
let G: Person; // guest seat
let A: Person; // auditor seat
let D: Person; // deactivated member
let Z: Person; // owner of T2
let L1: string; let L2: string; // locations
let leaveTypeId: string;
let H0: string; let H1: string; let H2: string;
let mtgActivityId: string;
let doneActivityId: string;

const isoPlus = (days: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const mmdd = (iso: string) => iso.slice(5);
const FROM = isoPlus(1);
const TO = isoPlus(30);
const TENANT_NAME = `RJ main ${rid()}`;

async function mkUser(label: string, timezone = 'Asia/Kolkata') {
  const email = `rj-${label.toLowerCase()}-${rid()}@t.test`;
  const [u] = await dbAdmin.insert(users).values({ email, full_name: `${label} Tester`, status: 'active', timezone }).returning();
  userIds.push(u!.id);
  return { id: u!.id, email, name: `${label} Tester` };
}

async function mkPerson(
  tenantId: string,
  label: string,
  role: UserRole,
  opts: { managerId?: string | null; deleted?: boolean; locationId?: string | null; dob?: string; doj?: string; noEmployee?: boolean; status?: 'active' | 'deactivated' } = {},
): Promise<Person> {
  const u = await mkUser(label);
  let employeeId: string | null = null;
  if (!opts.noEmployee) {
    const [e] = await dbAdmin
      .insert(employees)
      .values({
        tenant_id: tenantId,
        user_id: u.id,
        employee_code: `RJ-${rid()}`,
        first_name: label,
        last_name: 'Tester',
        work_email: u.email,
        date_of_joining: opts.doj ?? '2026-01-01',
        date_of_birth: opts.dob ?? null,
        status: 'active',
        reporting_manager_id: opts.managerId ?? null,
        location_id: opts.locationId ?? null,
        ...(opts.deleted ? { deleted_at: new Date() } : {}),
      })
      .returning();
    employeeId = e!.id;
  }
  const [m] = await dbAdmin
    .insert(memberships)
    .values({ tenant_id: tenantId, user_id: u.id, role, status: opts.status ?? 'active', employee_id: employeeId })
    .returning();
  return { userId: u.id, employeeId, membershipId: m!.id, email: u.email, name: u.name };
}

const jwt = (p: Person, role: UserRole, tenantId = T1, extra: Partial<JwtPayload> = {}): JwtPayload =>
  ({
    sub: p.userId,
    email: p.email,
    tenantId,
    membershipId: p.membershipId,
    role,
    isPlatformAdmin: false,
    deviceId: 'dev',
    iat: 0,
    exp: 0,
    iss: 'flicks',
    aud: 'flicks',
    ...extra,
  }) as JwtPayload;

async function seedLeave(p: Person, start: string, end: string, status: 'approved' | 'pending') {
  const [r] = await dbAdmin
    .insert(leaveRequests)
    .values({
      tenant_id: T1,
      employee_id: p.employeeId!,
      leave_type_id: leaveTypeId,
      start_date: start,
      end_date: end,
      total_days: 1,
      reason: 'SECRET medical reason — never shown to teammates',
      status,
    })
    .returning();
  return r!.id;
}

const timed = (dayOffset: number, hh: number, minutes = 30) => {
  const s = new Date(`${isoPlus(dayOffset)}T${String(hh).padStart(2, '0')}:00:00.000Z`);
  return { startAt: s.toISOString(), endAt: new Date(s.getTime() + minutes * 60_000).toISOString() };
};

const resetSpies = () => {
  createInAppNotification.mockClear();
  sendEmail.mockClear();
  eventsStub.publish.mockClear();
  changed.length = 0;
};

beforeAll(async () => {
  const [t] = await dbAdmin
    .insert(tenants)
    .values({ name: TENANT_NAME, slug: `rj-${rid()}-${Date.now()}`, status: 'active', currency: 'INR', week_starts_on: 1, timezone: 'Asia/Kolkata' })
    .returning();
  T1 = t!.id;
  const [t2] = await dbAdmin
    .insert(tenants)
    .values({ name: `RJ other ${rid()}`, slug: `rj2-${rid()}-${Date.now()}`, status: 'active', currency: 'INR' })
    .returning();
  T2 = t2!.id;

  const [l1] = await dbAdmin.insert(locations).values({ tenant_id: T1, name: 'Chennai', timezone: 'Asia/Kolkata' }).returning();
  const [l2] = await dbAdmin.insert(locations).values({ tenant_id: T1, name: 'Dubai', timezone: 'Asia/Dubai' }).returning();
  L1 = l1!.id;
  L2 = l2!.id;

  O = await mkPerson(T1, 'Owner', 'owner');
  M = await mkPerson(T1, 'Mgr', 'manager', { managerId: O.employeeId, locationId: L1 });
  M2 = await mkPerson(T1, 'MgrTwo', 'manager', { managerId: O.employeeId });
  R1 = await mkPerson(T1, 'RepOne', 'employee', { managerId: M.employeeId, locationId: L1, dob: `1990-${mmdd(isoPlus(5))}` });
  R2 = await mkPerson(T1, 'RepTwo', 'employee', { managerId: M.employeeId, doj: `${Number(isoPlus(7).slice(0, 4)) - 2}-${mmdd(isoPlus(7))}` });
  R3 = await mkPerson(T1, 'RepThree', 'employee', { managerId: M.employeeId, doj: isoPlus(9) });
  R5 = await mkPerson(T1, 'RepDeleted', 'employee', { managerId: M.employeeId, deleted: true });
  X1 = await mkPerson(T1, 'OtherOne', 'employee', { managerId: M2.employeeId, locationId: L2 });
  N = await mkPerson(T1, 'NoEmp', 'owner', { noEmployee: true });
  G = await mkPerson(T1, 'Guest', 'guest', { noEmployee: true });
  A = await mkPerson(T1, 'Auditor', 'auditor', { noEmployee: true });
  D = await mkPerson(T1, 'Deactivated', 'employee', { status: 'deactivated' });
  Z = await mkPerson(T2, 'Zed', 'owner', {});

  // X1 has no CRM access (member grant row = none).
  await dbAdmin.insert(membershipGrants).values({ tenant_id: T1, membership_id: X1.membershipId, module: 'crm', access_level: 'none' });

  const [lt] = await dbAdmin
    .insert(leaveTypes)
    .values({ tenant_id: T1, name: 'Casual Leave', code: `CL${rid().slice(0, 3)}`, default_quota_days: 12, is_paid: true, is_active: true })
    .returning();
  leaveTypeId = lt!.id;

  await seedLeave(R3, isoPlus(3), isoPlus(4), 'approved');
  await seedLeave(R2, isoPlus(6), isoPlus(6), 'pending');
  await seedLeave(X1, isoPlus(8), isoPlus(8), 'approved');
  await seedLeave(M, isoPlus(10), isoPlus(10), 'approved');
  await seedLeave(R5, isoPlus(12), isoPlus(12), 'approved');

  const [h0] = await dbAdmin.insert(holidays).values({ tenant_id: T1, holiday_date: isoPlus(2), name: 'Company-wide day', type: 'national' }).returning();
  const [h1] = await dbAdmin.insert(holidays).values({ tenant_id: T1, holiday_date: isoPlus(11), name: 'Chennai only', type: 'optional', location_id: L1 }).returning();
  const [h2] = await dbAdmin.insert(holidays).values({ tenant_id: T1, holiday_date: isoPlus(13), name: 'Dubai only', type: 'regional', location_id: L2 }).returning();
  H0 = h0!.id; H1 = h1!.id; H2 = h2!.id;

  const [act] = await dbAdmin
    .insert(activities)
    .values({ tenant_id: T1, type: 'meeting', subject: 'Discovery call with Acme', assignee_user_id: M.userId, due_at: new Date(`${isoPlus(4)}T09:00:00.000Z`), created_by: M.userId })
    .returning();
  mtgActivityId = act!.id;
  const [done] = await dbAdmin
    .insert(activities)
    .values({ tenant_id: T1, type: 'meeting', subject: 'Kickoff (done)', assignee_user_id: M.userId, due_at: new Date(`${isoPlus(3)}T11:00:00.000Z`), completed_at: new Date(), created_by: M.userId })
    .returning();
  doneActivityId = done!.id;
  await dbAdmin.insert(activities).values({ tenant_id: T1, type: 'task', subject: 'Send proposal (task, not on calendar)', assignee_user_id: M.userId, due_at: new Date(`${isoPlus(5)}T09:00:00.000Z`), created_by: M.userId });
  await dbAdmin.insert(activities).values({ tenant_id: T1, type: 'call', subject: 'X1 private call', assignee_user_id: X1.userId, due_at: new Date(`${isoPlus(6)}T09:00:00.000Z`), created_by: X1.userId });
});

afterAll(async () => {
  for (const t of [T1, T2]) await dbAdmin.delete(tenants).where(eq(tenants.id, t));
  for (const u of userIds) await dbAdmin.delete(users).where(eq(users.id, u));
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
});

const feedFor = async (p: Person, role: UserRole, from = FROM, to = TO) => calendar.listFeed(jwt(p, role), from, to);
const ofType = <T extends { type: string }>(items: T[], type: string): T[] => items.filter((i) => i.type === type);
const teamLeaveNames = <T extends { type: string; title: string }>(items: T[]) => ofType(items, 'team_leave').map((i) => i.title.split(' · ')[0]);

// ═════════════════════════════════════════════════════════════════════════════
// 0. Schema (migration 0061)
// ═════════════════════════════════════════════════════════════════════════════

describe('Round J — migration 0061 landed (indexes, policies, grants, constraints)', () => {
  it('indexes exist on both tables and on leave_requests', async () => {
    const rows = await dbAdmin.execute(sql`
      SELECT indexname FROM pg_indexes WHERE indexname IN (
        'idx_calendar_events_tenant_range','idx_calendar_events_organizer',
        'idx_calendar_attendees_user','idx_calendar_attendees_event','idx_leave_requests_tenant_range')`);
    expect((rows as unknown as Array<{ indexname: string }>).map((r) => r.indexname).sort()).toEqual([
      'idx_calendar_attendees_event',
      'idx_calendar_attendees_user',
      'idx_calendar_events_organizer',
      'idx_calendar_events_tenant_range',
      'idx_leave_requests_tenant_range',
    ]);
  });

  it('RLS is forced with a tenant_isolation policy and flicks_app can write both tables', async () => {
    const pol = await dbAdmin.execute(sql`
      SELECT tablename, policyname FROM pg_policies
      WHERE tablename IN ('calendar_events','calendar_event_attendees') AND policyname LIKE 'tenant_isolation_%'`);
    expect((pol as unknown as Array<{ tablename: string }>).map((r) => r.tablename).sort()).toEqual(['calendar_event_attendees', 'calendar_events']);
    const forced = await dbAdmin.execute(sql`
      SELECT relname, relforcerowsecurity FROM pg_class WHERE relname IN ('calendar_events','calendar_event_attendees')`);
    for (const r of forced as unknown as Array<{ relforcerowsecurity: boolean }>) expect(r.relforcerowsecurity).toBe(true);
    const priv = await dbAdmin.execute(sql`
      SELECT has_table_privilege('flicks_app','calendar_events','INSERT') AS a,
             has_table_privilege('flicks_app','calendar_event_attendees','INSERT') AS b`);
    expect((priv as unknown as Array<{ a: boolean; b: boolean }>)[0]).toEqual({ a: true, b: true });
  });

  it('the check constraints guard kind / provider / range at the database', async () => {
    const rows = await dbAdmin.execute(sql`
      SELECT conname FROM pg_constraint WHERE conname IN ('calendar_events_kind_chk','calendar_events_provider_chk','calendar_events_range_chk')`);
    expect((rows as unknown as Array<{ conname: string }>).length).toBe(3);
    await expect(
      dbAdmin.insert(calendarEvents).values({
        tenant_id: T1, event_type: 'company_event', title: 'bad', start_at: new Date('2026-10-01T10:00:00Z'), end_at: new Date('2026-10-01T09:00:00Z'), kind: 'event',
      }),
    ).rejects.toThrow(/calendar_events_range_chk/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 1. Feed scope
// ═════════════════════════════════════════════════════════════════════════════

describe('Round J — feed: team availability scope (teammates + reports + manager)', () => {
  it('owner sees every approved leave in the workspace, never pending, never removed staff', async () => {
    const feed = await feedFor(O, 'owner');
    const names = teamLeaveNames(feed.data);
    expect(names).toEqual(expect.arrayContaining(['RepThree Tester', 'OtherOne Tester', 'Mgr Tester']));
    expect(names).not.toContain('RepTwo Tester'); // pending
    expect(names).not.toContain('RepDeleted Tester'); // deleted_at
    // Names + leave-type code only — the reason never leaves the request.
    for (const it of ofType(feed.data, 'team_leave')) {
      expect(JSON.stringify(it)).not.toMatch(/SECRET/);
      expect(it.title).toMatch(/ · /);
    }
  });

  it('a manager sees their reports but not another team', async () => {
    const feed = await feedFor(M, 'manager');
    const names = teamLeaveNames(feed.data);
    expect(names).toContain('RepThree Tester');
    expect(names).not.toContain('OtherOne Tester');
    expect(names).not.toContain('RepDeleted Tester');
    // Own leave is "my leave", never "team leave".
    expect(names).not.toContain('Mgr Tester');
    expect(ofType(feed.data, 'my_leave')).toHaveLength(1);
  });

  it('an employee sees a teammate (same manager) and their manager, not another team', async () => {
    const feed = await feedFor(R1, 'employee');
    const names = teamLeaveNames(feed.data);
    expect(names).toEqual(expect.arrayContaining(['RepThree Tester', 'Mgr Tester']));
    expect(names).not.toContain('OtherOne Tester');
    expect(names).not.toContain('RepDeleted Tester');
    expect(names).not.toContain('RepTwo Tester');
  });

  it('a member on a team with no other leave sees nothing (and never R3)', async () => {
    const feed = await feedFor(X1, 'employee');
    expect(ofType(feed.data, 'team_leave')).toHaveLength(0);
    expect(ofType(feed.data, 'my_leave')).toHaveLength(1);
  });

  it('a pending request is visible only to its owner, with its status', async () => {
    const mine = await feedFor(R2, 'employee');
    const pending = ofType(mine.data, 'my_leave');
    expect(pending).toHaveLength(1);
    expect(pending[0]!.status).toBe('pending');
    expect(pending[0]!.title).toMatch(/pending/);
    for (const p of [O, M, R1] as const) {
      const f = await feedFor(p, p === O ? 'owner' : p === M ? 'manager' : 'employee');
      expect(teamLeaveNames(f.data)).not.toContain('RepTwo Tester');
    }
  });
});

describe('Round J — feed: holidays, birthdays, anniversaries, CRM, prefs', () => {
  it('holidays are company-wide plus the viewer’s own location, with a blocking flag', async () => {
    const r1 = await feedFor(R1, 'employee');
    const ids = ofType(r1.data, 'holiday').map((h) => h.id);
    expect(ids).toEqual(expect.arrayContaining([`holiday:${H0}`, `holiday:${H1}`]));
    expect(ids).not.toContain(`holiday:${H2}`);
    const h0 = r1.data.find((h) => h.id === `holiday:${H0}`)!;
    const h1 = r1.data.find((h) => h.id === `holiday:${H1}`)!;
    expect(h0.meta?.blocking).toBe(true);
    expect(h1.meta?.blocking).toBe(false);
    expect(h0.allDay).toBe(true);
    expect(h0.startDate).toBe(isoPlus(2));

    const x1 = await feedFor(X1, 'employee');
    const xids = ofType(x1.data, 'holiday').map((h) => h.id);
    expect(xids).toEqual(expect.arrayContaining([`holiday:${H0}`, `holiday:${H2}`]));
    expect(xids).not.toContain(`holiday:${H1}`);
  });

  it('birthdays follow the availability scope (plus self); anniversaries skip the joining year and count years', async () => {
    const m = await feedFor(M, 'manager');
    const bday = ofType(m.data, 'birthday');
    expect(bday.map((b) => b.title)).toContain("🎂 RepOne's birthday");
    expect(bday[0]!.startDate).toBe(isoPlus(5));
    expect(bday[0]!.link).toBe(`/employees/${R1.employeeId}`); // managers may open profiles
    const anniv = ofType(m.data, 'anniversary');
    expect(anniv.map((a) => a.title)).toContain(`🎉 RepTwo · 2 years at ${TENANT_NAME}`);
    expect(anniv.map((a) => a.title).join(' ')).not.toMatch(/RepThree/); // joined this year
    expect(anniv.find((a) => a.title.includes('RepTwo'))!.startDate).toBe(isoPlus(7));

    const r2 = await feedFor(R2, 'employee'); // teammate
    expect(ofType(r2.data, 'birthday').map((b) => b.title)).toContain("🎂 RepOne's birthday");
    expect(ofType(r2.data, 'anniversary').map((a) => a.title)).toContain(`🎉 2 years at ${TENANT_NAME}`); // self
    expect(ofType(r2.data, 'birthday')[0]!.link).toBeUndefined(); // employees don't open profiles

    const r1 = await feedFor(R1, 'employee');
    expect(ofType(r1.data, 'birthday').map((b) => b.title)).toContain('🎂 Your birthday');

    const o = await feedFor(O, 'owner');
    expect(ofType(o.data, 'birthday').map((b) => b.title)).toContain("🎂 RepOne's birthday");

    const x1 = await feedFor(X1, 'employee');
    expect(ofType(x1.data, 'birthday')).toHaveLength(0);
    expect(ofType(x1.data, 'anniversary')).toHaveLength(0);
  });

  it('CRM calls & meetings: own scheduled ones only, only with CRM access', async () => {
    const m = await feedFor(M, 'manager');
    expect(m.sources.crm).toBe(true);
    const crm = ofType(m.data, 'crm_activity');
    expect(crm.map((c) => c.id)).toEqual(expect.arrayContaining([`crm_activity:${mtgActivityId}`, `crm_activity:${doneActivityId}`]));
    expect(crm.map((c) => c.title).join(' ')).not.toMatch(/task/i);
    expect(crm.map((c) => c.title).join(' ')).not.toMatch(/X1 private/);
    const mtg = crm.find((c) => c.id === `crm_activity:${mtgActivityId}`)!;
    expect(mtg.title).toBe('🤝 Discovery call with Acme');
    expect(mtg.allDay).toBe(false);
    expect(new Date(mtg.endAt).getTime() - new Date(mtg.startAt).getTime()).toBe(30 * 60_000);
    expect(mtg.link).toBe('/crm/activities');
    expect(mtg.canEdit).toBe(false);
    expect(crm.find((c) => c.id === `crm_activity:${doneActivityId}`)!.meta?.completed).toBe(true);

    const x1 = await feedFor(X1, 'employee');
    expect(x1.sources.crm).toBe(false);
    expect(ofType(x1.data, 'crm_activity')).toHaveLength(0);

    const r1 = await feedFor(R1, 'employee');
    expect(r1.sources.crm).toBe(true); // built-in default: employees hold CRM
    expect(ofType(r1.data, 'crm_activity')).toHaveLength(0); // but never someone else's activity
  });

  it('a seat without an employee row still resolves: holidays + prefs, no leave/birthday sources', async () => {
    const n = await feedFor(N, 'owner');
    expect(n.prefs).toEqual({ timezone: 'Asia/Kolkata', weekStartsOn: 1, workingDays: [1, 2, 3, 4, 5], workStart: '09:00', workEnd: '18:00' });
    expect(ofType(n.data, 'holiday').map((h) => h.id)).toEqual([`holiday:${H0}`]);
    expect(ofType(n.data, 'my_leave')).toHaveLength(0);
    // Owner is org-wide: team leave still shows.
    expect(teamLeaveNames(n.data)).toContain('RepThree Tester');
  });

  it('range validation: to < from, > 93 days, malformed dates → 400', async () => {
    await expect(feedFor(O, 'owner', isoPlus(5), isoPlus(1))).rejects.toThrow(BadRequestException);
    await expect(feedFor(O, 'owner', isoPlus(0), isoPlus(100))).rejects.toThrow(BadRequestException);
    await expect(feedFor(O, 'owner', '2026-13-45', '2026-13-46')).rejects.toThrow(BadRequestException);
  });

  it('guests and auditors have no calendar (403), and the guest path allowlist denies /calendar', async () => {
    await expect(feedFor(G, 'guest')).rejects.toThrow(ForbiddenException);
    await expect(feedFor(A, 'auditor')).rejects.toThrow(ForbiddenException);
    expect(guestPathAllowed('/api/v1/calendar/events?from=2026-09-01&to=2026-09-30')).toBe(false);
    expect(guestPathAllowed('/api/v1/calendar/people')).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Create
// ═════════════════════════════════════════════════════════════════════════════

let meetingId: string;

describe('Round J — create an event / schedule a meeting', () => {
  it('happy path: rows, organizer auto-accepted, domain event in the tx, invites with .ics, push', async () => {
    resetSpies();
    const before = await dbAdmin.select({ id: calendarEvents.id }).from(calendarEvents).where(eq(calendarEvents.tenant_id, T1));
    const res = await calendar.createEvent(jwt(M, 'manager'), {
      kind: 'meeting',
      title: 'Sprint sync',
      description: 'Agenda: blockers',
      location: 'Board room',
      allDay: false,
      ...timed(2, 10),
      timezone: 'Asia/Kolkata',
      meetingProvider: 'teams',
      meetingUrl: 'https://teams.microsoft.com/l/meetup-join/abc',
      attendees: [{ userId: R1.userId }, { userId: R2.userId, isOptional: true }, { userId: R1.userId }],
    });
    meetingId = res.data.id;
    expect(res.data.type).toBe('meeting');
    expect(res.data.canEdit).toBe(true);
    expect(res.data.myResponse).toBe('accepted');
    expect(res.data.meetingProvider).toBe('teams');
    expect(res.data.meetingUrl).toBe('https://teams.microsoft.com/l/meetup-join/abc');
    expect(res.data.visibility).toBe('private');
    expect(res.data.organizer?.userId).toBe(M.userId);
    expect(res.data.attendees?.map((a) => [a.userId, a.response, a.isOptional])).toEqual(
      expect.arrayContaining([
        [M.userId, 'accepted', false],
        [R1.userId, 'pending', false],
        [R2.userId, 'pending', true],
      ]),
    );
    expect(res.data.attendees).toHaveLength(3); // duplicate R1 collapsed

    const after = await dbAdmin.select({ id: calendarEvents.id, event_type: calendarEvents.event_type, kind: calendarEvents.kind, organizer: calendarEvents.organizer_user_id }).from(calendarEvents).where(eq(calendarEvents.tenant_id, T1));
    expect(after.length).toBe(before.length + 1);
    const row = after.find((r) => r.id === meetingId)!;
    expect(row.event_type).toBe('company_event');
    expect(row.kind).toBe('meeting');
    expect(row.organizer).toBe(M.userId);

    // Domain event published INSIDE the tenant transaction.
    const pub = eventsStub.publish.mock.calls.find((c: unknown[]) => (c[0] as { name: string }).name === 'calendar.event.created') as unknown[] | undefined;
    expect(pub).toBeDefined();
    expect(pub![1]).toBeDefined();
    expect((pub![0] as { payload: Record<string, unknown> }).payload).toMatchObject({ event_id: meetingId, kind: 'meeting', provider: 'teams', attendee_count: 2 });

    // After commit: tenant-room push + best-effort notifications to invitees only.
    expect(changed).toEqual(expect.arrayContaining([{ tenantId: T1, eventId: meetingId }]));
    await waitFor(() => createInAppNotification.mock.calls.length >= 2 && sendEmail.mock.calls.length >= 2);
    const inApp = createInAppNotification.mock.calls as unknown as Array<[string, string, string, string, string, { groupKey?: string }]>;
    expect(inApp.map((c) => c[0]).sort()).toEqual([R1.userId, R2.userId].sort());
    for (const c of inApp) {
      expect(c[1]).toBe('calendar.event.invited');
      expect(c[2]).toMatch(/^Mgr Tester invited you: Sprint sync · /);
      expect(c[3]).toBe(`/calendar?event=${meetingId}&date=${isoPlus(2)}`);
      expect(c[4]).toBe(T1);
      expect(c[5]).toEqual({ groupKey: `calendar:${meetingId}` });
    }
    const mails = sendEmail.mock.calls as unknown as Array<[string, string, Record<string, unknown>, { userId: string; event: string; attachments?: Array<{ filename: string; content: string; contentType?: string }> }]>;
    expect(mails.map((m) => m[0])).toEqual(['calendar-invite', 'calendar-invite']);
    expect(mails.map((m) => m[1]).sort()).toEqual([R1.email, R2.email].sort());
    for (const m of mails) {
      expect(m[3].event).toBe('calendar_invited');
      expect([R1.userId, R2.userId]).toContain(m[3].userId);
      expect(m[3].attachments).toHaveLength(1);
      expect(m[3].attachments![0]!.filename).toBe('invite.ics');
      expect(m[3].attachments![0]!.contentType).toContain('text/calendar');
      expect(m[3].attachments![0]!.content).toContain('METHOD:REQUEST');
      // Long content lines are folded (RFC 5545 §3.1) — unfold before matching.
      expect(m[3].attachments![0]!.content.replace(/\r\n /g, '')).toContain(`UID:event-${meetingId}@flicks.${T1}`);
      expect(m[2].meetingUrl).toBe('https://teams.microsoft.com/l/meetup-join/abc');
      expect(m[2].organizerName).toBe('Mgr Tester');
      expect(m[2].when).toMatch(/IST/);
    }
    expect(inApp.some((c) => c[0] === M.userId)).toBe(false);
  });

  it('visibility: attendees + organizer + org-wide roles see a private meeting; others get nothing / 404', async () => {
    const m = await feedFor(M, 'manager');
    expect(m.data.find((i) => i.id === meetingId)?.type).toBe('meeting');
    const r1 = await feedFor(R1, 'employee');
    const mine = r1.data.find((i) => i.id === meetingId)!;
    expect(mine.myResponse).toBe('pending');
    expect(mine.canEdit).toBe(false);
    expect(mine.startDate).toBe(isoPlus(2));
    const o = await feedFor(O, 'owner');
    expect(o.data.find((i) => i.id === meetingId)?.canEdit).toBe(true);
    const x1 = await feedFor(X1, 'employee');
    expect(x1.data.find((i) => i.id === meetingId)).toBeUndefined();
    await expect(calendar.getEvent(jwt(X1, 'employee'), meetingId)).rejects.toThrow(NotFoundException);
    expect((await calendar.getEvent(jwt(R1, 'employee'), meetingId)).data.attendees).toHaveLength(3);
    await expect(calendar.getEvent(jwt(G, 'guest'), meetingId)).rejects.toThrow(ForbiddenException);
  });

  it('an invitee from another tenant, a guest or an auditor is rejected before anything is written (FK checks bypass RLS)', async () => {
    const count = async () => (await dbAdmin.select({ id: calendarEvents.id }).from(calendarEvents).where(eq(calendarEvents.tenant_id, T1))).length;
    const before = await count();
    for (const bad of [Z, G, A, D]) {
      resetSpies();
      await expect(
        calendar.createEvent(jwt(M, 'manager'), { kind: 'event', title: 'Nope', allDay: false, ...timed(3, 9), attendees: [{ userId: bad.userId }] }),
      ).rejects.toThrow(BadRequestException);
      expect(changed).toHaveLength(0);
      expect(createInAppNotification).not.toHaveBeenCalled();
    }
    expect(await count()).toBe(before);
  });

  it('validation: end ≤ start, spans, unknown timezone, wrong provider host, http link', async () => {
    const base = { kind: 'event' as const, title: 'V', allDay: false };
    const t = timed(3, 9);
    await expect(calendar.createEvent(jwt(M, 'manager'), { ...base, startAt: t.endAt, endAt: t.startAt })).rejects.toThrow(/after start/i);
    await expect(calendar.createEvent(jwt(M, 'manager'), { ...base, startAt: t.startAt, endAt: new Date(new Date(t.startAt).getTime() + 15 * 86_400_000).toISOString() })).rejects.toThrow(/14 days/);
    await expect(calendar.createEvent(jwt(M, 'manager'), { ...base, allDay: true, startDate: isoPlus(3), endDate: isoPlus(40) })).rejects.toThrow(/31 days/);
    await expect(calendar.createEvent(jwt(M, 'manager'), { ...base, ...t, timezone: 'Mars/Olympus' })).rejects.toThrow(/timezone/i);
    await expect(calendar.createEvent(jwt(M, 'manager'), { ...base, ...t, meetingProvider: 'teams', meetingUrl: 'https://zoom.us/j/123' })).rejects.toThrow(/teams\.microsoft\.com/);
    await expect(calendar.createEvent(jwt(M, 'manager'), { ...base, ...t, meetingProvider: 'google_meet', meetingUrl: 'https://teams.microsoft.com/x' })).rejects.toThrow(/meet\.google\.com/);
    await expect(calendar.createEvent(jwt(M, 'manager'), { ...base, ...t, meetingProvider: 'other', meetingUrl: 'http://insecure.example/x' })).rejects.toThrow(/https/);
    expect(isValidTimezone('Asia/Kolkata')).toBe(true);
    expect(isValidTimezone('Mars/Olympus')).toBe(false);
  });

  it('a provider without a link is allowed (link pending); none + link becomes other', async () => {
    const pending = await calendar.createEvent(jwt(M, 'manager'), { kind: 'meeting', title: 'Link later', allDay: false, ...timed(3, 14), meetingProvider: 'google_meet' });
    expect(pending.data.meetingProvider).toBe('google_meet');
    expect(pending.data.meetingUrl).toBeNull();
    const other = await calendar.createEvent(jwt(M, 'manager'), { kind: 'meeting', title: 'Zoom', allDay: false, ...timed(3, 15), meetingProvider: 'none', meetingUrl: 'https://zoom.us/j/1' });
    expect(other.data.meetingProvider).toBe('other');
    expect(other.data.meetingUrl).toBe('https://zoom.us/j/1');
  });

  it('all-day events are stored as UTC midnights (exclusive end) and read the same in every zone', async () => {
    const res = await calendar.createEvent(jwt(M, 'manager'), { kind: 'event', title: 'Offsite', allDay: true, startDate: isoPlus(14), endDate: isoPlus(15), visibility: 'company' });
    const [row] = await dbAdmin.select().from(calendarEvents).where(eq(calendarEvents.id, res.data.id));
    expect(row!.start_at.toISOString()).toBe(`${isoPlus(14)}T00:00:00.000Z`);
    expect(row!.end_at.toISOString()).toBe(`${isoPlus(16)}T00:00:00.000Z`);
    expect(row!.is_all_day).toBe(true);
    expect(res.data.startDate).toBe(isoPlus(14));
    expect(res.data.endDate).toBe(isoPlus(15));
    // Same dates for a viewer in Los Angeles.
    await dbAdmin.update(users).set({ timezone: 'America/Los_Angeles' }).where(eq(users.id, O.userId));
    try {
      const o = await feedFor(O, 'owner');
      const it = o.data.find((i) => i.id === res.data.id)!;
      expect([it.startDate, it.endDate]).toEqual([isoPlus(14), isoPlus(15)]);
      expect(it.allDay).toBe(true);
    } finally {
      await dbAdmin.update(users).set({ timezone: 'Asia/Kolkata' }).where(eq(users.id, O.userId));
    }
  });

  it('company visibility: everyone sees it, only the organizer / owner may change it', async () => {
    const res = await calendar.createEvent(jwt(M, 'manager'), { kind: 'event', title: 'Town hall', allDay: false, ...timed(4, 12, 60), visibility: 'company' });
    const x1 = await feedFor(X1, 'employee');
    const it = x1.data.find((i) => i.id === res.data.id)!;
    expect(it).toBeDefined();
    expect(it.canEdit).toBe(false);
    expect(it.myResponse).toBeNull();
    await expect(calendar.updateEvent(jwt(X1, 'employee'), res.data.id, { title: 'Hijack' })).rejects.toThrow(ForbiddenException);
    await expect(calendar.cancelEvent(jwt(X1, 'employee'), res.data.id)).rejects.toThrow(ForbiddenException);
    const byOwner = await calendar.updateEvent(jwt(O, 'owner'), res.data.id, { title: 'Town hall (Q4)' });
    expect(byOwner.data.title).toBe('Town hall (Q4)');
  });

  it('a failed outbox write rolls the whole create back: no row, no push, no notification', async () => {
    resetSpies();
    const count = async () => (await dbAdmin.select({ id: calendarEvents.id }).from(calendarEvents).where(eq(calendarEvents.tenant_id, T1))).length;
    const before = await count();
    eventsStub.publish.mockImplementationOnce(async () => { throw new Error('outbox down'); });
    await expect(calendar.createEvent(jwt(M, 'manager'), { kind: 'event', title: 'Ghost', allDay: false, ...timed(5, 9), attendees: [{ userId: R1.userId }] })).rejects.toThrow('outbox down');
    expect(await count()).toBe(before);
    expect(changed).toHaveLength(0);
    await settle();
    expect(createInAppNotification).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Update / cancel / RSVP
// ═════════════════════════════════════════════════════════════════════════════

describe('Round J — edit, cancel, RSVP', () => {
  it('RSVP: attendee only, transitions, organizer told once per event, non-attendee 403, bad value 400', async () => {
    resetSpies();
    const acc = await calendar.rsvp(jwt(R1, 'employee'), meetingId, { response: 'accepted' });
    expect(acc.data.myResponse).toBe('accepted');
    expect(acc.data.attendees?.find((a) => a.userId === R1.userId)?.response).toBe('accepted');
    expect(changed).toEqual([{ tenantId: T1, eventId: meetingId }]);
    await waitFor(() => createInAppNotification.mock.calls.length >= 1);
    const [c] = createInAppNotification.mock.calls as unknown as Array<[string, string, string, string, string, { groupKey?: string }]>;
    expect(c![0]).toBe(M.userId);
    expect(c![1]).toBe('calendar.event.rsvp');
    expect(c![2]).toBe('RepOne Tester accepted "Sprint sync"');
    expect(c![5]).toEqual({ groupKey: `rsvp:${meetingId}` });
    expect(eventsStub.publish.mock.calls.some((k: unknown[]) => (k[0] as { name: string }).name === 'calendar.event.rsvp')).toBe(true);

    const tent = await calendar.rsvp(jwt(R1, 'employee'), meetingId, { response: 'tentative' });
    expect(tent.data.myResponse).toBe('tentative');
    await expect(calendar.rsvp(jwt(X1, 'employee'), meetingId, { response: 'accepted' })).rejects.toThrow(ForbiddenException);
    await expect(calendar.rsvp(jwt(R1, 'employee'), meetingId, { response: 'pending' as never })).rejects.toThrow(BadRequestException);
    await expect(calendar.rsvp(jwt(G, 'guest'), meetingId, { response: 'accepted' })).rejects.toThrow(ForbiddenException);
  });

  it('only the organizer (or owner / HR admin) may edit; attendees get 403', async () => {
    await expect(calendar.updateEvent(jwt(R1, 'employee'), meetingId, { title: 'Mine now' })).rejects.toThrow(ForbiddenException);
    await expect(calendar.updateEvent(jwt(X1, 'employee'), meetingId, { title: 'Mine now' })).rejects.toThrow(NotFoundException);
    const byOwner = await calendar.updateEvent(jwt(O, 'owner'), meetingId, { description: 'Owner-added notes' });
    expect(byOwner.data.description).toBe('Owner-added notes');
  });

  it('a description-only edit tells nobody; time / place / link changes tell the remaining attendees', async () => {
    resetSpies();
    await calendar.updateEvent(jwt(M, 'manager'), meetingId, { description: 'Just notes' });
    await settle();
    expect(createInAppNotification).not.toHaveBeenCalled();
    expect(changed).toEqual([{ tenantId: T1, eventId: meetingId }]);

    resetSpies();
    const moved = timed(2, 11);
    const res = await calendar.updateEvent(jwt(M, 'manager'), meetingId, { startAt: moved.startAt, endAt: moved.endAt, location: 'Room 2' });
    expect(res.data.startAt).toBe(moved.startAt);
    expect(res.data.location).toBe('Room 2');
    await waitFor(() => createInAppNotification.mock.calls.length >= 2);
    const inApp = createInAppNotification.mock.calls as unknown as Array<[string, string, string]>;
    expect(inApp.map((c) => c[0]).sort()).toEqual([R1.userId, R2.userId].sort());
    for (const c of inApp) {
      expect(c[1]).toBe('calendar.event.updated');
      expect(c[2]).toMatch(/^Mgr Tester updated: Sprint sync · /);
    }
    await waitFor(() => sendEmail.mock.calls.length >= 2);
    expect((sendEmail.mock.calls as unknown as Array<[string]>).map((m) => m[0])).toEqual(['calendar-updated', 'calendar-updated']);
    expect(eventsStub.publish.mock.calls.some((k: unknown[]) => (k[0] as { name: string; payload: { rescheduled: boolean } }).name === 'calendar.event.updated' && (k[0] as { payload: { rescheduled: boolean } }).payload.rescheduled)).toBe(true);
  });

  it('attendee delta: added → invited, removed → told, kept → updated only when something material changed', async () => {
    resetSpies();
    const res = await calendar.updateEvent(jwt(M, 'manager'), meetingId, { attendees: [{ userId: R1.userId }, { userId: R3.userId }] });
    expect(res.data.attendees?.map((a) => a.userId).sort()).toEqual([M.userId, R1.userId, R3.userId].sort());
    expect(res.data.attendees?.find((a) => a.userId === R3.userId)?.response).toBe('pending');
    expect(res.data.attendees?.find((a) => a.userId === R1.userId)?.response).toBe('tentative'); // kept as-is
    await waitFor(() => createInAppNotification.mock.calls.length >= 2);
    await settle();
    const inApp = createInAppNotification.mock.calls as unknown as Array<[string, string, string, string]>;
    const byUser = Object.fromEntries(inApp.map((c) => [c[0], c]));
    expect(byUser[R3.userId]![1]).toBe('calendar.event.invited');
    expect(byUser[R2.userId]![1]).toBe('calendar.event.cancelled');
    expect(byUser[R2.userId]![2]).toBe('Mgr Tester removed you from: Sprint sync');
    expect(byUser[R2.userId]![3]).toBe('/calendar');
    expect(byUser[R1.userId]).toBeUndefined(); // nothing material changed for R1
    const rows = await dbAdmin.select({ user_id: calendarEventAttendees.user_id }).from(calendarEventAttendees).where(eq(calendarEventAttendees.event_id, meetingId));
    expect(rows.map((r) => r.user_id).sort()).toEqual([M.userId, R1.userId, R3.userId].sort());
    const mails = sendEmail.mock.calls as unknown as Array<[string, string]>;
    expect(mails.find((m) => m[1] === R3.email)![0]).toBe('calendar-invite');
    expect(mails.find((m) => m[1] === R2.email)![0]).toBe('calendar-cancelled');
    // R2, now off the list, can no longer see or answer it.
    await expect(calendar.getEvent(jwt(R2, 'employee'), meetingId)).rejects.toThrow(NotFoundException);
    await expect(calendar.rsvp(jwt(R2, 'employee'), meetingId, { response: 'accepted' })).rejects.toThrow(ForbiddenException);
  });

  it('cancel: attendee 403; organizer soft-cancels; feed excludes; idempotent; RSVP refused afterwards', async () => {
    await expect(calendar.cancelEvent(jwt(R1, 'employee'), meetingId)).rejects.toThrow(ForbiddenException);
    resetSpies();
    const res = await calendar.cancelEvent(jwt(M, 'manager'), meetingId);
    expect(res.data.id).toBe(meetingId);
    const [row] = await dbAdmin.select({ c: calendarEvents.cancelled_at }).from(calendarEvents).where(eq(calendarEvents.id, meetingId));
    expect(row!.c).not.toBeNull();
    expect((await feedFor(M, 'manager')).data.find((i) => i.id === meetingId)).toBeUndefined();
    expect((await feedFor(R1, 'employee')).data.find((i) => i.id === meetingId)).toBeUndefined();
    expect((await calendar.getEvent(jwt(M, 'manager'), meetingId)).data.status).toBe('cancelled');
    await waitFor(() => createInAppNotification.mock.calls.length >= 2);
    const inApp = createInAppNotification.mock.calls as unknown as Array<[string, string, string, string]>;
    expect(inApp.map((c) => c[0]).sort()).toEqual([R1.userId, R3.userId].sort());
    for (const c of inApp) {
      expect(c[1]).toBe('calendar.event.cancelled');
      expect(c[2]).toMatch(/^Mgr Tester cancelled: Sprint sync · /);
      expect(c[3]).toBe('/calendar');
    }
    await waitFor(() => sendEmail.mock.calls.length >= 2);
    expect((sendEmail.mock.calls as unknown as Array<[string]>).every((m) => m[0] === 'calendar-cancelled')).toBe(true);
    expect(changed).toEqual([{ tenantId: T1, eventId: meetingId }]);

    resetSpies();
    const again = await calendar.cancelEvent(jwt(M, 'manager'), meetingId);
    expect(again.data.id).toBe(meetingId);
    await settle();
    expect(createInAppNotification).not.toHaveBeenCalled();
    expect(changed).toHaveLength(0);
    await expect(calendar.rsvp(jwt(R1, 'employee'), meetingId, { response: 'accepted' })).rejects.toThrow(BadRequestException);
    await expect(calendar.updateEvent(jwt(M, 'manager'), meetingId, { title: 'Zombie' })).rejects.toThrow(BadRequestException);
  });

  it('notifications are best-effort: a failing notifier never fails the write', async () => {
    createInAppNotification.mockImplementationOnce(async () => { throw new Error('inbox down'); });
    sendEmail.mockImplementationOnce(async () => { throw new Error('smtp down'); });
    const res = await calendar.createEvent(jwt(M, 'manager'), { kind: 'meeting', title: 'Resilient', allDay: false, ...timed(6, 9), attendees: [{ userId: R1.userId }, { userId: R2.userId }] });
    expect(res.data.id).toBeDefined();
    await waitFor(() => createInAppNotification.mock.calls.length >= 2);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Tenant isolation
// ═════════════════════════════════════════════════════════════════════════════

describe('Round J — tenant isolation', () => {
  let ev: string;
  beforeAll(async () => {
    const res = await calendar.createEvent(jwt(M, 'manager'), { kind: 'event', title: 'T1 only', allDay: false, ...timed(7, 9), visibility: 'company' });
    ev = res.data.id;
  });

  it('another tenant cannot read, edit, cancel or answer a T1 event, and the app role sees no T1 rows from T2', async () => {
    await expect(calendar.getEvent(jwt(Z, 'owner', T2), ev)).rejects.toThrow(NotFoundException);
    await expect(calendar.updateEvent(jwt(Z, 'owner', T2), ev, { title: 'x' })).rejects.toThrow(NotFoundException);
    await expect(calendar.cancelEvent(jwt(Z, 'owner', T2), ev)).rejects.toThrow(NotFoundException);
    await expect(calendar.rsvp(jwt(Z, 'owner', T2), ev, { response: 'accepted' })).rejects.toThrow(NotFoundException);
    const rows = await dbSvc.withTenant(T2, (tx) => tx.select({ id: calendarEvents.id }).from(calendarEvents), Z.userId);
    expect(rows).toHaveLength(0);
    const att = await dbSvc.withTenant(T2, (tx) => tx.select({ id: calendarEventAttendees.id }).from(calendarEventAttendees), Z.userId);
    expect(att).toHaveLength(0);
    const z = await calendar.listFeed(jwt(Z, 'owner', T2), FROM, TO);
    expect(z.data.find((i) => i.id === ev)).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. People picker
// ═════════════════════════════════════════════════════════════════════════════

describe('Round J — invitable people', () => {
  it('lists active workspace seats only (no guests / auditors / deactivated), searchable, escaped, signed avatars', async () => {
    await dbAdmin.update(users).set({ avatar_key: 'users/r1/avatar/x_256.webp' }).where(eq(users.id, R1.userId));
    const all = await calendar.listPeople(jwt(R2, 'employee'));
    const ids = all.data.map((p) => p.userId);
    expect(ids).toEqual(expect.arrayContaining([O.userId, M.userId, R1.userId, X1.userId, N.userId]));
    expect(ids).not.toContain(G.userId);
    expect(ids).not.toContain(A.userId);
    expect(ids).not.toContain(D.userId);
    expect(ids).not.toContain(Z.userId);
    expect(all.data.find((p) => p.userId === R1.userId)!.avatarUrl).toBe('signed:users/r1/avatar/x_256.webp');

    const one = await calendar.listPeople(jwt(R2, 'employee'), 'RepOne');
    expect(one.data.map((p) => p.userId)).toEqual([R1.userId]);
    const none = await calendar.listPeople(jwt(R2, 'employee'), '%');
    expect(none.data).toHaveLength(0);
    const under = await calendar.listPeople(jwt(R2, 'employee'), '_');
    expect(under.data).toHaveLength(0);
    await expect(calendar.listPeople(jwt(G, 'guest'))).rejects.toThrow(ForbiddenException);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. iCal
// ═════════════════════════════════════════════════════════════════════════════

describe('Round J — iCal feed', () => {
  it('token round-trip, members without an employee row subscribe, guests / bad tokens do not', async () => {
    const url = calendar.buildIcalUrl(N.userId, T1);
    const q = new URL(url).searchParams;
    const sub = await calendar.resolveIcalSubscriber(q.get('uid')!, q.get('tid')!, q.get('token')!);
    expect(sub).toEqual({ userId: N.userId, tenantId: T1, employeeId: null });
    await expect(calendar.resolveIcalSubscriber(N.userId, T1, 'deadbeef')).rejects.toThrow(UnauthorizedException);
    await expect(calendar.resolveIcalSubscriber(G.userId, T1, calendar.generateIcalToken(G.userId, T1))).rejects.toThrow(UnauthorizedException);
    await expect(calendar.resolveIcalSubscriber(Z.userId, T1, calendar.generateIcalToken(Z.userId, T1))).rejects.toThrow(UnauthorizedException);
  });

  it('renders timed VEVENTs in UTC with LOCATION / URL / ORGANIZER / ATTENDEE, folds long lines, scopes holidays, drops cancelled + declined', async () => {
    const live = await calendar.createEvent(jwt(M, 'manager'), {
      kind: 'meeting',
      title: 'Very long meeting title that certainly needs to be folded because RFC 5545 caps content lines at seventy-five octets',
      allDay: false,
      ...timed(8, 13),
      location: 'Board room; 3rd floor, wing B',
      meetingProvider: 'google_meet',
      meetingUrl: 'https://meet.google.com/abc-defg-hij',
      attendees: [{ userId: R1.userId }],
    });
    const declined = await calendar.createEvent(jwt(M, 'manager'), { kind: 'meeting', title: 'R1 declined this', allDay: false, ...timed(9, 13), attendees: [{ userId: R1.userId }] });
    await calendar.rsvp(jwt(R1, 'employee'), declined.data.id, { response: 'declined' });
    const cancelled = await calendar.createEvent(jwt(M, 'manager'), { kind: 'meeting', title: 'Cancelled one', allDay: false, ...timed(9, 15), attendees: [{ userId: R1.userId }] });
    await calendar.cancelEvent(jwt(M, 'manager'), cancelled.data.id);

    const folded = await calendar.buildIcal(R1.userId, T1, R1.employeeId);
    // Every physical line respects the 75-octet cap …
    for (const line of folded.split('\r\n')) expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
    // … and unfolded (RFC 5545 §3.1) the content is intact.
    const unfold = (s: string) => s.replace(/\r\n /g, '');
    const ics = unfold(folded);
    expect(ics).toContain('X-WR-TIMEZONE:Asia/Kolkata');
    expect(ics).toContain(`UID:event-${live.data.id}@flicks.${T1}`);
    expect(ics).toContain(`DTSTART:${isoPlus(8).replace(/-/g, '')}T130000Z`);
    expect(ics).toContain(`DTEND:${isoPlus(8).replace(/-/g, '')}T133000Z`);
    expect(ics).toContain('LOCATION:Board room\\; 3rd floor\\, wing B');
    expect(ics).toContain('URL:https://meet.google.com/abc-defg-hij');
    expect(ics).toContain(`ORGANIZER;CN=Mgr Tester:mailto:${M.email}`);
    expect(ics).toContain(`ATTENDEE;CN=RepOne Tester;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION:mailto:${R1.email}`);
    expect(ics).toContain('SUMMARY:Very long meeting title that certainly needs to be folded because RFC 5545 caps content lines at seventy-five octets');
    expect(ics).not.toContain(`UID:event-${declined.data.id}@`);
    expect(ics).not.toContain(`UID:event-${cancelled.data.id}@`);
    expect(ics).toContain(`UID:holiday-${H0}@`);
    expect(ics).toContain(`UID:holiday-${H1}@`);
    expect(ics).not.toContain(`UID:holiday-${H2}@`);
    expect(ics).toMatch(/DTSTART;VALUE=DATE:\d{8}/);

    // The organizer's feed carries the declined one (they still host it).
    const mIcs = unfold(await calendar.buildIcal(M.userId, T1, M.employeeId));
    expect(mIcs).toContain(`UID:event-${declined.data.id}@`);
    // No-employee subscriber: holidays (company-wide only) + own events, no leave.
    const nIcs = unfold(await calendar.buildIcal(N.userId, T1, null));
    expect(nIcs).toContain(`UID:holiday-${H0}@`);
    expect(nIcs).not.toContain(`UID:holiday-${H1}@`);
    expect(nIcs).not.toContain('UID:leave-');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. Templates, time helper, DTO
// ═════════════════════════════════════════════════════════════════════════════

describe('Round J — email templates, time helper, DTO transform', () => {
  const svc = realNotifications as unknown as { renderTemplate: (t: string, p: Record<string, unknown>) => { subject: string; html: string } };
  const props = {
    organizerName: 'Mgr <script>alert(1)</script>',
    title: 'Sprint "sync" & more',
    when: 'Thu 10 Sep 2026, 16:00–16:30 IST',
    location: 'Board <b>room</b>',
    meetingUrl: 'https://teams.microsoft.com/l/meetup-join/abc?x=1&y=2',
    meetingProvider: 'teams',
    description: 'Agenda <i>items</i>',
    linkUrl: '/calendar?event=abc&date=2026-09-10',
  };

  it('invite escapes every field, links Join only with a URL, and opens the app deep link', () => {
    const out = svc.renderTemplate('calendar-invite', props);
    expect(out.subject).toContain('Invitation: Sprint "sync" & more');
    expect(out.html).not.toContain('<script>');
    expect(out.html).toContain('&lt;script&gt;');
    expect(out.html).not.toContain('<b>room</b>');
    expect(out.html).toContain('https://teams.microsoft.com/l/meetup-join/abc?x=1&amp;y=2');
    expect(out.html).toContain('Join');
    expect(out.html).toContain(`${APP_URL}/calendar?event=abc&amp;date=2026-09-10`);
    const noLink = svc.renderTemplate('calendar-invite', { ...props, meetingUrl: null });
    expect(noLink.html).not.toMatch(/Join Microsoft Teams/);
    const cancelled = svc.renderTemplate('calendar-cancelled', props);
    expect(cancelled.subject).toMatch(/^Cancelled:/);
    expect(cancelled.html).not.toMatch(/Join Microsoft Teams/);
    const updated = svc.renderTemplate('calendar-updated', props);
    expect(updated.subject).toMatch(/^Updated:/);
  });

  it('formatRangeInTimezone renders the recipient’s zone; all-day forms are zone-independent', () => {
    const s = new Date('2026-09-10T10:30:00.000Z');
    const e = new Date('2026-09-10T11:00:00.000Z');
    const ist = formatRangeInTimezone(s, e, 'Asia/Kolkata', false);
    const la = formatRangeInTimezone(s, e, 'America/Los_Angeles', false);
    expect(ist).toMatch(/16:00–16:30/);
    expect(la).toMatch(/03:30–04:00/);
    expect(ist).not.toBe(la);
    const allDay = formatRangeInTimezone(new Date('2026-09-10T00:00:00Z'), new Date('2026-09-11T00:00:00Z'), 'America/Los_Angeles', true);
    expect(allDay).toMatch(/10 Sep 2026 \(all day\)/);
    const span = formatRangeInTimezone(new Date('2026-09-10T00:00:00Z'), new Date('2026-09-13T00:00:00Z'), 'Asia/Kolkata', true);
    expect(span).toMatch(/10 Sep – .*12 Sep 2026 \(all day\)/);
    expect(formatRangeInTimezone(s, e, 'Mars/Olympus', false)).toMatch(/16:00–16:30/); // unknown zone → workspace default
  });

  it('the global ValidationPipe keeps nested attendees intact and rejects unknown keys', async () => {
    const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true, transformOptions: { enableImplicitConversion: true } });
    const body = { kind: 'meeting', title: 'T', allDay: false, startAt: '2026-09-10T10:00:00.000Z', endAt: '2026-09-10T10:30:00.000Z', attendees: [{ userId: R1.userId, isOptional: true }] };
    const out = (await pipe.transform(body, { type: 'body', metatype: CreateCalendarEventDto })) as CreateCalendarEventDto;
    expect(out.attendees?.[0]?.userId).toBe(R1.userId);
    expect(out.attendees?.[0]?.isOptional).toBe(true);
    await expect(pipe.transform({ ...body, organizer_user_id: O.userId }, { type: 'body', metatype: CreateCalendarEventDto })).rejects.toThrow(BadRequestException);
    await expect(pipe.transform({ ...body, meetingUrl: 'http://insecure/x' }, { type: 'body', metatype: CreateCalendarEventDto })).rejects.toThrow(BadRequestException);
    await expect(pipe.transform({ ...body, attendees: [{ userId: 'not-a-uuid' }] }, { type: 'body', metatype: CreateCalendarEventDto })).rejects.toThrow(BadRequestException);
    await expect(pipe.transform({ ...body, kind: 'party' }, { type: 'body', metatype: CreateCalendarEventDto })).rejects.toThrow(BadRequestException);
    const allDay = (await pipe.transform({ kind: 'event', title: 'A', allDay: true, startDate: '2026-09-10' }, { type: 'body', metatype: CreateCalendarEventDto })) as CreateCalendarEventDto;
    expect(allDay.startDate).toBe('2026-09-10');
  });

  it('the meeting-link door returns null until a provider is connected', async () => {
    expect(await meetingLinks.connected(T1, M.userId)).toEqual([]);
    expect(await meetingLinks.generate('teams', T1, M.userId, { title: 'x', startAt: new Date(), endAt: new Date(Date.now() + 1), timezone: 'Asia/Kolkata' })).toBeNull();
  });
});

// Keep the imported helper referenced (and/eq are used by the fixtures above).
void and;
