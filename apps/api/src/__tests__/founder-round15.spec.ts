import 'dotenv/config';
import * as crypto from 'crypto';
import { eq } from 'drizzle-orm';
import { db, dbAdmin } from '@flicks/db';
import {
  attendanceRecords,
  employees,
  memberships,
  tenants,
  users,
} from '@flicks/db/schema';
import { DatabaseService } from '../core/database/database.service';
import { AuditService } from '../modules/audit/audit.service';
import { AttendanceService } from '../modules/attendance/attendance.service';

/**
 * Founder round 15 — the employee-360° Attendance tab shows the employee's
 * REAL history via GET /attendance/employee/:id. Access: the employee
 * themselves, their reporting manager, and owner/admin/finance — nobody else.
 * Reads must never mint employee records (no self-heal on this path).
 */

const rid = () => crypto.randomBytes(4).toString('hex');
const dbSvc = new DatabaseService();
const audit = new AuditService(db as never, dbAdmin as never, dbSvc);
const notificationsStub = {
  sendEmail: async () => true,
  notify: async () => undefined,
  createInAppNotification: jest.fn(async () => undefined),
} as never;
const attendance = new AttendanceService(dbSvc, dbAdmin as never, audit, notificationsStub);

let tenantId: string;
const userIds: string[] = [];

interface Person {
  userId: string;
  employeeId: string;
}
let owner: Person;
let manager: Person;
let priya: Person; // manager's direct report
let mallory: Person; // unrelated employee

async function mkPerson(opts: {
  role: 'owner' | 'manager' | 'employee';
  reportingManagerId?: string | null;
}): Promise<Person> {
  const email = `r15-${opts.role}-${rid()}@t.test`;
  const [u] = await dbAdmin
    .insert(users)
    .values({ email, full_name: `R15 ${opts.role}`, status: 'active' })
    .returning();
  const [emp] = await dbAdmin
    .insert(employees)
    .values({
      tenant_id: tenantId,
      employee_code: `E15-${rid().toUpperCase()}`,
      first_name: 'R15',
      last_name: opts.role,
      work_email: email,
      date_of_joining: '2026-01-01',
      reporting_manager_id: opts.reportingManagerId ?? null,
      status: 'active',
    })
    .returning();
  await dbAdmin.insert(memberships).values({
    tenant_id: tenantId,
    user_id: u!.id,
    employee_id: emp!.id,
    role: opts.role,
    status: 'active',
  });
  userIds.push(u!.id);
  return { userId: u!.id, employeeId: emp!.id };
}

beforeAll(async () => {
  const [t] = await dbAdmin
    .insert(tenants)
    .values({ name: `R15 ${rid()}`, slug: `r15-${rid()}-${Date.now()}`, status: 'active', currency: 'INR' })
    .returning();
  tenantId = t!.id;
  owner = await mkPerson({ role: 'owner' });
  manager = await mkPerson({ role: 'manager' });
  priya = await mkPerson({ role: 'employee', reportingManagerId: manager.employeeId });
  mallory = await mkPerson({ role: 'employee' });

  // Two history days for Priya: an office day and a WFH day.
  await dbAdmin.insert(attendanceRecords).values([
    {
      tenant_id: tenantId,
      employee_id: priya.employeeId,
      attendance_date: '2026-08-24',
      attendance_status: 'present',
      work_mode: 'office',
      total_worked_minutes: 480,
    },
    {
      tenant_id: tenantId,
      employee_id: priya.employeeId,
      attendance_date: '2026-08-25',
      attendance_status: 'late',
      work_mode: 'remote',
      is_late: true,
      late_by_minutes: 22,
      total_worked_minutes: 450,
    },
  ]);
});

afterAll(async () => {
  await dbAdmin.delete(tenants).where(eq(tenants.id, tenantId));
  for (const id of userIds) await dbAdmin.delete(users).where(eq(users.id, id));
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
});

describe('Employee-360 attendance history — access + shape', () => {
  it('owner reads any employee: newest first, work_mode included', async () => {
    const res = await attendance.listForEmployee(owner.userId, 'owner', priya.employeeId, tenantId, {});
    expect(res.data).toHaveLength(2);
    expect(res.data[0]!.attendanceDate).toBe('2026-08-25');
    expect(res.data[0]!.workMode).toBe('remote');
    expect(res.data[0]!.isLate).toBe(true);
    expect(res.data[1]!.workMode).toBe('office');
  });

  it('the employee reads their own history', async () => {
    const res = await attendance.listForEmployee(priya.userId, 'employee', priya.employeeId, tenantId, {});
    expect(res.data).toHaveLength(2);
  });

  it('the reporting manager reads a direct report', async () => {
    const res = await attendance.listForEmployee(manager.userId, 'manager', priya.employeeId, tenantId, {});
    expect(res.data).toHaveLength(2);
  });

  it("an unrelated employee is refused a colleague's history", async () => {
    await expect(
      attendance.listForEmployee(mallory.userId, 'employee', priya.employeeId, tenantId, {}),
    ).rejects.toThrow(/visible to the employee/);
  });

  it("a manager is refused a NON-report's history", async () => {
    await expect(
      attendance.listForEmployee(manager.userId, 'manager', mallory.employeeId, tenantId, {}),
    ).rejects.toThrow(/visible to the employee/);
  });

  it('unknown employee → not found; date filters narrow the range', async () => {
    await expect(
      attendance.listForEmployee(owner.userId, 'owner', crypto.randomUUID(), tenantId, {}),
    ).rejects.toThrow(/not found/i);

    const res = await attendance.listForEmployee(owner.userId, 'owner', priya.employeeId, tenantId, {
      fromDate: '2026-08-25',
      toDate: '2026-08-25',
    } as never);
    expect(res.data).toHaveLength(1);
    expect(res.data[0]!.attendanceDate).toBe('2026-08-25');
  });
});
