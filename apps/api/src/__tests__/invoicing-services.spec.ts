/**
 * Invoicing service integration tests (Sprint 2) — exercises the real service
 * classes (CustomersService, ItemsService, HsnSacService, NumberingService)
 * against Postgres through the tenant (RLS) connection. Complements the pure
 * unit tests (numbering.util) and the cross-tenant isolation suite.
 */
import 'dotenv/config';
import { db, dbAdmin } from '@flicks/db';
import { tenants, users } from '@flicks/db/schema';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../core/database/database.service';
import { CustomersService } from '../modules/invoicing/customers.service';
import { ItemsService } from '../modules/invoicing/items.service';
import { HsnSacService } from '../modules/invoicing/hsn-sac.service';
import { NumberingService } from '../modules/invoicing/numbering.service';
import type { AuditService } from '../modules/audit/audit.service';

const audit = { log: async () => {} } as unknown as AuditService;
const dbSvc = new DatabaseService();
const customers = new CustomersService(dbSvc, audit);
const items = new ItemsService(dbSvc, audit);
const hsnSac = new HsnSacService(dbSvc, audit);
const numbering = new NumberingService(dbSvc, audit);

const rid = () => Math.random().toString(36).slice(2, 8);

describe('Invoicing services (Sprint 2 integration)', () => {
  let tenantId: string;
  let userId: string;

  beforeAll(async () => {
    const [t] = await dbAdmin
      .insert(tenants)
      .values({ name: `SvcCo${rid()}`, slug: `svc-${rid()}-${Date.now()}`, status: 'trialing' })
      .returning();
    tenantId = t!.id;
    const [u] = await dbAdmin
      .insert(users)
      .values({ email: `svc-${rid()}@test.test`, full_name: 'Svc User', status: 'active' })
      .returning();
    userId = u!.id;
  });

  afterAll(async () => {
    await dbAdmin.delete(tenants).where(eq(tenants.id, tenantId));
    await dbAdmin.delete(users).where(eq(users.id, userId));
  });

  describe('customers', () => {
    let createdId: string;

    it('auto-generates a sequential code and is listable', async () => {
      const created = await customers.create({ display_name: 'Acme Corp' }, userId, tenantId);
      expect(created.data.customer_code).toBe('CUST-0001');
      createdId = created.data.id;

      const listed = await customers.list(tenantId, {});
      expect(listed.data.some((c) => c.id === createdId)).toBe(true);
      expect(listed.pagination.total).toBeGreaterThanOrEqual(1);
    });

    it('increments the code on the next customer', async () => {
      const second = await customers.create({ display_name: 'Beta LLC' }, userId, tenantId);
      expect(second.data.customer_code).toBe('CUST-0002');
    });

    it('rejects a duplicate explicit code with 409', async () => {
      await expect(
        customers.create({ display_name: 'Dup', customer_code: 'CUST-0001' }, userId, tenantId),
      ).rejects.toThrow();
    });

    it('updates and archives', async () => {
      const updated = await customers.update(createdId, { display_name: 'Acme Renamed' } as any, userId, tenantId);
      expect(updated.data!.display_name).toBe('Acme Renamed');
      const archived = await customers.setStatus(createdId, 'archived', userId, tenantId);
      expect(archived.data!.status).toBe('archived');
    });
  });

  describe('items', () => {
    it('creates and lists an item', async () => {
      const created = await items.create({ name: 'Consulting hour', default_rate: '2500.00' }, userId, tenantId);
      expect(created.data.item_code).toBe('ITEM-0001');
      const listed = await items.list(tenantId, { q: 'Consulting' });
      expect(listed.data.some((i) => i.id === created.data.id)).toBe(true);
    });
  });

  describe('hsn/sac', () => {
    it('searches the global master', async () => {
      const res = await hsnSac.search(tenantId, { q: 'consulting' });
      expect(res.data.length).toBeGreaterThan(0);
      expect(res.data.every((r) => r.code)).toBe(true);
    });

    it('adds a tenant custom code and finds it', async () => {
      const code = `Z-${rid()}`;
      await hsnSac.addCustom({ code, type: 'SAC', description: 'Bespoke retainer' }, userId, tenantId);
      const res = await hsnSac.search(tenantId, { q: 'Bespoke' });
      expect(res.data.some((r) => r.code === code && r.source === 'tenant')).toBe(true);
    });
  });

  describe('numbering', () => {
    it('previews the next invoice number', async () => {
      const res = await numbering.preview(tenantId, { document_type: 'INVOICE' });
      expect(res.data.valid).toBe(true);
      expect(res.data.next_number_preview).toMatch(/^INV\/\d{2}-\d{2}\/0001$/);
    });

    it('reserves consecutive numbers atomically', async () => {
      const first = await dbSvc.withTenant(tenantId, (tx) =>
        numbering.reserveNext(tx, tenantId, 'INVOICE', '2026-06-01'),
      );
      const second = await dbSvc.withTenant(tenantId, (tx) =>
        numbering.reserveNext(tx, tenantId, 'INVOICE', '2026-06-01'),
      );
      expect(first.number).toBe(1);
      expect(second.number).toBe(2);
      expect(second.formatted).toMatch(/0002$/);
    });

    it('applies a config change via upsert and reflects it in preview', async () => {
      const up = await numbering.upsert(tenantId, { document_type: 'QUOTE', prefix: 'QTE' }, userId);
      expect(up.sample).toMatch(/^QTE\//);
      const prev = await numbering.preview(tenantId, { document_type: 'QUOTE' });
      expect(prev.data.next_number_preview).toMatch(/^QTE\//);
    });

    it('rejects an over-length number format', async () => {
      await expect(
        numbering.upsert(
          tenantId,
          { document_type: 'DEBIT_NOTE', prefix: 'TOOLONGPREFIX', fy_format: '2026-2027', zero_padding: 6 },
          userId,
        ),
      ).rejects.toThrow(/max 16/);
    });
  });
});

// ─── Sprint 3: invoices (GST/TDS totals, numbering, lifecycle) ────────────────
// Appended to reuse this file's tenant/user fixtures + open clients.
import { InvoicesService } from '../modules/invoicing/invoices.service';
import {
  tenants as tenantsTable,
  invoices as schemaInvoices,
} from '@flicks/db/schema';

// Config + email stubs for the invoice service (send() reads PUBLIC_INVOICE_BASE_URL
// and emails via NotificationsService — capture instead of sending).
const sentEmails: { template: string; to: string; props: Record<string, unknown> }[] = [];
const configStub = {
  get: (key: string, fallback?: unknown) =>
    key === 'PUBLIC_INVOICE_BASE_URL' ? 'http://localhost:3000' : fallback,
} as unknown as import('@nestjs/config').ConfigService;
const notificationsStub = {
  sendEmail: async (template: string, to: string, props: Record<string, unknown>) => {
    sentEmails.push({ template, to, props });
  },
} as unknown as import('../modules/notifications/notifications.service').NotificationsService;

import { OrgFinancialService } from '../modules/org-financial/org-financial.service';
const orgFinancial = new OrgFinancialService(dbSvc, audit);

describe('Invoicing services (Sprint 3 — invoices)', () => {
  const invoicesSvc = new InvoicesService(dbSvc, audit, numbering, configStub, notificationsStub, orgFinancial);
  let tenantId: string;
  let userId: string;
  let customerId: string;

  beforeAll(async () => {
    const [t] = await dbAdmin
      .insert(tenantsTable)
      .values({
        name: `InvCo${rid()}`,
        slug: `invco-${rid()}-${Date.now()}`,
        status: 'trialing',
        state_code: 'KA',
      })
      .returning();
    tenantId = t!.id;
    const [u] = await dbAdmin
      .insert(users)
      .values({ email: `inv-${rid()}@test.test`, full_name: 'Inv User', status: 'active' })
      .returning();
    userId = u!.id;
    const created = await customers.create(
      { display_name: 'GST Buyer', state_code: 'KA', gstin: '29ABCDE1234F1Z5' },
      userId,
      tenantId,
    );
    customerId = created.data.id;
  });

  afterAll(async () => {
    await dbAdmin.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
    await dbAdmin.delete(users).where(eq(users.id, userId));
  });

  it('creates a draft with server-computed intra-state GST + TDS and a reserved number', async () => {
    const res = await invoicesSvc.create(
      {
        customer_id: customerId,
        invoice_date: '2026-06-10',
        due_date: '2026-07-10',
        tds_rate: '10',
        tds_section: '393',
        line_items: [
          { item_name: 'Consulting', quantity: '2', rate: '5000.00', gst_rate: '18' },
        ],
      },
      userId,
      tenantId,
    );
    const inv = res.data;
    expect(inv.status).toBe('DRAFT');
    expect(inv.invoice_number).toMatch(/^INV\/\d{2}-\d{2}\/0001$/);
    expect(inv.subtotal).toBe('10000.00');
    // KA → KA = intra-state: 9% + 9%
    expect(inv.cgst_amount).toBe('900.00');
    expect(inv.sgst_amount).toBe('900.00');
    expect(inv.igst_amount).toBe('0.00');
    expect(inv.total_amount).toBe('11800.00');
    expect(inv.tds_amount).toBe('1000.00');
    expect(inv.net_receivable).toBe('10800.00');
    expect(inv.fx_rate_to_inr).toBe('1.000000');
  });

  it('reserves consecutive numbers across invoices', async () => {
    const res = await invoicesSvc.create(
      {
        customer_id: customerId,
        invoice_date: '2026-06-11',
        due_date: '2026-07-11',
        line_items: [{ item_name: 'Support', quantity: '1', rate: '100.00', gst_rate: '18' }],
      },
      userId,
      tenantId,
    );
    expect(res.data.invoice_number).toMatch(/0002$/);
  });

  it('updates a DRAFT and recomputes totals; blocks edits after leaving DRAFT', async () => {
    const created = await invoicesSvc.create(
      {
        customer_id: customerId,
        invoice_date: '2026-06-12',
        due_date: '2026-07-12',
        line_items: [{ item_name: 'A', quantity: '1', rate: '100.00', gst_rate: '18' }],
      },
      userId,
      tenantId,
    );
    const updated = await invoicesSvc.update(
      created.data.id,
      {
        discount_type: 'percent',
        discount_value: '10',
        line_items: [{ item_name: 'A', quantity: '1', rate: '200.00', gst_rate: '18' }],
      } as any,
      userId,
      tenantId,
    );
    expect(updated.data.subtotal).toBe('200.00');
    expect(updated.data.discount_amount).toBe('20.00');
    expect(updated.data.taxable_amount).toBe('180.00');

    // Force it out of DRAFT, then editing must fail.
    await dbAdmin
      .update(schemaInvoices)
      .set({ status: 'SENT' })
      .where(eq(schemaInvoices.id, created.data.id));
    await expect(
      invoicesSvc.update(created.data.id, { notes: 'nope' } as any, userId, tenantId),
    ).rejects.toThrow(/Only DRAFT/);
  });

  it('duplicates into a fresh DRAFT with a new number', async () => {
    const created = await invoicesSvc.create(
      {
        customer_id: customerId,
        invoice_date: '2026-06-13',
        due_date: '2026-07-13',
        line_items: [{ item_name: 'Dup me', quantity: '1', rate: '150.00', gst_rate: '18' }],
      },
      userId,
      tenantId,
    );
    const dup = await invoicesSvc.duplicate(created.data.id, userId, tenantId);
    expect(dup.data.id).not.toBe(created.data.id);
    expect(dup.data.invoice_number).not.toBe(created.data.invoice_number);
    expect(dup.data.status).toBe('DRAFT');
    expect(dup.data.subtotal).toBe('150.00');
  });

  it('lifecycle: cancel works from SENT; void blocked after viewing; write-off needs reason', async () => {
    const mk = async () =>
      (
        await invoicesSvc.create(
          {
            customer_id: customerId,
            invoice_date: '2026-06-14',
            due_date: '2026-07-14',
            line_items: [{ item_name: 'L', quantity: '1', rate: '100.00', gst_rate: '18' }],
          },
          userId,
          tenantId,
        )
      ).data;

    // cancel from SENT
    const a = await mk();
    await dbAdmin.update(schemaInvoices).set({ status: 'SENT' }).where(eq(schemaInvoices.id, a.id));
    const cancelled = await invoicesSvc.cancel(a.id, 'duplicate billing', userId, tenantId);
    expect(cancelled.data.status).toBe('CANCELLED');

    // void blocked once viewed
    const b = await mk();
    await dbAdmin
      .update(schemaInvoices)
      .set({ status: 'SENT', view_count: 2 })
      .where(eq(schemaInvoices.id, b.id));
    await expect(invoicesSvc.void(b.id, userId, tenantId)).rejects.toThrow(/viewed/);

    // write-off from OVERDUE
    const c = await mk();
    await dbAdmin.update(schemaInvoices).set({ status: 'OVERDUE' }).where(eq(schemaInvoices.id, c.id));
    const wrote = await invoicesSvc.writeOff(c.id, 'customer insolvent', userId, tenantId);
    expect(wrote.data.status).toBe('WRITE_OFF');
    expect(wrote.data.write_off_reason).toBe('customer insolvent');

    // invalid transition: write-off a DRAFT
    const d = await mk();
    await expect(invoicesSvc.writeOff(d.id, 'nope', userId, tenantId)).rejects.toThrow(
      /Cannot transition/,
    );
  });

  it('rejects export-state mishaps: due date before invoice date / empty lines', async () => {
    await expect(
      invoicesSvc.create(
        {
          customer_id: customerId,
          invoice_date: '2026-06-10',
          due_date: '2026-06-01',
          line_items: [{ item_name: 'X', quantity: '1', rate: '1.00' }],
        },
        userId,
        tenantId,
      ),
    ).rejects.toThrow(/Due date/);
    await expect(
      invoicesSvc.create(
        { customer_id: customerId, invoice_date: '2026-06-10', due_date: '2026-07-10', line_items: [] },
        userId,
        tenantId,
      ),
    ).rejects.toThrow(/line item/);
  });
});

// ─── Sprint 4: send, public page, payments, webhook ──────────────────────────
import { PublicInvoiceService } from '../modules/invoicing/public-invoice.service';
import { RazorpayWebhookController } from '../modules/invoicing/razorpay-webhook.controller';
import {
  customerCreditBalance as cbTable,
  razorpayWebhookEvents as rweTable,
} from '@flicks/db/schema';

describe('Invoicing services (Sprint 4 — send/public/payments)', () => {
  const invoicesSvc = new InvoicesService(dbSvc, audit, numbering, configStub, notificationsStub, orgFinancial);
  const publicSvc = new PublicInvoiceService(dbAdmin as any);
  let tenantId: string;
  let userId: string;
  let customerId: string;

  const mkInvoice = async (over: Record<string, unknown> = {}) =>
    (
      await invoicesSvc.create(
        {
          customer_id: customerId,
          invoice_date: '2026-06-12',
          due_date: '2026-07-12',
          line_items: [{ item_name: 'Retainer', quantity: '1', rate: '1000.00', gst_rate: '18' }],
          ...(over as object),
        } as any,
        userId,
        tenantId,
      )
    ).data;

  beforeAll(async () => {
    const [t] = await dbAdmin
      .insert(tenantsTable)
      .values({ name: `PayCo${rid()}`, slug: `payco-${rid()}-${Date.now()}`, status: 'trialing', state_code: 'KA' })
      .returning();
    tenantId = t!.id;
    const [u] = await dbAdmin
      .insert(users)
      .values({ email: `pay-${rid()}@test.test`, full_name: 'Pay User', status: 'active' })
      .returning();
    userId = u!.id;
    const c = await customers.create(
      { display_name: 'Payer Inc', email: 'payer@test.test', state_code: 'MH' },
      userId,
      tenantId,
    );
    customerId = c.data.id;
  });

  afterAll(async () => {
    await dbAdmin.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
    await dbAdmin.delete(users).where(eq(users.id, userId));
  });

  it('send: DRAFT → SENT, generates a public token and emails the View & Pay link', async () => {
    sentEmails.length = 0;
    const inv = await mkInvoice();
    const sent = await invoicesSvc.send(inv.id, userId, tenantId);
    expect(sent.data.status).toBe('SENT');
    expect(sent.data.public_view_token).toBeTruthy();
    expect(sent.meta.public_url).toContain(`/inv/${sent.data.public_view_token}`);
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0]!.template).toBe('invoice-sent');
    expect(sentEmails[0]!.to).toBe('payer@test.test');

    // Re-send keeps the SAME token (links stay valid).
    const again = await invoicesSvc.send(inv.id, userId, tenantId);
    expect(again.data.public_view_token).toBe(sent.data.public_view_token);
  });

  it('send: blocked without a customer email', async () => {
    const c2 = await customers.create({ display_name: 'No Email Co' }, userId, tenantId);
    const inv = await mkInvoice({ customer_id: c2.data.id });
    await expect(invoicesSvc.send(inv.id, userId, tenantId)).rejects.toThrow(/no email/);
  });

  it('public page: token resolves to a sanitized invoice; tracking flips SENT → VIEWED', async () => {
    const inv = await mkInvoice();
    const sent = await invoicesSvc.send(inv.id, userId, tenantId);
    const token = sent.data.public_view_token!;

    const pub = await publicSvc.getByToken(token);
    expect(pub.data.invoice.invoice_number).toBe(inv.invoice_number);
    expect(pub.data.seller?.name).toContain('PayCo');
    expect((pub.data.invoice as any).created_by).toBeUndefined(); // sanitized
    // MH customer + KA tenant ⇒ inter-state
    expect(pub.data.invoice.igst_amount).toBe('180.00');

    await publicSvc.trackView(token);
    await publicSvc.trackView(token);
    const after = await invoicesSvc.get(tenantId, inv.id);
    expect(after.data.status).toBe('VIEWED');
    expect(after.data.view_count).toBe(2);
    expect(after.data.first_viewed_at).toBeTruthy();

    await expect(publicSvc.getByToken('bogus-token')).rejects.toThrow(/not found/i);
  });

  it('payments: partial → PARTIALLY_PAID, completion → PAID, sequential PMT numbers', async () => {
    const inv = await mkInvoice();
    await invoicesSvc.send(inv.id, userId, tenantId);

    const p1 = await invoicesSvc.recordPayment(
      inv.id,
      { amount: '500.00', payment_method: 'BANK_TRANSFER' } as any,
      userId,
      tenantId,
    );
    expect(p1.data.payment_number).toMatch(/^PMT-\d{4}$/);
    expect(p1.meta.invoice_status).toBe('PARTIALLY_PAID');

    const p2 = await invoicesSvc.recordPayment(
      inv.id,
      { amount: '680.00', payment_method: 'UPI_DIRECT' } as any,
      userId,
      tenantId,
    );
    expect(p2.meta.invoice_status).toBe('PAID');
    const after = await invoicesSvc.get(tenantId, inv.id);
    expect(after.data.amount_paid).toBe('1180.00');
    expect(after.data.amount_outstanding).toBe('0.00');
    expect(after.data.paid_at).toBeTruthy();

    const n1 = parseInt(p1.data.payment_number.slice(4), 10);
    const n2 = parseInt(p2.data.payment_number.slice(4), 10);
    expect(n2).toBe(n1 + 1);
  });

  it('payments: overpayment books the excess into the customer credit balance', async () => {
    const inv = await mkInvoice(); // total 1180.00
    await invoicesSvc.send(inv.id, userId, tenantId);
    const p = await invoicesSvc.recordPayment(
      inv.id,
      { amount: '1300.00', payment_method: 'CASH' } as any,
      userId,
      tenantId,
    );
    expect(p.meta.invoice_status).toBe('PAID');
    expect(p.meta.overpaid).toBe('120.00');

    const [balance] = await dbAdmin
      .select()
      .from(cbTable)
      .where(eq(cbTable.customer_id, customerId));
    expect(parseFloat(balance!.balance_amount)).toBeGreaterThanOrEqual(120);
  });

  it('payments: rejected on DRAFT and for non-positive amounts', async () => {
    const inv = await mkInvoice();
    await expect(
      invoicesSvc.recordPayment(inv.id, { amount: '10.00', payment_method: 'CASH' } as any, userId, tenantId),
    ).rejects.toThrow(/DRAFT/);
    await invoicesSvc.send(inv.id, userId, tenantId);
    await expect(
      invoicesSvc.recordPayment(inv.id, { amount: '0.00', payment_method: 'CASH' } as any, userId, tenantId),
    ).rejects.toThrow(/positive/);
  });

  it('razorpay webhook: idempotent on event_id; unverified events stored but not applied', async () => {
    const webhook = new RazorpayWebhookController(dbAdmin as any, configStub as any, invoicesSvc);
    const inv = await mkInvoice();
    await invoicesSvc.send(inv.id, userId, tenantId);
    const evt = {
      id: `evt_test_${rid()}`,
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: `pay_${rid()}`,
            amount: 118000,
            method: 'upi',
            notes: { invoice_id: inv.id, tenant_id: tenantId },
          },
        },
      },
    };
    const r1 = await webhook.razorpay(evt as any, undefined, undefined);
    expect(r1.data.received).toBe(true);
    expect(r1.data.verified).toBe(false); // no secret configured → not applied
    const r2 = await webhook.razorpay(evt as any, undefined, undefined);
    expect((r2.data as any).duplicate).toBe(true);

    // Stored exactly once; invoice untouched (unverified).
    const events = await dbAdmin.select().from(rweTable).where(eq(rweTable.event_id, evt.id));
    expect(events).toHaveLength(1);
    const after = await invoicesSvc.get(tenantId, inv.id);
    expect(after.data.status).toBe('SENT');
    expect(after.data.amount_paid).toBe('0.00');
  });
});

// ─── Sprint 5: Organization → Financial + bank accounts (§7.2 / §8) ──────────
import { PublicInvoiceService as PubSvc5 } from '../modules/invoicing/public-invoice.service';

describe('Org financial + bank accounts (Sprint 5)', () => {
  const invoicesSvc = new InvoicesService(dbSvc, audit, numbering, configStub, notificationsStub, orgFinancial);
  const publicSvc = new PubSvc5(dbAdmin as any);
  let tenantId: string;
  let userId: string;
  let customerId: string;
  let inrAccountId: string;
  let fxAccountId: string;

  beforeAll(async () => {
    const [t] = await dbAdmin
      .insert(tenantsTable)
      .values({
        name: `BankCo${rid()}`,
        slug: `bankco-${rid()}-${Date.now()}`,
        status: 'trialing',
        state_code: 'KA',
        legal_name: 'BankCo Private Limited',
      })
      .returning();
    tenantId = t!.id;
    const [u] = await dbAdmin
      .insert(users)
      .values({ email: `bank-${rid()}@test.test`, full_name: 'Bank User', status: 'active' })
      .returning();
    userId = u!.id;
    const c = await customers.create(
      { display_name: 'FX Buyer', email: 'fx@test.test', state_code: 'KA' },
      userId,
      tenantId,
    );
    customerId = c.data.id;
  });

  afterAll(async () => {
    await dbAdmin.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
    await dbAdmin.delete(users).where(eq(users.id, userId));
  });

  it('updates GSTIN/PAN on the tenant (single source of truth) and validates formats', async () => {
    const updated = await orgFinancial.updateFinancial(
      { gstin: '29ABCDE1234F1Z5', pan: 'ABCDE1234F', legal_name: 'BankCo Private Limited' },
      userId,
      tenantId,
    );
    expect(updated.data!.gstin).toBe('29ABCDE1234F1Z5');
    const read = await orgFinancial.getFinancial(tenantId);
    expect(read.data.pan).toBe('ABCDE1234F');
  });

  it('creates an INR account (IFSC) — first account auto-defaults; warns on beneficiary mismatch', async () => {
    const created = await orgFinancial.createBankAccount(
      {
        beneficiary_name: 'Some Other Name',
        account_number: '50100123456789',
        bank_name: 'HDFC Bank',
        branch: 'Koramangala',
        ifsc: 'HDFC0001234',
      },
      userId,
      tenantId,
    );
    inrAccountId = created.data.id;
    expect(created.data.is_default).toBe(true);
    expect(created.warning).toMatch(/doesn't match your legal name/);
  });

  it('rejects an account with neither IFSC nor SWIFT, and SWIFT without bank address', async () => {
    await expect(
      orgFinancial.createBankAccount(
        { beneficiary_name: 'X', account_number: '1', bank_name: 'Y' },
        userId,
        tenantId,
      ),
    ).rejects.toThrow(/IFSC.*SWIFT|SWIFT.*IFSC/);
    await expect(
      orgFinancial.createBankAccount(
        { beneficiary_name: 'X', account_number: '1', bank_name: 'Y', swift_bic: 'HDFCINBB' },
        userId,
        tenantId,
      ),
    ).rejects.toThrow(/Bank address is required/);
  });

  it('malformed IFSC/SWIFT rejected by the DB CHECK as backstop', async () => {
    await expect(
      dbAdmin.execute(
        // bypasses the DTO on purpose — the DB constraint must still hold
        (await import('drizzle-orm')).sql`INSERT INTO tenant_bank_accounts
          (tenant_id, beneficiary_name, account_number, bank_name, ifsc)
          VALUES (${tenantId}, 'X', '1', 'Y', 'BADIFSC')`,
      ),
    ).rejects.toThrow();
  });

  it('creates an FX account (SWIFT + address) and sets it as the USD default', async () => {
    const created = await orgFinancial.createBankAccount(
      {
        beneficiary_name: 'BankCo Private Limited',
        account_number: '99880011223344',
        bank_name: 'HDFC Bank',
        account_type: 'EEFC',
        swift_bic: 'HDFCINBBXXX',
        bank_address: 'HDFC Bank, Sandoz Branch, Mumbai 400069, India',
        ifsc: 'HDFC0009999',
      },
      userId,
      tenantId,
    );
    fxAccountId = created.data.id;
    expect(created.warning).toBeUndefined();
    await orgFinancial.setCurrencyDefault(
      { currency: 'USD', bank_account_id: fxAccountId },
      userId,
      tenantId,
    );
    const listed = await orgFinancial.listBankAccounts(tenantId, 'owner');
    expect(listed.meta.currency_defaults['USD']).toBe(fxAccountId);
  });

  it('blocks a no-SWIFT account from becoming a foreign-currency default', async () => {
    await expect(
      orgFinancial.setCurrencyDefault(
        { currency: 'USD', bank_account_id: inrAccountId },
        userId,
        tenantId,
      ),
    ).rejects.toThrow(/no SWIFT/);
  });

  it('masks account numbers for non-privileged roles, full for owner', async () => {
    const asOwner = await orgFinancial.listBankAccounts(tenantId, 'owner');
    expect(asOwner.data[0]!.account_number).not.toContain('•');
    const asAuditor = await orgFinancial.listBankAccounts(tenantId, 'auditor');
    const masked = asAuditor.data.find((a) => a.id === inrAccountId)!;
    expect(masked.account_number).toMatch(/^•+6789$/);
  });

  it('set-default moves the overall default atomically (single default invariant)', async () => {
    await orgFinancial.setDefault(fxAccountId, userId, tenantId);
    const listed = await orgFinancial.listBankAccounts(tenantId, 'owner');
    const defaults = listed.data.filter((a) => a.is_default);
    expect(defaults).toHaveLength(1);
    expect(defaults[0]!.id).toBe(fxAccountId);
  });

  it('§8 selection: INR invoice picks overall default; USD invoice picks the USD currency default', async () => {
    const mk = (currency: string) =>
      invoicesSvc.create(
        {
          customer_id: customerId,
          invoice_date: '2026-06-12',
          due_date: '2026-07-12',
          currency,
          line_items: [{ item_name: 'Svc', quantity: '1', rate: '100.00', gst_rate: '18' }],
        } as any,
        userId,
        tenantId,
      );
    // overall default is now the FX account; INR has no currency default → falls to overall
    const inr = await mk('INR');
    expect(inr.data.bank_account_id).toBe(fxAccountId);
    const usd = await mk('USD');
    expect(usd.data.bank_account_id).toBe(fxAccountId);

    // explicit override wins
    const overridden = await invoicesSvc.create(
      {
        customer_id: customerId,
        invoice_date: '2026-06-12',
        due_date: '2026-07-12',
        currency: 'INR',
        bank_account_id: inrAccountId,
        line_items: [{ item_name: 'Svc', quantity: '1', rate: '50.00', gst_rate: '18' }],
      } as any,
      userId,
      tenantId,
    );
    expect(overridden.data.bank_account_id).toBe(inrAccountId);
  });

  it('§8 acceptance: public page shows IFSC for INR and SWIFT+address for USD; currency change swaps the block', async () => {
    // INR invoice on the INR account → IFSC visible, SWIFT hidden
    const inr = await invoicesSvc.create(
      {
        customer_id: customerId,
        invoice_date: '2026-06-12',
        due_date: '2026-07-12',
        currency: 'INR',
        bank_account_id: inrAccountId,
        line_items: [{ item_name: 'Svc', quantity: '1', rate: '100.00', gst_rate: '18' }],
      } as any,
      userId,
      tenantId,
    );
    const sentInr = await invoicesSvc.send(inr.data.id, userId, tenantId);
    const pubInr = await publicSvc.getByToken(sentInr.data.public_view_token!);
    const btInr = pubInr.data.payment_options.bank_transfer!;
    expect(btInr.ifsc).toBe('HDFC0001234');
    expect(btInr.swift_bic).toBeNull();
    expect(btInr.account_number).toBe('50100123456789'); // full number on the invoice itself

    // Change the same draft to USD → §8: block swaps to SWIFT + bank address
    const usdDraft = await invoicesSvc.create(
      {
        customer_id: customerId,
        invoice_date: '2026-06-12',
        due_date: '2026-07-12',
        currency: 'INR',
        line_items: [{ item_name: 'Svc', quantity: '1', rate: '100.00', gst_rate: '18' }],
      } as any,
      userId,
      tenantId,
    );
    await invoicesSvc.update(usdDraft.data.id, { currency: 'USD' } as any, userId, tenantId);
    const sentUsd = await invoicesSvc.send(usdDraft.data.id, userId, tenantId);
    const pubUsd = await publicSvc.getByToken(sentUsd.data.public_view_token!);
    const btUsd = pubUsd.data.payment_options.bank_transfer!;
    expect(btUsd.swift_bic).toBe('HDFCINBBXXX');
    expect(btUsd.bank_address).toContain('Mumbai');
    expect(btUsd.ifsc).toBeNull();
    // UPI never offered on a USD invoice
    expect(pubUsd.data.payment_options.upi).toBeNull();
  });

  it('deleting an account clears its currency defaults and soft-deletes', async () => {
    const extra = await orgFinancial.createBankAccount(
      {
        beneficiary_name: 'BankCo Private Limited',
        account_number: '11112222',
        bank_name: 'ICICI',
        swift_bic: 'ICICINBB',
        bank_address: 'ICICI, BKC, Mumbai',
      },
      userId,
      tenantId,
    );
    await orgFinancial.setCurrencyDefault(
      { currency: 'EUR', bank_account_id: extra.data.id },
      userId,
      tenantId,
    );
    await orgFinancial.deleteBankAccount(extra.data.id, userId, tenantId);
    const listed = await orgFinancial.listBankAccounts(tenantId, 'owner');
    expect(listed.data.some((a) => a.id === extra.data.id)).toBe(false);
    expect(listed.meta.currency_defaults['EUR']).toBeUndefined();
  });
});

// Close the shared postgres pools after every describe in this file has run,
// so jest can exit cleanly.
afterAll(async () => {
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
});
