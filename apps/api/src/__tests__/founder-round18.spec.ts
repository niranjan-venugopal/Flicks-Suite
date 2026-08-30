/**
 * Founder round 18:
 *
 *  - An HR admin's onboarding is the OWNER's to sign off. A peer admin holds
 *    the same powers, so approving a colleague would be self-review by proxy:
 *    the queue hides those rows from admins and approve/reject 403s. The one
 *    exception is a workspace with no active owner — otherwise a pending admin
 *    would be stranded with nobody able to approve them.
 *  - A client outside India is an EXPORT of services: no GSTIN asked or
 *    accepted, zero-rated under LUT, place of supply = the statutory '96', and
 *    the invoice lands in the GSTR-1 EXP bucket instead of B2B/B2CL (which is
 *    where every foreign invoice went before, because nothing could set
 *    customers.country_code).
 *  - Invoices delete softly (restorable), never once a payment exists, and the
 *    number is never reissued. Clients delete hard when unbilled, soft when
 *    they have documents — and the next client code must not collide.
 *
 * Service-level against the real Postgres, mirroring invoicing-services.spec.
 */
import 'dotenv/config';
import * as crypto from 'crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db, dbAdmin } from '@flicks/db';
import {
  tenants,
  users,
  memberships,
  employees,
  invoices as invoicesTable,
  customers as customersTable,
} from '@flicks/db/schema';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DatabaseService } from '../core/database/database.service';
import { EmployeesService } from '../modules/employees/employees.service';
import { DashboardService } from '../modules/dashboard/dashboard.service';
import { CustomersService } from '../modules/invoicing/customers.service';
import { InvoicesService } from '../modules/invoicing/invoices.service';
import { NumberingService } from '../modules/invoicing/numbering.service';
import { InvReportsService } from '../modules/invoicing/inv-reports.service';
import { OrgFinancialService } from '../modules/org-financial/org-financial.service';
import type { AuditService } from '../modules/audit/audit.service';
import type { NotificationsService } from '../modules/notifications/notifications.service';
import type { AuthService } from '../modules/auth/auth.service';
import type { MediaService } from '../modules/media/media.service';

const rid = () => crypto.randomBytes(4).toString('hex');
const audit = { log: async () => undefined } as unknown as AuditService;
const createInAppNotification = jest.fn(async () => undefined);
const sendEmail = jest.fn(async () => true);
const notifications = {
  createInAppNotification,
  sendEmail,
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

const numbering = new NumberingService(dbSvc, audit);
const orgFinancial = new OrgFinancialService(dbSvc, audit);
const configStub = {
  get: (key: string, fallback?: unknown) =>
    key === 'PUBLIC_INVOICE_BASE_URL' ? 'http://localhost:3000' : fallback,
} as unknown as ConfigService;
const customersSvc = new CustomersService(dbSvc, audit);
const invoicesSvc = new InvoicesService(
  dbSvc,
  audit,
  numbering,
  configStub,
  notifications,
  orgFinancial,
  { publish: async () => null } as never,
);
const reportsSvc = new InvReportsService(dbSvc, audit);

// ─── Part 1: owner-only approval of HR staff ────────────────────────────────

describe('an HR admin is approved by the owner, not by a peer admin', () => {
  let tenantId: string;
  let ownerUserId: string;
  let adminAUserId: string; // the peer admin — must not review a colleague
  let pendingAdminUserId: string; // the HR admin awaiting review
  let plainEmpUserId: string;
  let pendingAdminEmpId: string;
  let plainEmpId: string;
  let invitedEmpId: string; // no user, no membership
  const trackedUsers: string[] = [];

  const seedUser = async (email: string) => {
    const [u] = await dbAdmin
      .insert(users)
      .values({ email, full_name: 'Round Eighteen', status: 'active' })
      .returning();
    trackedUsers.push(u!.id);
    return u!.id;
  };

  beforeAll(async () => {
    const [t] = await dbAdmin
      .insert(tenants)
      .values({
        name: `R18Co${rid()}`,
        slug: `r18-${rid()}-${Date.now()}`,
        status: 'active',
        currency: 'INR',
        state_code: 'KA',
      })
      .returning();
    tenantId = t!.id;

    ownerUserId = await seedUser(`owner-${rid()}@r18.test`);
    adminAUserId = await seedUser(`admin-a-${rid()}@r18.test`);
    pendingAdminUserId = await seedUser(`admin-pending-${rid()}@r18.test`);
    plainEmpUserId = await seedUser(`emp-${rid()}@r18.test`);

    const mkEmp = async (values: Record<string, unknown>) => {
      const [e] = await dbAdmin
        .insert(employees)
        .values({
          tenant_id: tenantId,
          employee_code: `R18${rid().slice(0, 5).toUpperCase()}`,
          first_name: 'Round',
          last_name: 'Eighteen',
          work_email: `emp-${rid()}@r18.test`,
          date_of_joining: '2026-08-01',
          status: 'inactive',
          custom_fields: {
            onboarding_step: 5,
            onboarding_submitted_for_review: true,
            onboarding_submitted_at: new Date().toISOString(),
          },
          ...values,
        } as never)
        .returning();
      return e!.id;
    };

    pendingAdminEmpId = await mkEmp({ user_id: pendingAdminUserId });
    plainEmpId = await mkEmp({ user_id: plainEmpUserId });
    invitedEmpId = await mkEmp({}); // user_id NULL, no membership row

    const seats: Array<[string, 'owner' | 'admin' | 'employee', 'active' | 'invited', string | null]> = [
      [ownerUserId, 'owner', 'active', null],
      [adminAUserId, 'admin', 'active', null],
      // Still 'invited' — a pending admin's seat is not active yet, which is
      // exactly why the queue must not filter memberships on status.
      [pendingAdminUserId, 'admin', 'invited', pendingAdminEmpId],
      [plainEmpUserId, 'employee', 'active', plainEmpId],
    ];
    for (const [userId, role, status, employeeId] of seats) {
      await dbAdmin.insert(memberships).values({
        tenant_id: tenantId,
        user_id: userId,
        role,
        status,
        ...(employeeId ? { employee_id: employeeId } : {}),
        ...(status === 'active' ? { accepted_at: new Date() } : {}),
      } as never);
    }
  });

  afterAll(async () => {
    await dbAdmin.delete(tenants).where(eq(tenants.id, tenantId));
    for (const id of trackedUsers)
      await dbAdmin.delete(users).where(eq(users.id, id));
  });

  it('hides the pending HR admin from another admin, but not the ordinary joiners', async () => {
    const forAdmin = await employeesService.getOnboardingQueue(tenantId, adminAUserId);
    const ids = forAdmin.data.map((r) => r.id);
    expect(ids).not.toContain(pendingAdminEmpId);
    expect(ids).toContain(plainEmpId);
    // No membership at all ⇒ not an admin ⇒ still reviewable by HR.
    expect(ids).toContain(invitedEmpId);
  });

  it('shows every pending row to the owner', async () => {
    const forOwner = await employeesService.getOnboardingQueue(tenantId, ownerUserId);
    const ids = forOwner.data.map((r) => r.id);
    expect(ids).toContain(pendingAdminEmpId);
    expect(ids).toContain(plainEmpId);
    expect(ids).toContain(invitedEmpId);
  });

  it('refuses approve and reject of an HR admin by a peer admin', async () => {
    await expect(
      employeesService.approveOnboarding(pendingAdminEmpId, adminAUserId, tenantId),
    ).rejects.toThrow(/only be reviewed by an owner/i);
    await expect(
      employeesService.rejectOnboarding(pendingAdminEmpId, 'no', adminAUserId, tenantId),
    ).rejects.toThrow(/only be reviewed by an owner/i);

    const [row] = await dbAdmin
      .select({ status: employees.status })
      .from(employees)
      .where(eq(employees.id, pendingAdminEmpId));
    expect(row!.status).toBe('inactive');
  });

  it('lets an admin still approve an ordinary joiner', async () => {
    const res = await employeesService.approveOnboarding(
      plainEmpId,
      adminAUserId,
      tenantId,
    );
    expect(res.status).toBe('active');
  });

  it('lets the owner approve the HR admin', async () => {
    const res = await employeesService.approveOnboarding(
      pendingAdminEmpId,
      ownerUserId,
      tenantId,
    );
    expect(res.status).toBe('active');
  });

  it('mirrors the rule in the dashboard approvals bucket', async () => {
    // invitedEmpId is the only row left pending; it has no membership, so both
    // roles see it — proving the filter targets admin seats, not everything.
    const forAdmin = await dashboardService.getAdminOverview(tenantId, {
      callerUserId: adminAUserId,
      includeOnboarding: true,
      includeApprovals: true,
    });
    expect(forAdmin.pending.onboarding.map((o) => o.employeeId)).toContain(
      invitedEmpId,
    );
    expect(forAdmin.pending.onboarding.map((o) => o.employeeId)).not.toContain(
      pendingAdminEmpId,
    );
  });
});

describe('a workspace with no active owner does not strand its admins', () => {
  let tenantId: string;
  let adminAUserId: string;
  let pendingAdminUserId: string;
  let pendingAdminEmpId: string;
  const trackedUsers: string[] = [];

  beforeAll(async () => {
    const [t] = await dbAdmin
      .insert(tenants)
      .values({
        name: `R18NoOwner${rid()}`,
        slug: `r18no-${rid()}-${Date.now()}`,
        status: 'active',
        currency: 'INR',
      })
      .returning();
    tenantId = t!.id;

    for (const email of [`na-${rid()}@r18.test`, `nb-${rid()}@r18.test`]) {
      const [u] = await dbAdmin
        .insert(users)
        .values({ email, full_name: 'No Owner', status: 'active' })
        .returning();
      trackedUsers.push(u!.id);
    }
    [adminAUserId, pendingAdminUserId] = trackedUsers as [string, string];

    const [e] = await dbAdmin
      .insert(employees)
      .values({
        tenant_id: tenantId,
        employee_code: `R18N${rid().slice(0, 5).toUpperCase()}`,
        first_name: 'Pending',
        last_name: 'Admin',
        work_email: `pending-${rid()}@r18.test`,
        date_of_joining: '2026-08-01',
        status: 'inactive',
        user_id: pendingAdminUserId,
        custom_fields: {
          onboarding_step: 5,
          onboarding_submitted_for_review: true,
        },
      } as never)
      .returning();
    pendingAdminEmpId = e!.id;

    await dbAdmin.insert(memberships).values([
      {
        tenant_id: tenantId,
        user_id: adminAUserId,
        role: 'admin',
        status: 'active',
        accepted_at: new Date(),
      },
      {
        tenant_id: tenantId,
        user_id: pendingAdminUserId,
        role: 'admin',
        status: 'invited',
        employee_id: pendingAdminEmpId,
      },
    ] as never);
  });

  afterAll(async () => {
    await dbAdmin.delete(tenants).where(eq(tenants.id, tenantId));
    for (const id of trackedUsers)
      await dbAdmin.delete(users).where(eq(users.id, id));
  });

  it('shows the row and allows the approval', async () => {
    const queue = await employeesService.getOnboardingQueue(tenantId, adminAUserId);
    expect(queue.data.map((r) => r.id)).toContain(pendingAdminEmpId);
    const res = await employeesService.approveOnboarding(
      pendingAdminEmpId,
      adminAUserId,
      tenantId,
    );
    expect(res.status).toBe('active');
  });
});

// ─── Part 2: foreign clients, exports, and deletes ──────────────────────────

describe('foreign clients, export invoices, and deletes', () => {
  let tenantId: string;
  let userId: string;
  const trackedUsers: string[] = [];

  beforeAll(async () => {
    const [t] = await dbAdmin
      .insert(tenants)
      .values({
        name: `R18Inv${rid()}`,
        slug: `r18inv-${rid()}-${Date.now()}`,
        status: 'active',
        currency: 'INR',
        state_code: 'KA',
      })
      .returning();
    tenantId = t!.id;
    const [u] = await dbAdmin
      .insert(users)
      .values({ email: `inv-${rid()}@r18.test`, full_name: 'Inv User', status: 'active' })
      .returning();
    userId = u!.id;
    trackedUsers.push(u!.id);
    await dbAdmin.insert(memberships).values({
      tenant_id: tenantId,
      user_id: userId,
      role: 'owner',
      status: 'active',
      accepted_at: new Date(),
    } as never);
  });

  afterAll(async () => {
    await dbAdmin.delete(tenants).where(eq(tenants.id, tenantId));
    for (const id of trackedUsers)
      await dbAdmin.delete(users).where(eq(users.id, id));
    await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
    await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  });

  const mkLine = () => [
    { item_name: 'Consulting', quantity: '1', rate: '1000.00', gst_rate: '18' },
  ];

  it('stores a full billing address and rejects a GSTIN on a foreign client', async () => {
    const us = await customersSvc.create(
      {
        display_name: 'Globex Inc',
        country_code: 'US',
        billing_address_line1: '500 Market St',
        billing_city: 'San Francisco',
        billing_state: 'California',
        billing_postal_code: '94105',
        intl_tax_id: 'US-99-1234567',
        default_currency: 'USD',
      } as never,
      userId,
      tenantId,
    );
    expect(us.data.country_code).toBe('US');
    expect(us.data.billing_address_line1).toBe('500 Market St');
    expect(us.data.intl_tax_id).toBe('US-99-1234567');
    // No GSTIN was asked for, so none is stored.
    expect(us.data.gstin).toBeNull();
    expect(us.data.is_gst_registered).toBe(false);

    await expect(
      customersSvc.create(
        { display_name: 'Bad Intl', country_code: 'US', gstin: '29ABCDE1234F1Z5' } as never,
        userId,
        tenantId,
      ),
    ).rejects.toThrow(/cannot have a GSTIN/i);
  });

  it("clears the GSTIN when an Indian client moves abroad", async () => {
    const indian = await customersSvc.create(
      {
        display_name: 'Desi Corp',
        country_code: 'IN',
        state_code: 'KA',
        gstin: '29ABCDE1234F1Z5',
      } as never,
      userId,
      tenantId,
    );
    expect(indian.data.gstin).toBe('29ABCDE1234F1Z5');

    const moved = await customersSvc.update(
      indian.data.id,
      { country_code: 'US' } as never,
      userId,
      tenantId,
    );
    // The merged state is what matters — flipping only the country must not
    // leave a stale GSTIN behind.
    expect(moved.data!.gstin).toBeNull();
    expect(moved.data!.is_gst_registered).toBe(false);
  });

  it('treats a foreign client as a zero-rated export with place of supply 96', async () => {
    const c = await customersSvc.create(
      {
        display_name: 'Initech Ltd',
        country_code: 'GB',
        default_currency: 'INR',
        email: `initech-${rid()}@r18.test`,
      } as never,
      userId,
      tenantId,
    );
    const inv = await invoicesSvc.create(
      {
        customer_id: c.data.id,
        invoice_date: '2026-08-10',
        due_date: '2026-09-10',
        line_items: mkLine(),
      } as never,
      userId,
      tenantId,
    );
    expect(inv.data.tax_treatment).toBe('EXPORT');
    expect(inv.data.place_of_supply).toBe('96');
    expect(inv.data.export_route).toBe('LUT');
    // Zero-rated under LUT: no GST on the document.
    expect(parseFloat(inv.data.igst_amount ?? '0')).toBe(0);
    expect(parseFloat(inv.data.cgst_amount ?? '0')).toBe(0);
    // Issue it so the GSTR-1 test below has something to file (drafts are
    // deliberately excluded from the return).
    await invoicesSvc.send(inv.data.id, userId, tenantId);
  });

  it('charges IGST when the tenant exports on payment of tax', async () => {
    const c = await customersSvc.create(
      {
        display_name: 'Payer GmbH',
        country_code: 'DE',
        default_currency: 'INR',
        email: `payer-${rid()}@r18.test`,
      } as never,
      userId,
      tenantId,
    );
    const inv = await invoicesSvc.create(
      {
        customer_id: c.data.id,
        invoice_date: '2026-08-10',
        due_date: '2026-09-10',
        export_route: 'WITH_IGST',
        line_items: mkLine(),
      } as never,
      userId,
      tenantId,
    );
    expect(inv.data.export_route).toBe('WITH_IGST');
    expect(parseFloat(inv.data.igst_amount ?? '0')).toBeGreaterThan(0);
    await invoicesSvc.send(inv.data.id, userId, tenantId);
  });

  it('files an export in the GSTR-1 EXP bucket as URP / 96, not B2B', async () => {
    const gstr = await reportsSvc.generateGstr1(
      { period_month: 8, period_year: 2026 } as never,
      userId,
      tenantId,
    );
    const payload = (gstr.data as unknown as { payload: unknown }).payload as {
      gstr1: {
        exp: Array<{ customer_gstin: string; place_of_supply: string; export_route: string }>;
        b2b: Array<{ invoice_number: string }>;
      };
    };
    expect(payload.gstr1.exp.length).toBeGreaterThan(0);
    for (const row of payload.gstr1.exp) {
      expect(row.customer_gstin).toBe('URP');
      expect(row.place_of_supply).toBe('96');
      expect(['LUT', 'WITH_IGST']).toContain(row.export_route);
    }
  });

  it('soft-deletes a draft, hides it, and restores it — without reusing the number', async () => {
    const c = await customersSvc.create(
      { display_name: 'Delete Me Co', country_code: 'IN', state_code: 'KA' } as never,
      userId,
      tenantId,
    );
    const draft = await invoicesSvc.create(
      {
        customer_id: c.data.id,
        invoice_date: '2026-08-11',
        due_date: '2026-09-11',
        line_items: mkLine(),
      } as never,
      userId,
      tenantId,
    );
    const deletedNumber = draft.data.invoice_number;

    await invoicesSvc.softDelete(draft.data.id, userId, tenantId);

    const live = await invoicesSvc.list(tenantId, {} as never);
    expect(live.data.map((r) => r.id)).not.toContain(draft.data.id);
    const binned = await invoicesSvc.list(tenantId, { deleted: 'true' } as never);
    expect(binned.data.map((r) => r.id)).toContain(draft.data.id);
    // A deleted invoice must not resolve by id either.
    await expect(invoicesSvc.get(tenantId, draft.data.id)).rejects.toThrow(/not found/i);

    // The number is burned: the next invoice gets a new one.
    const next = await invoicesSvc.create(
      {
        customer_id: c.data.id,
        invoice_date: '2026-08-12',
        due_date: '2026-09-12',
        line_items: mkLine(),
      } as never,
      userId,
      tenantId,
    );
    expect(next.data.invoice_number).not.toBe(deletedNumber);

    await invoicesSvc.restore(draft.data.id, userId, tenantId);
    const back = await invoicesSvc.get(tenantId, draft.data.id);
    expect(back.data.invoice_number).toBe(deletedNumber);
  });

  it('refuses to delete an invoice that has a recorded payment', async () => {
    const c = await customersSvc.create(
      { display_name: 'Paid Co', country_code: 'IN', state_code: 'KA', email: 'paid@r18.test' } as never,
      userId,
      tenantId,
    );
    const inv = await invoicesSvc.create(
      {
        customer_id: c.data.id,
        invoice_date: '2026-08-13',
        due_date: '2026-09-13',
        line_items: mkLine(),
      } as never,
      userId,
      tenantId,
    );
    await invoicesSvc.send(inv.data.id, userId, tenantId);
    await invoicesSvc.recordPayment(
      inv.data.id,
      { amount: '100', payment_method: 'OTHER', payment_date: '2026-08-14' } as never,
      userId,
      tenantId,
    );

    await expect(
      invoicesSvc.softDelete(inv.data.id, userId, tenantId),
    ).rejects.toThrow(/Remove the recorded payment first/i);

    // …and it survives.
    const still = await invoicesSvc.get(tenantId, inv.data.id);
    expect(still.data.id).toBe(inv.data.id);
  });

  it('deletes an unbilled client outright and does not collide on the next code', async () => {
    const before = await customersSvc.create(
      { display_name: 'Throwaway Ltd', country_code: 'IN', state_code: 'KA' } as never,
      userId,
      tenantId,
    );
    const res = await customersSvc.remove(before.data.id, userId, tenantId);
    expect(res.data.mode).toBe('hard');

    const [gone] = await dbAdmin
      .select({ n: sql<number>`count(*)::int` })
      .from(customersTable)
      .where(eq(customersTable.id, before.data.id));
    expect(gone!.n).toBe(0);

    // count(*)+1 would now hand out an existing code and 409 — the regression
    // this guards.
    const after = await customersSvc.create(
      { display_name: 'Next Client', country_code: 'IN', state_code: 'KA' } as never,
      userId,
      tenantId,
    );
    expect(after.data.id).toBeTruthy();
  });

  it('archives a billed client instead, and drops it from the list', async () => {
    const c = await customersSvc.create(
      { display_name: 'Billed Co', country_code: 'IN', state_code: 'KA' } as never,
      userId,
      tenantId,
    );
    await invoicesSvc.create(
      {
        customer_id: c.data.id,
        invoice_date: '2026-08-15',
        due_date: '2026-09-15',
        line_items: mkLine(),
      } as never,
      userId,
      tenantId,
    );

    const res = await customersSvc.remove(c.data.id, userId, tenantId);
    expect(res.data.mode).toBe('soft');
    expect(res.data.references.invoices).toBeGreaterThan(0);

    const list = await customersSvc.list(tenantId, {} as never);
    expect(list.data.map((r) => r.id)).not.toContain(c.data.id);
    // The row survives so past invoices still resolve their customer.
    const [row] = await dbAdmin
      .select({ deleted_at: customersTable.deleted_at })
      .from(customersTable)
      .where(eq(customersTable.id, c.data.id));
    expect(row!.deleted_at).toBeTruthy();
  });

  it('keeps a deleted invoice out of the reports', async () => {
    const c = await customersSvc.create(
      {
        display_name: 'Reported Co',
        country_code: 'IN',
        state_code: 'KA',
        email: `reported-${rid()}@r18.test`,
      } as never,
      userId,
      tenantId,
    );
    const inv = await invoicesSvc.create(
      {
        customer_id: c.data.id,
        invoice_date: '2026-08-16',
        due_date: '2026-09-16',
        line_items: mkLine(),
      } as never,
      userId,
      tenantId,
    );
    await invoicesSvc.send(inv.data.id, userId, tenantId);

    const before = await reportsSvc.dashboard(tenantId);
    await invoicesSvc.softDelete(inv.data.id, userId, tenantId);
    const after = await reportsSvc.dashboard(tenantId);

    // The money stops being counted, not just the row hidden from a list.
    expect(after.data.open).toBe(before.data.open - 1);
    expect(parseFloat(after.data.outstanding)).toBeLessThan(
      parseFloat(before.data.outstanding),
    );

    const [row] = await dbAdmin
      .select({ deleted_at: invoicesTable.deleted_at })
      .from(invoicesTable)
      .where(and(eq(invoicesTable.id, inv.data.id), eq(invoicesTable.tenant_id, tenantId)));
    expect(row!.deleted_at).toBeTruthy();
  });
});
