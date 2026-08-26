/**
 * Admin writes to employee detail groups (go-live round) — the owner/HR
 * "Edit personal & statutory" dialog reuses the self-onboarding step writer
 * targeted at any employee (POST /employees/:id/onboarding/:step). These
 * tests exercise the service call that route delegates to: fields persist
 * through the typed columns, and undefined fields never clobber existing
 * values (the blank-input-means-keep contract of the dialog).
 */
import 'dotenv/config';
import * as crypto from 'crypto';
import { dbAdmin } from '@flicks/db';
import { employees, memberships, tenants, users } from '@flicks/db/schema';
import { eq } from 'drizzle-orm';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DatabaseService } from '../core/database/database.service';
import { EmployeesService } from '../modules/employees/employees.service';
import type { AuditService } from '../modules/audit/audit.service';
import type { NotificationsService } from '../modules/notifications/notifications.service';
import type { AuthService } from '../modules/auth/auth.service';
import type { MediaService } from '../modules/media/media.service';

const rid = () => crypto.randomBytes(4).toString('hex');
const audit = { log: async () => {} } as unknown as AuditService;
const notifications = { sendEmail: jest.fn(async () => {}) } as unknown as NotificationsService;
const auth = {} as unknown as AuthService;
// Encryption live, like production (EMPLOYEE_DATA_ENC_KEY set).
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
  // MediaService stub: echo the key so specs can assert the avatar pipeline.
  { servedUrl: async (k: string | null, l: string | null) => (k ? `signed:${k}` : l) } as unknown as MediaService,
);

let tenantId: string;
let adminUserId: string;
let employeeId: string;

beforeAll(async () => {
  const [t] = await dbAdmin
    .insert(tenants)
    .values({ name: `DetailsCo${rid()}`, slug: `details-${rid()}-${Date.now()}`, status: 'active', currency: 'INR' })
    .returning();
  tenantId = t!.id;

  const [admin] = await dbAdmin
    .insert(users)
    .values({ email: `admin-${rid()}@details.test`, full_name: 'Admin Details', status: 'active' })
    .returning();
  adminUserId = admin!.id;
  await dbAdmin.insert(memberships).values({
    tenant_id: tenantId, user_id: adminUserId, role: 'owner', status: 'active', accepted_at: new Date(),
  });

  const [emp] = await dbAdmin
    .insert(employees)
    .values({
      tenant_id: tenantId,
      employee_code: `DET${rid().slice(0, 4).toUpperCase()}`,
      first_name: 'Target',
      last_name: 'Employee',
      work_email: `target-${rid()}@details.test`,
      date_of_joining: '2026-01-05',
    })
    .returning();
  employeeId = emp!.id;
});

afterAll(async () => {
  await dbAdmin.delete(employees).where(eq(employees.tenant_id, tenantId));
  await dbAdmin.delete(memberships).where(eq(memberships.tenant_id, tenantId));
  await dbAdmin.delete(tenants).where(eq(tenants.id, tenantId));
  await dbAdmin.delete(users).where(eq(users.id, adminUserId));
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
});

describe('admin employee-details writes (onboarding step writer, admin-targeted)', () => {
  it('bank + statutory fields persist through the typed columns', async () => {
    await service.submitOnboardingStep(
      employeeId,
      3,
      {
        step: 3,
        bank: {
          bankName: 'HDFC Bank',
          bankBranch: 'Chennai Main',
          bankAccountNumber: '123456789012',
          bankAccountHolder: 'Target Employee',
          bankIfsc: 'HDFC0001234',
          bankAccountType: 'salary',
          pfUan: '100200300400',
        },
      } as never,
      tenantId,
      adminUserId,
    );

    const [row] = await dbAdmin
      .select({
        bankName: employees.bank_name,
        ifsc: employees.bank_ifsc,
        acctEnc: employees.bank_account_number_encrypted,
        uan: employees.pf_uan,
        type: employees.bank_account_type,
      })
      .from(employees)
      .where(eq(employees.id, employeeId));
    expect(row!.bankName).toBe('HDFC Bank');
    expect(row!.ifsc).toBe('HDFC0001234');
    expect(row!.uan).toBe('100200300400');
    expect(row!.type).toBe('salary');
    expect(row!.acctEnc).toBeTruthy();
    // Stored encrypted (iv:tag:ciphertext), never as plaintext.
    expect(row!.acctEnc).not.toBe('123456789012');
    expect(row!.acctEnc).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
  });

  it('undefined fields keep existing values (blank input = no change)', async () => {
    // Write identity (PAN) first…
    await service.submitOnboardingStep(
      employeeId,
      2,
      { step: 2, identity: { pan: 'ABCDE1234F' } } as never,
      tenantId,
      adminUserId,
    );
    const before = await dbAdmin
      .select({ pan: employees.pan_encrypted, ifsc: employees.bank_ifsc })
      .from(employees)
      .where(eq(employees.id, employeeId));
    expect(before[0]!.pan).toBeTruthy();

    // …then a bank-only update with a single field must not touch PAN (or
    // the other bank columns).
    await service.submitOnboardingStep(
      employeeId,
      3,
      { step: 3, bank: { bankBranch: 'Chennai Anna Nagar' } } as never,
      tenantId,
      adminUserId,
    );

    const after = await dbAdmin
      .select({
        pan: employees.pan_encrypted,
        ifsc: employees.bank_ifsc,
        branch: employees.bank_branch,
      })
      .from(employees)
      .where(eq(employees.id, employeeId));
    expect(after[0]!.pan).toBe(before[0]!.pan);
    expect(after[0]!.ifsc).toBe('HDFC0001234');
    expect(after[0]!.branch).toBe('Chennai Anna Nagar');
  });
});
