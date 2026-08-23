/**
 * Founder round 3 — location lifecycle, employee-confirmed detail changes,
 * designation on /me, and the refresh contract behind web silent-refresh:
 *
 *  - Locations: country/state/timezone are now editable; guarded delete
 *    (deactivate first, transfer employees, never leak location holidays
 *    into the company-wide NULL scope).
 *  - Admin "Edit details" on an ACTIVE app-joined employee creates a
 *    pending change request (record untouched, employee notified, sensitive
 *    payload encrypted at rest) that the employee confirms or rejects;
 *    invited/not-yet-joined employees still get direct writes. Admin edits
 *    never re-flag onboarding_submitted_for_review (regression).
 *  - /auth/me carries designationTitle for the profile chip.
 *  - Refresh rotation: valid token → new pair; the rotated-out token 401s.
 */
import 'dotenv/config';
import * as crypto from 'crypto';
import { eq, and, isNull } from 'drizzle-orm';
import { db, dbAdmin } from '@flicks/db';
import {
  tenants,
  users,
  memberships,
  employees,
  locations,
  designations,
  holidays,
  employeeChangeRequests,
  authOtps,
} from '@flicks/db/schema';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DatabaseService } from '../core/database/database.service';
import { EmployeesService } from '../modules/employees/employees.service';
import { SettingsService } from '../modules/settings/settings.service';
import { AuthService } from '../modules/auth/auth.service';
import { TotpService } from '../modules/auth/totp.service';
import { ConsentService } from '../modules/consent/consent.service';
import type { AuditService } from '../modules/audit/audit.service';
import type { NotificationsService } from '../modules/notifications/notifications.service';
import type { MediaService } from '../modules/media/media.service';
import type { DomainEventsService } from '../core/events/domain-events.service';
import type { AuthService as AuthServiceType } from '../modules/auth/auth.service';

const rid = () => crypto.randomBytes(4).toString('hex');
const audit = { log: async () => {} } as unknown as AuditService;

// Shared notifications stub: captures OTP codes for the auth flow AND
// in-app pings for the change-request flow.
let lastOtpCode = '';
const sendEmail = jest.fn(async (_tpl: unknown, _to: unknown, props?: unknown) => {
  const code = (props as { otpCode?: string } | undefined)?.otpCode;
  if (code) lastOtpCode = String(code);
  return true;
});
const createInAppNotification = jest.fn(async () => undefined);
const notifications = {
  sendEmail,
  createInAppNotification,
} as unknown as NotificationsService;

// Encryption live, like production.
process.env.EMPLOYEE_DATA_ENC_KEY = 'f'.repeat(64);

const dbSvc = new DatabaseService();
const employeesService = new EmployeesService(
  dbSvc,
  dbAdmin as never,
  audit,
  notifications,
  new EventEmitter2(),
  new ConfigService({ NODE_ENV: 'test' }),
  {} as unknown as AuthServiceType,
);
const settingsService = new SettingsService(
  db as never,
  dbAdmin as never,
  audit,
  { servedUrl: async () => null } as unknown as MediaService,
  {} as unknown as DomainEventsService,
);
const authConfig = {
  get: (key: string, fallback?: unknown) =>
    (({
      NODE_ENV: 'test',
      JWT_SECRET: 'test-secret',
      JWT_ISSUER: 'flicks-suite',
      JWT_AUDIENCE: 'flicks-suite-api',
    } as Record<string, unknown>)[key] ?? fallback),
} as unknown as ConfigService;
const authService = new AuthService(
  dbAdmin as never,
  dbAdmin as never,
  new JwtService({ secret: 'test-secret' }),
  authConfig,
  { emit: () => true } as never,
  notifications,
  audit,
  new TotpService(authConfig),
  new ConsentService(dbAdmin as never, authConfig),
);

let tenantId: string;
let hqLocId: string; // stays
let branchLocId: string; // gets deleted
let adminUserId: string;
let activeUserId: string; // app-joined active employee (confirm flow)
let activeEmpId: string;
let invitedEmpId: string; // no user yet (direct-write path)
const trackedEmails: string[] = [];
const trackedUserIds: string[] = [];

async function seedUser(email: string) {
  const [u] = await dbAdmin
    .insert(users)
    .values({ email, full_name: 'Round Three', status: 'active' })
    .returning();
  trackedUserIds.push(u!.id);
  trackedEmails.push(email);
  return u!.id;
}

beforeAll(async () => {
  const [t] = await dbAdmin
    .insert(tenants)
    .values({ name: `R3Co${rid()}`, slug: `r3-${rid()}-${Date.now()}`, status: 'active', currency: 'INR' })
    .returning();
  tenantId = t!.id;

  const [hq] = await dbAdmin
    .insert(locations)
    .values({ tenant_id: tenantId, name: 'HQ', city: 'Chennai', country_code: 'IN' })
    .returning();
  hqLocId = hq!.id;
  const [branch] = await dbAdmin
    .insert(locations)
    .values({ tenant_id: tenantId, name: 'Old Branch', city: 'Coimbatore', country_code: 'IN' })
    .returning();
  branchLocId = branch!.id;

  const [des] = await dbAdmin
    .insert(designations)
    .values({ tenant_id: tenantId, title: 'Operations Manager', level: 4 })
    .returning();

  adminUserId = await seedUser(`admin-${rid()}@r3.test`);
  await dbAdmin.insert(memberships).values({
    tenant_id: tenantId, user_id: adminUserId, role: 'owner', status: 'active', accepted_at: new Date(),
  });

  activeUserId = await seedUser(`emp-${rid()}@r3.test`);
  const [activeEmp] = await dbAdmin
    .insert(employees)
    .values({
      tenant_id: tenantId,
      employee_code: `R3A${rid().slice(0, 4).toUpperCase()}`,
      first_name: 'Active',
      last_name: 'Employee',
      work_email: `active-${rid()}@r3.test`,
      date_of_joining: '2026-02-02',
      user_id: activeUserId,
      status: 'active',
      location_id: branchLocId,
      designation_id: des!.id,
      // Fully onboarded once already — the regression state for admin edits.
      custom_fields: { onboarding_step: 5, onboarding_submitted_for_review: false },
    })
    .returning();
  activeEmpId = activeEmp!.id;
  await dbAdmin.insert(memberships).values({
    tenant_id: tenantId, user_id: activeUserId, role: 'employee', status: 'active',
    employee_id: activeEmpId, accepted_at: new Date(),
  });

  const [invitedEmp] = await dbAdmin
    .insert(employees)
    .values({
      tenant_id: tenantId,
      employee_code: `R3I${rid().slice(0, 4).toUpperCase()}`,
      first_name: 'Invited',
      last_name: 'Employee',
      work_email: `invited-${rid()}@r3.test`,
      date_of_joining: '2026-03-01',
      status: 'inactive',
      location_id: branchLocId,
    })
    .returning();
  invitedEmpId = invitedEmp!.id;

  // A holiday scoped to the branch — must be deleted with the location,
  // never converted to company-wide.
  await dbAdmin.insert(holidays).values({
    tenant_id: tenantId,
    location_id: branchLocId,
    holiday_date: '2026-12-30',
    name: 'Branch Founding Day',
    type: 'company',
  });
});

afterAll(async () => {
  await dbAdmin.delete(tenants).where(eq(tenants.id, tenantId));
  for (const email of trackedEmails)
    await dbAdmin.delete(authOtps).where(eq(authOtps.email, email));
  for (const id of trackedUserIds)
    await dbAdmin.delete(users).where(eq(users.id, id));
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
});

describe('locations: editable country/state/timezone', () => {
  it('updateLocation persists the new fields and "" clears state', async () => {
    await settingsService.updateLocation(hqLocId, tenantId, adminUserId, {
      countryCode: 'AE',
      stateCode: 'Dubai',
      timezone: 'Asia/Dubai',
      addressLine2: 'Floor 12',
    } as never);
    let [row] = await dbAdmin.select().from(locations).where(eq(locations.id, hqLocId));
    expect(row!.country_code).toBe('AE');
    expect(row!.state_code).toBe('Dubai');
    expect(row!.timezone).toBe('Asia/Dubai');
    expect(row!.address_line2).toBe('Floor 12');

    await settingsService.updateLocation(hqLocId, tenantId, adminUserId, {
      countryCode: 'IN',
      stateCode: '',
      timezone: 'Asia/Kolkata',
    } as never);
    ;[row] = await dbAdmin.select().from(locations).where(eq(locations.id, hqLocId));
    expect(row!.state_code).toBeNull();
  });
});

describe('locations: guarded delete with employee transfer', () => {
  it('previews the impact and blocks deleting an active location', async () => {
    const preview = await settingsService.locationDeletePreview(branchLocId, tenantId);
    expect(preview.employees).toBe(2); // active + invited
    expect(preview.holidays).toBe(1);
    expect(preview.otherLocations.map((l) => l.id)).toContain(hqLocId);

    await expect(
      settingsService.deleteLocation(branchLocId, tenantId, adminUserId),
    ).rejects.toThrow(/deactivate/i);
  });

  it('requires a transfer target, then moves ALL employees and removes its holidays', async () => {
    await settingsService.updateLocation(branchLocId, tenantId, adminUserId, {
      isActive: false,
    } as never);

    await expect(
      settingsService.deleteLocation(branchLocId, tenantId, adminUserId),
    ).rejects.toThrow(/assigned/i);
    await expect(
      settingsService.deleteLocation(branchLocId, tenantId, adminUserId, branchLocId),
    ).rejects.toThrow(/different location/i);

    const res = await settingsService.deleteLocation(
      branchLocId,
      tenantId,
      adminUserId,
      hqLocId,
    );
    expect(res).toEqual({ deleted: true, movedEmployees: 2, deletedHolidays: 1 });

    const moved = await dbAdmin
      .select({ locationId: employees.location_id })
      .from(employees)
      .where(eq(employees.tenant_id, tenantId));
    expect(moved.every((m) => m.locationId === hqLocId)).toBe(true);

    // The branch holiday must be GONE — not floating company-wide.
    const strays = await dbAdmin
      .select({ id: holidays.id })
      .from(holidays)
      .where(
        and(
          eq(holidays.tenant_id, tenantId),
          eq(holidays.name, 'Branch Founding Day'),
          isNull(holidays.location_id),
        ),
      );
    expect(strays).toHaveLength(0);
    const all = await dbAdmin
      .select({ id: holidays.id })
      .from(holidays)
      .where(eq(holidays.tenant_id, tenantId));
    expect(all).toHaveLength(0);
  });
});

describe('employee-confirmed detail changes', () => {
  it('holds an admin bank edit as pending, encrypted, with the record untouched', async () => {
    createInAppNotification.mockClear();
    const res = await employeesService.adminSubmitEmployeeDetails(
      activeEmpId,
      3,
      {
        step: 3,
        bank: { bankName: 'ICICI Bank', bankAccountNumber: '999888777666', bankIfsc: 'ICIC0000123' },
      } as never,
      tenantId,
      adminUserId,
    );
    expect(res.pendingConfirmation).toBe(true);

    const [emp] = await dbAdmin
      .select({ bankName: employees.bank_name, acct: employees.bank_account_number_encrypted })
      .from(employees)
      .where(eq(employees.id, activeEmpId));
    expect(emp!.bankName).toBeNull();
    expect(emp!.acct).toBeNull();

    const [req] = await dbAdmin
      .select()
      .from(employeeChangeRequests)
      .where(
        and(
          eq(employeeChangeRequests.employee_id, activeEmpId),
          eq(employeeChangeRequests.status, 'pending'),
        ),
      );
    const payload = req!.payload as { bank: { bankAccountNumber: string } };
    expect(payload.bank.bankAccountNumber).not.toBe('999888777666');
    expect(payload.bank.bankAccountNumber).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
    expect(createInAppNotification).toHaveBeenCalledWith(
      activeUserId,
      'employee.details_change_requested',
      expect.any(String),
      '/profile',
      tenantId,
    );
  });

  it('a re-save of the same step replaces the previous pending request', async () => {
    await employeesService.adminSubmitEmployeeDetails(
      activeEmpId,
      3,
      { step: 3, bank: { bankName: 'HDFC Bank', bankAccountNumber: '111222333444', bankIfsc: 'HDFC0009999' } } as never,
      tenantId,
      adminUserId,
    );
    const pending = await dbAdmin
      .select({ id: employeeChangeRequests.id })
      .from(employeeChangeRequests)
      .where(
        and(
          eq(employeeChangeRequests.employee_id, activeEmpId),
          eq(employeeChangeRequests.step, 3),
          eq(employeeChangeRequests.status, 'pending'),
        ),
      );
    expect(pending).toHaveLength(1);
  });

  it('confirm applies through the step writer (re-encrypted) and never re-flags review', async () => {
    createInAppNotification.mockClear();
    sendEmail.mockClear();
    const [req] = await dbAdmin
      .select({ id: employeeChangeRequests.id })
      .from(employeeChangeRequests)
      .where(
        and(
          eq(employeeChangeRequests.employee_id, activeEmpId),
          eq(employeeChangeRequests.status, 'pending'),
        ),
      );
    const out = await employeesService.reviewMyChangeRequest(
      activeUserId,
      tenantId,
      req!.id,
      'confirm',
    );
    expect(out.status).toBe('confirmed');

    const [emp] = await dbAdmin
      .select({
        bankName: employees.bank_name,
        acct: employees.bank_account_number_encrypted,
        custom: employees.custom_fields,
      })
      .from(employees)
      .where(eq(employees.id, activeEmpId));
    expect(emp!.bankName).toBe('HDFC Bank');
    expect(emp!.acct).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
    // The regression: an admin-path write on an onboarded employee must NOT
    // flip the review flag back on or email the manager.
    expect(
      (emp!.custom as Record<string, unknown>).onboarding_submitted_for_review,
    ).toBe(false);
    expect(sendEmail).not.toHaveBeenCalledWith(
      'onboarding-submitted',
      expect.anything(),
      expect.anything(),
    );
    // The requesting admin hears back.
    expect(createInAppNotification).toHaveBeenCalledWith(
      adminUserId,
      'employee.details_change_confirmed',
      expect.any(String),
      `/employees/${activeEmpId}`,
      tenantId,
    );
  });

  it('reject leaves the record untouched and notifies the admin with the reason', async () => {
    createInAppNotification.mockClear();
    await employeesService.adminSubmitEmployeeDetails(
      activeEmpId,
      2,
      { step: 2, identity: { pan: 'XYZAB1234C' } } as never,
      tenantId,
      adminUserId,
    );
    const [req] = await dbAdmin
      .select({ id: employeeChangeRequests.id })
      .from(employeeChangeRequests)
      .where(
        and(
          eq(employeeChangeRequests.employee_id, activeEmpId),
          eq(employeeChangeRequests.status, 'pending'),
        ),
      );
    await employeesService.reviewMyChangeRequest(
      activeUserId,
      tenantId,
      req!.id,
      'reject',
      'Wrong PAN entirely',
    );
    const [emp] = await dbAdmin
      .select({ pan: employees.pan_encrypted })
      .from(employees)
      .where(eq(employees.id, activeEmpId));
    expect(emp!.pan).toBeNull();
    expect(createInAppNotification).toHaveBeenCalledWith(
      adminUserId,
      'employee.details_change_rejected',
      expect.stringContaining('Wrong PAN entirely'),
      `/employees/${activeEmpId}`,
      tenantId,
    );
  });

  it('applies directly for an employee who has not joined the app yet', async () => {
    const res = await employeesService.adminSubmitEmployeeDetails(
      invitedEmpId,
      3,
      { step: 3, bank: { bankName: 'SBI', bankIfsc: 'SBIN0001111' } } as never,
      tenantId,
      adminUserId,
    );
    expect(res.pendingConfirmation).toBe(false);
    const [emp] = await dbAdmin
      .select({ bankName: employees.bank_name })
      .from(employees)
      .where(eq(employees.id, invitedEmpId));
    expect(emp!.bankName).toBe('SBI');
  });
});

describe('auth: designation on /me and refresh rotation', () => {
  it('getMe surfaces designationTitle for the profile chip', async () => {
    const me = await authService.getMe(activeUserId, tenantId);
    expect(me.currentMembership?.designationTitle).toBe('Operations Manager');
  });

  it('refresh rotates: valid token → new pair, old token → 401', async () => {
    const email = `refresh-${rid()}@r3.test`;
    trackedEmails.push(email);
    await authService.requestOtp(email, '127.0.0.1', 'jest', 'signup');
    expect(lastOtpCode).toMatch(/^\d{6}$/);
    const verify = (await authService.verifyOtp(
      email,
      lastOtpCode,
      undefined,
      '127.0.0.1',
      'jest',
      [{ type: 'terms_privacy', granted: true }] as never,
    )) as { refreshToken?: string; user?: { id?: string } };
    const firstRefresh = verify.refreshToken;
    expect(firstRefresh).toBeTruthy();
    if (verify.user?.id) trackedUserIds.push(verify.user.id);

    const rotated = (await authService.refreshToken(
      firstRefresh!,
      undefined,
      '127.0.0.1',
      'jest',
    )) as { accessToken?: string; refreshToken?: string };
    expect(rotated.accessToken).toBeTruthy();
    expect(rotated.refreshToken).toBeTruthy();
    expect(rotated.refreshToken).not.toBe(firstRefresh);

    // The rotated-out token must be dead (reuse detection).
    await expect(
      authService.refreshToken(firstRefresh!, undefined, '127.0.0.1', 'jest'),
    ).rejects.toThrow();
  });
});
