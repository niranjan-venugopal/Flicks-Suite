/**
 * Round 10 (founder onboarding-tester feedback) — location-aware statutory
 * fields + the terms-gate consent contract:
 *  - passportNumber (non-India identity) encrypts at rest via FieldCipher and
 *    surfaces only as hasPassport;
 *  - aadhaarLast4 actually persists (the wizard used to capture Aadhaar and
 *    silently drop it);
 *  - the identity DTO accepts/rejects the right shapes (PAN optional,
 *    aadhaarLast4 strictly 4 digits, passportNumber capped at 20);
 *  - getEmployee exposes the assigned location's country_code (the client's
 *    India/elsewhere fork reads it);
 *  - requiresReacceptance is true for a ledger-less user and flips false
 *    after a terms_privacy acceptance — the assertion whose absence let the
 *    dead (unclickable) re-acceptance gate ship.
 */
import 'dotenv/config';
import * as crypto from 'crypto';
import { db, dbAdmin } from '@flicks/db';
import {
  consentRecords,
  employees,
  locations,
  memberships,
  tenants,
  users,
} from '@flicks/db/schema';
import { eq } from 'drizzle-orm';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { DatabaseService } from '../core/database/database.service';
import { EmployeesService } from '../modules/employees/employees.service';
import { OnboardingIdentityDto } from '../modules/employees/employees.dto';
import { ConsentService } from '../modules/consent/consent.service';
import type { AuditService } from '../modules/audit/audit.service';
import type { NotificationsService } from '../modules/notifications/notifications.service';
import type { AuthService } from '../modules/auth/auth.service';
import type { MediaService } from '../modules/media/media.service';
import type { DbAdmin } from '@flicks/db';

const rid = () => crypto.randomBytes(4).toString('hex');
const audit = { log: async () => {} } as unknown as AuditService;
const notifications = {
  sendEmail: jest.fn(async () => {}),
} as unknown as NotificationsService;
const auth = {} as unknown as AuthService;
process.env.EMPLOYEE_DATA_ENC_KEY = 'e'.repeat(64);
const config = new ConfigService({ NODE_ENV: 'test' });

const dbSvc = new DatabaseService();
const service = new EmployeesService(
  dbSvc,
  dbAdmin as never,
  audit,
  notifications,
  new EventEmitter2(),
  config,
  auth,
  { servedUrl: async (k: string | null, l: string | null) => (k ? `signed:${k}` : l) } as unknown as MediaService,
);
const consentService = new ConsentService(dbAdmin as unknown as DbAdmin, config);

const ENC_SHAPE = /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/; // iv:tag:ciphertext

let tenantId: string;
let adminUserId: string;
let employeeId: string;
let ledgerlessUserId: string;

beforeAll(async () => {
  const [t] = await dbAdmin
    .insert(tenants)
    .values({
      name: `R10Co${rid()}`,
      slug: `r10-${rid()}-${Date.now()}`,
      status: 'active',
      currency: 'INR',
    })
    .returning();
  tenantId = t!.id;

  const [admin] = await dbAdmin
    .insert(users)
    .values({ email: `admin-${rid()}@r10.test`, full_name: 'R10 Admin', status: 'active' })
    .returning();
  adminUserId = admin!.id;
  await dbAdmin.insert(memberships).values({
    tenant_id: tenantId,
    user_id: adminUserId,
    role: 'owner',
    status: 'active',
    accepted_at: new Date(),
  });

  const [emp] = await dbAdmin
    .insert(employees)
    .values({
      tenant_id: tenantId,
      employee_code: `R10${rid().slice(0, 4).toUpperCase()}`,
      first_name: 'Dubai',
      last_name: 'Hire',
      work_email: `hire-${rid()}@r10.test`,
      date_of_joining: '2026-08-01',
    })
    .returning();
  employeeId = emp!.id;

  // A user with NO consent ledger rows at all (the invited-employee case
  // that hit the stuck terms gate).
  const [bare] = await dbAdmin
    .insert(users)
    .values({ email: `bare-${rid()}@r10.test`, full_name: 'No Ledger', status: 'active' })
    .returning();
  ledgerlessUserId = bare!.id;
});

afterAll(async () => {
  await dbAdmin.delete(consentRecords).where(eq(consentRecords.user_id, ledgerlessUserId));
  await dbAdmin.delete(employees).where(eq(employees.tenant_id, tenantId));
  await dbAdmin.delete(locations).where(eq(locations.tenant_id, tenantId));
  await dbAdmin.delete(memberships).where(eq(memberships.tenant_id, tenantId));
  await dbAdmin.delete(tenants).where(eq(tenants.id, tenantId));
  await dbAdmin.delete(users).where(eq(users.id, adminUserId));
  await dbAdmin.delete(users).where(eq(users.id, ledgerlessUserId));
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
});

describe('round 10 — location-aware statutory identity fields', () => {
  it('passportNumber encrypts at rest and surfaces only as hasPassport', async () => {
    await service.submitOnboardingStep(
      employeeId,
      2,
      { step: 2, identity: { passportNumber: 'Z9876543' } } as never,
      tenantId,
      adminUserId,
    );

    const [row] = await dbAdmin
      .select({ enc: employees.passport_number_encrypted })
      .from(employees)
      .where(eq(employees.id, employeeId));
    expect(row!.enc).toBeTruthy();
    expect(row!.enc).not.toContain('Z9876543');
    expect(row!.enc).toMatch(ENC_SHAPE);

    const detail = await service.getEmployee(employeeId, tenantId);
    expect(detail.hasPassport).toBe(true);
    // The raw number never leaves through the detail payload.
    expect(JSON.stringify(detail)).not.toContain('Z9876543');
  });

  it('aadhaarLast4 persists to the (previously never-written) column', async () => {
    await service.submitOnboardingStep(
      employeeId,
      2,
      { step: 2, identity: { aadhaarLast4: '9012' } } as never,
      tenantId,
      adminUserId,
    );

    const [row] = await dbAdmin
      .select({ last4: employees.aadhaar_last4 })
      .from(employees)
      .where(eq(employees.id, employeeId));
    expect(row!.last4).toBe('9012');

    const detail = await service.getEmployee(employeeId, tenantId);
    expect(detail.aadhaarLast4).toBe('9012');
    // Partial identity updates keep the passport written in the prior spec.
    expect(detail.hasPassport).toBe(true);
  });

  it('identity DTO: PAN optional, aadhaarLast4 four digits exactly, passport capped at 20', () => {
    const ok = validateSync(
      plainToInstance(OnboardingIdentityDto, {
        aadhaarLast4: '1234',
        passportNumber: 'A1234567',
      }),
    );
    expect(ok).toHaveLength(0); // no PAN sent — still valid

    const badAadhaar = validateSync(
      plainToInstance(OnboardingIdentityDto, { aadhaarLast4: '123456789012' }),
    );
    expect(badAadhaar.some((e) => e.property === 'aadhaarLast4')).toBe(true);

    const nonNumeric = validateSync(
      plainToInstance(OnboardingIdentityDto, { aadhaarLast4: '12a4' }),
    );
    expect(nonNumeric.some((e) => e.property === 'aadhaarLast4')).toBe(true);

    const longPassport = validateSync(
      plainToInstance(OnboardingIdentityDto, { passportNumber: 'P'.repeat(21) }),
    );
    expect(longPassport.some((e) => e.property === 'passportNumber')).toBe(true);

    const badPan = validateSync(
      plainToInstance(OnboardingIdentityDto, { pan: 'NOT-A-PAN' }),
    );
    expect(badPan.some((e) => e.property === 'pan')).toBe(true);
  });

  it('getEmployee exposes the assigned location country_code', async () => {
    const [loc] = await dbAdmin
      .insert(locations)
      .values({
        tenant_id: tenantId,
        name: 'Dubai Office',
        timezone: 'Asia/Dubai',
        country_code: 'AE',
      })
      .returning();
    await dbAdmin
      .update(employees)
      .set({ location_id: loc!.id })
      .where(eq(employees.id, employeeId));

    const detail = await service.getEmployee(employeeId, tenantId);
    expect(detail.locationCountryCode).toBe('AE');
  });
});

describe('round 10 — terms re-acceptance contract (the stuck-gate regression)', () => {
  it('is required for a ledger-less user and clears after acceptance', async () => {
    await expect(consentService.requiresReacceptance(ledgerlessUserId)).resolves.toBe(true);

    // The gate's Continue button posts exactly this.
    await consentService.record(
      ledgerlessUserId,
      [{ type: 'terms_privacy', granted: true }],
      { source: 'settings', tenantId },
    );

    await expect(consentService.requiresReacceptance(ledgerlessUserId)).resolves.toBe(false);
  });

  it('stays required when the latest acceptance is for an outdated version', async () => {
    await dbAdmin.insert(consentRecords).values({
      user_id: ledgerlessUserId,
      tenant_id: tenantId,
      consent_type: 'terms_privacy',
      granted: true,
      policy_version: 'tos-2020-01-01',
      source: 'signup',
      // Strictly after the acceptance row so "latest" is unambiguous.
      occurred_at: new Date(Date.now() + 5_000),
    });
    await expect(consentService.requiresReacceptance(ledgerlessUserId)).resolves.toBe(true);
  });
});
