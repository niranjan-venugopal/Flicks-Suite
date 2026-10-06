/**
 * Round Q — HR access (founder 2026-10-06).
 *
 *  - "Only an Owner controls Owner and HR seats" (decision). Before this an HR
 *    admin could promote anyone — themselves included — to Owner (and, via
 *    the API, to the platform role `fam`), and demote or switch off Owners.
 *  - "HR should be shown Insights but only with Report access": the audit
 *    trail is the Owner's; the company-wide HR reports are Owner / HR only;
 *    the dashboard activity feed (the audit trail) was open to any member.
 *
 * Service-level against the real Postgres + route metadata checks.
 */
import 'dotenv/config';
import * as crypto from 'crypto';
import { eq } from 'drizzle-orm';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { db, dbAdmin } from '@flicks/db';
import { tenants, users, memberships } from '@flicks/db/schema';
import type { UserRole } from '@flicks/shared/types';
import { ROLES_KEY } from '../core/auth/decorators/roles.decorator';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import type { JwtPayload } from '@flicks/shared/types';
import { RolesGuard } from '../core/auth/guards/roles.guard';
import { ModuleAccessService } from '../core/auth/module-access.service';
import { DatabaseService } from '../core/database/database.service';
import { SettingsService } from '../modules/settings/settings.service';
import { UpdateMemberRoleDto } from '../modules/settings/settings.dto';
import { AuditController } from '../modules/audit/audit.controller';
import { ReportsController } from '../modules/reports/reports.controller';
import { DashboardController } from '../modules/dashboard/dashboard.controller';
import { EmployeesController } from '../modules/employees/employees.controller';
import type { AuditService } from '../modules/audit/audit.service';
import type { MediaService } from '../modules/media/media.service';

const rid = () => crypto.randomBytes(4).toString('hex');
const settings = new SettingsService(
  db as never,
  dbAdmin as never,
  { log: async () => undefined } as unknown as AuditService,
  { servedUrl: async () => null } as unknown as MediaService,
  { publish: async () => null } as never,
);

let tenantId: string;
const trackedUsers: string[] = [];

async function seat(label: string, role: string) {
  const [u] = await dbAdmin
    .insert(users)
    .values({ email: `rqr-${label}-${rid()}@t.test`, full_name: `RQR ${label}`, status: 'active' })
    .returning();
  trackedUsers.push(u!.id);
  const [m] = await dbAdmin
    .insert(memberships)
    .values({ tenant_id: tenantId, user_id: u!.id, role: role as never, status: 'active' })
    .returning();
  return { userId: u!.id, membershipId: m!.id };
}
const roleOf = async (membershipId: string) =>
  (await dbAdmin.select().from(memberships).where(eq(memberships.id, membershipId)))[0]!;

let owner: { userId: string; membershipId: string };
let owner2: { userId: string; membershipId: string };
let hr: { userId: string; membershipId: string };

beforeAll(async () => {
  const [t] = await dbAdmin
    .insert(tenants)
    .values({ name: `RQR ${rid()}`, slug: `rqr-${rid()}-${Date.now()}`, status: 'active' })
    .returning();
  tenantId = t!.id;
  owner = await seat('owner', 'owner');
  owner2 = await seat('owner2', 'owner');
  hr = await seat('hr', 'admin');
});

afterAll(async () => {
  await dbAdmin.delete(tenants).where(eq(tenants.id, tenantId));
  for (const id of trackedUsers) await dbAdmin.delete(users).where(eq(users.id, id));
});

describe('Round Q — role changes: only an Owner controls Owner / HR seats', () => {
  it('an HR admin cannot make anyone an Owner or HR admin — not even themselves', async () => {
    const emp = await seat('emp1', 'employee');
    await expect(
      settings.updateMemberRole(emp.membershipId, tenantId, hr.userId, { role: 'owner' }),
    ).rejects.toThrow(/Only an owner can make someone an owner or HR admin/);
    await expect(
      settings.updateMemberRole(emp.membershipId, tenantId, hr.userId, { role: 'admin' }),
    ).rejects.toThrow(/Only an owner/);
    await expect(
      settings.updateMemberRole(hr.membershipId, tenantId, hr.userId, { role: 'owner' }),
    ).rejects.toThrow(/cannot change your own role/);
    expect((await roleOf(emp.membershipId)).role).toBe('employee');
    expect((await roleOf(hr.membershipId)).role).toBe('admin');
  });

  it('an HR admin still sets Manager / Finance / Employee', async () => {
    const emp = await seat('emp2', 'employee');
    for (const r of ['manager', 'finance', 'employee'] as const) {
      await settings.updateMemberRole(emp.membershipId, tenantId, hr.userId, { role: r });
      expect((await roleOf(emp.membershipId)).role).toBe(r);
    }
  });

  it('an HR admin cannot demote an Owner or another HR admin', async () => {
    const hr2 = await seat('hr2', 'admin');
    await expect(
      settings.updateMemberRole(owner2.membershipId, tenantId, hr.userId, { role: 'employee' }),
    ).rejects.toThrow(/Only an owner can change the role of an owner or HR admin/);
    await expect(
      settings.updateMemberRole(hr2.membershipId, tenantId, hr.userId, { role: 'employee' }),
    ).rejects.toThrow(/Only an owner/);
    expect((await roleOf(owner2.membershipId)).role).toBe('owner');
    expect((await roleOf(hr2.membershipId)).role).toBe('admin');
  });

  it('the Owner can promote to HR admin / Owner and demote them again', async () => {
    const emp = await seat('emp3', 'employee');
    await settings.updateMemberRole(emp.membershipId, tenantId, owner.userId, { role: 'admin' });
    expect((await roleOf(emp.membershipId)).role).toBe('admin');
    await settings.updateMemberRole(emp.membershipId, tenantId, owner.userId, { role: 'owner' });
    expect((await roleOf(emp.membershipId)).role).toBe('owner');
    await settings.updateMemberRole(emp.membershipId, tenantId, owner.userId, { role: 'employee' });
    expect((await roleOf(emp.membershipId)).role).toBe('employee');
  });

  it('platform roles are never assignable — DTO and service both refuse', async () => {
    for (const role of ['fam', 'super_admin']) {
      const errors = await validate(plainToInstance(UpdateMemberRoleDto, { role }));
      expect(errors.length).toBeGreaterThan(0);
    }
    const emp = await seat('emp4', 'employee');
    await expect(
      settings.updateMemberRole(emp.membershipId, tenantId, owner.userId, { role: 'fam' } as never),
    ).rejects.toThrow(/Platform roles/);
    expect((await roleOf(emp.membershipId)).role).toBe('employee');
  });
});

describe('Round Q — deactivate / reactivate: same rule', () => {
  it('an HR admin cannot switch off an Owner or another HR admin, nor themselves', async () => {
    const hr3 = await seat('hr3', 'admin');
    await expect(
      settings.setMemberStatus(owner2.membershipId, tenantId, hr.userId, 'deactivated'),
    ).rejects.toThrow(/Only an owner can deactivate an owner or HR admin/);
    await expect(
      settings.setMemberStatus(hr3.membershipId, tenantId, hr.userId, 'deactivated'),
    ).rejects.toThrow(/Only an owner/);
    await expect(
      settings.setMemberStatus(hr.membershipId, tenantId, hr.userId, 'deactivated'),
    ).rejects.toThrow(/cannot deactivate yourself/);
    expect((await roleOf(owner2.membershipId)).status).toBe('active');
    expect((await roleOf(hr3.membershipId)).status).toBe('active');
  });

  it('HR switches ordinary seats off and on; the Owner switches an HR admin', async () => {
    const emp = await seat('emp5', 'employee');
    await settings.setMemberStatus(emp.membershipId, tenantId, hr.userId, 'deactivated');
    expect((await roleOf(emp.membershipId)).status).toBe('deactivated');
    await settings.setMemberStatus(emp.membershipId, tenantId, hr.userId, 'active');
    expect((await roleOf(emp.membershipId)).status).toBe('active');
    const hr4 = await seat('hr4', 'admin');
    await settings.setMemberStatus(hr4.membershipId, tenantId, owner.userId, 'deactivated');
    expect((await roleOf(hr4.membershipId)).status).toBe('deactivated');
  });
});

describe('Round Q — Insights: Reports for HR, the audit trail for the Owner', () => {
  const rolesOf = (proto: object, name: string) =>
    Reflect.getMetadata(ROLES_KEY, (proto as Record<string, object>)[name]!) as UserRole[] | undefined;

  it('GET audit/logs is Owner-only', () => {
    expect(rolesOf(AuditController.prototype, 'getLogs')).toEqual(['owner']);
  });

  it('company-wide HR reports are Owner / HR admin (no longer any manager)', () => {
    const names = Object.getOwnPropertyNames(ReportsController.prototype).filter((n) => n !== 'constructor');
    expect(names.length).toBe(3);
    for (const n of names) expect(rolesOf(ReportsController.prototype, n)).toEqual(['admin']);
  });

  it('the dashboard activity feed (the audit trail) needs an Owner / HR seat', () => {
    expect(rolesOf(DashboardController.prototype, 'getActivity')).toEqual(['admin']);
  });

  it('cancel-offboarding is an Owner / HR action', () => {
    expect(rolesOf(EmployeesController.prototype, 'cancelOffboarding')).toEqual(['admin']);
  });
});

describe('Round Q — a switched-off seat is refused on EVERY tenant route, not only ranked ones', () => {
  const moduleAccess = new ModuleAccessService(new DatabaseService(), dbAdmin as never);
  const auditStub = { log: async () => undefined } as unknown as AuditService;
  // No @Roles on the route (getAllAndOverride → undefined): the unranked path.
  const guard = new RolesGuard({ getAllAndOverride: () => undefined } as never, auditStub, moduleAccess);
  const ctx = (user: Partial<JwtPayload> | undefined, url: string) =>
    ({
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => ({ user, method: 'GET', originalUrl: url, headers: {} }) }),
    }) as unknown as ExecutionContext;

  it('an active seat passes; once switched off, self-service routes refuse it immediately', async () => {
    const e = await seat('guard-emp', 'employee');
    const token: Partial<JwtPayload> = { sub: e.userId, tenantId, membershipId: e.membershipId, role: 'employee', isPlatformAdmin: false };
    await expect(guard.canActivate(ctx(token, '/api/v1/leave/types'))).resolves.toBe(true);
    await dbAdmin.update(memberships).set({ status: 'deactivated' }).where(eq(memberships.id, e.membershipId));
    for (const url of ['/api/v1/leave/types', '/api/v1/employees/org-chart', '/api/v1/assets/me', '/api/v1/dashboard/admin/overview']) {
      await expect(guard.canActivate(ctx(token, url))).rejects.toThrow(ForbiddenException);
    }
    // …but the account routes needed to leave the company still work.
    for (const url of ['/api/v1/auth/me', '/api/v1/auth/switch-company', '/api/v1/auth/logout', '/api/v1/me/companies?x=1']) {
      await expect(guard.canActivate(ctx(token, url))).resolves.toBe(true);
    }
    await dbAdmin.update(memberships).set({ status: 'active' }).where(eq(memberships.id, e.membershipId));
    await expect(guard.canActivate(ctx(token, '/api/v1/leave/types'))).resolves.toBe(true);
  });

  it('public routes, platform admins and seat-less tokens are unaffected', async () => {
    await expect(guard.canActivate(ctx(undefined, '/api/v1/public/inv/x'))).resolves.toBe(true);
    await expect(
      guard.canActivate(ctx({ sub: 'x', isPlatformAdmin: true, tenantId, membershipId: crypto.randomUUID() }, '/api/v1/leave/types')),
    ).resolves.toBe(true);
    await expect(guard.canActivate(ctx({ sub: 'x', tenantId, isPlatformAdmin: false }, '/api/v1/leave/types'))).resolves.toBe(true);
  });

  it("a seat id from another company never passes (look-alike prefixes aren't exempt)", async () => {
    const e = await seat('guard-foreign', 'employee');
    const forged: Partial<JwtPayload> = { sub: e.userId, tenantId: crypto.randomUUID(), membershipId: e.membershipId, role: 'employee', isPlatformAdmin: false };
    await expect(guard.canActivate(ctx(forged, '/api/v1/leave/types'))).rejects.toThrow('no longer active');
    await expect(guard.canActivate(ctx(forged, '/api/v1/authority/x'))).rejects.toThrow('no longer active');
    await expect(guard.canActivate(ctx(forged, '/api/v1/members/x'))).rejects.toThrow('no longer active');
  });
});
