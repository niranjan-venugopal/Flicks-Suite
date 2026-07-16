import 'dotenv/config';
import * as crypto from 'crypto';
import { eq } from 'drizzle-orm';
import { db, dbAdmin } from '@flicks/db';
import {
  tenants,
  users,
  memberships,
  employees,
  leaveTypes,
  leaveRequests,
} from '@flicks/db/schema';
import { DatabaseService } from '../core/database/database.service';
import { AuditService } from '../modules/audit/audit.service';
import { LeaveService } from '../modules/leave/leave.service';

/**
 * Launch-readiness (real-time notifications): leave submit/review must now
 * raise an in-app notification, not just an email — the approver gets a
 * `leave.requested` ping on submit and the requester gets `leave.approved` /
 * `leave.rejected` on the decision. This closes the coverage hole that left the
 * bell's leave.* branch dead. We stub NotificationsService and assert the
 * service calls createInAppNotification with the right (userId, type); the row
 * write + preference gating are NotificationsService's own concern (covered
 * elsewhere).
 */

const rid = () => crypto.randomBytes(4).toString('hex');
const dbSvc = new DatabaseService();
const audit = new AuditService(db as never, dbAdmin as never, dbSvc);

const inApp = jest.fn(async (..._args: unknown[]): Promise<void> => undefined);
const notificationsStub = {
  sendEmail: jest.fn(async () => true),
  createInAppNotification: inApp,
} as never;
const service = new LeaveService(dbSvc, audit, notificationsStub);

let tenantId: string;
let managerUserId: string;
let managerEmployeeId: string;
let reportUserId: string;
let reportEmployeeId: string;
let leaveTypeId: string;

async function seedPerson(opts: { managerId?: string; role: 'owner' | 'employee' }) {
  const email = `${rid()}@lv.test`;
  const [u] = await dbAdmin
    .insert(users)
    .values({ email, full_name: 'Test Person', status: 'active' })
    .returning();
  const [e] = await dbAdmin
    .insert(employees)
    .values({
      tenant_id: tenantId,
      employee_code: `EMP-${rid().toUpperCase()}`,
      first_name: 'Test',
      last_name: 'Person',
      work_email: email,
      date_of_joining: '2026-01-01',
      user_id: u!.id,
      reporting_manager_id: opts.managerId ?? null,
    })
    .returning();
  await dbAdmin.insert(memberships).values({
    tenant_id: tenantId,
    user_id: u!.id,
    role: opts.role,
    status: 'active',
    employee_id: e!.id,
  });
  return { userId: u!.id, employeeId: e!.id };
}

/** Poll a predicate until it's true or the timeout elapses. */
async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function seedPendingRequest(startDate: string, endDate: string) {
  const [r] = await dbAdmin
    .insert(leaveRequests)
    .values({
      tenant_id: tenantId,
      employee_id: reportEmployeeId,
      leave_type_id: leaveTypeId,
      start_date: startDate,
      end_date: endDate,
      total_days: 1,
      reason: 'Regression fixture',
      status: 'pending',
    })
    .returning();
  return r!.id;
}

beforeAll(async () => {
  const [t] = await dbAdmin
    .insert(tenants)
    .values({
      name: `Lv${rid()}`,
      slug: `lv-${rid()}-${Date.now()}`,
      status: 'active',
      currency: 'INR',
    })
    .returning();
  tenantId = t!.id;

  const manager = await seedPerson({ role: 'owner' });
  managerUserId = manager.userId;
  managerEmployeeId = manager.employeeId;

  const report = await seedPerson({ managerId: managerEmployeeId, role: 'employee' });
  reportUserId = report.userId;
  reportEmployeeId = report.employeeId;

  const [lt] = await dbAdmin
    .insert(leaveTypes)
    .values({
      tenant_id: tenantId,
      name: 'Casual Leave',
      code: 'CL',
      default_quota_days: 12,
      is_active: true,
    })
    .returning();
  leaveTypeId = lt!.id;
});

afterAll(async () => {
  await dbAdmin.delete(tenants).where(eq(tenants.id, tenantId));
  await dbAdmin.delete(users).where(eq(users.id, managerUserId));
  await dbAdmin.delete(users).where(eq(users.id, reportUserId));
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
});

beforeEach(() => inApp.mockClear());

describe('Leave in-app notifications (launch-readiness)', () => {
  it('pings the approver with leave.requested on submit', async () => {
    await service.applyLeave(reportUserId, tenantId, {
      leaveTypeId,
      startDate: '2026-09-07',
      endDate: '2026-09-09',
      reason: 'Regression apply notification',
    });
    // notifyOnApply is fire-and-forget — poll for the async in-app call.
    await waitFor(() =>
      inApp.mock.calls.some(
        (c) => c[0] === managerUserId && c[1] === 'leave.requested',
      ),
    );
    const call = inApp.mock.calls.find((c) => c[1] === 'leave.requested')!;
    expect(call[0]).toBe(managerUserId);
    expect(call[3]).toBe('/team/leave'); // approver link
    expect(call[4]).toBe(tenantId);
  });

  it('notifies the requester with leave.approved on approval', async () => {
    const reqId = await seedPendingRequest('2026-09-16', '2026-09-16');
    await service.reviewLeave(reqId, managerUserId, tenantId, { action: 'approve' });
    expect(inApp).toHaveBeenCalledWith(
      reportUserId,
      'leave.approved',
      expect.any(String),
      '/leave',
      tenantId,
    );
  });

  it('notifies the requester with leave.rejected on rejection', async () => {
    const reqId = await seedPendingRequest('2026-09-23', '2026-09-23');
    await service.reviewLeave(reqId, managerUserId, tenantId, {
      action: 'reject',
      comment: 'Coverage gap',
    });
    expect(inApp).toHaveBeenCalledWith(
      reportUserId,
      'leave.rejected',
      expect.any(String),
      '/leave',
      tenantId,
    );
  });
});
