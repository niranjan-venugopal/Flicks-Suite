/**
 * Founder round L (2026-09-17) — agent A: day semantics + regularization.
 *
 *  Item 1 — "If a user is on leave, it shows the manager stating that the
 *           user has missed punch." One read-only resolver
 *           (core/common/workday.ts) decides what a day IS — holiday →
 *           weekend (per the SHIFT's working days) → approved full-day leave
 *           → approved half-day → working — and every "yet to clock in"
 *           surface (team today, my today, punch-in, month view, the admin
 *           dashboard) derives from it. Pending leave is labelled but still
 *           expected; leave day-counting follows the shift; half-day leave
 *           writes `half_day` (never demoting a worked day); full-day leave
 *           writes `on_leave` (never over a regularised day); punch-in on
 *           approved leave is a 409.
 *  Item 3 — "check whether the clock-out of the request is ahead of time":
 *           a regularization is validated in the shift's timezone — no future
 *           day, instants on the day (next day only for overnight shifts),
 *           out after in, and for TODAY refused while still clocked in or
 *           with a clock-out that hasn't happened yet.
 *
 * Service-level against the real Postgres (founder-roundK harness).
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
  locations,
  holidays,
  shiftTemplates,
  employeeShifts,
  leaveTypes,
  leaveRequests,
  attendanceRecords,
} from '@flicks/db/schema';
import { ConfigService } from '@nestjs/config';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { DatabaseService } from '../core/database/database.service';
import { AuditService } from '../modules/audit/audit.service';
import { NotificationsService } from '../modules/notifications/notifications.service';
import type { MediaService } from '../modules/media/media.service';
import { AttendanceService } from '../modules/attendance/attendance.service';
import { RegularizationRequestDto } from '../modules/attendance/attendance.dto';
import { LeaveService, countBusinessDays, businessDays } from '../modules/leave/leave.service';
import { DashboardService } from '../modules/dashboard/dashboard.service';
import { dateInTimezone, addDaysISO, localTimeToUTC } from '../core/common/time';
import {
  resolveShiftsTx,
  resolveExpectationsTx,
  resolveExpectationTx,
  employeeOnApprovedLeaveTx,
  tenantTodayISOTx,
  derivedStatus,
  dayOfWeekISO,
  pickLeaveForDate,
} from '../core/common/workday';

jest.setTimeout(120_000);

const rid = () => crypto.randomBytes(4).toString('hex');
const IST = 'Asia/Kolkata';
const APP_URL = 'https://app.test';

const auditStub = { log: async () => {} } as unknown as AuditService;
const notifications = {
  createInAppNotification: jest.fn(async () => undefined),
  sendEmail: jest.fn(async () => true),
} as unknown as NotificationsService;
const media = {
  servedUrl: async (k: string | null, l: string | null) => (k ? `signed:${k}` : l),
} as unknown as MediaService;

const dbSvc = new DatabaseService();
const attendance = new AttendanceService(
  dbSvc,
  dbAdmin as never,
  auditStub,
  notifications,
  new ConfigService({ APP_URL }),
);
const leave = new LeaveService(dbSvc, auditStub, notifications);
const dashboard = new DashboardService(dbSvc, media);

// ─── Fixed calendar (all far from "today"; 2027-03-01 is a Monday) ───────────
const WED_HOLIDAY = '2027-03-03'; // company-wide, blocking
const THU_ELECTIVE = '2027-03-04'; // type=optional → never blocks
const FRI_LOCAL = '2027-03-05'; // location L1 only
const SAT = '2027-03-06';
const SUN = '2027-03-07';
const MON_LEAVE_FROM = '2027-03-08';
const MON_LEAVE_TO = '2027-03-10';
const THU_PENDING = '2027-03-11';
const FRI_HALF = '2027-03-12';
const MON_PRESENT = '2027-03-15';
const TUE_REG = '2027-03-16';
const WED_AFTER_REG = '2027-03-17';
const MON_WORKED = '2027-03-22'; // a worked (present) day a full-day leave lands on
const TUE_AFTER_WORKED = '2027-03-23';
const FOREIGN_TYPE_DAY = '2027-03-24'; // leave whose leave_type_id lives in T2

// "Today" as the fixtures' shift (AllDays, IST) sees it. A test that spans
// IST midnight can flake — same caveat as attendance-selfheal.spec.ts.
const todayIST = dateInTimezone(new Date(), IST);
/** IST has no DST: fixed +05:30. */
const istInstant = (dateISO: string, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(`${dateISO}T00:00:00Z`);
  d.setUTCMinutes(d.getUTCMinutes() + (h! * 60 + m!) - 330);
  return d;
};

// ─── Fixtures ────────────────────────────────────────────────────────────────
let T1: string;
let T2: string; // default shift in Pacific/Kiritimati (UTC+14)
let T3: string; // no shift templates at all; tenant timezone Pacific/Honolulu
const userIds: string[] = [];

type Person = { userId: string; employeeId: string; email: string; name: string };
type Role = 'owner' | 'admin' | 'manager' | 'employee' | 'finance';
let O: Person; // owner (no manager)
let mgrB: Person; // → O
let mgrA: Person; // → mgrB
let empX: Person; // → mgrB, location L1 (explicit-date tests)
let empY: Person; // → mgrB, location L2
let empSix: Person; // → mgrB, Saturday-working shift, no location
let empNoShift: Person; // → mgrB, no assignment → tenant default (Mon–Fri)
let empNoMgr: Person;
let tX: Person; // → mgrA, approved full-day leave TODAY
let tY: Person; // → mgrA, approved half-day leave TODAY
let tP: Person; // → mgrA, pending leave TODAY
let tW: Person; // → mgrA, plain working day, no record
let rX: Person; // → mgrA, regularization subject (punches today)
let rY: Person; // → mgrA, regularization subject (no punches)
let rN: Person; // → mgrA, overnight shift
let zEmp: Person; // T3 employee (fallback shift)
let zEmp2: Person; // T2 employee (foreign managerId)
let fin: Person; // T1 finance seat — sees the roster, never the leave behind it
let tC: Person; // → mgrB, approved leave TODAY then cancelled
let empKiri: Person; // → mgrB, UTC+14 shift (per-employee "today")
let empBadShift: Person; // → mgrB, employee_shifts row pointing at T2's template
let L1: string;
let L2: string;
let allDaysShiftId: string;
let sixDayShiftId: string;
let overnightShiftId: string;
let kiriT1ShiftId: string;
let t2ShiftId: string;
let clTypeId: string;
let t2TypeId: string;

async function mkUser(label: string) {
  const email = `rl-${label.toLowerCase()}-${rid()}@t.test`;
  const [u] = await dbAdmin
    .insert(users)
    .values({ email, full_name: `${label} Tester`, status: 'active' })
    .returning();
  userIds.push(u!.id);
  return { id: u!.id, email, name: `${label} Tester` };
}

async function mkPerson(
  tenantId: string,
  label: string,
  role: Role,
  opts: { managerId?: string | null; locationId?: string | null; shiftId?: string | null } = {},
): Promise<Person> {
  const u = await mkUser(label);
  const [e] = await dbAdmin
    .insert(employees)
    .values({
      tenant_id: tenantId,
      user_id: u.id,
      employee_code: `RL-${rid()}`,
      first_name: label,
      last_name: 'Tester',
      work_email: u.email,
      date_of_joining: '2026-01-01',
      status: 'active',
      reporting_manager_id: opts.managerId ?? null,
      location_id: opts.locationId ?? null,
    })
    .returning();
  await dbAdmin
    .insert(memberships)
    .values({ tenant_id: tenantId, user_id: u.id, role, status: 'active', employee_id: e!.id });
  if (opts.shiftId) {
    await dbAdmin.insert(employeeShifts).values({
      tenant_id: tenantId,
      employee_id: e!.id,
      shift_template_id: opts.shiftId,
      effective_from: '2026-01-01',
      effective_to: null,
    });
  }
  return { userId: u.id, employeeId: e!.id, email: u.email, name: u.name };
}

async function mkShift(
  tenantId: string,
  name: string,
  workingDays: number[],
  opts: { isDefault?: boolean; timezone?: string; start?: string; end?: string; overnight?: boolean } = {},
) {
  const [s] = await dbAdmin
    .insert(shiftTemplates)
    .values({
      tenant_id: tenantId,
      name,
      start_time: opts.start ?? '09:00',
      end_time: opts.end ?? '18:00',
      is_overnight: opts.overnight ?? false,
      working_days: workingDays,
      timezone: opts.timezone ?? IST,
      is_default: opts.isDefault ?? false,
      is_active: true,
    })
    .returning();
  return s!.id;
}

async function seedLeave(
  p: Person,
  from: string,
  to: string,
  status: 'approved' | 'pending',
  opts: { halfDay?: boolean; session?: 'first_half' | 'second_half'; typeId?: string } = {},
) {
  const [r] = await dbAdmin
    .insert(leaveRequests)
    .values({
      tenant_id: T1,
      employee_id: p.employeeId,
      leave_type_id: opts.typeId ?? clTypeId,
      start_date: from,
      end_date: to,
      is_half_day: opts.halfDay ?? false,
      half_day_session: opts.session ?? null,
      total_days: opts.halfDay ? 0.5 : 1,
      reason: 'Round L fixture',
      status,
    })
    .returning();
  return r!.id;
}

const expectationFor = (employeeId: string, date: string | null) =>
  dbSvc.withTenant(T1, (tx) => resolveExpectationTx(tx, T1, employeeId, date));

const recordFor = async (p: Person, date: string) => {
  const [row] = await dbAdmin
    .select()
    .from(attendanceRecords)
    .where(
      and(
        eq(attendanceRecords.tenant_id, T1),
        eq(attendanceRecords.employee_id, p.employeeId),
        eq(attendanceRecords.attendance_date, date),
      ),
    );
  return row ?? null;
};

beforeAll(async () => {
  const [t] = await dbAdmin
    .insert(tenants)
    .values({ name: `RL main ${rid()}`, slug: `rl-${rid()}-${Date.now()}`, status: 'active', currency: 'INR', timezone: IST })
    .returning();
  T1 = t!.id;
  const [t2] = await dbAdmin
    .insert(tenants)
    .values({ name: `RL kiri ${rid()}`, slug: `rl2-${rid()}-${Date.now()}`, status: 'active', currency: 'INR', timezone: IST })
    .returning();
  T2 = t2!.id;
  const [t3] = await dbAdmin
    .insert(tenants)
    .values({ name: `RL bare ${rid()}`, slug: `rl3-${rid()}-${Date.now()}`, status: 'active', currency: 'INR', timezone: 'Pacific/Honolulu' })
    .returning();
  T3 = t3!.id;

  // Shifts: the tenant default (Mon–Fri), an every-day shift so "today" is
  // never a weekend for the today-based fixtures, a six-day shift and an
  // overnight shift.
  await mkShift(T1, 'General', [1, 2, 3, 4, 5], { isDefault: true });
  allDaysShiftId = await mkShift(T1, 'AllDays', [0, 1, 2, 3, 4, 5, 6]);
  sixDayShiftId = await mkShift(T1, 'SixDay', [1, 2, 3, 4, 5, 6]);
  overnightShiftId = await mkShift(T1, 'Night', [0, 1, 2, 3, 4, 5, 6], {
    start: '22:00',
    end: '06:00',
    overnight: true,
  });
  t2ShiftId = await mkShift(T2, 'Kiri', [1, 2, 3, 4, 5], { isDefault: true, timezone: 'Pacific/Kiritimati' });
  kiriT1ShiftId = await mkShift(T1, 'KiriT1', [0, 1, 2, 3, 4, 5, 6], { timezone: 'Pacific/Kiritimati' });

  const [l1] = await dbAdmin.insert(locations).values({ tenant_id: T1, name: 'Chennai' }).returning();
  const [l2] = await dbAdmin.insert(locations).values({ tenant_id: T1, name: 'Dubai' }).returning();
  L1 = l1!.id;
  L2 = l2!.id;

  await dbAdmin.insert(holidays).values([
    { tenant_id: T1, holiday_date: WED_HOLIDAY, name: 'Founders Day', type: 'company' },
    { tenant_id: T1, holiday_date: THU_ELECTIVE, name: 'Optional Fest', type: 'optional' },
    { tenant_id: T1, holiday_date: FRI_LOCAL, name: 'Chennai Day', type: 'regional', location_id: L1 },
  ]);

  const [lt] = await dbAdmin
    .insert(leaveTypes)
    .values({ tenant_id: T1, name: 'Casual Leave', code: 'CL', default_quota_days: 12, is_active: true })
    .returning();
  clTypeId = lt!.id;
  const [lt2] = await dbAdmin
    .insert(leaveTypes)
    .values({ tenant_id: T2, name: 'Foreign Leave', code: 'FL', default_quota_days: 12, is_active: true })
    .returning();
  t2TypeId = lt2!.id;

  O = await mkPerson(T1, 'Owner', 'owner', { shiftId: allDaysShiftId });
  mgrB = await mkPerson(T1, 'MgrB', 'manager', { managerId: O.employeeId, shiftId: allDaysShiftId });
  mgrA = await mkPerson(T1, 'MgrA', 'manager', { managerId: mgrB.employeeId, shiftId: allDaysShiftId });
  empX = await mkPerson(T1, 'EmpX', 'employee', { managerId: mgrB.employeeId, locationId: L1, shiftId: allDaysShiftId });
  empY = await mkPerson(T1, 'EmpY', 'employee', { managerId: mgrB.employeeId, locationId: L2, shiftId: allDaysShiftId });
  empSix = await mkPerson(T1, 'EmpSix', 'employee', { managerId: mgrB.employeeId, shiftId: sixDayShiftId });
  empNoShift = await mkPerson(T1, 'EmpNoShift', 'employee', { managerId: mgrB.employeeId });
  empNoMgr = await mkPerson(T1, 'EmpNoMgr', 'employee', { shiftId: allDaysShiftId });
  tX = await mkPerson(T1, 'TodayLeave', 'employee', { managerId: mgrA.employeeId, shiftId: allDaysShiftId });
  tY = await mkPerson(T1, 'TodayHalf', 'employee', { managerId: mgrA.employeeId, shiftId: allDaysShiftId });
  tP = await mkPerson(T1, 'TodayPending', 'employee', { managerId: mgrA.employeeId, shiftId: allDaysShiftId });
  tW = await mkPerson(T1, 'TodayWorking', 'employee', { managerId: mgrA.employeeId, shiftId: allDaysShiftId });
  rX = await mkPerson(T1, 'RegX', 'employee', { managerId: mgrA.employeeId, shiftId: allDaysShiftId });
  rY = await mkPerson(T1, 'RegY', 'employee', { managerId: mgrA.employeeId, shiftId: allDaysShiftId });
  rN = await mkPerson(T1, 'RegNight', 'employee', { managerId: mgrA.employeeId, shiftId: overnightShiftId });
  zEmp = await mkPerson(T3, 'Zed', 'owner');
  zEmp2 = await mkPerson(T2, 'ZedTwo', 'owner');
  fin = await mkPerson(T1, 'Fin', 'finance', { shiftId: allDaysShiftId });
  tC = await mkPerson(T1, 'TodayCancel', 'employee', { managerId: mgrB.employeeId, shiftId: allDaysShiftId });
  empKiri = await mkPerson(T1, 'EmpKiri', 'employee', { managerId: mgrB.employeeId, shiftId: kiriT1ShiftId });
  // A T1 assignment that points at ANOTHER tenant's template — the FK is
  // happy, the resolver must not be.
  empBadShift = await mkPerson(T1, 'EmpBadShift', 'employee', { managerId: mgrB.employeeId });
  await dbAdmin.insert(employeeShifts).values({
    tenant_id: T1,
    employee_id: empBadShift.employeeId,
    shift_template_id: t2ShiftId,
    effective_from: '2026-01-01',
    effective_to: null,
  });

  // Explicit-date leave: empX approved Mon–Wed, pending Thu; empY approved
  // Tue–Thu spanning the Wednesday holiday, half-day pending on the Friday.
  await seedLeave(empX, MON_LEAVE_FROM, MON_LEAVE_TO, 'approved');
  await seedLeave(empX, THU_PENDING, THU_PENDING, 'pending');
  await seedLeave(empY, '2027-03-02', THU_ELECTIVE, 'approved');
  // A T1 request whose leave_type_id lives in T2 (the FK is happy): the
  // day is still leave, the type name must not cross the tenant line.
  await seedLeave(empX, FOREIGN_TYPE_DAY, FOREIGN_TYPE_DAY, 'approved', { typeId: t2TypeId });
  // Today-based leave.
  await seedLeave(tX, todayIST, todayIST, 'approved');
  await seedLeave(tP, todayIST, todayIST, 'pending');
});

afterAll(async () => {
  for (const t of [T1, T2, T3]) await dbAdmin.delete(tenants).where(eq(tenants.id, t));
  for (const u of userIds) await dbAdmin.delete(users).where(eq(users.id, u));
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
});

// ═════════════════════════════════════════════════════════════════════════════
// Item 1 — the day resolver
// ═════════════════════════════════════════════════════════════════════════════

describe('Round L — workday resolver: shifts', () => {
  it('the fixed calendar really is what the constants say', () => {
    expect(dayOfWeekISO(WED_HOLIDAY)).toBe(3);
    expect(dayOfWeekISO(SAT)).toBe(6);
    expect(dayOfWeekISO(SUN)).toBe(0);
    expect(dayOfWeekISO(MON_LEAVE_FROM)).toBe(1);
  });

  it('assignment → tenant default → literal Mon–Fri fallback, in one batch, never seeding', async () => {
    const shifts = await dbSvc.withTenant(T1, (tx) =>
      resolveShiftsTx(tx, T1, [empSix.employeeId, empNoShift.employeeId, empX.employeeId], SAT),
    );
    expect(shifts.get(empSix.employeeId)).toMatchObject({ source: 'assignment', workingDays: [1, 2, 3, 4, 5, 6] });
    expect(shifts.get(empNoShift.employeeId)).toMatchObject({ source: 'default', name: 'General', workingDays: [1, 2, 3, 4, 5] });
    expect(shifts.get(empX.employeeId)).toMatchObject({ source: 'assignment', name: 'AllDays' });

    // T3 has no template at all → the literal fallback, and still no row.
    const bare = await dbSvc.withTenant(T3, (tx) => resolveShiftsTx(tx, T3, [zEmp.employeeId], SAT));
    expect(bare.get(zEmp.employeeId)).toMatchObject({ source: 'fallback', id: null, timezone: IST, workingDays: [1, 2, 3, 4, 5] });
    const seeded = await dbAdmin.select().from(shiftTemplates).where(eq(shiftTemplates.tenant_id, T3));
    expect(seeded).toHaveLength(0);
  });

  it('a foreign employee id never resolves (batch: no entry; single: 404)', async () => {
    const map = await dbSvc.withTenant(T1, (tx) => resolveExpectationsTx(tx, T1, [zEmp.employeeId], SAT));
    expect(map.size).toBe(0);
    await expect(expectationFor(zEmp.employeeId, SAT)).rejects.toThrow(NotFoundException);
  });

  it('an assignment pointing at another tenant’s template is ignored — the tenant default wins', async () => {
    const shifts = await dbSvc.withTenant(T1, (tx) => resolveShiftsTx(tx, T1, [empBadShift.employeeId], SAT));
    expect(shifts.get(empBadShift.employeeId)).toMatchObject({ source: 'default', name: 'General' });
    // The punch-path resolver carries the same predicate now.
    const mine = await attendance.getMyToday(empBadShift.userId, T1);
    expect(mine.shift.name).toBe('General');
    expect(mine.shift.timezone).toBe(IST);
  });

  it('listTeamToday with a foreign managerId is empty, never a leak', async () => {
    expect(await attendance.listTeamToday(O.userId, T1, 'owner', zEmp2.employeeId)).toEqual([]);
  });
});

describe('Round L — workday resolver: weekend by shift, holiday kinds', () => {
  it('Saturday is a working day for the six-day shift and a weekend for the default shift', async () => {
    const six = await expectationFor(empSix.employeeId, SAT);
    expect(six).toMatchObject({ kind: 'working', expected: true, date: SAT, timezone: IST });
    expect(derivedStatus(six)).toBeNull();
    const sixSun = await expectationFor(empSix.employeeId, SUN);
    expect(sixSun).toMatchObject({ kind: 'weekend', expected: false });
    expect(derivedStatus(sixSun)).toBe('weekend');

    const def = await expectationFor(empNoShift.employeeId, SAT);
    expect(def).toMatchObject({ kind: 'weekend', expected: false });
  });

  it('company-wide holiday blocks everyone; elective never; location-scoped only that location', async () => {
    const xWed = await expectationFor(empX.employeeId, WED_HOLIDAY);
    expect(xWed).toMatchObject({ kind: 'holiday', expected: false, holidayName: 'Founders Day' });
    expect(derivedStatus(xWed)).toBe('holiday');
    const yWed = await expectationFor(empY.employeeId, WED_HOLIDAY);
    expect(yWed).toMatchObject({ kind: 'holiday', holidayName: 'Founders Day' });

    // empY's approved leave spans the Wednesday: holiday wins (precedence),
    // the leave is still reported.
    expect(yWed.leave).toMatchObject({ status: 'approved', isHalfDay: false });
    const yTue = await expectationFor(empY.employeeId, '2027-03-02');
    expect(yTue).toMatchObject({ kind: 'leave', expected: false });

    // Elective (optional) — plain working day for a person NOT on leave.
    const xThu = await expectationFor(empX.employeeId, THU_ELECTIVE);
    expect(xThu).toMatchObject({ kind: 'working', expected: true, holidayName: null });

    // Location-scoped: Chennai (L1) off, Dubai (L2) working, no-location working.
    const xFri = await expectationFor(empX.employeeId, FRI_LOCAL);
    expect(xFri).toMatchObject({ kind: 'holiday', holidayName: 'Chennai Day' });
    const yFri = await expectationFor(empY.employeeId, FRI_LOCAL);
    expect(yFri).toMatchObject({ kind: 'working', expected: true });
    const sixFri = await expectationFor(empSix.employeeId, FRI_LOCAL);
    expect(sixFri).toMatchObject({ kind: 'working', expected: true });
  });
});

describe('Round L — workday resolver: leave', () => {
  it('approved full-day leave ⇒ expected:false, kind leave, derived on_leave, without any attendance row', async () => {
    expect(await recordFor(empX, '2027-03-09')).toBeNull();
    const exp = await expectationFor(empX.employeeId, '2027-03-09');
    expect(exp).toMatchObject({ kind: 'leave', expected: false, pendingLeave: false });
    expect(exp.leave).toMatchObject({ status: 'approved', isHalfDay: false, leaveTypeName: 'Casual Leave' });
    expect(derivedStatus(exp)).toBe('on_leave');
  });

  it('pending leave ⇒ still expected, labelled pendingLeave', async () => {
    const exp = await expectationFor(empX.employeeId, THU_PENDING);
    expect(exp).toMatchObject({ kind: 'working', expected: true, pendingLeave: true });
    expect(exp.leave).toMatchObject({ status: 'pending' });
    expect(derivedStatus(exp)).toBeNull();
  });

  it('approved beats pending on the same day; the picker is pure', async () => {
    await seedLeave(empNoMgr, '2027-04-01', '2027-04-02', 'approved');
    await seedLeave(empNoMgr, '2027-04-02', '2027-04-03', 'pending');
    const d2 = await expectationFor(empNoMgr.employeeId, '2027-04-02');
    expect(d2).toMatchObject({ kind: 'leave', expected: false, pendingLeave: false });
    expect(d2.leave?.status).toBe('approved');
    const d3 = await expectationFor(empNoMgr.employeeId, '2027-04-03');
    expect(d3).toMatchObject({ kind: 'working', expected: true, pendingLeave: true });

    const rows = [
      { id: 'p', startDate: '2027-05-01', endDate: '2027-05-03', status: 'pending', isHalfDay: false, session: null, leaveTypeName: 'CL' },
      { id: 'h', startDate: '2027-05-02', endDate: '2027-05-02', status: 'approved', isHalfDay: true, session: 'first_half' as const, leaveTypeName: 'CL' },
      { id: 'c', startDate: '2027-05-02', endDate: '2027-05-02', status: 'cancelled', isHalfDay: false, session: null, leaveTypeName: 'CL' },
    ];
    expect(pickLeaveForDate(rows, '2027-05-02')?.id).toBe('h');
    expect(pickLeaveForDate(rows, '2027-05-03')?.id).toBe('p');
    expect(pickLeaveForDate(rows, '2027-05-04')).toBeNull();
  });

  it('employeeOnApprovedLeaveTx: full-day approved only — never pending, never half-day', async () => {
    const on = (p: Person, d: string) => dbSvc.withTenant(T1, (tx) => employeeOnApprovedLeaveTx(tx, T1, p.employeeId, d));
    expect(await on(empX, '2027-03-09')).toBe(true);
    expect(await on(empX, THU_PENDING)).toBe(false);
    await seedLeave(empY, FRI_HALF, FRI_HALF, 'approved', { halfDay: true, session: 'second_half' });
    expect(await on(empY, FRI_HALF)).toBe(false);
    const half = await expectationFor(empY.employeeId, FRI_HALF);
    expect(half).toMatchObject({ kind: 'half_day_leave', expected: true });
    expect(derivedStatus(half)).toBeNull();
  });

  it('tenantTodayISOTx: default shift timezone → tenant timezone → IST', async () => {
    const at = new Date('2027-03-05T12:00:00Z');
    expect(await dbSvc.withTenant(T1, (tx) => tenantTodayISOTx(tx, T1, at))).toBe('2027-03-05'); // IST 17:30
    expect(await dbSvc.withTenant(T2, (tx) => tenantTodayISOTx(tx, T2, at))).toBe('2027-03-06'); // UTC+14 02:00
    const early = new Date('2027-03-05T05:00:00Z');
    expect(await dbSvc.withTenant(T3, (tx) => tenantTodayISOTx(tx, T3, early))).toBe('2027-03-04'); // Honolulu 19:00
  });

  it('a leave whose leave_type_id lives in another tenant is still leave, but its type name never crosses over', async () => {
    const exp = await expectationFor(empX.employeeId, FOREIGN_TYPE_DAY);
    expect(exp).toMatchObject({ kind: 'leave', expected: false });
    expect(exp.leave).toMatchObject({ status: 'approved', leaveTypeName: null });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Item 1 — leave day-counting + the approval backfill
// ═════════════════════════════════════════════════════════════════════════════

describe('Round L — leave days follow the shift; the backfill never demotes a worked day', () => {
  it('countBusinessDays / businessDays honour the working-day set and holidays', () => {
    const six = new Set([1, 2, 3, 4, 5, 6]);
    expect(countBusinessDays('2027-03-01', '2027-03-07')).toBe(5);
    expect(countBusinessDays('2027-03-01', '2027-03-07', new Set(), six)).toBe(6);
    expect(countBusinessDays('2027-03-01', '2027-03-07', new Set([WED_HOLIDAY]), six)).toBe(5);
    expect([...businessDays(SAT, SUN, new Set(), six)]).toEqual([SAT]);
    expect([...businessDays(SAT, SUN, new Set())]).toEqual([]);
  });

  it('applyLeave counts a Saturday for the six-day shift (minus the company holiday)', async () => {
    const res = await leave.applyLeave(empSix.userId, T1, {
      leaveTypeId: clTypeId,
      startDate: '2027-03-01',
      endDate: SUN,
      reason: 'six-day week',
    } as never);
    // Mon–Sat = 6 working days, minus Founders Day (Wed) = 5. The default
    // Mon–Fri literal would have said 4.
    expect(Number(res.totalDays)).toBe(5);
  });

  it('half-day approval writes half_day rows and never demotes a present day; full-day skips regularised rows', async () => {
    // A worked day (present) that a half-day request lands on.
    await dbAdmin.insert(attendanceRecords).values({
      tenant_id: T1,
      employee_id: empY.employeeId,
      attendance_date: MON_PRESENT,
      attendance_status: 'present',
      source: 'web',
      first_punch_in_at: istInstant(MON_PRESENT, '09:00'),
      last_punch_out_at: istInstant(MON_PRESENT, '18:00'),
      total_worked_minutes: 480,
    });
    const halfId = await seedLeave(empY, MON_PRESENT, MON_PRESENT, 'pending', { halfDay: true, session: 'first_half' });
    const decided = await leave.reviewLeave(halfId, mgrB.userId, T1, { action: 'approve' }, 'manager');
    expect(decided.status).toBe('approved');
    const kept = await recordFor(empY, MON_PRESENT);
    expect(kept!.attendance_status).toBe('present');
    expect(kept!.notes ?? '').toContain('Half-day leave approved');

    // A half-day request on an empty day writes half_day (NOT on_leave).
    const fresh = await seedLeave(empX, FRI_HALF, FRI_HALF, 'pending', { halfDay: true, session: 'second_half' });
    await leave.reviewLeave(fresh, mgrB.userId, T1, { action: 'approve' }, 'manager');
    const half = await recordFor(empX, FRI_HALF);
    expect(half).toMatchObject({ attendance_status: 'half_day', source: 'system', first_punch_in_at: null });

    // Full-day over a REGULARISED day keeps the manager's decision; the
    // untouched day becomes on_leave.
    await dbAdmin.insert(attendanceRecords).values({
      tenant_id: T1,
      employee_id: empX.employeeId,
      attendance_date: TUE_REG,
      attendance_status: 'present',
      source: 'manual',
      is_regularized: true,
    });
    const full = await seedLeave(empX, TUE_REG, WED_AFTER_REG, 'pending');
    await leave.reviewLeave(full, mgrB.userId, T1, { action: 'approve' }, 'manager');
    expect((await recordFor(empX, TUE_REG))!.attendance_status).toBe('present');
    expect((await recordFor(empX, WED_AFTER_REG))).toMatchObject({ attendance_status: 'on_leave', source: 'system' });
  });

  it('full-day approval never demotes a WORKED day either (present survives; the empty day becomes on_leave)', async () => {
    await dbAdmin.insert(attendanceRecords).values({
      tenant_id: T1,
      employee_id: empX.employeeId,
      attendance_date: MON_WORKED,
      attendance_status: 'present',
      source: 'web',
      first_punch_in_at: istInstant(MON_WORKED, '09:05'),
      last_punch_out_at: istInstant(MON_WORKED, '18:10'),
      total_worked_minutes: 485,
    });
    const full = await seedLeave(empX, MON_WORKED, TUE_AFTER_WORKED, 'pending');
    await leave.reviewLeave(full, mgrB.userId, T1, { action: 'approve' }, 'manager');
    const worked = await recordFor(empX, MON_WORKED);
    expect(worked).toMatchObject({ attendance_status: 'present', source: 'web', total_worked_minutes: 485 });
    expect(worked!.first_punch_in_at).not.toBeNull();
    expect((await recordFor(empX, TUE_AFTER_WORKED))).toMatchObject({ attendance_status: 'on_leave', source: 'system' });
  });

  it('getMyMonth overlays leave: approved full-day without a row reads on_leave; pending is labelled', async () => {
    const res = await attendance.getMyMonth(empX.userId, T1, '2027-03');
    const d9 = res.days.find((d) => d.date === '2027-03-09')!;
    expect(d9.attendanceStatus).toBe('on_leave');
    expect(d9.leave).toMatchObject({ status: 'approved', leaveTypeName: 'Casual Leave' });
    expect(d9.pendingLeave).toBe(false);
    const d11 = res.days.find((d) => d.date === THU_PENDING)!;
    expect(d11.attendanceStatus).toBeNull();
    expect(d11.pendingLeave).toBe(true);
    const d3 = res.days.find((d) => d.date === WED_HOLIDAY)!;
    expect(d3).toMatchObject({ isHoliday: true, holidayName: 'Founders Day', attendanceStatus: null });
    const d12 = res.days.find((d) => d.date === FRI_HALF)!;
    expect(d12.attendanceStatus).toBe('half_day');
    expect(d12.leave).toMatchObject({ status: 'approved', isHalfDay: true });
    const d17 = res.days.find((d) => d.date === WED_AFTER_REG)!;
    expect(d17.attendanceStatus).toBe('on_leave');
    const d18 = res.days.find((d) => d.date === '2027-03-18')!;
    expect(d18.leave).toBeNull();
    expect(d18.attendanceStatus).toBeNull();
    // The request with a T2 leave_type_id: leave, but no name crosses over.
    const d24 = res.days.find((d) => d.date === FOREIGN_TYPE_DAY)!;
    expect(d24.attendanceStatus).toBe('on_leave');
    expect(d24.leave).toMatchObject({ status: 'approved', leaveTypeName: null });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Item 1 — today: punch-in, my today, team today, dashboard
// ═════════════════════════════════════════════════════════════════════════════

describe('Round L — today (IST, every-day shift): leave vs "yet to clock in"', () => {
  it('punchIn on approved leave ⇒ 409 with the exact copy; getMyToday says so and shows no working expectation', async () => {
    await expect(attendance.punchIn(tX.userId, T1, {})).rejects.toThrow(ConflictException);
    await expect(attendance.punchIn(tX.userId, T1, {})).rejects.toThrow(
      "You're on approved leave today — no clock-in needed. If you are working today, cancel the leave first.",
    );
    expect(await recordFor(tX, todayIST)).toBeNull();

    const mine = await attendance.getMyToday(tX.userId, T1);
    expect(mine.attendanceDate).toBe(todayIST);
    expect(mine).toMatchObject({ expected: false, dayKind: 'leave', pendingLeave: false, isWorkingDay: true });
    expect(mine.attendanceStatus).toBe('on_leave');
    expect(mine.leave).toMatchObject({ status: 'approved', leaveTypeName: 'Casual Leave' });
    expect(mine.firstPunchInAt).toBeNull();
  });

  it('half-day leave today: the backfilled half_day row is kept on punch-in (no late maths), punch stamped', async () => {
    const halfId = await seedLeave(tY, todayIST, todayIST, 'pending', { halfDay: true, session: 'first_half' });
    await leave.reviewLeave(halfId, mgrA.userId, T1, { action: 'approve' }, 'manager');
    expect(await recordFor(tY, todayIST)).toMatchObject({ attendance_status: 'half_day', source: 'system', first_punch_in_at: null });

    const punch = await attendance.punchIn(tY.userId, T1, {});
    expect(punch.type).toBe('in');
    expect(punch.isLate).toBe(false);
    expect(punch.lateByMinutes).toBe(0);
    const row = await recordFor(tY, todayIST);
    expect(row!.attendance_status).toBe('half_day');
    expect(row!.first_punch_in_at).not.toBeNull();
    expect(row!.is_late).toBe(false);

    const mine = await attendance.getMyToday(tY.userId, T1);
    expect(mine).toMatchObject({ expected: true, dayKind: 'half_day_leave', attendanceStatus: 'half_day' });
    expect(mine.leave).toMatchObject({ status: 'approved', isHalfDay: true, session: 'first_half' });
  });

  it('pending leave today: still expected, labelled; plain working day: expected, nothing derived', async () => {
    const pending = await attendance.getMyToday(tP.userId, T1);
    expect(pending).toMatchObject({ expected: true, dayKind: 'working', pendingLeave: true, attendanceStatus: 'absent' });
    expect(pending.leave).toMatchObject({ status: 'pending' });
    const working = await attendance.getMyToday(tW.userId, T1);
    expect(working).toMatchObject({ expected: true, dayKind: 'working', pendingLeave: false, leave: null, attendanceStatus: 'absent' });
  });

  it('listTeamToday derives each row from the request, per-employee date, no IST literal', async () => {
    const rows = await attendance.listTeamToday(mgrA.userId, T1, 'manager');
    const by = new Map(rows.map((r) => [r.employeeId, r]));
    for (const p of [tX, tY, tP, tW]) expect(by.get(p.employeeId)?.attendanceDate).toBe(todayIST);

    const x = by.get(tX.employeeId)!;
    expect(x).toMatchObject({ attendanceStatus: null, recordId: null, derivedStatus: 'on_leave', expected: false, dayKind: 'leave', pendingLeave: false });
    expect(x.leave).toMatchObject({ status: 'approved', leaveTypeName: 'Casual Leave' });

    const y = by.get(tY.employeeId)!;
    expect(y).toMatchObject({ attendanceStatus: 'half_day', derivedStatus: 'half_day', expected: true, dayKind: 'half_day_leave' });
    expect(y.firstPunchInAt).not.toBeNull();

    const p = by.get(tP.employeeId)!;
    expect(p).toMatchObject({ attendanceStatus: null, derivedStatus: null, expected: true, dayKind: 'working', pendingLeave: true });
    expect(p.leave).toMatchObject({ status: 'pending' });

    const w = by.get(tW.employeeId)!;
    expect(w).toMatchObject({ attendanceStatus: null, derivedStatus: null, expected: true, dayKind: 'working', pendingLeave: false, leave: null });
  });

  it('finance sees the roster with "On leave" / expected, never the request behind it', async () => {
    const rows = await attendance.listTeamToday(fin.userId, T1, 'finance');
    const by = new Map(rows.map((r) => [r.employeeId, r]));
    const x = by.get(tX.employeeId)!;
    expect(x).toMatchObject({ derivedStatus: 'on_leave', expected: false, dayKind: 'leave', leave: null, pendingLeave: false });
    const y = by.get(tY.employeeId)!;
    expect(y).toMatchObject({ attendanceStatus: 'half_day', dayKind: 'working', leave: null, pendingLeave: false, expected: true });
    const p = by.get(tP.employeeId)!;
    expect(p).toMatchObject({ derivedStatus: null, expected: true, leave: null, pendingLeave: false });
    // The manager and the owner still get the details.
    const owner = await attendance.listTeamToday(O.userId, T1, 'owner');
    expect(owner.find((r) => r.employeeId === tX.employeeId)?.leave).toMatchObject({ status: 'approved' });
    expect(owner.find((r) => r.employeeId === tP.employeeId)?.pendingLeave).toBe(true);
  });

  it('"today" is per employee: a UTC+14 shift is on Kiritimati’s date, not the IST one', async () => {
    const rows = await attendance.listTeamToday(O.userId, T1, 'owner');
    const kiri = rows.find((r) => r.employeeId === empKiri.employeeId)!;
    const now = new Date();
    expect(kiri.attendanceDate).toBe(dateInTimezone(now, 'Pacific/Kiritimati'));
    expect(rows.find((r) => r.employeeId === tW.employeeId)!.attendanceDate).toBe(dateInTimezone(now, IST));
    // Whenever the two zones are on different calendar days, the rows say so.
    if (dateInTimezone(now, 'Pacific/Kiritimati') !== dateInTimezone(now, IST)) {
      expect(kiri.attendanceDate).not.toBe(todayIST);
    }
  });

  it('cancelling an approved leave frees the day: the backfilled row goes, the board says expected, clock-in works', async () => {
    const id = await seedLeave(tC, todayIST, todayIST, 'pending');
    await leave.reviewLeave(id, mgrB.userId, T1, { action: 'approve' }, 'manager');
    expect(await recordFor(tC, todayIST)).toMatchObject({ attendance_status: 'on_leave', source: 'system', first_punch_in_at: null });
    let row = (await attendance.listTeamToday(mgrB.userId, T1, 'manager')).find((r) => r.employeeId === tC.employeeId)!;
    expect(row).toMatchObject({ derivedStatus: 'on_leave', expected: false, dayKind: 'leave' });
    await expect(attendance.punchIn(tC.userId, T1, {})).rejects.toThrow(ConflictException);

    const cancelled = await leave.cancelLeave(id, tC.userId, T1, { reason: 'Working after all' });
    expect(cancelled.status).toBe('cancelled');
    expect(await recordFor(tC, todayIST)).toBeNull();
    row = (await attendance.listTeamToday(mgrB.userId, T1, 'manager')).find((r) => r.employeeId === tC.employeeId)!;
    expect(row).toMatchObject({ attendanceStatus: null, derivedStatus: null, expected: true, dayKind: 'working', leave: null });
    expect((await attendance.getMyToday(tC.userId, T1))).toMatchObject({ expected: true, dayKind: 'working', attendanceStatus: 'absent' });
    const punch = await attendance.punchIn(tC.userId, T1, {});
    expect(punch.type).toBe('in');
  });

  it('getAdminOverview.attendanceToday (team scope): onLeave counts the leave, yetToClockIn excludes it, expectedToday and pendingLeave are new', async () => {
    const ov = await dashboard.getAdminOverview(T1, {
      callerUserId: mgrA.userId,
      includeOnboarding: false,
      includeApprovals: true,
      scope: 'team',
    });
    // mgrA's reports: tX (leave), tY (half-day, punched), tP (pending), tW
    // (working, no record), rX/rY/rN (working, no record yet).
    expect(ov.attendanceToday).toEqual({
      present: 1,
      late: 0,
      onLeave: 1,
      yetToClockIn: 4,
      holiday: 0,
      weekend: 0,
      pendingLeave: 1,
      expectedToday: 6,
    });
    expect(ov.stats.presentToday).toBe(1);
    expect(ov.stats.onLeaveToday).toBe(1);

    // Without the approvals gate the pending request is nobody's business:
    // the person is simply still to clock in.
    const plain = await dashboard.getAdminOverview(T1, {
      callerUserId: mgrA.userId,
      includeOnboarding: false,
      includeApprovals: false,
      scope: 'team',
    });
    expect(plain.attendanceToday.pendingLeave).toBe(0);
    expect(plain.attendanceToday.yetToClockIn).toBe(5);
    expect(plain.attendanceToday.expectedToday).toBe(6);

    // Org-wide: the same people are in there, plus the rest of the roster.
    const org = await dashboard.getAdminOverview(T1, {
      callerUserId: O.userId,
      includeOnboarding: false,
      includeApprovals: true,
      scope: 'org',
    });
    expect(org.attendanceToday.onLeave).toBeGreaterThanOrEqual(1);
    expect(org.attendanceToday.pendingLeave).toBeGreaterThanOrEqual(1);
    expect(org.attendanceToday.expectedToday).toBeGreaterThanOrEqual(6);
    expect(org.attendanceToday.present).toBeGreaterThanOrEqual(1);
    expect(org.stats.presentToday).toBe(org.attendanceToday.present);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Item 3 — regularization before clocking out
// ═════════════════════════════════════════════════════════════════════════════

describe('Round L — regularization is validated in the shift timezone', () => {
  const pastDay = addDaysISO(todayIST, -3);
  const reason = 'Round L — forgot to punch, client visit';

  it('a future day is refused', async () => {
    await expect(
      attendance.requestRegularization(rY.userId, T1, {
        attendanceDate: addDaysISO(todayIST, 1),
        requestType: 'missing_punch',
        reason,
      }),
    ).rejects.toThrow('Regularization can only be requested for today or a past day.');
  });

  it('out <= in is refused', async () => {
    await expect(
      attendance.requestRegularization(rY.userId, T1, {
        attendanceDate: pastDay,
        requestType: 'wrong_time',
        proposedInTime: istInstant(pastDay, '10:00').toISOString(),
        proposedOutTime: istInstant(pastDay, '09:00').toISOString(),
        reason,
      }),
    ).rejects.toThrow('Proposed clock-out must be after the proposed clock-in.');
  });

  it('instants must fall on the attendance date in the shift timezone; overnight shifts may clock out the next day', async () => {
    const next = addDaysISO(pastDay, 1);
    await expect(
      attendance.requestRegularization(rY.userId, T1, {
        attendanceDate: pastDay,
        requestType: 'wrong_time',
        proposedInTime: istInstant(next, '09:00').toISOString(),
        reason,
      }),
    ).rejects.toThrow(`Proposed clock-in must fall on ${pastDay} (${IST}).`);
    await expect(
      attendance.requestRegularization(rY.userId, T1, {
        attendanceDate: pastDay,
        requestType: 'wrong_time',
        proposedInTime: istInstant(pastDay, '22:00').toISOString(),
        proposedOutTime: istInstant(next, '06:00').toISOString(),
        reason,
      }),
    ).rejects.toThrow(`Proposed clock-out must fall on ${pastDay} (${IST}).`);

    // The overnight shift: same instants are fine.
    const night = await attendance.requestRegularization(rN.userId, T1, {
      attendanceDate: pastDay,
      requestType: 'wrong_time',
      proposedInTime: istInstant(pastDay, '22:00').toISOString(),
      proposedOutTime: istInstant(next, '06:00').toISOString(),
      reason,
    });
    expect(night.status).toBe('pending');
    expect(night.proposedOutTime).toBe(istInstant(next, '06:00').toISOString());
    // …but two days later is not.
    await expect(
      attendance.requestRegularization(rN.userId, T1, {
        attendanceDate: addDaysISO(pastDay, -1),
        requestType: 'wrong_time',
        proposedInTime: istInstant(addDaysISO(pastDay, -1), '22:00').toISOString(),
        proposedOutTime: istInstant(next, '06:00').toISOString(),
        reason,
      }),
    ).rejects.toThrow(/following day/);
  });

  it('a future instant is never valid, even on a past day (overnight shift filing yesterday with a clock-out ahead)', async () => {
    const yesterday = addDaysISO(todayIST, -1);
    let futureOut = new Date(Date.now() + 60_000);
    if (dateInTimezone(futureOut, IST) !== todayIST) futureOut = new Date(Date.now() + 1_000);
    await expect(
      attendance.requestRegularization(rN.userId, T1, {
        attendanceDate: yesterday,
        requestType: 'wrong_time',
        proposedInTime: istInstant(yesterday, '22:00').toISOString(),
        proposedOutTime: futureOut.toISOString(),
        reason,
      }),
    ).rejects.toThrow('Proposed clock-out is later than now — you can only regularize time that has already passed.');
  });

  it('today with a future clock-out is refused', async () => {
    let futureOut = new Date(Date.now() + 60_000);
    if (dateInTimezone(futureOut, IST) !== todayIST) futureOut = new Date(Date.now() + 1_000);
    await expect(
      attendance.requestRegularization(rY.userId, T1, {
        attendanceDate: todayIST,
        requestType: 'missing_punch',
        proposedOutTime: futureOut.toISOString(),
        reason,
      }),
    ).rejects.toThrow(
      'Proposed clock-out is later than now — regularization for today can be requested after you clock out.',
    );
  });

  it('today with no clock-out at all (never clocked in) is refused — the founder’s literal rule', async () => {
    expect(await recordFor(rY, todayIST)).toBeNull();
    await expect(
      attendance.requestRegularization(rY.userId, T1, {
        attendanceDate: todayIST,
        requestType: 'missing_punch',
        proposedInTime: istInstant(todayIST, '00:01').toISOString(),
        proposedOutTime: new Date(Date.now() - 30_000).toISOString(),
        reason,
      }),
    ).rejects.toThrow('Regularization for today can be requested after you clock out.');
    await expect(
      attendance.requestRegularization(rY.userId, T1, { attendanceDate: todayIST, requestType: 'missing_punch', reason }),
    ).rejects.toThrow('Regularization for today can be requested after you clock out.');
  });

  it('today while still clocked in is refused; after clocking out it goes through with exact instants', async () => {
    await attendance.punchIn(rX.userId, T1, {});
    await expect(
      attendance.requestRegularization(rX.userId, T1, {
        attendanceDate: todayIST,
        requestType: 'wrong_time',
        reason,
      }),
    ).rejects.toThrow(
      "You haven't clocked out yet today — regularization for today can be requested after you clock out.",
    );

    await attendance.punchOut(rX.userId, T1, {});
    const inAt = istInstant(todayIST, '00:01');
    const outAt = new Date(Date.now() - 30_000);
    const ok = await attendance.requestRegularization(rX.userId, T1, {
      attendanceDate: todayIST,
      requestType: 'wrong_time',
      proposedInTime: inAt.toISOString(),
      proposedOutTime: outAt.toISOString(),
      reason,
    });
    expect(ok.status).toBe('pending');
    expect(ok.attendanceDate).toBe(todayIST);
    expect(ok.proposedInTime).toBe(inAt.toISOString());
    expect(ok.proposedOutTime).toBe(outAt.toISOString());
  });

  it('a past day with 09:30–18:30 IST is stored as exactly those instants', async () => {
    const res = await attendance.requestRegularization(rY.userId, T1, {
      attendanceDate: pastDay,
      requestType: 'missing_punch',
      proposedInTime: `${pastDay}T04:00:00.000Z`,
      proposedOutTime: `${pastDay}T13:00:00.000Z`,
      reason,
    });
    expect(res.status).toBe('pending');
    expect(res.proposedInTime).toBe(`${pastDay}T04:00:00.000Z`);
    expect(res.proposedOutTime).toBe(`${pastDay}T13:00:00.000Z`);
    // The duplicate guard still runs AFTER the day checks.
    await expect(
      attendance.requestRegularization(rY.userId, T1, {
        attendanceDate: pastDay,
        requestType: 'missing_punch',
        reason,
      }),
    ).rejects.toThrow('A pending regularization already exists for this date');
  });

  it('the DTO refuses a malformed date or time through the real ValidationPipe', async () => {
    const pipe = new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      transformOptions: { enableImplicitConversion: true },
    });
    const meta = { type: 'body' as const, metatype: RegularizationRequestDto };
    const ok = (await pipe.transform(
      { attendanceDate: '2026-09-01', requestType: 'missing_punch', proposedInTime: '2026-09-01T03:30:00Z', proposedOutTime: '2026-09-01T12:30:00.000Z', reason },
      meta,
    )) as RegularizationRequestDto;
    expect(ok.attendanceDate).toBe('2026-09-01');
    // An explicit offset is an instant too.
    const offset = (await pipe.transform(
      { attendanceDate: '2026-09-01', requestType: 'missing_punch', proposedInTime: '2026-09-01T09:00:00+05:30', proposedOutTime: '2026-09-01T18:00+0530', reason },
      meta,
    )) as RegularizationRequestDto;
    expect(offset.proposedInTime).toBe('2026-09-01T09:00:00+05:30');
    for (const bad of [
      // Offset-less strings would be read in the SERVER's zone — refused.
      { proposedInTime: '2026-05-08T09:00:00' },
      { proposedInTime: '2026-05-08' },
      { proposedOutTime: '2026-05-08T09:00:00.000' },
      { attendanceDate: '2026/09/01' },
      { attendanceDate: '2026-13-01' },
      { attendanceDate: '01-09-2026' },
      { attendanceDate: '2026-09-01T00:00:00Z' },
      { proposedInTime: '09:30' },
      { proposedInTime: '2026-09-01 09:30' },
      { proposedOutTime: 'tomorrow' },
      { proposedOutTime: 1_700_000_000 },
      { extra: 'nope' },
    ]) {
      await expect(
        pipe.transform({ attendanceDate: '2026-09-01', requestType: 'missing_punch', reason, ...bad }, meta),
      ).rejects.toThrow(BadRequestException);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// core/common/time.ts — localTimeToUTC (the attendance module's private copy
// landed evening wall times on the next day)
// ═════════════════════════════════════════════════════════════════════════════

describe('Round L — localTimeToUTC keeps the calendar day', () => {
  it('morning and evening IST, a west-of-UTC zone, and midnight all stay on the requested day', () => {
    expect(localTimeToUTC('2026-09-17', '09:00', 'Asia/Kolkata').toISOString()).toBe('2026-09-17T03:30:00.000Z');
    expect(localTimeToUTC('2026-09-17', '22:00', 'Asia/Kolkata').toISOString()).toBe('2026-09-17T16:30:00.000Z');
    expect(localTimeToUTC('2026-09-17', '00:30', 'Asia/Kolkata').toISOString()).toBe('2026-09-16T19:00:00.000Z');
    expect(localTimeToUTC('2026-09-17', '01:00', 'America/Los_Angeles').toISOString()).toBe('2026-09-17T08:00:00.000Z');
    expect(localTimeToUTC('2026-09-17', '23:00', 'Pacific/Kiritimati').toISOString()).toBe('2026-09-17T09:00:00.000Z');
    // Round-trips through the zone it was asked for.
    for (const [d, t, tz] of [
      ['2026-09-17', '22:00', 'Asia/Kolkata'],
      ['2026-03-08', '02:30', 'America/New_York'], // DST gap — lands on a real instant, same day
      ['2026-11-01', '01:30', 'America/New_York'], // DST overlap
    ] as const) {
      const at = localTimeToUTC(d, t, tz);
      expect(dateInTimezone(at, tz)).toBe(d);
    }
  });
});
