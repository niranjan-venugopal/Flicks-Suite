/**
 * Location-aware holiday calendars (global-audience round) + the org-ref
 * hardening that shipped with it:
 *
 *  - Owner/HR CRUD on holidays (company-wide or per-location), duplicate
 *    rejection, cross-tenant location rejection (FK checks bypass RLS).
 *  - listHolidays scoping: an employee only sees company-wide rows + their
 *    own location's rows; admin scopes 'all' / 'company' work.
 *  - Leave day-count math skips exactly the holidays that apply to the
 *    requesting employee's location; elective (optional/restricted) types
 *    never reduce day counts.
 *  - Country-preset import is idempotent (re-import skips duplicates).
 *  - Employee org refs (designation/department/location/manager) are
 *    existence-checked inside the tenant transaction.
 *  - Settings → General accepts countryCode, free-text state for non-IN,
 *    and '' to clear Indian statutory IDs.
 */
import 'dotenv/config';
import * as crypto from 'crypto';
import { eq, and } from 'drizzle-orm';
import { db, dbAdmin } from '@flicks/db';
import {
  tenants,
  users,
  memberships,
  employees,
  locations,
  designations,
  leaveTypes,
  leaveRequests,
  holidays,
} from '@flicks/db/schema';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DatabaseService } from '../core/database/database.service';
import { AuditService } from '../modules/audit/audit.service';
import { LeaveService } from '../modules/leave/leave.service';
import { EmployeesService } from '../modules/employees/employees.service';
import { SettingsService } from '../modules/settings/settings.service';
import type { NotificationsService } from '../modules/notifications/notifications.service';
import type { AuthService } from '../modules/auth/auth.service';
import type { MediaService } from '../modules/media/media.service';
import type { DomainEventsService } from '../core/events/domain-events.service';

const rid = () => crypto.randomBytes(4).toString('hex');
const dbSvc = new DatabaseService();
const audit = new AuditService(db as never, dbAdmin as never, dbSvc);
const notificationsStub = {
  sendEmail: jest.fn(async () => true),
  createInAppNotification: jest.fn(async () => undefined),
} as unknown as NotificationsService;

const leaveService = new LeaveService(dbSvc, audit, notificationsStub as never);
const employeesService = new EmployeesService(
  dbSvc,
  dbAdmin as never,
  { log: async () => {} } as never,
  notificationsStub as never,
  new EventEmitter2(),
  new ConfigService({ NODE_ENV: 'test' }),
  {} as unknown as AuthService,
  // MediaService stub: echo the key so specs can assert the avatar pipeline.
  { servedUrl: async (k: string | null, l: string | null) => (k ? `signed:${k}` : l) } as unknown as MediaService,
);
const settingsService = new SettingsService(
  db as never,
  dbAdmin as never,
  { log: async () => {} } as never,
  { servedUrl: async () => null } as unknown as MediaService,
  {} as unknown as DomainEventsService,
);

let tenantId: string;
let foreignTenantId: string;
let chennaiLocId: string;
let dubaiLocId: string;
let foreignLocId: string;
let foreignDesignationId: string;
let commonDesignationId: string;
let leaveTypeId: string;
let chennaiUserId: string;
let chennaiEmpId: string;
let dubaiUserId: string;
let dubaiEmpId: string;
const userIds: string[] = [];

async function seedPerson(locationId: string | null) {
  const email = `${rid()}@holiday.test`;
  const [u] = await dbAdmin
    .insert(users)
    .values({ email, full_name: 'Holiday Person', status: 'active' })
    .returning();
  userIds.push(u!.id);
  const [e] = await dbAdmin
    .insert(employees)
    .values({
      tenant_id: tenantId,
      employee_code: `HOL${rid().slice(0, 5).toUpperCase()}`,
      first_name: 'Holiday',
      last_name: 'Person',
      work_email: email,
      date_of_joining: '2026-01-05',
      user_id: u!.id,
      location_id: locationId,
    })
    .returning();
  await dbAdmin.insert(memberships).values({
    tenant_id: tenantId,
    user_id: u!.id,
    role: 'employee',
    status: 'active',
    employee_id: e!.id,
  });
  return { userId: u!.id, employeeId: e!.id };
}

beforeAll(async () => {
  const [t] = await dbAdmin
    .insert(tenants)
    .values({
      name: `HolidayCo${rid()}`,
      slug: `holidays-${rid()}-${Date.now()}`,
      status: 'active',
      currency: 'INR',
      gstin: '33AABCU9603R1ZX',
      state_code: 'TN',
    })
    .returning();
  tenantId = t!.id;

  const [ft] = await dbAdmin
    .insert(tenants)
    .values({ name: `ForeignCo${rid()}`, slug: `foreign-${rid()}-${Date.now()}`, status: 'active' })
    .returning();
  foreignTenantId = ft!.id;

  const [chennai] = await dbAdmin
    .insert(locations)
    .values({ tenant_id: tenantId, name: 'Chennai HQ', city: 'Chennai', country_code: 'IN' })
    .returning();
  chennaiLocId = chennai!.id;
  const [dubai] = await dbAdmin
    .insert(locations)
    .values({ tenant_id: tenantId, name: 'Dubai Branch', city: 'Dubai', country_code: 'AE', timezone: 'Asia/Dubai' })
    .returning();
  dubaiLocId = dubai!.id;
  const [floc] = await dbAdmin
    .insert(locations)
    .values({ tenant_id: foreignTenantId, name: 'Foreign Office', country_code: 'US' })
    .returning();
  foreignLocId = floc!.id;

  const [fdes] = await dbAdmin
    .insert(designations)
    .values({ tenant_id: foreignTenantId, title: 'Foreign Manager' })
    .returning();
  foreignDesignationId = fdes!.id;
  const [cdes] = await dbAdmin
    .insert(designations)
    .values({ tenant_id: tenantId, title: 'Manager', level: 5 }) // no department: common
    .returning();
  commonDesignationId = cdes!.id;

  const [lt] = await dbAdmin
    .insert(leaveTypes)
    .values({ tenant_id: tenantId, name: 'Casual Leave', code: 'CL', default_quota_days: 12, is_active: true })
    .returning();
  leaveTypeId = lt!.id;

  ({ userId: chennaiUserId, employeeId: chennaiEmpId } = await seedPerson(chennaiLocId));
  ({ userId: dubaiUserId, employeeId: dubaiEmpId } = await seedPerson(dubaiLocId));
});

afterAll(async () => {
  await dbAdmin.delete(tenants).where(eq(tenants.id, tenantId));
  await dbAdmin.delete(tenants).where(eq(tenants.id, foreignTenantId));
  for (const id of userIds) await dbAdmin.delete(users).where(eq(users.id, id));
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
});

describe('holiday admin CRUD', () => {
  it('creates company-wide and per-location holidays; rejects duplicates', async () => {
    // All on Wednesdays so the leave-math tests below are deterministic.
    await leaveService.createHoliday(tenantId, {
      date: '2026-09-16',
      name: 'Founders Day',
      type: 'company',
    });
    await leaveService.createHoliday(tenantId, {
      date: '2026-09-23',
      name: 'Chennai Local Festival',
      type: 'regional',
      locationId: chennaiLocId,
    });
    await leaveService.createHoliday(tenantId, {
      date: '2026-09-30',
      name: 'Dubai Local Holiday',
      type: 'regional',
      locationId: dubaiLocId,
    });
    await leaveService.createHoliday(tenantId, {
      date: '2026-10-07',
      name: 'Elective Festival',
      type: 'optional',
    });

    await expect(
      leaveService.createHoliday(tenantId, {
        date: '2026-09-16',
        name: 'Founders Day',
        type: 'company',
      }),
    ).rejects.toThrow(/already exists/i);
  });

  it('rejects a location id from another tenant (FK bypasses RLS)', async () => {
    await expect(
      leaveService.createHoliday(tenantId, {
        date: '2026-12-30',
        name: 'Sneaky Holiday',
        locationId: foreignLocId,
      }),
    ).rejects.toThrow(/does not belong/i);
  });

  it('scopes the list to the caller: Chennai sees company + Chennai, never Dubai', async () => {
    const mine = await leaveService.listHolidays(tenantId, {
      year: 2026,
      userId: chennaiUserId,
    });
    const names = mine.holidays.map((h) => h.name);
    expect(names).toContain('Founders Day');
    expect(names).toContain('Chennai Local Festival');
    expect(names).toContain('Elective Festival');
    expect(names).not.toContain('Dubai Local Holiday');

    const all = await leaveService.listHolidays(tenantId, {
      year: 2026,
      locationScope: 'all',
    });
    expect(all.holidays.map((h) => h.name)).toContain('Dubai Local Holiday');
    const chennaiRow = all.holidays.find((h) => h.name === 'Chennai Local Festival');
    expect(chennaiRow?.locationName).toBe('Chennai HQ');

    const companyOnly = await leaveService.listHolidays(tenantId, {
      year: 2026,
      locationScope: 'company',
    });
    expect(companyOnly.holidays.map((h) => h.name).sort()).toEqual(
      ['Elective Festival', 'Founders Day'],
    );
  });

  it('update can move a holiday between location and company-wide; delete removes it', async () => {
    const created = await leaveService.createHoliday(tenantId, {
      date: '2026-11-18',
      name: 'Movable Day',
      locationId: chennaiLocId,
    });
    const moved = await leaveService.updateHoliday(tenantId, created!.id, {
      locationId: null,
    });
    expect(moved!.location_id).toBeNull();

    await leaveService.deleteHoliday(tenantId, created!.id);
    await expect(leaveService.deleteHoliday(tenantId, created!.id)).rejects.toThrow(/not found/i);
  });
});

describe('leave day counts are location-aware', () => {
  const applied: string[] = [];

  async function apply(userId: string, startDate: string, endDate: string) {
    await leaveService.applyLeave(userId, tenantId, {
      leaveTypeId,
      startDate,
      endDate,
      reason: 'Family function attendance',
    } as never);
    applied.push(startDate);
  }

  async function totalDaysOf(employeeId: string, startDate: string) {
    const [row] = await dbAdmin
      .select({ totalDays: leaveRequests.total_days })
      .from(leaveRequests)
      .where(
        and(
          eq(leaveRequests.tenant_id, tenantId),
          eq(leaveRequests.employee_id, employeeId),
          eq(leaveRequests.start_date, startDate),
        ),
      );
    return Number(row!.totalDays);
  }

  it("a location holiday reduces the count only for that location's employees", async () => {
    // Mon 21 – Fri 25 Sep 2026; Wed 23 is a Chennai-only holiday.
    await apply(chennaiUserId, '2026-09-21', '2026-09-25');
    expect(await totalDaysOf(chennaiEmpId, '2026-09-21')).toBe(4);

    await apply(dubaiUserId, '2026-09-21', '2026-09-25');
    expect(await totalDaysOf(dubaiEmpId, '2026-09-21')).toBe(5);
  });

  it('a company-wide holiday reduces the count for everyone', async () => {
    // Mon 14 – Fri 18 Sep 2026; Wed 16 is Founders Day (company-wide).
    await apply(dubaiUserId, '2026-09-14', '2026-09-18');
    expect(await totalDaysOf(dubaiEmpId, '2026-09-14')).toBe(4);
  });

  it('optional holidays never reduce the count', async () => {
    // Mon 5 – Fri 9 Oct 2026; Wed 7 is an optional holiday.
    await apply(chennaiUserId, '2026-10-05', '2026-10-09');
    expect(await totalDaysOf(chennaiEmpId, '2026-10-05')).toBe(5);
  });
});

describe('country-preset import', () => {
  it('imports a preset list and skips duplicates on re-import', async () => {
    const presets = leaveService.listHolidayPresets('AE', 2026);
    expect(presets.holidays.length).toBeGreaterThan(5);

    const slice = presets.holidays.slice(0, 4).map((h) => ({
      date: h.date,
      name: h.name,
      type: h.type,
      description: h.description,
    }));
    const first = await leaveService.importHolidays(tenantId, {
      holidays: slice,
      locationId: dubaiLocId,
    });
    expect(first).toEqual({ imported: 4, skipped: 0 });

    const again = await leaveService.importHolidays(tenantId, {
      holidays: slice,
      locationId: dubaiLocId,
    });
    expect(again).toEqual({ imported: 0, skipped: 4 });

    // Same names as company-wide rows are a different scope → still imported.
    const companyWide = await leaveService.importHolidays(tenantId, {
      holidays: slice.slice(0, 1),
    });
    expect(companyWide.imported).toBe(1);
  });

  it('IN presets carry the gazetted list; unknown countries return empty', async () => {
    expect(
      leaveService.listHolidayPresets('IN', 2026).holidays.map((h) => h.name),
    ).toContain('Republic Day');
    expect(leaveService.listHolidayPresets('ZZ', 2026).holidays).toEqual([]);
  });
});

describe('employee org refs are tenant-checked', () => {
  it("rejects another tenant's designation id and accepts an own common one", async () => {
    await expect(
      employeesService.updateEmployee(
        chennaiEmpId,
        { designationId: foreignDesignationId } as never,
        chennaiUserId,
        tenantId,
      ),
    ).rejects.toThrow(/does not belong/i);

    await employeesService.updateEmployee(
      chennaiEmpId,
      { designationId: commonDesignationId } as never,
      chennaiUserId,
      tenantId,
    );
    const [row] = await dbAdmin
      .select({ designationId: employees.designation_id })
      .from(employees)
      .where(eq(employees.id, chennaiEmpId));
    expect(row!.designationId).toBe(commonDesignationId);
  });
});

describe('organization country / GST', () => {
  it('accepts a non-IN country with free-text state and clears GSTIN with ""', async () => {
    await settingsService.updateOrganization(tenantId, chennaiUserId, {
      countryCode: 'AE',
      stateCode: 'Dubai',
      gstin: '',
    } as never);
    const [t] = await dbAdmin.select().from(tenants).where(eq(tenants.id, tenantId));
    expect(t!.country_code).toBe('AE');
    expect(t!.state_code).toBe('Dubai');
    expect(t!.gstin).toBeNull();
  });
});
