/**
 * Round P — R1 go-live hardening (2026-10-04), implementer A2:
 *
 *  C12 — the global exception filter maps Postgres 23505 to 409 DUPLICATE
 *        (friendly copy for the two employee constraints) and, in production
 *        only, masks non-HTTP errors behind "Something went wrong" + a short
 *        errorId that is also printed in the log line.
 *  R1.6 — new tenants are seeded with the curated India holiday preset for
 *        the signup year (Holi, Eid, Dussehra, Diwali …) topped up with the
 *        legacy fixed days by date + name (2026: Labour Day next to Buddha
 *        Purnima on 1 May; "New Year"/"Christmas" never doubled) and the
 *        legacy list as the fallback; the welcome email greets the founder
 *        by the name they just typed, not the email-prefix placeholder.
 *  R1.6 — GET /crm/pipelines self-heals the default pipeline on a fresh
 *        tenant (so /crm/deals never caches an empty list), and collapses a
 *        double seed (its locked seeder racing DealsService's unlocked copy
 *        from the concurrent /crm/board request) on the next read.
 *  C8  — applyLeave refuses a request that exceeds the days left
 *        (400 LEAVE_BALANCE_EXCEEDED, "You have N day(s) of <type> left for
 *        this year"); pending requests reduce availability; unpaid (LOP) and
 *        untracked (quota 0, nothing credited) types are exempt; concurrent
 *        applies by one employee serialise on a per-employee advisory lock;
 *        the balances endpoint keeps its shape.
 *
 * Service-level against the real Postgres (founder-roundL harness).
 */
import 'dotenv/config';
import * as crypto from 'crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db, dbAdmin } from '@flicks/db';
import {
  tenants,
  users,
  memberships,
  employees,
  holidays,
  leaveTypes,
  leaveBalances,
  leaveRequests,
  pipelines,
  pipelineStages,
  lostReasons,
  deals,
} from '@flicks/db/schema';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { HttpExceptionFilter } from '../core/common/filters/http-exception.filter';
import { DatabaseService } from '../core/database/database.service';
import type { AuditService } from '../modules/audit/audit.service';
import type { NotificationsService } from '../modules/notifications/notifications.service';
import type { AnalyticsService } from '../core/analytics/analytics.service';
import { LeaveService, formatLeaveDays } from '../modules/leave/leave.service';
import { PipelinesService, ensureDefaultPipeline } from '../modules/crm/pipelines.service';
import { DealsService } from '../modules/crm/deals.service';
import { OnboardingService, getSignupYearHolidays } from '../modules/onboarding/onboarding.service';

jest.setTimeout(120_000);

const rid = () => crypto.randomBytes(4).toString('hex');
const IST = 'Asia/Kolkata';

const auditStub = { log: async () => {} } as unknown as AuditService;
const sendEmailSpy = jest.fn(async () => true);
const notifications = {
  createInAppNotification: jest.fn(async () => undefined),
  sendEmail: sendEmailSpy,
} as unknown as NotificationsService;
const analyticsStub = { capture: () => {}, track: () => {} } as unknown as AnalyticsService;
const config = new ConfigService({ NODE_ENV: 'test', APP_URL: 'http://localhost:3000' });

const dbSvc = new DatabaseService();
const leave = new LeaveService(dbSvc, auditStub, notifications);
const pipelinesSvc = new PipelinesService(dbSvc, auditStub);
// Only `board()` on an empty tenant is exercised (its unlocked seed racing
// ours) — it reads the tenant currency and the pipeline tables and nothing
// else, so FX / invoicing / media can be inert stubs.
const dealsSvc = new DealsService(
  dbSvc,
  auditStub,
  { publish: async () => 'evt' } as never,
  {} as never,
  new EventEmitter2(),
  {} as never,
);
const onboarding = new OnboardingService(dbAdmin as never, auditStub, analyticsStub, notifications, config);

// ─── Fixtures ────────────────────────────────────────────────────────────────
type Person = { userId: string; employeeId: string; email: string };
let T1: string;
const extraTenants: string[] = [];
const userIds: string[] = [];
let owner: Person;
let emp: Person;
let clTypeId: string; // paid, quota 3
let lopTypeId: string; // unpaid (is_paid=false, is_lop=true), quota 0
let wfhTypeId: string; // paid, quota 0 — untracked
let compTypeId: string; // paid, quota 0 — HR credits days via the ledger

async function mkUser(label: string, fullName?: string) {
  const email = `rp-${label.toLowerCase()}-${rid()}@t.test`;
  const [u] = await dbAdmin
    .insert(users)
    .values({ email, full_name: fullName ?? `${label} Tester`, status: 'active' })
    .returning();
  userIds.push(u!.id);
  return { id: u!.id, email };
}

async function mkPerson(
  tenantId: string,
  label: string,
  role: 'owner' | 'employee',
  managerId: string | null = null,
): Promise<Person> {
  const u = await mkUser(label);
  const [e] = await dbAdmin
    .insert(employees)
    .values({
      tenant_id: tenantId,
      user_id: u.id,
      employee_code: `RP-${rid()}`,
      first_name: label,
      last_name: 'Tester',
      work_email: u.email,
      date_of_joining: '2026-01-01',
      status: 'active',
      reporting_manager_id: managerId,
    })
    .returning();
  await dbAdmin
    .insert(memberships)
    .values({ tenant_id: tenantId, user_id: u.id, role, status: 'active', employee_id: e!.id });
  return { userId: u.id, employeeId: e!.id, email: u.email };
}

async function mkTenant(label: string): Promise<string> {
  const [t] = await dbAdmin
    .insert(tenants)
    .values({
      name: `RP ${label} ${rid()}`,
      slug: `rp-${label}-${rid()}-${Date.now()}`,
      status: 'active',
      currency: 'INR',
      timezone: IST,
    })
    .returning();
  return t!.id;
}

async function mkLeaveType(
  tenantId: string,
  name: string,
  code: string,
  quota: number,
  opts: { isPaid?: boolean; isLop?: boolean } = {},
) {
  const [lt] = await dbAdmin
    .insert(leaveTypes)
    .values({
      tenant_id: tenantId,
      name,
      code,
      default_quota_days: quota,
      is_paid: opts.isPaid ?? true,
      is_lop: opts.isLop ?? false,
      allow_half_day: true,
      is_active: true,
    })
    .returning();
  return lt!.id;
}

/** Applies as `p` and returns the thrown HttpException body (or null when it succeeded). */
async function applyExpectingError(
  p: Person,
  dto: Parameters<LeaveService['applyLeave']>[2],
): Promise<{ status: number; body: { code?: string; message?: string } } | null> {
  try {
    await leave.applyLeave(p.userId, T1, dto);
    return null;
  } catch (err) {
    if (!(err instanceof HttpException)) throw err;
    return { status: err.getStatus(), body: err.getResponse() as { code?: string; message?: string } };
  }
}

async function ledgerFor(p: Person, typeId: string, year: number) {
  const [row] = await dbAdmin
    .select()
    .from(leaveBalances)
    .where(
      and(
        eq(leaveBalances.tenant_id, T1),
        eq(leaveBalances.employee_id, p.employeeId),
        eq(leaveBalances.leave_type_id, typeId),
        eq(leaveBalances.leave_year, year),
      ),
    );
  return row ?? null;
}

beforeAll(async () => {
  T1 = await mkTenant('main');
  owner = await mkPerson(T1, 'Owner', 'owner');
  emp = await mkPerson(T1, 'Emp', 'employee', owner.employeeId);
  clTypeId = await mkLeaveType(T1, 'Casual Leave', 'CL', 3);
  lopTypeId = await mkLeaveType(T1, 'Loss of Pay', 'LOP', 0, { isPaid: false, isLop: true });
  wfhTypeId = await mkLeaveType(T1, 'Work From Home', 'WFH', 0);
  compTypeId = await mkLeaveType(T1, 'Compensatory Off', 'COMP', 0);
});

afterAll(async () => {
  for (const t of [T1, ...extraTenants]) await dbAdmin.delete(tenants).where(eq(tenants.id, t));
  for (const u of userIds) await dbAdmin.delete(users).where(eq(users.id, u));
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
});

// ═════════════════════════════════════════════════════════════════════════════
// C12 — global exception filter
// ═════════════════════════════════════════════════════════════════════════════

type Captured = { status: number; body: Record<string, unknown> };
function hostFor(url: string, captured: Captured): ArgumentsHost {
  const response: { status: (s: number) => unknown; json: (b: Record<string, unknown>) => void } = {
    status: (s: number) => {
      captured.status = s;
      return response;
    },
    json: (b: Record<string, unknown>) => {
      captured.body = b;
    },
  };
  const request = { url, method: 'POST', headers: {} };
  return {
    switchToHttp: () => ({ getResponse: () => response, getRequest: () => request }),
  } as unknown as ArgumentsHost;
}

function run(filter: HttpExceptionFilter, exception: unknown, url = '/api/v1/employees/invite') {
  const captured: Captured = { status: 0, body: {} };
  filter.catch(exception, hostFor(url, captured));
  return captured;
}

function captureLogs(filter: HttpExceptionFilter) {
  const lines: Array<{ level: 'error' | 'warn'; message: string; stack?: string }> = [];
  (filter as unknown as { logger: unknown }).logger = {
    error: (message: string, stack?: string) => lines.push({ level: 'error', message, stack }),
    warn: (message: string) => lines.push({ level: 'warn', message }),
    log: () => {},
  };
  return lines;
}

describe('C12 — HttpExceptionFilter: 23505 → 409 DUPLICATE', () => {
  it('maps the work-email constraint to the friendly 409 (plain driver error shape)', () => {
    const filter = new HttpExceptionFilter({ nodeEnv: 'development' });
    captureLogs(filter);
    const { status, body } = run(filter, {
      code: '23505',
      constraint: 'employees_tenant_work_email_unique',
    });
    expect(status).toBe(409);
    expect(body.statusCode).toBe(409);
    expect(body.code).toBe('DUPLICATE');
    expect(body.message).toBe('An employee with this work email already exists');
    expect(body.error).toBe('Conflict');
    expect(body.errorId).toBeUndefined();
  });

  it('maps the employee-code constraint using the postgres.js field name (constraint_name)', () => {
    const filter = new HttpExceptionFilter({ nodeEnv: 'production' });
    captureLogs(filter);
    const err = Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
      constraint_name: 'employees_tenant_code_unique',
    });
    const { status, body } = run(filter, err);
    expect(status).toBe(409);
    expect(body.code).toBe('DUPLICATE');
    expect(body.message).toBe('Employee code already in use');
  });

  it('any other unique constraint gets the generic DUPLICATE copy — never the raw Postgres text', () => {
    const filter = new HttpExceptionFilter({ nodeEnv: 'production' });
    const lines = captureLogs(filter);
    const err = Object.assign(
      new Error('duplicate key value violates unique constraint "leave_types_tenant_code_unique"'),
      { code: '23505', constraint_name: 'leave_types_tenant_code_unique' },
    );
    const { status, body } = run(filter, err);
    expect(status).toBe(409);
    expect(body.code).toBe('DUPLICATE');
    expect(body.message).toBe('A record with the same value already exists.');
    expect(String(body.message)).not.toMatch(/duplicate key/);
    // A stackless warn line names the constraint so the missing pre-check is findable.
    expect(lines.some((l) => l.level === 'warn' && l.message.includes('leave_types_tenant_code_unique'))).toBe(true);
    expect(lines.filter((l) => l.level === 'error')).toHaveLength(0);
  });

  it('finds the unique violation when a wrapper re-threw it as `cause`', () => {
    const filter = new HttpExceptionFilter({ nodeEnv: 'development' });
    captureLogs(filter);
    const wrapped = Object.assign(new Error('Failed query: insert into employees …'), {
      cause: { code: '23505', constraint_name: 'employees_tenant_work_email_unique' },
    });
    const { status, body } = run(filter, wrapped);
    expect(status).toBe(409);
    expect(body.message).toBe('An employee with this work email already exists');
  });
});

describe('C12 — HttpExceptionFilter: production masking', () => {
  it('in production a plain Error becomes a masked 500 with an errorId that the log line carries', () => {
    const filter = new HttpExceptionFilter({ nodeEnv: 'production' });
    const lines = captureLogs(filter);
    const { status, body } = run(filter, new Error('connect ECONNREFUSED pooler.internal:5432'));

    expect(status).toBe(500);
    expect(body.statusCode).toBe(500);
    expect(body.message).toBe('Something went wrong. Please try again.');
    expect(body.error).toBe('InternalServerError');
    expect(body.errorId).toMatch(/^[0-9a-f]{8}$/);
    expect(JSON.stringify(body)).not.toMatch(/ECONNREFUSED|pooler/);

    // The raw message + stack are logged once, tagged with the same ref.
    const ref = String(body.errorId);
    const headline = lines.find((l) => l.message.startsWith('Unhandled exception'));
    expect(headline).toBeDefined();
    expect(headline!.message).toContain(`[ref ${ref}]`);
    expect(headline!.message).toContain('ECONNREFUSED');
    expect(headline!.stack).toBeTruthy();
    const context = lines.find((l) => l.message.includes('POST /api/v1/employees/invite 500'));
    expect(context).toBeDefined();
    expect(context!.message).toContain(`[ref ${ref}]`);
  });

  it('reads NODE_ENV from the environment when no override is given', () => {
    const previous = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      const filter = new HttpExceptionFilter();
      captureLogs(filter);
      const { body } = run(filter, new Error('relation "secret_table" does not exist'));
      expect(body.message).toBe('Something went wrong. Please try again.');
      expect(body.errorId).toMatch(/^[0-9a-f]{8}$/);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  it('outside production the raw message is still returned (behaviour unchanged) plus the errorId', () => {
    const filter = new HttpExceptionFilter({ nodeEnv: 'development' });
    captureLogs(filter);
    const { status, body } = run(filter, new TypeError('Cannot read properties of undefined'));
    expect(status).toBe(500);
    expect(body.message).toBe('Cannot read properties of undefined');
    expect(body.error).toBe('TypeError');
    expect(body.errorId).toMatch(/^[0-9a-f]{8}$/);
  });

  it('HttpExceptions pass through untouched in production, including their code', () => {
    const filter = new HttpExceptionFilter({ nodeEnv: 'production' });
    const lines = captureLogs(filter);
    const { status, body } = run(
      filter,
      new BadRequestException({ code: 'LEAVE_BALANCE_EXCEEDED', message: 'You have 2 day(s) of Casual Leave left for this year' }),
    );
    expect(status).toBe(400);
    expect(body.code).toBe('LEAVE_BALANCE_EXCEEDED');
    expect(body.message).toBe('You have 2 day(s) of Casual Leave left for this year');
    expect(body.errorId).toBeUndefined();
    expect(lines).toHaveLength(0);

    const conflict = run(filter, new HttpException('nope', HttpStatus.CONFLICT));
    expect(conflict.status).toBe(409);
    expect(conflict.body.message).toBe('nope');
    expect(conflict.body.code).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// R1.6 — holiday seed + welcome email name
// ═════════════════════════════════════════════════════════════════════════════

describe('R1.6 — getSignupYearHolidays', () => {
  it('2026 comes from the curated preset: Diwali, Dussehra, Holi, Eid, Good Friday … plus the fixed days', () => {
    const rows = getSignupYearHolidays(2026);
    const names = rows.map((r) => r.name);
    expect(names.some((n) => /Diwali/.test(n))).toBe(true);
    expect(names.some((n) => /Dussehra/.test(n))).toBe(true);
    expect(names.some((n) => /Holi/.test(n))).toBe(true);
    expect(names.some((n) => /Eid al-Fitr/.test(n))).toBe(true);
    expect(names.some((n) => /Good Friday/.test(n))).toBe(true);
    for (const fixed of ['Republic Day', 'Independence Day', 'Gandhi Jayanti', 'Christmas Day']) {
      expect(names).toContain(fixed);
    }
    // Dates are the preset's real 2026 dates, sorted, and no (date, name) repeats.
    expect(rows.find((r) => /Diwali/.test(r.name))!.date).toBe('2026-11-08');
    expect(rows.find((r) => /Dussehra/.test(r.name))!.date).toBe('2026-10-20');
    expect(rows.map((r) => r.date)).toEqual([...rows.map((r) => r.date)].sort());
    expect(new Set(rows.map((r) => `${r.date}|${r.name}`)).size).toBe(rows.length);
    // Festival dates move every year; the fixed national days recur.
    expect(rows.find((r) => /Diwali/.test(r.name))!.is_recurring).toBe(false);
    expect(rows.find((r) => r.name === 'Republic Day')!.is_recurring).toBe(true);
    // Nothing a tenant used to get is lost: today's list had 6 fixed days.
    expect(rows.length).toBeGreaterThanOrEqual(6);
  });

  it('2026 keeps Labour Day next to Buddha Purnima on 1 May, but never doubles New Year / Christmas', () => {
    const rows = getSignupYearHolidays(2026);
    // The preset has Buddha Purnima on the legacy Labour Day date: both are
    // seeded (the day-off calculation reads a set of dates, so still one day).
    const mayDay = rows.filter((r) => r.date === '2026-05-01').map((r) => r.name).sort();
    expect(mayDay).toEqual(['Buddha Purnima', 'Labour Day']);
    expect(rows.find((r) => r.name === 'Labour Day')!.is_recurring).toBe(true);
    expect(rows.find((r) => r.name === 'Buddha Purnima')!.is_recurring).toBe(false);
    // Same holiday under the legacy spelling collapses into the preset row.
    expect(rows.filter((r) => r.date === '2026-01-01').map((r) => r.name)).toEqual(["New Year's Day"]);
    expect(rows.filter((r) => r.date === '2026-12-25').map((r) => r.name)).toEqual(['Christmas Day']);
    expect(rows.map((r) => r.name)).not.toContain('New Year');
    expect(rows.map((r) => r.name)).not.toContain('Christmas');
    // Every legacy fixed day survives, by date.
    for (const d of ['2026-01-01', '2026-01-26', '2026-05-01', '2026-08-15', '2026-10-02', '2026-12-25']) {
      expect(rows.some((r) => r.date === d)).toBe(true);
    }
  });

  it('2031 (no preset yet) falls back to the legacy fixed-date list, all recurring', () => {
    const rows = getSignupYearHolidays(2031);
    expect(rows.map((r) => r.name).sort()).toEqual(
      ['Christmas', 'Gandhi Jayanti', 'Independence Day', 'Labour Day', 'New Year', 'Republic Day'].sort(),
    );
    expect(rows.every((r) => r.is_recurring)).toBe(true);
    expect(rows.every((r) => r.date.startsWith('2031-'))).toBe(true);
    expect(rows.find((r) => r.name === 'Republic Day')!.date).toBe('2031-01-26');
  });
});

describe('R1.6 — createTenant seeds the preset holidays and greets the founder by name', () => {
  it('inserts the signup-year rows and emails "welcome-tenant" with the typed name', async () => {
    const placeholder = `asha.verma-${rid()}`;
    const [u] = await dbAdmin
      .insert(users)
      .values({ email: `${placeholder}@rp.test`, full_name: placeholder, status: 'active' })
      .returning();
    userIds.push(u!.id);
    sendEmailSpy.mockClear();

    const created = await onboarding.createTenant(
      {
        name: `RP Signup ${rid()}`,
        slug: `rp-signup-${rid()}-${Date.now()}`,
        fullName: '  Asha   Verma ',
        industry: 'SaaS / Software',
        sizeBand: '1-10',
        primaryLocation: { name: 'HQ', timezone: IST },
      } as never,
      u!.id,
    );
    extraTenants.push(created.id);

    // Holidays = exactly the helper's rows for this year (dates, names, recurrence).
    const expected = getSignupYearHolidays(new Date().getFullYear());
    const rows = await dbAdmin.select().from(holidays).where(eq(holidays.tenant_id, created.id));
    expect(rows).toHaveLength(expected.length);
    for (const h of expected) {
      // Two rows may share a date (Buddha Purnima + Labour Day) — match both keys.
      const row = rows.find((r) => r.holiday_date === h.date && r.name === h.name);
      expect(row).toBeDefined();
      expect(row!.type).toBe(h.type);
      expect(row!.is_recurring).toBe(h.is_recurring);
      expect(row!.location_id).toBeNull();
    }

    // The placeholder name was replaced and the welcome email uses the new one.
    const [after] = await dbAdmin.select({ name: users.full_name }).from(users).where(eq(users.id, u!.id));
    expect(after!.name).toBe('Asha Verma');
    const welcome = sendEmailSpy.mock.calls.find((c) => (c as unknown[])[0] === 'welcome-tenant') as
      | [string, string, Record<string, unknown>]
      | undefined;
    expect(welcome).toBeDefined();
    expect(welcome![1]).toBe(`${placeholder}@rp.test`);
    expect(welcome![2].ownerName).toBe('Asha Verma');
    expect(welcome![2].tenantName).toBe(created.name);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// R1.6 — GET /crm/pipelines self-heals the default pipeline
// ═════════════════════════════════════════════════════════════════════════════

describe('R1.6 — PipelinesService.list heals a fresh tenant', () => {
  it('a tenant with no pipeline gets the default "Sales" pipeline with 7 stages on first list', async () => {
    const t = await mkTenant('pl-fresh');
    extraTenants.push(t);

    const first = await pipelinesSvc.list(t);
    expect(first.data).toHaveLength(1);
    const pl = first.data[0]!;
    expect(pl.tenant_id).toBe(t);
    expect(pl.name).toBe('Sales');
    expect(pl.is_default).toBe(true);
    expect(pl.stages.map((s) => s.name)).toEqual([
      'Qualified',
      'Contact Made',
      'Demo Scheduled',
      'Proposal Sent',
      'Negotiation',
      'Won',
      'Lost',
    ]);
    expect(pl.stages.map((s) => s.display_order)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(pl.stages.filter((s) => s.stage_type === 'won')).toHaveLength(1);
    expect(pl.stages.filter((s) => s.stage_type === 'lost')).toHaveLength(1);

    // Lost reasons are healed on the same read (Mark as lost never dead-ends).
    const reasons = await dbAdmin.select().from(lostReasons).where(eq(lostReasons.tenant_id, t));
    expect(reasons.length).toBeGreaterThanOrEqual(6);

    // Idempotent: a second list (and a direct re-run of the helper) adds nothing.
    const second = await pipelinesSvc.list(t);
    expect(second.data).toHaveLength(1);
    await dbSvc.withTenant(t, (tx) => ensureDefaultPipeline(tx, t));
    const all = await dbAdmin.select().from(pipelines).where(eq(pipelines.tenant_id, t));
    expect(all).toHaveLength(1);
    const stages = await dbAdmin.select().from(pipelineStages).where(eq(pipelineStages.tenant_id, t));
    expect(stages).toHaveLength(7);
  });

  it('defaultPipeline() on a fresh tenant resolves instead of throwing NotFound', async () => {
    const t = await mkTenant('pl-default');
    extraTenants.push(t);
    const p = await pipelinesSvc.defaultPipeline(t);
    expect(p.name).toBe('Sales');
    expect(p.tenant_id).toBe(t);
  });

  it('a tenant that already has a pipeline is left alone (no second seed, no cross-tenant leak)', async () => {
    const t = await mkTenant('pl-custom');
    extraTenants.push(t);
    const [custom] = await dbAdmin
      .insert(pipelines)
      .values({ tenant_id: t, name: 'Enterprise', is_default: true })
      .returning();
    await dbAdmin.insert(pipelineStages).values([
      { tenant_id: t, pipeline_id: custom!.id, name: 'Open', display_order: 0, win_probability: 10, stage_type: 'open' },
      { tenant_id: t, pipeline_id: custom!.id, name: 'Won', display_order: 1, win_probability: 100, stage_type: 'won' },
      { tenant_id: t, pipeline_id: custom!.id, name: 'Lost', display_order: 2, win_probability: 0, stage_type: 'lost' },
    ]);
    const res = await pipelinesSvc.list(t);
    expect(res.data).toHaveLength(1);
    expect(res.data[0]!.name).toBe('Enterprise');
    expect(res.data[0]!.stages).toHaveLength(3);
    // Fresh tenants healed above never show up in this tenant's list.
    expect(res.data.every((p) => p.tenant_id === t)).toBe(true);
  });
});

describe('R1.6 — a double-seeded default pipeline collapses on the next read', () => {
  const STAGES: Array<[string, number, string]> = [
    ['Qualified', 10, 'open'],
    ['Won', 100, 'won'],
    ['Lost', 0, 'lost'],
  ];
  /** A seeded default exactly as either seeder writes it, with a chosen age. */
  async function seededSales(tenantId: string, ageMs: number) {
    const [pl] = await dbAdmin
      .insert(pipelines)
      .values({
        tenant_id: tenantId,
        name: 'Sales',
        is_default: true,
        display_order: 0,
        created_at: new Date(Date.now() - ageMs),
      })
      .returning();
    await dbAdmin.insert(pipelineStages).values(
      STAGES.map(([name, prob, type], i) => ({
        tenant_id: tenantId,
        pipeline_id: pl!.id,
        name,
        display_order: i,
        win_probability: prob,
        stage_type: type,
      })),
    );
    return pl!.id;
  }
  async function livePipelineIds(tenantId: string) {
    const rows = await dbAdmin
      .select({ id: pipelines.id })
      .from(pipelines)
      .where(and(eq(pipelines.tenant_id, tenantId), isNull(pipelines.deleted_at)));
    return rows.map((r) => r.id).sort();
  }
  async function liveStageCount(tenantId: string, pipelineId: string) {
    const rows = await dbAdmin
      .select({ id: pipelineStages.id })
      .from(pipelineStages)
      .where(
        and(
          eq(pipelineStages.tenant_id, tenantId),
          eq(pipelineStages.pipeline_id, pipelineId),
          isNull(pipelineStages.deleted_at),
        ),
      );
    return rows.length;
  }
  async function firstOpenStage(tenantId: string, pipelineId: string) {
    const [s] = await dbAdmin
      .select({ id: pipelineStages.id })
      .from(pipelineStages)
      .where(and(eq(pipelineStages.tenant_id, tenantId), eq(pipelineStages.pipeline_id, pipelineId)))
      .limit(1);
    return s!.id;
  }

  it('two live default "Sales" pipelines → the oldest survives, the extra and its stages are retired', async () => {
    const t = await mkTenant('pl-dupe');
    extraTenants.push(t);
    const older = await seededSales(t, 60_000);
    const newer = await seededSales(t, 0);
    expect(await livePipelineIds(t)).toEqual([older, newer].sort());

    const res = await pipelinesSvc.list(t);
    expect(res.data).toHaveLength(1);
    expect(res.data[0]!.id).toBe(older);
    expect(res.data[0]!.stages).toHaveLength(3);

    expect(await livePipelineIds(t)).toEqual([older]);
    expect(await liveStageCount(t, older)).toBe(3);
    expect(await liveStageCount(t, newer)).toBe(0);
    // Soft-deleted, not gone (history stays inspectable).
    const [gone] = await dbAdmin.select().from(pipelines).where(eq(pipelines.id, newer));
    expect(gone!.deleted_at).not.toBeNull();
    // Every read path agrees afterwards, and the heal is a no-op on a healthy tenant.
    expect((await pipelinesSvc.defaultPipeline(t)).id).toBe(older);
    expect((await pipelinesSvc.list(t)).data).toHaveLength(1);
  });

  it('the duplicate that already holds a deal is the one kept, even when it is the newer row', async () => {
    const t = await mkTenant('pl-dupe-deal');
    extraTenants.push(t);
    const older = await seededSales(t, 60_000);
    const newer = await seededSales(t, 0);
    const [deal] = await dbAdmin
      .insert(deals)
      .values({
        tenant_id: t,
        pipeline_id: newer,
        stage_id: await firstOpenStage(t, newer),
        title: 'Lives in the newer seed',
        owner_user_id: owner.userId,
        currency: 'INR',
      })
      .returning();

    const res = await pipelinesSvc.list(t);
    expect(res.data.map((p) => p.id)).toEqual([newer]);
    expect(await livePipelineIds(t)).toEqual([newer]);
    expect(await liveStageCount(t, older)).toBe(0);
    expect(await liveStageCount(t, newer)).toBe(3);
    const [still] = await dbAdmin.select().from(deals).where(eq(deals.id, deal!.id));
    expect(still!.deleted_at).toBeNull();
    expect(still!.pipeline_id).toBe(newer);
  });

  it('when both duplicates hold deals nothing is deleted; user-created pipelines are never touched', async () => {
    const t = await mkTenant('pl-dupe-both');
    extraTenants.push(t);
    const a = await seededSales(t, 60_000);
    const b = await seededSales(t, 0);
    for (const pl of [a, b]) {
      await dbAdmin.insert(deals).values({
        tenant_id: t,
        pipeline_id: pl,
        stage_id: await firstOpenStage(t, pl),
        title: `Deal in ${pl}`,
        owner_user_id: owner.userId,
        currency: 'INR',
      });
    }
    // A user-created pipeline that happens to be called "Sales" (is_default=false)
    // and a plainly named one.
    const [userSales] = await dbAdmin
      .insert(pipelines)
      .values({ tenant_id: t, name: 'Sales', is_default: false, display_order: 1 })
      .returning();
    const [enterprise] = await dbAdmin
      .insert(pipelines)
      .values({ tenant_id: t, name: 'Enterprise', is_default: false, display_order: 2 })
      .returning();

    const res = await pipelinesSvc.list(t);
    expect(res.data.map((p) => p.id).sort()).toEqual([a, b, userSales!.id, enterprise!.id].sort());
    expect(await livePipelineIds(t)).toEqual([a, b, userSales!.id, enterprise!.id].sort());
  });

  it('GET /crm/pipelines racing GET /crm/board on a tenant with lost reasons ends with exactly one default', async () => {
    // The trigger condition from the review: lost reasons already exist (so
    // neither seeder takes the lost-reasons lock) and no pipeline yet. The
    // board seed is unlocked, so the pair CAN double-seed; the next read
    // must leave one live default with its seven stages either way.
    for (let round = 0; round < 6; round++) {
      const t = await mkTenant(`pl-race${round}`);
      extraTenants.push(t);
      await dbAdmin.insert(lostReasons).values(
        ['Price', 'Competitor', 'No budget', 'No response', 'Bad timing', 'Not a fit'].map((label, i) => ({
          tenant_id: t,
          label,
          display_order: i,
          archived: false,
        })),
      );

      await Promise.all([pipelinesSvc.list(t), dealsSvc.board(t)]);

      const healed = await pipelinesSvc.list(t);
      expect(healed.data).toHaveLength(1);
      expect(healed.data[0]!.name).toBe('Sales');
      expect(healed.data[0]!.stages).toHaveLength(7);
      const live = await livePipelineIds(t);
      expect(live).toEqual([healed.data[0]!.id]);
      expect(await liveStageCount(t, live[0]!)).toBe(7);
      // The board now resolves the same pipeline the list shows.
      const board = await dealsSvc.board(t);
      expect(board.data.pipeline.id).toBe(live[0]);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// C8 — leave balance guard
// ═════════════════════════════════════════════════════════════════════════════

describe('C8 — formatLeaveDays', () => {
  it('whole numbers print without decimals, fractions with one', () => {
    expect(formatLeaveDays(3)).toBe('3');
    expect(formatLeaveDays(0)).toBe('0');
    expect(formatLeaveDays(1.0)).toBe('1');
    expect(formatLeaveDays(2.5)).toBe('2.5');
    expect(formatLeaveDays(0.5)).toBe('0.5');
    expect(formatLeaveDays(11.5000001)).toBe('11.5');
  });
});

describe('C8 — applyLeave blocks requests over the balance', () => {
  // 2027-03-01 is a Monday; the tenant has no holidays and no shift
  // templates, so day counting is plain Mon–Fri.
  const YEAR = 2027;
  const base = { reason: 'Round P balance fixture' };
  let firstRequestId: string;

  it('one day over the quota → 400 LEAVE_BALANCE_EXCEEDED with the remaining count, nothing written', async () => {
    const res = await applyExpectingError(emp, {
      ...base,
      leaveTypeId: clTypeId,
      startDate: '2027-03-01',
      endDate: '2027-03-04', // Mon–Thu = 4 days against a quota of 3
    });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    expect(res!.body.code).toBe('LEAVE_BALANCE_EXCEEDED');
    expect(res!.body.message).toBe('You have 3 day(s) of Casual Leave left for this year');

    const reqs = await dbAdmin
      .select()
      .from(leaveRequests)
      .where(and(eq(leaveRequests.tenant_id, T1), eq(leaveRequests.employee_id, emp.employeeId)));
    expect(reqs).toHaveLength(0);
    expect(await ledgerFor(emp, clTypeId, YEAR)).toBeNull();
  });

  it('exactly the balance → accepted, and the ledger now holds it as pending', async () => {
    const r = await leave.applyLeave(emp.userId, T1, {
      ...base,
      leaveTypeId: clTypeId,
      startDate: '2027-03-01',
      endDate: '2027-03-03', // Mon–Wed = 3 days
    });
    firstRequestId = r.id;
    expect(Number(r.totalDays)).toBe(3);
    expect(r.status).toBe('pending');
    const ledger = await ledgerFor(emp, clTypeId, YEAR);
    expect(ledger).not.toBeNull();
    expect(Number(ledger!.pending)).toBe(3);
    expect(Number(ledger!.available)).toBe(0);
  });

  it('pending requests reduce availability: one more day → 400 "0 day(s) left"', async () => {
    const res = await applyExpectingError(emp, {
      ...base,
      leaveTypeId: clTypeId,
      startDate: '2027-03-08',
      endDate: '2027-03-08',
    });
    expect(res!.status).toBe(400);
    expect(res!.body.code).toBe('LEAVE_BALANCE_EXCEEDED');
    expect(res!.body.message).toBe('You have 0 day(s) of Casual Leave left for this year');
  });

  it('cancelling releases the days; a half-day leaves a fractional remainder in the message', async () => {
    await leave.cancelLeave(firstRequestId, emp.userId, T1, { reason: 'plans changed' });
    expect(Number((await ledgerFor(emp, clTypeId, YEAR))!.available)).toBe(3);

    const two = await leave.applyLeave(emp.userId, T1, {
      ...base,
      leaveTypeId: clTypeId,
      startDate: '2027-03-08',
      endDate: '2027-03-09',
    });
    expect(Number(two.totalDays)).toBe(2);

    const half = await leave.applyLeave(emp.userId, T1, {
      ...base,
      leaveTypeId: clTypeId,
      startDate: '2027-03-10',
      endDate: '2027-03-10',
      isHalfDay: true,
      halfDaySession: 'first_half',
    });
    expect(Number(half.totalDays)).toBe(0.5);
    expect(Number((await ledgerFor(emp, clTypeId, YEAR))!.available)).toBe(0.5);

    const res = await applyExpectingError(emp, {
      ...base,
      leaveTypeId: clTypeId,
      startDate: '2027-03-11',
      endDate: '2027-03-11',
    });
    expect(res!.status).toBe(400);
    expect(res!.body.code).toBe('LEAVE_BALANCE_EXCEEDED');
    expect(res!.body.message).toBe('You have 0.5 day(s) of Casual Leave left for this year');

    // Another half day still fits exactly.
    const lastHalf = await leave.applyLeave(emp.userId, T1, {
      ...base,
      leaveTypeId: clTypeId,
      startDate: '2027-03-11',
      endDate: '2027-03-11',
      isHalfDay: true,
      halfDaySession: 'second_half',
    });
    expect(Number(lastHalf.totalDays)).toBe(0.5);
    expect(Number((await ledgerFor(emp, clTypeId, YEAR))!.available)).toBe(0);
  });

  it('unpaid types (is_paid=false / is_lop) are exempt — Loss of Pay for a week goes through', async () => {
    const r = await leave.applyLeave(emp.userId, T1, {
      ...base,
      leaveTypeId: lopTypeId,
      startDate: '2027-03-15',
      endDate: '2027-03-19',
    });
    expect(Number(r.totalDays)).toBe(5);
    expect(r.status).toBe('pending');
  });

  it('an untracked paid type (quota 0, nothing credited) is exempt — Work From Home is never a dead end', async () => {
    const r = await leave.applyLeave(emp.userId, T1, {
      ...base,
      leaveTypeId: wfhTypeId,
      startDate: '2027-03-22',
      endDate: '2027-03-22',
    });
    expect(Number(r.totalDays)).toBe(1);
  });

  it('once HR credits days on a quota-0 type, the credited balance is enforced', async () => {
    await dbAdmin.insert(leaveBalances).values({
      tenant_id: T1,
      employee_id: emp.employeeId,
      leave_type_id: compTypeId,
      leave_year: YEAR,
      opening_balance: 1,
    });
    const over = await applyExpectingError(emp, {
      ...base,
      leaveTypeId: compTypeId,
      startDate: '2027-03-23',
      endDate: '2027-03-24',
    });
    expect(over!.status).toBe(400);
    expect(over!.body.message).toBe('You have 1 day(s) of Compensatory Off left for this year');

    const ok = await leave.applyLeave(emp.userId, T1, {
      ...base,
      leaveTypeId: compTypeId,
      startDate: '2027-03-23',
      endDate: '2027-03-23',
    });
    expect(Number(ok.totalDays)).toBe(1);
  });

  it('two simultaneous applies that together exceed the balance → exactly one is accepted', async () => {
    // Different, non-overlapping weeks so the overlap guard cannot catch it;
    // 2 + 2 days against a quota of 3. The per-employee advisory lock
    // serialises the transactions so the second one reads the first's pending.
    const racer = await mkPerson(T1, 'Racer', 'employee', owner.employeeId);
    const dto = (startDate: string, endDate: string) => ({ ...base, leaveTypeId: clTypeId, startDate, endDate });
    const results = await Promise.allSettled([
      leave.applyLeave(racer.userId, T1, dto('2028-03-06', '2028-03-07')), // Mon–Tue
      leave.applyLeave(racer.userId, T1, dto('2028-03-13', '2028-03-14')), // Mon–Tue
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    const err = failed[0]!.reason as HttpException;
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(400);
    expect((err.getResponse() as { code?: string; message?: string }).code).toBe('LEAVE_BALANCE_EXCEEDED');
    expect((err.getResponse() as { message?: string }).message).toBe(
      'You have 1 day(s) of Casual Leave left for this year',
    );

    const ledger = await ledgerFor(racer, clTypeId, 2028);
    expect(Number(ledger!.pending)).toBe(2);
    expect(Number(ledger!.available)).toBe(1);
    const reqs = await dbAdmin
      .select()
      .from(leaveRequests)
      .where(and(eq(leaveRequests.tenant_id, T1), eq(leaveRequests.employee_id, racer.employeeId)));
    expect(reqs).toHaveLength(1);
  });

  it('the owner is subject to the same rule (no privileged bypass)', async () => {
    const res = await applyExpectingError(owner, {
      ...base,
      leaveTypeId: clTypeId,
      startDate: '2027-03-01',
      endDate: '2027-03-05', // 5 days against 3
    });
    expect(res!.status).toBe(400);
    expect(res!.body.code).toBe('LEAVE_BALANCE_EXCEEDED');
    expect(res!.body.message).toBe('You have 3 day(s) of Casual Leave left for this year');
  });

  it('getMyBalances keeps its shape — remaining per type is still `available`', async () => {
    const { leaveYear, balances } = await leave.getMyBalances(emp.userId, T1);
    expect(leaveYear).toBe(new Date().getFullYear());
    const cl = balances.find((b) => b.leaveTypeId === clTypeId)!;
    expect(cl).toBeDefined();
    expect(Object.keys(cl).sort()).toEqual(
      ['accrued', 'available', 'code', 'color', 'leaveTypeId', 'leaveTypeName', 'opening', 'pending', 'used'].sort(),
    );
    // No ledger row for the CURRENT year → synthesised from the quota.
    expect(cl.available).toBe(3);
    expect(cl.leaveTypeName).toBe('Casual Leave');
  });
});
