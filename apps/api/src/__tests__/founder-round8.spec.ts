/**
 * Founder round 8 — approval integrity, avatar propagation and module access.
 *
 *  1. Nobody approves their own request. An OWNER clears the @Roles('manager')
 *     gate on the review routes, so leave AND attendance regularizations both
 *     needed an explicit self-guard; the queues and the dashboard buckets hide
 *     the caller's own row, and an applicant with no reporting manager (the
 *     owner case) now notifies the OTHER owners instead of nobody.
 *  2. Avatars: the upload path writes users.avatar_key only, so every read
 *     surface has to resolve it. Employee detail / team / org chart /
 *     onboarding queue / dashboard approvals previously read legacy columns
 *     that are never written → initials forever.
 *  3. Module access: an explicit membership_grants row now WINS over the role
 *     default (that is what makes revocation possible), with a workspace-level
 *     per-role policy in between. Full-access roles stay unrevokable, guests
 *     are rejected, and the per-module upsert never disturbs other modules.
 *
 * Service-level against the real Postgres, mirroring founder-round5.spec.ts.
 */
import 'dotenv/config';
import * as crypto from 'crypto';
import { and, eq } from 'drizzle-orm';
import { dbAdmin } from '@flicks/db';
import {
  tenants,
  users,
  memberships,
  employees,
  leaveTypes,
  leaveRequests,
  membershipGrants,
  tenantRoleModuleDefaults,
  attendanceRegularizations,
} from '@flicks/db/schema';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ForbiddenException, ConflictException } from '@nestjs/common';
import { DatabaseService } from '../core/database/database.service';
import { ModuleAccessService } from '../core/auth/module-access.service';
import { EmployeesService } from '../modules/employees/employees.service';
import { DashboardService } from '../modules/dashboard/dashboard.service';
import { LeaveService } from '../modules/leave/leave.service';
import { AttendanceService } from '../modules/attendance/attendance.service';
import { MembersService } from '../modules/members/members.service';
import type { AuditService } from '../modules/audit/audit.service';
import type { NotificationsService } from '../modules/notifications/notifications.service';
import type { AuthService } from '../modules/auth/auth.service';
import type { MediaService } from '../modules/media/media.service';

const rid = () => crypto.randomBytes(4).toString('hex');

/** Notifications are fire-and-forget by design (house rule 6) — poll. */
async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}
const audit = { log: async () => {} } as unknown as AuditService;

const createInAppNotification = jest.fn(async () => undefined);
const sendEmail = jest.fn(async () => true);
const notifications = {
  createInAppNotification,
  sendEmail,
} as unknown as NotificationsService;

// Echo the key so the specs can prove a surface went through the media
// pipeline instead of reading a legacy column.
const media = {
  servedUrl: async (k: string | null, l: string | null) => (k ? `signed:${k}` : l),
} as unknown as MediaService;

const dbSvc = new DatabaseService();
const moduleAccess = new ModuleAccessService(dbSvc);
const emitter = new EventEmitter2();

const employeesService = new EmployeesService(
  dbSvc,
  dbAdmin as never,
  audit,
  notifications,
  emitter,
  new ConfigService({ NODE_ENV: 'test' }),
  {} as unknown as AuthService,
  media,
);
const dashboardService = new DashboardService(dbSvc, media);
const leaveService = new LeaveService(dbSvc, audit, notifications);
const attendanceService = new AttendanceService(
  dbSvc,
  dbAdmin as never,
  audit,
  notifications,
);
const membersService = new MembersService(
  dbSvc,
  dbAdmin as never,
  audit,
  notifications,
  { issueInviteMagicLink: async () => 'https://app.test/verify?token=stub' } as unknown as AuthService,
  moduleAccess,
  { servedUrl: async (k: string | null, l: string | null) => (k ? `signed:${k}` : l) } as never,
);

let tenantId: string;
let ownerAUserId: string; // applies for leave
let ownerBUserId: string; // the other owner — the only valid reviewer
let managerUserId: string;
let managerMembershipId: string;
let ownerAMembershipId: string;
let ownerAEmpId: string;
let ownerBEmpId: string;
let managerEmpId: string;
let leaveTypeId: string;
let leaveRequestId: string;
let regularizationId: string;

const AVATAR_KEY = 'avatars/r8/photo_256.webp';

async function mkUser(email: string, fullName: string, avatarKey?: string) {
  const [u] = await dbAdmin
    .insert(users)
    .values({
      email,
      full_name: fullName,
      ...(avatarKey ? { avatar_key: avatarKey } : {}),
    })
    .returning();
  return u!.id;
}

async function mkMembership(userId: string, role: 'owner' | 'admin' | 'manager' | 'employee' | 'auditor' | 'guest', employeeId?: string) {
  const [m] = await dbAdmin
    .insert(memberships)
    .values({
      tenant_id: tenantId,
      user_id: userId,
      role,
      status: 'active',
      ...(employeeId ? { employee_id: employeeId } : {}),
    })
    .returning();
  return m!.id;
}

async function mkEmployee(
  userId: string,
  firstName: string,
  managerEmployeeId?: string,
) {
  const [e] = await dbAdmin
    .insert(employees)
    .values({
      tenant_id: tenantId,
      user_id: userId,
      employee_code: `R8-${rid()}`,
      first_name: firstName,
      last_name: 'Tester',
      work_email: `${firstName.toLowerCase()}-${rid()}@r8.test`,
      date_of_joining: '2026-01-01',
      status: 'active',
      ...(managerEmployeeId ? { reporting_manager_id: managerEmployeeId } : {}),
    })
    .returning();
  return e!.id;
}

beforeAll(async () => {
  const [t] = await dbAdmin
    .insert(tenants)
    .values({ name: `R8 ${rid()}`, slug: `r8-${rid()}` })
    .returning();
  tenantId = t!.id;

  ownerAUserId = await mkUser(`r8-owner-a-${rid()}@t.test`, 'Owner A', AVATAR_KEY);
  ownerBUserId = await mkUser(`r8-owner-b-${rid()}@t.test`, 'Owner B');
  managerUserId = await mkUser(`r8-mgr-${rid()}@t.test`, 'Mia Manager');

  ownerAEmpId = await mkEmployee(ownerAUserId, 'Ownera');
  ownerBEmpId = await mkEmployee(ownerBUserId, 'Ownerb');
  // The manager reports to owner B, so their own requests route normally.
  managerEmpId = await mkEmployee(managerUserId, 'Mia', ownerBEmpId);

  ownerAMembershipId = await mkMembership(ownerAUserId, 'owner', ownerAEmpId);
  await mkMembership(ownerBUserId, 'owner', ownerBEmpId);
  managerMembershipId = await mkMembership(managerUserId, 'manager', managerEmpId);

  const [lt] = await dbAdmin
    .insert(leaveTypes)
    .values({
      tenant_id: tenantId,
      name: 'Casual Leave',
      code: `CL${rid().slice(0, 3)}`,
      default_quota_days: 12,
      is_paid: true,
    })
    .returning();
  leaveTypeId = lt!.id;
});

afterAll(async () => {
  await dbAdmin.delete(tenants).where(eq(tenants.id, tenantId));
  for (const id of [ownerAUserId, ownerBUserId, managerUserId]) {
    if (id) await dbAdmin.delete(users).where(eq(users.id, id));
  }
});

// ─── 1. Nobody approves their own request ────────────────────────────────────

describe('leave: separation of duties', () => {
  it('an owner applying for leave notifies the OTHER owner, not nobody', async () => {
    createInAppNotification.mockClear();
    const res = await leaveService.applyLeave(ownerAUserId, tenantId, {
      leaveTypeId,
      startDate: '2026-09-14',
      endDate: '2026-09-15',
      reason: 'Family function',
    } as never);
    leaveRequestId = res.id;

    // Owner A has no reporting manager — before this round that meant NOBODY
    // was told while the request still sat in everyone's queue.
    await waitFor(() =>
      createInAppNotification.mock.calls.some(
        (c) => (c as unknown as string[])[0] === ownerBUserId,
      ),
    );
    const pinged = createInAppNotification.mock.calls.map(
      (c) => (c as unknown as string[])[0],
    );
    expect(pinged).toContain(ownerBUserId);
    expect(pinged).not.toContain(ownerAUserId);
  });

  it('the applicant cannot approve their own request', async () => {
    await expect(
      leaveService.reviewLeave(leaveRequestId, ownerAUserId, tenantId, {
        action: 'approve',
      } as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('the queue hides the applicant’s own row and shows it to the other owner', async () => {
    const mine = await leaveService.listPending(ownerAUserId, tenantId, {} as never);
    expect(mine.data.some((r) => r.id === leaveRequestId)).toBe(false);

    const theirs = await leaveService.listPending(ownerBUserId, tenantId, {} as never);
    expect(theirs.data.some((r) => r.id === leaveRequestId)).toBe(true);
  });

  it('the dashboard bucket and count exclude the caller’s own request', async () => {
    const forA = await dashboardService.getAdminOverview(tenantId, {
      callerUserId: ownerAUserId,
      includeOnboarding: true,
      includeApprovals: true,
    });
    expect(forA.pending.leaves.some((l) => l.id === leaveRequestId)).toBe(false);
    expect(forA.pending.leaveCount).toBe(0);

    const forB = await dashboardService.getAdminOverview(tenantId, {
      callerUserId: ownerBUserId,
      includeOnboarding: true,
      includeApprovals: true,
    });
    expect(forB.pending.leaves.some((l) => l.id === leaveRequestId)).toBe(true);
    expect(forB.pending.leaveCount).toBe(1);
  });

  it('a non-approver role gets no approvals bucket at all', async () => {
    const forEmployee = await dashboardService.getAdminOverview(tenantId, {
      callerUserId: managerUserId,
      includeOnboarding: false,
      includeApprovals: false,
    });
    expect(forEmployee.pending.leaves).toEqual([]);
    expect(forEmployee.pending.leaveCount).toBe(0);
  });

  it('the other owner CAN approve it', async () => {
    const res = await leaveService.reviewLeave(
      leaveRequestId,
      ownerBUserId,
      tenantId,
      { action: 'approve' } as never,
    );
    expect(res.status).toBe('approved');
  });
});

describe('attendance regularization: separation of duties', () => {
  beforeAll(async () => {
    const [reg] = await dbAdmin
      .insert(attendanceRegularizations)
      .values({
        tenant_id: tenantId,
        employee_id: ownerAEmpId,
        attendance_date: '2026-09-10',
        request_type: 'missing_punch',
        reason: 'Forgot to clock out',
        status: 'pending',
      })
      .returning();
    regularizationId = reg!.id;
  });

  it('the requester cannot approve their own regularization', async () => {
    await expect(
      attendanceService.reviewRegularization(
        regularizationId,
        ownerAUserId,
        tenantId,
        { action: 'approve' } as never,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('the queue hides it from the requester and shows it to the other owner', async () => {
    const mine = await attendanceService.listPendingRegularizations(
      ownerAUserId,
      tenantId,
      {} as never,
    );
    expect(mine.data.some((r) => r.id === regularizationId)).toBe(false);

    const theirs = await attendanceService.listPendingRegularizations(
      ownerBUserId,
      tenantId,
      {} as never,
    );
    expect(theirs.data.some((r) => r.id === regularizationId)).toBe(true);
  });

  it('the dashboard regularization bucket excludes the caller’s own row', async () => {
    const forA = await dashboardService.getAdminOverview(tenantId, {
      callerUserId: ownerAUserId,
      includeOnboarding: true,
      includeApprovals: true,
    });
    expect(forA.pending.regularizations.some((r) => r.id === regularizationId)).toBe(false);
    expect(forA.pending.regularizationCount).toBe(0);
  });
});

// ─── 2. Avatars reach every surface ──────────────────────────────────────────

describe('avatar propagation', () => {
  it('employee detail resolves users.avatar_key instead of the never-written legacy column', async () => {
    const detail = await employeesService.getEmployee(ownerAEmpId, tenantId);
    expect(detail.avatarUrl).toBe(`signed:${AVATAR_KEY}`);
  });

  it('the org chart carries resolved avatars', async () => {
    const chart = await employeesService.getOrgChart(tenantId);
    const flat: Array<{ id: string; avatarUrl: string | null }> = [];
    const walk = (nodes: Array<{ id: string; avatarUrl: string | null; children: never[] }>) => {
      for (const n of nodes) {
        flat.push(n);
        walk(n.children);
      }
    };
    walk(chart.tree as never);
    const ownerNode = flat.find((n) => n.id === ownerAEmpId);
    expect(ownerNode?.avatarUrl).toBe(`signed:${AVATAR_KEY}`);
  });

  it('a manager’s direct reports carry resolved avatars', async () => {
    const team = await employeesService.listMyTeam(ownerBUserId, tenantId);
    const mia = team.data.find((r) => r.id === managerEmpId);
    // Mia has no photo — the surface must fall back cleanly, not error.
    expect(mia).toBeDefined();
    expect(mia?.avatarUrl ?? null).toBeNull();
  });

  it('dashboard approval rows carry the requester’s photo', async () => {
    const [reg] = await dbAdmin
      .insert(attendanceRegularizations)
      .values({
        tenant_id: tenantId,
        employee_id: ownerAEmpId,
        attendance_date: '2026-09-11',
        request_type: 'missing_punch',
        reason: 'Second one',
        status: 'pending',
      })
      .returning();

    const forB = await dashboardService.getAdminOverview(tenantId, {
      callerUserId: ownerBUserId,
      includeOnboarding: true,
      includeApprovals: true,
    });
    const row = forB.pending.regularizations.find((r) => r.id === reg!.id);
    expect(row?.avatarUrl).toBe(`signed:${AVATAR_KEY}`);
  });
});

// ─── 3. Module access ────────────────────────────────────────────────────────

describe('module access resolution', () => {
  afterEach(async () => {
    await dbAdmin
      .delete(membershipGrants)
      .where(eq(membershipGrants.membership_id, managerMembershipId));
    await dbAdmin
      .delete(tenantRoleModuleDefaults)
      .where(eq(tenantRoleModuleDefaults.tenant_id, tenantId));
    moduleAccess.invalidateTenant(tenantId);
  });

  it('a manager holds CRM and Projects by the shipped default', async () => {
    const crm = await moduleAccess.resolve(tenantId, managerMembershipId, 'manager', 'crm');
    expect(crm.level).toBe('edit');
    expect(crm.source).toBe('built_in');
    const pm = await moduleAccess.resolve(tenantId, managerMembershipId, 'manager', 'pm');
    expect(pm.level).toBe('edit');
  });

  it('an explicit "none" row REVOKES a module the role default grants', async () => {
    await membersService.upsertGrant(
      managerMembershipId,
      'crm',
      { access_level: 'none' },
      ownerAUserId,
      tenantId,
    );
    const crm = await moduleAccess.resolve(tenantId, managerMembershipId, 'manager', 'crm');
    expect(crm.level).toBe('none');
    expect(crm.source).toBe('member');
    // …and it does not spill into the other modules.
    const pm = await moduleAccess.resolve(tenantId, managerMembershipId, 'manager', 'pm');
    expect(pm.level).toBe('edit');
  });

  it('a workspace role policy applies when the member has no row', async () => {
    await membersService.updateRoleDefaults(
      { defaults: [{ role: 'manager', module: 'crm', access_level: 'none' }] },
      ownerAUserId,
      tenantId,
    );
    const crm = await moduleAccess.resolve(tenantId, managerMembershipId, 'manager', 'crm');
    expect(crm.level).toBe('none');
    expect(crm.source).toBe('tenant_default');
  });

  it('a member row beats the workspace role policy in both directions', async () => {
    await membersService.updateRoleDefaults(
      { defaults: [{ role: 'manager', module: 'crm', access_level: 'none' }] },
      ownerAUserId,
      tenantId,
    );
    await membersService.upsertGrant(
      managerMembershipId,
      'crm',
      { access_level: 'edit' },
      ownerAUserId,
      tenantId,
    );
    const crm = await moduleAccess.resolve(tenantId, managerMembershipId, 'manager', 'crm');
    expect(crm.level).toBe('edit');
    expect(crm.source).toBe('member');
  });

  it('clearing an override returns the member to their role', async () => {
    await membersService.upsertGrant(
      managerMembershipId,
      'pm',
      { access_level: 'none' },
      ownerAUserId,
      tenantId,
    );
    expect(
      (await moduleAccess.resolve(tenantId, managerMembershipId, 'manager', 'pm')).level,
    ).toBe('none');

    await membersService.clearGrant(managerMembershipId, 'pm', ownerAUserId, tenantId);
    const pm = await moduleAccess.resolve(tenantId, managerMembershipId, 'manager', 'pm');
    expect(pm.level).toBe('edit');
    expect(pm.source).toBe('built_in');
  });

  it('owners keep every module no matter what is written', async () => {
    await membersService.updateRoleDefaults(
      { defaults: [{ role: 'manager', module: 'crm', access_level: 'none' }] },
      ownerAUserId,
      tenantId,
    );
    for (const module of ['crm', 'invoicing', 'pm'] as const) {
      // The membership row is the source of truth for the role, so this must
      // be a real owner membership — a stale JWT role can never widen access.
      const res = await moduleAccess.resolve(tenantId, ownerAMembershipId, 'owner', module);
      expect(res.level).toBe('edit');
      expect(res.source).toBe('role');
    }
  });

  it('the per-module write leaves other modules untouched', async () => {
    await dbAdmin.insert(membershipGrants).values({
      tenant_id: tenantId,
      membership_id: managerMembershipId,
      module: 'org_financial',
      access_level: 'view',
      capabilities: {},
    });
    await membersService.upsertGrant(
      managerMembershipId,
      'crm',
      { access_level: 'none' },
      ownerAUserId,
      tenantId,
    );
    const rows = await dbAdmin
      .select()
      .from(membershipGrants)
      .where(eq(membershipGrants.membership_id, managerMembershipId));
    expect(rows.map((r) => r.module).sort()).toEqual(['crm', 'org_financial']);
  });

  it('a project guest’s access cannot be edited from Settings', async () => {
    const guestUserId = await mkUser(`r8-guest-${rid()}@client.test`, 'Gary Guest');
    const guestMembershipId = await mkMembership(guestUserId, 'guest');
    await dbAdmin.insert(membershipGrants).values({
      tenant_id: tenantId,
      membership_id: guestMembershipId,
      module: 'pm',
      access_level: 'edit',
      capabilities: {},
    });

    await expect(
      membersService.upsertGrant(
        guestMembershipId,
        'pm',
        { access_level: 'none' },
        ownerAUserId,
        tenantId,
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    // The guest's project access survived the attempt.
    const [row] = await dbAdmin
      .select()
      .from(membershipGrants)
      .where(
        and(
          eq(membershipGrants.membership_id, guestMembershipId),
          eq(membershipGrants.module, 'pm'),
        ),
      );
    expect(row?.access_level).toBe('edit');
    await dbAdmin.delete(users).where(eq(users.id, guestUserId));
  });

  it('the role policy read-back marks which rows the workspace customised', async () => {
    await membersService.updateRoleDefaults(
      { defaults: [{ role: 'employee', module: 'pm', access_level: 'view' }] },
      ownerAUserId,
      tenantId,
    );
    const { data } = await membersService.getRoleDefaults(tenantId, ownerAUserId);
    const row = data.defaults.find((d) => d.role === 'employee' && d.module === 'pm');
    expect(row?.access_level).toBe('view');
    expect(row?.is_custom).toBe(true);

    const untouched = data.defaults.find((d) => d.role === 'employee' && d.module === 'crm');
    expect(untouched?.access_level).toBe('edit');
    expect(untouched?.is_custom).toBe(false);
  });

  it('the /me module map hides what the member cannot open', async () => {
    await membersService.upsertGrant(
      managerMembershipId,
      'crm',
      { access_level: 'none' },
      ownerAUserId,
      tenantId,
    );
    const map = await moduleAccess.moduleAccessMap(tenantId, managerMembershipId, 'manager');
    expect(map.crm).toBe('none');
    expect(map.pm).toBe('edit');
    // Invoicing is opt-in for managers — no row, no access.
    expect(map.invoicing).toBe('none');
  });
});

describe('tenant isolation: tenant_role_module_defaults', () => {
  it('a bogus tenant context reads no rows', async () => {
    await membersService.updateRoleDefaults(
      { defaults: [{ role: 'manager', module: 'crm', access_level: 'none' }] },
      ownerAUserId,
      tenantId,
    );
    const foreign = crypto.randomUUID();
    const rows = await dbSvc.withTenant(foreign, (tx) =>
      tx.select().from(tenantRoleModuleDefaults),
    );
    expect(rows.every((r) => r.tenant_id !== tenantId)).toBe(true);

    await dbAdmin
      .delete(tenantRoleModuleDefaults)
      .where(eq(tenantRoleModuleDefaults.tenant_id, tenantId));
    moduleAccess.invalidateTenant(tenantId);
  });
});

afterAll(async () => {
  await dbAdmin.delete(leaveRequests).where(eq(leaveRequests.tenant_id, tenantId));
});
