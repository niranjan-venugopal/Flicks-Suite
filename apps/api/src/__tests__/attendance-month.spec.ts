/**
 * Unified month view (calendar redesign) — GET /attendance/me/month.
 * One entry per calendar day (backfilled), real punch UUIDs in the payload,
 * the employee's own regularization status surfaced (pending + rejected),
 * holiday/weekend flags, and the DTO month-format guard.
 */
import 'dotenv/config';
import * as crypto from 'crypto';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { db, dbAdmin } from '@flicks/db';
import {
  attendanceRegularizations,
  holidays,
  memberships,
  tenants,
  users,
} from '@flicks/db/schema';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../core/database/database.service';
import { AuditService } from '../modules/audit/audit.service';
import { AttendanceService } from '../modules/attendance/attendance.service';
import { AttendanceMonthQueryDto } from '../modules/attendance/attendance.dto';

const rid = () => crypto.randomBytes(4).toString('hex');
const dbSvc = new DatabaseService();
const audit = new AuditService(db as never, dbAdmin as never, dbSvc);
const notificationsStub = { sendEmail: async () => true, notify: async () => undefined } as never;
const service = new AttendanceService(dbSvc, dbAdmin as never, audit, notificationsStub);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let tenantId: string;
let userId: string;
let employeeId: string;

const now = new Date();
const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
const dateOf = (day: number) => `${month}-${String(day).padStart(2, '0')}`;

beforeAll(async () => {
  const [t] = await dbAdmin
    .insert(tenants)
    .values({ name: `Month${rid()}`, slug: `month-${rid()}-${Date.now()}`, status: 'active', currency: 'INR' })
    .returning();
  tenantId = t!.id;
  const [u] = await dbAdmin
    .insert(users)
    .values({ email: `month-${rid()}@cal.test`, full_name: 'Cal Month', status: 'active' })
    .returning();
  userId = u!.id;
  await dbAdmin.insert(memberships).values({ tenant_id: tenantId, user_id: userId, role: 'owner', status: 'active' });

  // Self-heal mints the employee bridge + the default Mon–Fri shift.
  // (No punch-out: an instant out would compute 0 worked minutes → absent.)
  await service.punchIn(userId, tenantId, {});
  const [m] = await dbAdmin
    .select({ employee_id: memberships.employee_id })
    .from(memberships)
    .where(eq(memberships.user_id, userId));
  employeeId = m!.employee_id!;
});

afterAll(async () => {
  await dbAdmin.delete(tenants).where(eq(tenants.id, tenantId));
  await dbAdmin.delete(users).where(eq(users.id, userId));
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.().catch(() => {});
});

describe('getMyMonth — unified month payload', () => {
  it('returns one entry per calendar day, backfilled, with real punch UUIDs on the worked day', async () => {
    const res = await service.getMyMonth(userId, tenantId, month);
    expect(res.month).toBe(month);
    expect(res.days).toHaveLength(daysInMonth);
    // Backfill: every date present exactly once, in order.
    expect(res.days.map((d) => d.date)).toEqual(
      Array.from({ length: daysInMonth }, (_, i) => dateOf(i + 1)),
    );

    const worked = res.days.filter((d) => d.punches.length > 0);
    expect(worked.length).toBeGreaterThanOrEqual(1);
    const today = worked[worked.length - 1]!;
    expect(today.firstPunchInAt).not.toBeNull();
    expect(['present', 'late', 'half_day']).toContain(today.attendanceStatus);
    for (const p of today.punches) {
      expect(p.id).toMatch(UUID_RE);
      expect(['in', 'out', 'break_start', 'break_end']).toContain(p.punchType);
    }
    // Empty days carry the null/zero shape, not missing keys.
    const empty = res.days.find((d) => d.punches.length === 0)!;
    expect(empty.attendanceStatus).toBeNull();
    expect(empty.totalWorkedMinutes).toBe(0);
    expect(empty.regularization).toBeNull();
  });

  it('surfaces my own regularization status (pending + rejected), latest per date winning', async () => {
    const pendingDate = dateOf(1);
    const rejectedDate = dateOf(2);
    await dbAdmin.insert(attendanceRegularizations).values([
      {
        tenant_id: tenantId,
        employee_id: employeeId,
        attendance_date: pendingDate,
        request_type: 'missing_punch',
        status: 'pending',
        reason: 'Forgot to clock in on the first.',
        created_at: new Date('2026-01-01T10:00:00Z'),
      },
      // Two on the same date — the LATER one (rejected) must win.
      {
        tenant_id: tenantId,
        employee_id: employeeId,
        attendance_date: rejectedDate,
        request_type: 'wrong_time',
        status: 'cancelled',
        reason: 'First attempt, later cancelled.',
        created_at: new Date('2026-01-02T09:00:00Z'),
      },
      {
        tenant_id: tenantId,
        employee_id: employeeId,
        attendance_date: rejectedDate,
        request_type: 'wrong_time',
        status: 'rejected',
        reason: 'Second attempt, rejected by manager.',
        created_at: new Date('2026-01-02T11:00:00Z'),
      },
    ]);

    const res = await service.getMyMonth(userId, tenantId, month);
    const d1 = res.days.find((d) => d.date === pendingDate)!;
    expect(d1.regularization).toMatchObject({ status: 'pending', requestType: 'missing_punch' });
    expect(d1.regularization!.id).toMatch(UUID_RE);
    const d2 = res.days.find((d) => d.date === rejectedDate)!;
    expect(d2.regularization).toMatchObject({ status: 'rejected', requestType: 'wrong_time' });
  });

  it('flags holidays (with name) and weekends from the shift template', async () => {
    const holidayDate = dateOf(15);
    await dbAdmin.insert(holidays).values({
      tenant_id: tenantId,
      name: 'Founders Day',
      holiday_date: holidayDate,
      type: 'company',
    });
    const res = await service.getMyMonth(userId, tenantId, month);
    const h = res.days.find((d) => d.date === holidayDate)!;
    expect(h.isHoliday).toBe(true);
    expect(h.holidayName).toBe('Founders Day');

    // Default self-healed shift is Mon–Fri → every Sunday/Saturday flagged.
    for (const d of res.days) {
      const dow = new Date(`${d.date}T00:00:00`).getDay();
      expect(d.isWeekend).toBe(dow === 0 || dow === 6);
    }
  });
});

describe('AttendanceMonthQueryDto', () => {
  it('accepts YYYY-MM and rejects malformed months', async () => {
    const ok = plainToInstance(AttendanceMonthQueryDto, { month: '2026-07' });
    expect(await validate(ok)).toHaveLength(0);
    for (const bad of ['2026-13', '2026-00', '26-07', '2026/07', '2026-7']) {
      const dto = plainToInstance(AttendanceMonthQueryDto, { month: bad });
      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
    }
  });
});
