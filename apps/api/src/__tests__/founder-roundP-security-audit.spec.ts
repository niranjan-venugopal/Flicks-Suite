/**
 * Round P security audit (2026-10-06) — regression pins for the fixes.
 *
 * The founder asked for proof that nothing leaks between companies and that
 * sensitive data is encrypted. A live two-company attack harness (200 cross-
 * company requests, every asset / policy / project / grant route as every
 * role) found no cross-company read or write; these tests pin the weaknesses
 * the audit did find, so they cannot come back:
 *  1. @Roles(...) ranked the role baked into the 15-minute access token — a
 *     removed or demoted HR admin kept the asset register (and every other
 *     admin route) until it expired. RolesGuard now ranks the LIVE seat.
 *  2. The organisation export wrote member-editable text to CSV without
 *     formula neutralisation, and shipped live secrets (Razorpay tokens,
 *     webhook secret, mandate / public-view tokens) in a 7-day link.
 *  3. External auditors could be granted company-policy management.
 *  4. HR edit requests stored the passport number in plain text.
 *  5. Employee-document "signed" URLs were permanent public links.
 */
import 'dotenv/config';
import * as crypto from 'crypto';
import { and, eq } from 'drizzle-orm';
import { db, dbAdmin } from '@flicks/db';
import {
  employees,
  employeeChangeRequests,
  membershipGrants,
  memberships,
  tenants,
  users,
} from '@flicks/db/schema';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { JwtPayload, UserRole } from '@flicks/shared/types';

// Encryption live, like production — must be set before the services are built.
process.env.EMPLOYEE_DATA_ENC_KEY = 'a'.repeat(64);

import { DatabaseService } from '../core/database/database.service';
import { ModuleAccessService } from '../core/auth/module-access.service';
import { RolesGuard } from '../core/auth/guards/roles.guard';
import { FieldCipher } from '../core/common/field-cipher';
import { EmployeesService } from '../modules/employees/employees.service';
import { MembersService } from '../modules/members/members.service';
import { exportCsvCell, stripExportSecrets } from '../modules/consent/data-export.service';
import type { AuditService } from '../modules/audit/audit.service';
import type { NotificationsService } from '../modules/notifications/notifications.service';
import type { AuthService } from '../modules/auth/auth.service';
import type { MediaService } from '../modules/media/media.service';
import type { R2Service } from '../core/storage/r2.service';

const rid = () => crypto.randomBytes(4).toString('hex');
const audit = { log: jest.fn(async () => undefined) } as unknown as AuditService;
const notifications = { sendEmail: jest.fn(async () => true), createInAppNotification: jest.fn(async () => undefined) } as unknown as NotificationsService;
const media = { servedUrl: async (k: string | null, l: string | null) => (k ? `signed:${k}` : l) } as unknown as MediaService;
const dbSvc = new DatabaseService();
const moduleAccess = new ModuleAccessService(dbSvc, dbAdmin as never);
const config = new ConfigService({ NODE_ENV: 'test', R2_PUBLIC_URL: 'https://files.example.test' });
const signedGetUrl = jest.fn(async (key: string, ttl?: number) => `https://r2.example.test/${key}?X-Amz-Expires=${ttl}&X-Amz-Signature=abc`);
const r2 = { isConfigured: () => true, signedGetUrl } as unknown as R2Service;
const mkEmployees = (withR2: boolean) =>
  new EmployeesService(
    dbSvc,
    dbAdmin as never,
    audit,
    notifications,
    new EventEmitter2(),
    config,
    {} as unknown as AuthService,
    media,
    withR2 ? r2 : undefined,
  );
const employeesSvc = mkEmployees(true);
const members = new MembersService(dbSvc, dbAdmin as never, audit, notifications, {} as unknown as AuthService, moduleAccess, media);

let tenantId: string;
const userIds: string[] = [];

async function seat(role: UserRole, label: string, withEmployee = false) {
  const [u] = await dbAdmin
    .insert(users)
    .values({ email: `sec-${label}-${rid()}@t.test`, full_name: `Sec ${label}`, status: 'active' })
    .returning();
  userIds.push(u!.id);
  let employeeId: string | null = null;
  if (withEmployee) {
    const [e] = await dbAdmin
      .insert(employees)
      .values({
        tenant_id: tenantId,
        user_id: u!.id,
        employee_code: `SEC-${rid()}`,
        first_name: label,
        last_name: 'Audit',
        work_email: `sec-work-${rid()}@t.test`,
        date_of_joining: '2026-01-01',
        status: 'active',
      })
      .returning();
    employeeId = e!.id;
  }
  const [m] = await dbAdmin
    .insert(memberships)
    .values({ tenant_id: tenantId, user_id: u!.id, role, status: 'active', employee_id: employeeId, accepted_at: new Date() })
    .returning();
  return { userId: u!.id, membershipId: m!.id, employeeId };
}

beforeAll(async () => {
  const [t] = await dbAdmin
    .insert(tenants)
    .values({ name: `SecAudit ${rid()}`, slug: `sec-audit-${rid()}-${Date.now()}`, status: 'active', currency: 'INR' })
    .returning();
  tenantId = t!.id;
});

afterAll(async () => {
  await dbAdmin.delete(tenants).where(eq(tenants.id, tenantId));
  for (const id of userIds) await dbAdmin.delete(users).where(eq(users.id, id));
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
});

describe('1 — @Roles ranks the LIVE seat, not the 15-minute token', () => {
  const guardFor = (required: UserRole[]) =>
    new RolesGuard({ getAllAndOverride: () => required } as never, audit, moduleAccess);
  const ctxFor = (user: Partial<JwtPayload>) =>
    ({
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => ({ user, method: 'GET', originalUrl: '/api/v1/assets', headers: {} }) }),
    }) as unknown as ExecutionContext;

  it('a removed / deactivated / demoted HR admin is refused on the very next request; restoring the seat restores access', async () => {
    const hr = await seat('admin', 'hr');
    const token: Partial<JwtPayload> = { sub: hr.userId, tenantId, membershipId: hr.membershipId, role: 'admin', isPlatformAdmin: false };
    const guard = guardFor(['admin']);
    await expect(guard.canActivate(ctxFor(token))).resolves.toBe(true);

    await dbAdmin.update(memberships).set({ status: 'deactivated' }).where(eq(memberships.id, hr.membershipId));
    await expect(guard.canActivate(ctxFor(token))).rejects.toThrow(ForbiddenException);
    await expect(guard.canActivate(ctxFor(token))).rejects.toThrow('Your access to this workspace is no longer active');

    await dbAdmin.update(memberships).set({ status: 'active', role: 'employee' }).where(eq(memberships.id, hr.membershipId));
    await expect(guard.canActivate(ctxFor(token))).rejects.toThrow('Insufficient permissions');

    await dbAdmin.update(memberships).set({ role: 'admin', access_expires_at: new Date(Date.now() - 60_000) }).where(eq(memberships.id, hr.membershipId));
    await expect(guard.canActivate(ctxFor(token))).rejects.toThrow('no longer active');

    await dbAdmin.update(memberships).set({ access_expires_at: null }).where(eq(memberships.id, hr.membershipId));
    await expect(guard.canActivate(ctxFor(token))).resolves.toBe(true);
  });

  it('a membership id from another workspace never satisfies the gate', async () => {
    const hr = await seat('admin', 'hr2');
    const guard = guardFor(['admin']);
    const forged: Partial<JwtPayload> = { sub: hr.userId, tenantId: crypto.randomUUID(), membershipId: hr.membershipId, role: 'owner', isPlatformAdmin: false };
    await expect(guard.canActivate(ctxFor(forged))).rejects.toThrow('no longer active');
  });

  it('a live promotion counts immediately too (the seat, not the token, is the truth)', async () => {
    const emp = await seat('employee', 'promo');
    const token: Partial<JwtPayload> = { sub: emp.userId, tenantId, membershipId: emp.membershipId, role: 'employee', isPlatformAdmin: false };
    await expect(guardFor(['admin']).canActivate(ctxFor(token))).rejects.toThrow('Insufficient permissions');
    await dbAdmin.update(memberships).set({ role: 'admin' }).where(eq(memberships.id, emp.membershipId));
    await expect(guardFor(['admin']).canActivate(ctxFor(token))).resolves.toBe(true);
  });
});

describe('2 — organisation export: formula-safe CSV, no secrets', () => {
  it('text starting with = + - @ tab CR is neutralised; plain numbers keep their sign', () => {
    expect(exportCsvCell('=HYPERLINK("http://evil","x")')).toBe(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(exportCsvCell('+91 98765 43210')).toBe(`'+91 98765 43210`);
    expect(exportCsvCell('@SUM(A1)')).toBe(`'@SUM(A1)`);
    expect(exportCsvCell('-2+3+cmd|calc')).toBe(`'-2+3+cmd|calc`);
    expect(exportCsvCell('\tinjected')).toBe(`'\tinjected`);
    expect(exportCsvCell('-500.00')).toBe('-500.00');
    expect(exportCsvCell(-500)).toBe('-500');
    expect(exportCsvCell('Asha, HR')).toBe('"Asha, HR"');
    expect(exportCsvCell('line\rbreak')).toBe('"line\rbreak"');
    expect(exportCsvCell(null)).toBe('');
  });

  it('secret, token, ciphertext and storage-key columns never reach the export', () => {
    const out = stripExportSecrets({
      settings: [
        {
          tenant_id: 't',
          razorpay_access_token: 'enc',
          razorpay_refresh_token: 'enc',
          razorpay_public_token: 'pk',
          razorpay_oauth_state: 'st',
          razorpay_webhook_secret: 'whsec',
          razorpay_token_expires_at: 'x',
          invoice_prefix: 'INV',
        },
      ],
      invoices: [{ id: 'i', public_view_token: 'tok', public_view_token_expires_at: 'x', pdf_storage_key: 'k', total: '10.00' }],
      subscriptions: [{ id: 's', mandate_token: 'm', mandate_token_expires_at: 'x', amount: '5.00' }],
      employees: [{ id: 'e', first_name: 'A', pan_encrypted: 'iv:tag:ct', passport_number_encrypted: 'x', bank_account_number_encrypted: 'y', bank_ifsc: 'HDFC0001' }],
      assets: [{ id: 'a', name: 'Laptop', photo_key: 'tenants/t/assets/a/photo_x_256.webp' }],
    });
    expect(out.settings![0]).toEqual({ tenant_id: 't', invoice_prefix: 'INV' });
    expect(out.invoices![0]).toEqual({ id: 'i', total: '10.00' });
    expect(out.subscriptions![0]).toEqual({ id: 's', amount: '5.00' });
    expect(out.employees![0]).toEqual({ id: 'e', first_name: 'A', bank_ifsc: 'HDFC0001' });
    expect(out.assets![0]).toEqual({ id: 'a', name: 'Laptop' });
  });
});

describe('3 — external auditors never get company policies', () => {
  it('a stray grant row does not open the module; the grant writers refuse it', async () => {
    const owner = await seat('owner', 'owner');
    const auditor = await seat('auditor', 'auditor');
    await dbAdmin.insert(membershipGrants).values({ tenant_id: tenantId, membership_id: auditor.membershipId, module: 'policies', access_level: 'edit' });
    const res = await moduleAccess.resolve(tenantId, auditor.membershipId, 'auditor', 'policies', auditor.userId);
    expect(res.level).toBe('none');

    await dbAdmin.delete(membershipGrants).where(and(eq(membershipGrants.tenant_id, tenantId), eq(membershipGrants.membership_id, auditor.membershipId)));
    await expect(members.upsertGrant(auditor.membershipId, 'policies', { access_level: 'view' } as never, owner.userId, tenantId)).rejects.toThrow(ConflictException);
    await expect(
      members.updateRoleDefaults({ defaults: [{ role: 'auditor', module: 'policies', access_level: 'view' }] } as never, owner.userId, tenantId),
    ).rejects.toThrow(ConflictException);
    // Explicitly turning it OFF stays allowed.
    await expect(members.upsertGrant(auditor.membershipId, 'policies', { access_level: 'none' } as never, owner.userId, tenantId)).resolves.toBeTruthy();
  });

  it('a manager can still be granted policies (the rule is auditor/guest only)', async () => {
    const owner = await seat('owner', 'owner2');
    const mgr = await seat('manager', 'mgr');
    await members.upsertGrant(mgr.membershipId, 'policies', { access_level: 'view' } as never, owner.userId, tenantId);
    const res = await moduleAccess.resolve(tenantId, mgr.membershipId, 'manager', 'policies', mgr.userId);
    expect(res.level).toBe('view');
  });
});

describe('4 — HR edit requests keep the passport number encrypted at rest', () => {
  it('stored payload holds ciphertext; confirming applies the real value to the encrypted column', async () => {
    const hr = await seat('owner', 'hr-edit');
    const emp = await seat('employee', 'traveller', true);
    const res = await employeesSvc.adminSubmitEmployeeDetails(
      emp.employeeId!,
      2,
      { step: 2, identity: { passportNumber: 'Z1234567', pan: 'ABCDE1234F' } } as never,
      tenantId,
      hr.userId,
    );
    expect(res.pendingConfirmation).toBe(true);
    const [request] = await dbAdmin
      .select({ id: employeeChangeRequests.id, payload: employeeChangeRequests.payload })
      .from(employeeChangeRequests)
      .where(and(eq(employeeChangeRequests.tenant_id, tenantId), eq(employeeChangeRequests.employee_id, emp.employeeId!)));
    const identity = (request!.payload as { identity: Record<string, string> }).identity;
    expect(JSON.stringify(request!.payload)).not.toContain('Z1234567');
    expect(JSON.stringify(request!.payload)).not.toContain('ABCDE1234F');
    expect(identity.passportNumber).toMatch(/^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/);

    await employeesSvc.reviewMyChangeRequest(emp.userId, tenantId, request!.id, 'confirm');
    const [row] = await dbAdmin.select({ passport: employees.passport_number_encrypted }).from(employees).where(eq(employees.id, emp.employeeId!));
    expect(row!.passport).not.toBe('Z1234567');
    expect(new FieldCipher(process.env.EMPLOYEE_DATA_ENC_KEY, 'flicks-employee-fields-v1').decrypt(row!.passport!)).toBe('Z1234567');
  });
});

describe('5 — employee-document links are signed and short-lived', () => {
  it('signs a 15-minute GET; never hands out the public bucket URL', async () => {
    const out = await employeesSvc.generateSignedUrl('tenants/t/employees/e/docs/offer.pdf');
    expect(signedGetUrl).toHaveBeenCalledWith('tenants/t/employees/e/docs/offer.pdf', 900);
    expect(out.url).toContain('X-Amz-Signature');
    expect(out.url).not.toContain('files.example.test');
    expect(out.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(900_000);
  });

  it('no key → 404; no storage configured → 503 (never a public link)', async () => {
    await expect(employeesSvc.generateSignedUrl('')).rejects.toThrow(NotFoundException);
    await expect(mkEmployees(false).generateSignedUrl('tenants/t/x.pdf')).rejects.toThrow(ServiceUnavailableException);
  });
});
