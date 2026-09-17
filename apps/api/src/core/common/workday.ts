/**
 * Round L — the ONE read-only resolver for "is this person expected to work
 * on this day?". Before it, "absent / yet to clock in" was inferred from the
 * absence of an attendance row in five places with five different rules
 * (hard-coded IST, UTC "today", no weekend awareness, leave never consulted).
 *
 * Everything here derives on read and NEVER seeds rows: an employee with no
 * shift assignment and a tenant with no default template fall back to the
 * literal Mon–Fri / IST shift the punch flow would create, without creating
 * it. Every query carries an explicit tenant predicate (RLS is the floor).
 *
 * Precedence for a day: holiday → weekend → approved full-day leave
 * (`expected:false`) → approved half-day leave (`expected:true`,
 * kind `half_day_leave`) → working. A PENDING request is labelled
 * (`pendingLeave`) but never flips `expected` — the person still has to
 * clock in until someone approves it (founder default #6).
 */
import { NotFoundException } from '@nestjs/common';
import { and, desc, eq, gte, inArray, isNull, lte, notInArray, or } from 'drizzle-orm';
import {
  employees,
  employeeShifts,
  shiftTemplates,
  holidays,
  leaveRequests,
  leaveTypes,
  tenants,
} from '@flicks/db/schema';
import type { Db } from '@flicks/db';
import { dateInTimezone, isValidTimezone } from './time';

// ─── Types ──────────────────────────────────────────────────────────────────

export type DayKind = 'working' | 'weekend' | 'holiday' | 'leave' | 'half_day_leave';

export interface DayLeave {
  id: string;
  status: 'approved' | 'pending';
  isHalfDay: boolean;
  session: 'first_half' | 'second_half' | null;
  leaveTypeName: string | null;
}

export interface DayExpectation {
  employeeId: string;
  /** YYYY-MM-DD the expectation is for (per employee when "today"). */
  date: string;
  /** IANA zone the date was resolved in (the employee's shift timezone). */
  timezone: string;
  /** Is a clock-in expected? false on holidays, weekends and full-day leave. */
  expected: boolean;
  kind: DayKind;
  holidayName: string | null;
  /** The overlapping request that decides the day — approved beats pending. */
  leave: DayLeave | null;
  /** A pending request overlaps the day (informational; never flips `expected`). */
  pendingLeave: boolean;
}

export interface ShiftLite {
  /** null for the literal fallback (no assignment and no default template). */
  id: string | null;
  name: string;
  timezone: string;
  /** 0=Sun..6=Sat */
  workingDays: number[];
  startTime: string;
  endTime: string;
  isOvernight: boolean;
  source: 'assignment' | 'default' | 'fallback';
}

/** Minimal leave row the day picker needs (shared with the month view). */
export interface LeaveRow {
  id: string;
  startDate: string;
  endDate: string;
  status: string;
  isHalfDay: boolean;
  session: 'first_half' | 'second_half' | null;
  leaveTypeName: string | null;
}

// ─── Constants ──────────────────────────────────────────────────────────────

export const DEFAULT_TIMEZONE = 'Asia/Kolkata';
const DEFAULT_WORKING_DAYS = [1, 2, 3, 4, 5];
/** Elective holiday types never block work (Keka/Zoho semantics). */
const ELECTIVE_HOLIDAY_TYPES = ['optional', 'restricted'] as const;

const FALLBACK_SHIFT: ShiftLite = {
  id: null,
  name: 'General',
  timezone: DEFAULT_TIMEZONE,
  workingDays: [...DEFAULT_WORKING_DAYS],
  startTime: '09:00',
  endTime: '18:00',
  isOvernight: false,
  source: 'fallback',
};

// ─── Small helpers ──────────────────────────────────────────────────────────

/** Day-of-week (0=Sun..6=Sat) of a YYYY-MM-DD calendar date — zone-free. */
export function dayOfWeekISO(dateISO: string): number {
  return new Date(`${dateISO}T00:00:00Z`).getUTCDay();
}

function unique(ids: string[]): string[] {
  return Array.from(new Set(ids));
}

function toLite(
  t: typeof shiftTemplates.$inferSelect,
  source: ShiftLite['source'],
): ShiftLite {
  return {
    id: t.id,
    name: t.name,
    timezone: isValidTimezone(t.timezone) ? t.timezone : DEFAULT_TIMEZONE,
    workingDays: Array.isArray(t.working_days) && t.working_days.length
      ? t.working_days.map(Number)
      : [...DEFAULT_WORKING_DAYS],
    startTime: t.start_time,
    endTime: t.end_time,
    isOvernight: t.is_overnight,
    source,
  };
}

/** Lower is better: approved full > approved half > pending full > pending half. */
function leaveRank(l: LeaveRow): number {
  const approved = l.status === 'approved' ? 0 : 2;
  return approved + (l.isHalfDay ? 1 : 0);
}

/**
 * The request that decides `dateISO` among overlapping rows (any status the
 * caller passed in — normally approved + pending). Approved beats pending,
 * full-day beats half-day, then the earlier-starting request.
 */
export function pickLeaveForDate(rows: LeaveRow[], dateISO: string): DayLeave | null {
  let best: LeaveRow | null = null;
  for (const r of rows) {
    if (r.startDate > dateISO || r.endDate < dateISO) continue;
    if (r.status !== 'approved' && r.status !== 'pending') continue;
    if (
      !best ||
      leaveRank(r) < leaveRank(best) ||
      (leaveRank(r) === leaveRank(best) && r.startDate < best.startDate)
    ) {
      best = r;
    }
  }
  if (!best) return null;
  return {
    id: best.id,
    status: best.status as 'approved' | 'pending',
    isHalfDay: best.isHalfDay,
    session: best.session,
    leaveTypeName: best.leaveTypeName,
  };
}

// ─── Shifts ─────────────────────────────────────────────────────────────────

/**
 * The shift each employee is on for `dateISO`: their active employee_shifts
 * assignment, else the tenant's default template, else the literal Mon–Fri
 * IST fallback. One query for the assignments, one for the default. Never
 * seeds a template (the punch flow's self-heal stays the only writer).
 */
export async function resolveShiftsTx(
  tx: Db,
  tenantId: string,
  employeeIds: string[],
  dateISO: string,
): Promise<Map<string, ShiftLite>> {
  const out = new Map<string, ShiftLite>();
  const ids = unique(employeeIds);
  if (ids.length === 0) return out;

  const [assignments, defaults] = await Promise.all([
    tx
      .select({
        employeeId: employeeShifts.employee_id,
        template: shiftTemplates,
      })
      .from(employeeShifts)
      .innerJoin(
        shiftTemplates,
        and(
          eq(employeeShifts.shift_template_id, shiftTemplates.id),
          eq(shiftTemplates.tenant_id, tenantId),
        ),
      )
      .where(
        and(
          eq(employeeShifts.tenant_id, tenantId),
          inArray(employeeShifts.employee_id, ids),
          lte(employeeShifts.effective_from, dateISO),
          or(
            isNull(employeeShifts.effective_to),
            gte(employeeShifts.effective_to, dateISO),
          ),
        ),
      )
      .orderBy(employeeShifts.employee_id, desc(employeeShifts.effective_from)),
    tx
      .select()
      .from(shiftTemplates)
      .where(
        and(
          eq(shiftTemplates.tenant_id, tenantId),
          eq(shiftTemplates.is_default, true),
          eq(shiftTemplates.is_active, true),
        ),
      )
      .limit(1),
  ]);

  // Newest effective_from wins per employee (rows arrive sorted that way).
  for (const a of assignments) {
    if (!out.has(a.employeeId)) out.set(a.employeeId, toLite(a.template, 'assignment'));
  }
  const fallback = defaults[0] ? toLite(defaults[0], 'default') : FALLBACK_SHIFT;
  for (const id of ids) {
    if (!out.has(id)) out.set(id, fallback);
  }
  return out;
}

// ─── Expectations ───────────────────────────────────────────────────────────

/**
 * Batch expectation for many employees. `dateISO === null` means "today as
 * observed in EACH employee's shift timezone" (the punch flow's definition of
 * the attendance date); a string evaluates everyone on that calendar day.
 *
 * Employees that don't exist in this tenant get no entry — a foreign id can
 * never come back as "working".
 */
export async function resolveExpectationsTx(
  tx: Db,
  tenantId: string,
  employeeIds: string[],
  dateISO: string | null,
  now: Date = new Date(),
): Promise<Map<string, DayExpectation>> {
  const out = new Map<string, DayExpectation>();
  const ids = unique(employeeIds);
  if (ids.length === 0) return out;

  // The shift lookup needs a date before the shift's own timezone is known —
  // same bootstrap the punch flow uses (IST today), then re-derived per zone.
  const lookupDate = dateISO ?? dateInTimezone(now, DEFAULT_TIMEZONE);
  const shifts = await resolveShiftsTx(tx, tenantId, ids, lookupDate);

  const dateFor = new Map<string, string>();
  for (const id of ids) {
    const shift = shifts.get(id) ?? FALLBACK_SHIFT;
    dateFor.set(id, dateISO ?? dateInTimezone(now, shift.timezone));
  }
  const dates = unique(Array.from(dateFor.values())).sort();
  const minDate = dates[0]!;
  const maxDate = dates[dates.length - 1]!;

  const [people, holidayRows, leaveRows] = await Promise.all([
    tx
      .select({ id: employees.id, locationId: employees.location_id })
      .from(employees)
      .where(and(eq(employees.tenant_id, tenantId), inArray(employees.id, ids))),
    tx
      .select({
        date: holidays.holiday_date,
        name: holidays.name,
        locationId: holidays.location_id,
      })
      .from(holidays)
      .where(
        and(
          eq(holidays.tenant_id, tenantId),
          gte(holidays.holiday_date, minDate),
          lte(holidays.holiday_date, maxDate),
          notInArray(holidays.type, [...ELECTIVE_HOLIDAY_TYPES]),
        ),
      ),
    tx
      .select({
        id: leaveRequests.id,
        employeeId: leaveRequests.employee_id,
        startDate: leaveRequests.start_date,
        endDate: leaveRequests.end_date,
        status: leaveRequests.status,
        isHalfDay: leaveRequests.is_half_day,
        session: leaveRequests.half_day_session,
        leaveTypeName: leaveTypes.name,
      })
      .from(leaveRequests)
      .leftJoin(
        leaveTypes,
        and(eq(leaveRequests.leave_type_id, leaveTypes.id), eq(leaveTypes.tenant_id, tenantId)),
      )
      .where(
        and(
          eq(leaveRequests.tenant_id, tenantId),
          inArray(leaveRequests.employee_id, ids),
          inArray(leaveRequests.status, ['approved', 'pending']),
          // Overlap on [minDate, maxDate] — uses idx_leave_requests_tenant_range.
          lte(leaveRequests.start_date, maxDate),
          gte(leaveRequests.end_date, minDate),
        ),
      ),
  ]);

  const leavesByEmployee = new Map<string, LeaveRow[]>();
  for (const l of leaveRows) {
    const list = leavesByEmployee.get(l.employeeId) ?? [];
    list.push(l);
    leavesByEmployee.set(l.employeeId, list);
  }

  for (const person of people) {
    const shift = shifts.get(person.id) ?? FALLBACK_SHIFT;
    const date = dateFor.get(person.id)!;
    // Company-wide rows (location NULL) apply to everyone; location rows only
    // to employees AT that location (same rule as leave's workingHolidayFilter).
    const holiday =
      holidayRows.find(
        (h) =>
          h.date === date &&
          (h.locationId === null || h.locationId === person.locationId),
      ) ?? null;
    const isWeekend = !shift.workingDays.includes(dayOfWeekISO(date));
    const leave = pickLeaveForDate(leavesByEmployee.get(person.id) ?? [], date);

    let kind: DayKind = 'working';
    let expected = true;
    if (holiday) {
      kind = 'holiday';
      expected = false;
    } else if (isWeekend) {
      kind = 'weekend';
      expected = false;
    } else if (leave?.status === 'approved') {
      if (leave.isHalfDay) {
        kind = 'half_day_leave';
        expected = true;
      } else {
        kind = 'leave';
        expected = false;
      }
    }

    out.set(person.id, {
      employeeId: person.id,
      date,
      timezone: shift.timezone,
      expected,
      kind,
      holidayName: holiday?.name ?? null,
      leave,
      pendingLeave: leave?.status === 'pending',
    });
  }
  return out;
}

/** Single-employee convenience over `resolveExpectationsTx`. */
export async function resolveExpectationTx(
  tx: Db,
  tenantId: string,
  employeeId: string,
  dateISO: string | null,
  now: Date = new Date(),
): Promise<DayExpectation> {
  const map = await resolveExpectationsTx(tx, tenantId, [employeeId], dateISO, now);
  const exp = map.get(employeeId);
  if (!exp) throw new NotFoundException('Employee not found');
  return exp;
}

/**
 * True when `employeeId` has an APPROVED FULL-DAY leave covering `dateISO`.
 * Half-day leave never counts (founder default #2) — item 2 uses this to skip
 * a reviewer who is away.
 */
export async function employeeOnApprovedLeaveTx(
  tx: Db,
  tenantId: string,
  employeeId: string,
  dateISO: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: leaveRequests.id })
    .from(leaveRequests)
    .where(
      and(
        eq(leaveRequests.tenant_id, tenantId),
        eq(leaveRequests.employee_id, employeeId),
        eq(leaveRequests.status, 'approved'),
        eq(leaveRequests.is_half_day, false),
        lte(leaveRequests.start_date, dateISO),
        gte(leaveRequests.end_date, dateISO),
      ),
    )
    .limit(1);
  return !!row;
}

/**
 * The tenant's "today" for workspace-wide numbers (dashboard): the default
 * shift template's timezone, else the tenant's own timezone, else IST. The
 * old dashboard used a UTC date — wrong for every Indian tenant after 17:30.
 */
export async function tenantTodayISOTx(
  tx: Db,
  tenantId: string,
  now: Date = new Date(),
): Promise<string> {
  const [def] = await tx
    .select({ timezone: shiftTemplates.timezone })
    .from(shiftTemplates)
    .where(
      and(
        eq(shiftTemplates.tenant_id, tenantId),
        eq(shiftTemplates.is_default, true),
        eq(shiftTemplates.is_active, true),
      ),
    )
    .limit(1);
  let tz: string | null | undefined = def?.timezone;
  if (!isValidTimezone(tz)) {
    const [t] = await tx
      .select({ timezone: tenants.timezone })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    tz = t?.timezone;
  }
  return dateInTimezone(now, isValidTimezone(tz) ? tz : DEFAULT_TIMEZONE);
}

/**
 * The attendance_status a day WITHOUT a record reads as, from its
 * expectation: on_leave / holiday / weekend, or null when the person is
 * simply expected and hasn't clocked in (half-day leave included — they are
 * expected for the other half).
 */
export function derivedStatus(
  exp: Pick<DayExpectation, 'kind'>,
): 'on_leave' | 'holiday' | 'weekend' | null {
  switch (exp.kind) {
    case 'leave':
      return 'on_leave';
    case 'holiday':
      return 'holiday';
    case 'weekend':
      return 'weekend';
    default:
      return null;
  }
}
