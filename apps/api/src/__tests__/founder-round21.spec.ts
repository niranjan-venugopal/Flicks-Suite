/**
 * Founder round 21 — removing an employee.
 *
 * "We had an option to delete the employee right? Why it is not showing?"
 * There never was one: 22 routes on the employees controller and not a single
 * delete. What DID exist, with no button anywhere, was `terminate` — the exit
 * flow that moves someone to notice period.
 *
 * The founder asked to be able to delete ANY employee. That is honoured, but
 * not as a raw DELETE: FOURTEEN tables cascade off employees.id, so deleting
 * someone who has worked here destroys their attendance, punches, leave,
 * timesheets and employment history — the PF/ESI and wage-register substrate.
 * So the rule, the same one already shipped for invoicing clients:
 *
 *   no history at all -> a real DELETE (added by mistake, nothing to lose)
 *   any history       -> deleted_at stamped; they leave every directory and
 *                        the statutory rows survive; restorable
 *
 * Either way the workspace seat is revoked — "removed" that leaves someone
 * able to sign in is not removed.
 *
 * Service-level against the real Postgres, mirroring founder-round18.spec.
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
  attendanceRecords,
  employmentHistory,
} from '@flicks/db/schema';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DatabaseService } from '../core/database/database.service';
import { EmployeesService } from '../modules/employees/employees.service';
import { DashboardService } from '../modules/dashboard/dashboard.service';
import type { AuditService } from '../modules/audit/audit.service';
import type { NotificationsService } from '../modules/notifications/notifications.service';
import type { AuthService } from '../modules/auth/auth.service';
import type { MediaService } from '../modules/media/media.service';

const rid = () => crypto.randomBytes(4).toString('hex');
const audit = { log: async () => undefined } as unknown as AuditService;
const notifications = {
  createInAppNotification: async () => undefined,
  sendEmail: async () => true,
} as unknown as NotificationsService;
const emitter = new EventEmitter2();
const dbSvc = new DatabaseService();
const mediaStub = {
  servedUrl: async (k: string | null, l: string | null) => (k ? `signed:${k}` : l),
} as unknown as MediaService;

const employeesService = new EmployeesService(
  dbSvc,
  dbAdmin as never,
  audit,
  notifications,
  emitter,
  new ConfigService({ NODE_ENV: 'test' }),
  {} as unknown as AuthService,
  mediaStub,
);
const dashboardService = new DashboardService(dbSvc, mediaStub);

let tenantId: string;
let ownerUserId: string;
let adminUserId: string;
const trackedUsers: string[] = [];

/** An employee row, optionally with a membership seat at `role`. */
async function seedEmployee(
  label: string,
  opts: { role?: string; withUser?: boolean } = {},
) {
  const email = `r21-${label}-${rid()}@t.test`;
  let userId: string | null = null;
  if (opts.withUser !== false) {
    const [u] = await dbAdmin
      .insert(users)
      .values({ email, full_name: `R21 ${label}`, status: 'active' })
      .returning();
    userId = u!.id;
    trackedUsers.push(u!.id);
  }
  const [emp] = await dbAdmin
    .insert(employees)
    .values({
      tenant_id: tenantId,
      employee_code: `E-${rid()}`,
      first_name: label,
      last_name: 'Seed',
      work_email: email,
      date_of_joining: '2025-01-01',
      status: 'active',
      user_id: userId,
    })
    .returning();
  let membershipId: string | null = null;
  if (opts.role && userId) {
    const [m] = await dbAdmin
      .insert(memberships)
      .values({
        tenant_id: tenantId,
        user_id: userId,
        role: opts.role as never,
        status: 'active',
        employee_id: emp!.id,
      })
      .returning();
    membershipId = m!.id;
  }
  return { id: emp!.id, userId, membershipId, email };
}

/** Give someone a working record so they can't be hard-deleted. */
async function giveHistory(employeeId: string) {
  await dbAdmin.insert(attendanceRecords).values({
    tenant_id: tenantId,
    employee_id: employeeId,
    attendance_date: '2026-01-05',
    attendance_status: 'present',
  });
}

beforeAll(async () => {
  const [t] = await dbAdmin
    .insert(tenants)
    .values({ name: `R21 ${rid()}`, slug: `r21-${rid()}-${Date.now()}`, status: 'active' })
    .returning();
  tenantId = t!.id;

  const owner = await seedEmployee('owner', { role: 'owner' });
  ownerUserId = owner.userId!;
  // A SECOND owner, so removing the first is never blocked by the last-owner
  // guard in the cases that aren't about that guard.
  await seedEmployee('owner2', { role: 'owner' });
  const admin = await seedEmployee('admin', { role: 'admin' });
  adminUserId = admin.userId!;
});

afterAll(async () => {
  await dbAdmin.delete(tenants).where(eq(tenants.id, tenantId));
  for (const id of trackedUsers) await dbAdmin.delete(users).where(eq(users.id, id));
});

describe('Founder round 21 — delete vs archive', () => {
  it('an employee with no history is deleted outright', async () => {
    const emp = await seedEmployee('mistake');
    const preview = await employeesService.previewRemoval(emp.id, tenantId);
    expect(preview.data.mode).toBe('delete');
    expect(preview.data.total).toBe(0);

    const res = await employeesService.removeEmployee(emp.id, tenantId, ownerUserId);
    expect(res.data.mode).toBe('delete');
    const rows = await dbAdmin.select().from(employees).where(eq(employees.id, emp.id));
    expect(rows).toHaveLength(0);
  });

  it('an employee WITH history is archived, and their records survive', async () => {
    const emp = await seedEmployee('worked');
    await giveHistory(emp.id);
    const preview = await employeesService.previewRemoval(emp.id, tenantId);
    expect(preview.data.mode).toBe('archive');
    expect(preview.data.attendance).toBe(1);

    const res = await employeesService.removeEmployee(emp.id, tenantId, ownerUserId);
    expect(res.data.mode).toBe('archive');

    const [row] = await dbAdmin.select().from(employees).where(eq(employees.id, emp.id));
    expect(row).toBeDefined();
    expect(row!.deleted_at).not.toBeNull();
    // The whole point: the statutory rows are still there.
    const att = await dbAdmin
      .select()
      .from(attendanceRecords)
      .where(eq(attendanceRecords.employee_id, emp.id));
    expect(att).toHaveLength(1);
  });

  it('a removed employee leaves the directory, the org chart and the headcount', async () => {
    const emp = await seedEmployee('gone');
    await giveHistory(emp.id);

    const before = await employeesService.listEmployees(tenantId, {} as never);
    expect(before.data.some((e) => e.id === emp.id)).toBe(true);

    await employeesService.removeEmployee(emp.id, tenantId, ownerUserId);

    const after = await employeesService.listEmployees(tenantId, {} as never);
    expect(after.data.some((e) => e.id === emp.id)).toBe(false);

    const chart = await employeesService.getOrgChart(tenantId);
    const flat = JSON.stringify(chart);
    expect(flat).not.toContain(emp.id);

    const overview = await dashboardService.getAdminOverview(tenantId, {
      callerUserId: ownerUserId,
      includeOnboarding: true,
      includeApprovals: true,
    });
    const headcount = JSON.stringify(overview.headcount ?? {});
    expect(headcount).not.toContain(emp.id);
  });

  it('the Removed filter shows exactly the archived ones, and restore brings them back', async () => {
    const emp = await seedEmployee('restoreme');
    await giveHistory(emp.id);
    await employeesService.removeEmployee(emp.id, tenantId, ownerUserId);

    const removed = await employeesService.listEmployees(tenantId, { removed: true } as never);
    expect(removed.data.some((e) => e.id === emp.id)).toBe(true);
    const live = await employeesService.listEmployees(tenantId, {} as never);
    expect(live.data.some((e) => e.id === emp.id)).toBe(false);

    await employeesService.restoreEmployee(emp.id, tenantId, ownerUserId);
    const back = await employeesService.listEmployees(tenantId, {} as never);
    expect(back.data.some((e) => e.id === emp.id)).toBe(true);
    const stillRemoved = await employeesService.listEmployees(tenantId, { removed: true } as never);
    expect(stillRemoved.data.some((e) => e.id === emp.id)).toBe(false);
  });

  it('removing the same employee twice is refused, not silently repeated', async () => {
    const emp = await seedEmployee('twice');
    await giveHistory(emp.id);
    await employeesService.removeEmployee(emp.id, tenantId, ownerUserId);
    await expect(
      employeesService.removeEmployee(emp.id, tenantId, ownerUserId),
    ).rejects.toThrow(/already been removed/i);
  });
});

describe('Founder round 21 — the seat goes with the person', () => {
  it('removing an employee revokes their workspace membership', async () => {
    const emp = await seedEmployee('seated', { role: 'employee' });
    await giveHistory(emp.id);
    await employeesService.removeEmployee(emp.id, tenantId, ownerUserId);

    const [seat] = await dbAdmin
      .select()
      .from(memberships)
      .where(eq(memberships.id, emp.membershipId!));
    expect(seat!.status).toBe('deactivated');
    expect(seat!.employee_id).toBeNull();
  });

  it('restore does NOT hand the login back — re-inviting is a deliberate act', async () => {
    const emp = await seedEmployee('seated2', { role: 'employee' });
    await giveHistory(emp.id);
    await employeesService.removeEmployee(emp.id, tenantId, ownerUserId);
    await employeesService.restoreEmployee(emp.id, tenantId, ownerUserId);

    const [seat] = await dbAdmin
      .select()
      .from(memberships)
      .where(eq(memberships.id, emp.membershipId!));
    expect(seat!.status).toBe('deactivated');
  });
});

describe('Founder round 21 — who may remove whom', () => {
  it('an admin cannot remove an owner or another HR admin', async () => {
    const targetAdmin = await seedEmployee('victim-admin', { role: 'admin' });
    await expect(
      employeesService.removeEmployee(targetAdmin.id, tenantId, adminUserId),
    ).rejects.toThrow(/Only an owner can remove an owner or HR admin/i);

    const targetOwner = await seedEmployee('victim-owner', { role: 'owner' });
    await expect(
      employeesService.removeEmployee(targetOwner.id, tenantId, adminUserId),
    ).rejects.toThrow(/Only an owner can remove an owner or HR admin/i);
  });

  it('an owner can remove an HR admin', async () => {
    const target = await seedEmployee('ok-admin', { role: 'admin' });
    const res = await employeesService.removeEmployee(target.id, tenantId, ownerUserId);
    expect(res.data.mode).toBe('delete');
  });

  it('an admin CAN remove an ordinary employee', async () => {
    const target = await seedEmployee('ordinary', { role: 'employee' });
    const res = await employeesService.removeEmployee(target.id, tenantId, adminUserId);
    expect(res.data.mode).toBe('delete');
  });

  it('you cannot remove your own record', async () => {
    const [selfEmp] = await dbAdmin
      .select()
      .from(employees)
      .where(and(eq(employees.tenant_id, tenantId), eq(employees.user_id, adminUserId)));
    await expect(
      employeesService.removeEmployee(selfEmp!.id, tenantId, adminUserId),
    ).rejects.toThrow(/your own employee record/i);
  });

  it('the last ACTIVE owner cannot be removed — the workspace would be stranded', async () => {
    // Reachable exactly when the caller is an owner whose own seat has not
    // been accepted yet ('invited'): they pass the owner-only rule, but the
    // target is the only owner who can actually administer the workspace, so
    // removing them would leave nobody. A workspace of its own so the owner
    // count is unambiguous.
    const [t2] = await dbAdmin
      .insert(tenants)
      .values({ name: `R21 solo ${rid()}`, slug: `r21s-${rid()}-${Date.now()}`, status: 'active' })
      .returning();
    const [soloUser] = await dbAdmin
      .insert(users)
      .values({ email: `r21-solo-${rid()}@t.test`, full_name: 'Solo', status: 'active' })
      .returning();
    const [pendingOwner] = await dbAdmin
      .insert(users)
      .values({ email: `r21-pending-${rid()}@t.test`, full_name: 'Pending', status: 'active' })
      .returning();
    const [emp] = await dbAdmin
      .insert(employees)
      .values({
        tenant_id: t2!.id, employee_code: `E-${rid()}`, first_name: 'Solo', last_name: 'Owner',
        work_email: `solo-${rid()}@t.test`, date_of_joining: '2025-01-01', status: 'active',
        user_id: soloUser!.id,
      })
      .returning();
    await dbAdmin.insert(memberships).values({
      tenant_id: t2!.id, user_id: soloUser!.id, role: 'owner', status: 'active', employee_id: emp!.id,
    });
    await dbAdmin.insert(memberships).values({
      tenant_id: t2!.id, user_id: pendingOwner!.id, role: 'owner', status: 'invited',
    });

    await expect(
      employeesService.removeEmployee(emp!.id, t2!.id, pendingOwner!.id),
    ).rejects.toThrow(/only owner/i);

    await dbAdmin.delete(tenants).where(eq(tenants.id, t2!.id));
    await dbAdmin.delete(users).where(eq(users.id, soloUser!.id));
    await dbAdmin.delete(users).where(eq(users.id, pendingOwner!.id));
  });
});

describe('Founder round 21 — no dead ends', () => {
  it('re-using a removed employee’s code explains itself instead of just saying "in use"', async () => {
    const emp = await seedEmployee('codeclash');
    await giveHistory(emp.id);
    const [row] = await dbAdmin.select().from(employees).where(eq(employees.id, emp.id));
    const code = row!.employee_code;
    await employeesService.removeEmployee(emp.id, tenantId, ownerUserId);

    await expect(
      employeesService.inviteEmployee(
        {
          employeeCode: code,
          fullName: 'New Hire',
          email: `newhire-${rid()}@t.test`,
        } as never,
        ownerUserId,
        tenantId,
      ),
    ).rejects.toThrow(/belongs to a removed employee/i);
  });

  it('the employment history of an archived employee is still readable', async () => {
    const emp = await seedEmployee('histkeeper');
    await giveHistory(emp.id);
    await dbAdmin.insert(employmentHistory).values({
      tenant_id: tenantId,
      employee_id: emp.id,
      change_type: 'promotion',
      effective_from: '2025-06-01',
      new_value: { note: 'promoted' },
    });
    await employeesService.removeEmployee(emp.id, tenantId, ownerUserId);
    const hist = await dbAdmin
      .select()
      .from(employmentHistory)
      .where(eq(employmentHistory.employee_id, emp.id));
    expect(hist.length).toBeGreaterThan(0);
  });
});
