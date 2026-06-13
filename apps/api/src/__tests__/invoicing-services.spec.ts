/**
 * Invoicing service integration tests (Sprint 2) — exercises the real service
 * classes (CustomersService, ItemsService, HsnSacService, NumberingService)
 * against Postgres through the tenant (RLS) connection. Complements the pure
 * unit tests (numbering.util) and the cross-tenant isolation suite.
 */
import 'dotenv/config';
import { db, dbAdmin } from '@flicks/db';
import { tenants, users } from '@flicks/db/schema';
import { and, eq } from 'drizzle-orm';
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

  it('creates a QUOTE on the QUOTE series and converts it to an INVOICE (Sprint 10 §D)', async () => {
    const quote = await invoicesSvc.create(
      {
        customer_id: customerId,
        invoice_date: '2026-06-10',
        due_date: '2026-07-10',
        document_type: 'QUOTE',
        line_items: [{ item_name: 'Estimate', quantity: '1', rate: '1000', gst_rate: '18' }],
      },
      userId,
      tenantId,
    );
    expect(quote.data.document_type).toBe('QUOTE');
    expect(quote.data.invoice_number).toMatch(/^QT/); // QUOTE prefix

    // Quotes are excluded from the INVOICE-filtered list and present in QUOTE.
    const invoiceList = await invoicesSvc.list(tenantId, { document_type: 'INVOICE' } as never);
    expect(invoiceList.data.every((r) => r.document_type === 'INVOICE')).toBe(true);
    const quoteList = await invoicesSvc.list(tenantId, { document_type: 'QUOTE' } as never);
    expect(quoteList.data.some((r) => r.id === quote.data.id)).toBe(true);

    // Convert → promoted to the INVOICE series, DRAFT, keeps the quote ref.
    const converted = await invoicesSvc.convertToInvoice(quote.data.id, userId, tenantId);
    expect(converted.data.document_type).toBe('INVOICE');
    expect(converted.data.invoice_number).toMatch(/^INV/);
    expect(converted.data.status).toBe('DRAFT');

    await expect(
      invoicesSvc.convertToInvoice(converted.data.id, userId, tenantId),
    ).rejects.toThrow(/Only quotes/);
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

// ─── Sprint 6: notes, ledger, reminders, reports/GSTR-1 ──────────────────────
import { NotesService } from '../modules/invoicing/notes.service';
import { InvReportsService } from '../modules/invoicing/inv-reports.service';
import { InvoicingJobs } from '../jobs/invoicing.jobs';
import {
  reminderSchedule as rsTable,
  reminderSent as rsentTable,
  customerCreditBalance as ccb6,
} from '@flicks/db/schema';

describe('Invoicing services (Sprint 6 — notes/ledger/reminders/reports)', () => {
  const invoicesSvc = new InvoicesService(dbSvc, audit, numbering, configStub, notificationsStub, orgFinancial);
  const notesSvc = new NotesService(dbSvc, audit, numbering);
  const reportsSvc = new InvReportsService(dbSvc, audit);
  const jobs = new InvoicingJobs(dbSvc, dbAdmin as any, notificationsStub as any, invoicesSvc);
  let tenantId: string;
  let userId: string;
  let customerId: string;

  const mkInvoice = async (over: Record<string, unknown> = {}) =>
    (
      await invoicesSvc.create(
        {
          customer_id: customerId,
          invoice_date: '2026-06-05',
          due_date: '2026-06-20',
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
      .values({ name: `RepCo${rid()}`, slug: `repco-${rid()}-${Date.now()}`, status: 'trialing', state_code: 'KA' })
      .returning();
    tenantId = t!.id;
    const [u] = await dbAdmin
      .insert(users)
      .values({ email: `rep-${rid()}@test.test`, full_name: 'Rep User', status: 'active' })
      .returning();
    userId = u!.id;
    const c = await customers.create(
      { display_name: 'Ledger Co', email: 'ledger@test.test', state_code: 'KA', gstin: '29ABCDE1234F1Z5' },
      userId,
      tenantId,
    );
    customerId = c.data.id;
  });

  afterAll(async () => {
    await dbAdmin.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
    await dbAdmin.delete(users).where(eq(users.id, userId));
  });

  it('credit note: CRN numbering, ISSUED, books into the customer credit balance', async () => {
    const inv = await mkInvoice();
    await invoicesSvc.send(inv.id, userId, tenantId);
    const note = await notesSvc.create(
      'credit',
      { invoice_id: inv.id, reason: 'post_supply_discount', amount: '200.00' },
      userId,
      tenantId,
    );
    expect((note.data as any).credit_note_number).toMatch(/^CRN\/\d{2}-\d{2}\/0001$/);
    expect(note.data.status).toBe('ISSUED');

    const [balance] = await dbAdmin
      .select()
      .from(ccb6)
      .where(eq(ccb6.customer_id, customerId));
    expect(parseFloat(balance!.balance_amount)).toBeGreaterThanOrEqual(200);

    const listed = await notesSvc.list(tenantId);
    expect(listed.data.credit.some((n) => n.id === note.data.id)).toBe(true);
  });

  it('debit note: DBN numbering, no credit-balance effect', async () => {
    const inv = await mkInvoice();
    await invoicesSvc.send(inv.id, userId, tenantId);
    const before = await dbAdmin.select().from(ccb6).where(eq(ccb6.customer_id, customerId));
    const note = await notesSvc.create(
      'debit',
      { invoice_id: inv.id, reason: 'additional_charges', amount: '150.00' },
      userId,
      tenantId,
    );
    expect((note.data as any).debit_note_number).toMatch(/^DBN\//);
    const after = await dbAdmin.select().from(ccb6).where(eq(ccb6.customer_id, customerId));
    expect(after[0]?.balance_amount).toBe(before[0]?.balance_amount);
  });

  it('customer ledger: invoices debit, payments/credit notes credit, running balance', async () => {
    const inv = await mkInvoice(); // 1180.00
    await invoicesSvc.send(inv.id, userId, tenantId);
    await invoicesSvc.recordPayment(
      inv.id,
      { amount: '500.00', payment_method: 'UPI_DIRECT' } as any,
      userId,
      tenantId,
    );
    const stmt = await customers.statement(tenantId, customerId);
    const lines = stmt.data.lines;
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines.some((l: any) => l.type === 'invoice' && l.debit === '1180.00')).toBe(true);
    expect(lines.some((l: any) => l.type === 'payment' && l.credit === '500.00')).toBe(true);
    expect(lines.some((l: any) => l.type === 'credit_note')).toBe(true);
    // closing balance equals sum of debits − credits
    const sum = lines.reduce(
      (a: number, l: any) =>
        a + Math.round(parseFloat(l.debit ?? '0') * 100) - Math.round(parseFloat(l.credit ?? '0') * 100),
      0,
    );
    expect((sum / 100).toFixed(2)).toBe(stmt.data.closing_balance);
  });

  it('adjustments: create, list, delete within 24h', async () => {
    const adj = await notesSvc.createAdjustment(
      { customer_id: customerId, amount: '-50.00', type: 'round_off', reason: 'rounding' },
      userId,
      tenantId,
    );
    const listed = await notesSvc.listAdjustments(tenantId);
    expect(listed.data.some((a) => a.id === adj.data!.id)).toBe(true);
    await notesSvc.deleteAdjustment(adj.data!.id, userId, tenantId);
    const after = await notesSvc.listAdjustments(tenantId);
    expect(after.data.some((a) => a.id === adj.data!.id)).toBe(false);
  });

  it('payments ledger lists tenant-wide payments with invoice + customer', async () => {
    const res = await invoicesSvc.listPayments(tenantId, {});
    expect(res.data.length).toBeGreaterThanOrEqual(1);
    expect(res.data[0]!.payment_number).toMatch(/^PMT-/);
    expect(res.data[0]!.customer_name).toBe('Ledger Co');
  });

  it('aging buckets the outstanding by due date', async () => {
    // overdue invoice (due last year) + current one
    const overdue = await mkInvoice({ invoice_date: '2025-01-01', due_date: '2025-01-15' });
    await dbAdmin
      .update(schemaInvoices)
      .set({ status: 'OVERDUE' })
      .where(eq(schemaInvoices.id, overdue.id));
    const current = await mkInvoice({ due_date: '2099-01-01' });
    await invoicesSvc.send(current.id, userId, tenantId);

    const aging = await reportsSvc.aging(tenantId);
    const byBucket = Object.fromEntries(aging.data.buckets.map((b) => [b.bucket, parseFloat(b.amount)]));
    expect(byBucket['60+ days']).toBeGreaterThanOrEqual(1180);
    expect(byBucket['Current']).toBeGreaterThanOrEqual(1180);
    expect(parseFloat(aging.data.total)).toBeGreaterThan(0);
  });

  it('GSTR-1: buckets B2B (registered) + CDNR, logs the export with a hash', async () => {
    const inv = await mkInvoice({ invoice_date: '2026-06-05' });
    await invoicesSvc.send(inv.id, userId, tenantId);
    const res = await reportsSvc.generateGstr1(
      { period_month: 6, period_year: 2026 } as any,
      userId,
      tenantId,
    );
    expect(res.data.summary.b2b.count).toBeGreaterThanOrEqual(1); // customer has a GSTIN
    expect(res.data.summary.cdnr.count).toBeGreaterThanOrEqual(1); // CRN issued in June
    expect(res.data.export.file_hash).toHaveLength(64);
    const history = await reportsSvc.gstr1History(tenantId);
    expect(history.data.some((h) => h.id === res.data.export.id)).toBe(true);
  });

  it('TDS receivable + Form 131 mark-received round trip', async () => {
    const inv = await mkInvoice({ tds_rate: '10', tds_section: '393' });
    await invoicesSvc.send(inv.id, userId, tenantId);
    const tds = await reportsSvc.tdsReceivable(tenantId);
    expect(parseFloat(tds.meta.total)).toBeGreaterThanOrEqual(100);

    const tracking = await reportsSvc.form131Tracking(tenantId);
    const row = tracking.data.find((r) => r.customer_id === customerId);
    expect(row).toBeTruthy();
    expect(row!.received).toBe(false);
    await reportsSvc.markForm131Received(
      { customer_id: customerId, fy_label: row!.fy_label, quarter: row!.quarter, total_tds_amount: row!.total_tds },
      userId,
      tenantId,
    );
    const after = await reportsSvc.form131Tracking(tenantId);
    expect(after.data.find((r) => r.customer_id === customerId && r.quarter === row!.quarter)!.received).toBe(true);
  });

  it('reminders sweep: fires due steps once (idempotent on re-run)', async () => {
    // schedule: on-due-day (0) + +7d for this tenant
    await dbAdmin.insert(rsTable).values([
      { tenant_id: tenantId, reminder_number: 1, offset_days: 0, scope: 'tenant', active: true },
      { tenant_id: tenantId, reminder_number: 2, offset_days: 7, scope: 'tenant', active: true },
    ]);
    // overdue invoice (due 30 days ago) → both steps due
    const inv = await mkInvoice({ invoice_date: '2026-05-01', due_date: '2026-05-13' });
    await dbAdmin.update(schemaInvoices).set({ status: 'OVERDUE' }).where(eq(schemaInvoices.id, inv.id));

    sentEmails.length = 0;
    const first = await jobs.runRemindersSweep();
    expect(first).toBeGreaterThanOrEqual(2);
    expect(sentEmails.filter((e) => e.template === 'invoice-reminder').length).toBeGreaterThanOrEqual(2);

    const again = await jobs.runRemindersSweep();
    expect(again).toBe(0); // idempotent — reminder_sent unique key blocks re-sends

    const sentRows = await dbAdmin.select().from(rsentTable).where(eq(rsentTable.invoice_id, inv.id));
    expect(sentRows).toHaveLength(2);
  });
});

// ─── Sprint 7: subscriptions + mandate + dunning ──────────────────────────────
import { SubscriptionsService } from '../modules/invoicing/subscriptions.service';
import {
  invoiceSubscriptions as subsTable,
  invoiceSubscriptionProrationEvents as prorTable,
} from '@flicks/db/schema';

describe('Invoicing services (Sprint 7 — subscriptions)', () => {
  const invoicesSvc = new InvoicesService(dbSvc, audit, numbering, configStub, notificationsStub, orgFinancial);
  const subsSvc = new SubscriptionsService(dbSvc, audit, configStub as any);
  const jobs = new InvoicingJobs(dbSvc, dbAdmin as any, notificationsStub as any, invoicesSvc);
  let tenantId: string;
  let userId: string;
  let customerId: string;

  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

  beforeAll(async () => {
    const [t] = await dbAdmin
      .insert(tenantsTable)
      .values({ name: `SubCo${rid()}`, slug: `subco-${rid()}-${Date.now()}`, status: 'trialing', state_code: 'KA' })
      .returning();
    tenantId = t!.id;
    const [u] = await dbAdmin
      .insert(users)
      .values({ email: `sub-${rid()}@test.test`, full_name: 'Sub User', status: 'active' })
      .returning();
    userId = u!.id;
    const c = await customers.create(
      { display_name: 'Retainer Client', email: 'retainer@test.test', state_code: 'KA' },
      userId,
      tenantId,
    );
    customerId = c.data.id;
  });

  afterAll(async () => {
    await dbAdmin.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
    await dbAdmin.delete(users).where(eq(users.id, userId));
  });

  it('creates a flat-rate profile (PENDING_MANDATE, currency locked) and activates via the mandate stub', async () => {
    const created = await subsSvc.create(
      {
        customer_id: customerId,
        name: 'Design retainer',
        pricing_model: 'flat_rate',
        flat_amount: '80000.00',
        billing_period: 'monthly',
        start_date: yesterday,
      } as any,
      userId,
      tenantId,
    );
    expect(created.data.status).toBe('PENDING_MANDATE');
    expect(created.data.currency).toBe('INR');
    expect(created.data.next_billing_date).toBe(yesterday);

    const link = await subsSvc.mandateLink(created.data.id, tenantId);
    expect(link.data.stub).toBe(true); // no Razorpay keys configured

    const active = await subsSvc.activate(created.data.id, userId, tenantId);
    expect(active.data.status).toBe('ACTIVE');
    expect(active.data.mandate_authorized_at).toBeTruthy();
  });

  it('generation sweep: due profile → real invoice (GST applied), auto-sent, cycle advanced', async () => {
    sentEmails.length = 0;
    const generated = await jobs.runSubscriptionGeneration();
    expect(generated).toBeGreaterThanOrEqual(1);

    const [sub] = await dbAdmin.select().from(subsTable).where(eq(subsTable.tenant_id, tenantId));
    expect(sub!.total_cycles_billed).toBe(1);
    expect(sub!.next_billing_date! > yesterday).toBe(true);

    const subDetail = await subsSvc.get(tenantId, sub!.id);
    expect(subDetail.data.invoices).toHaveLength(1);
    const inv = subDetail.data.invoices[0]!;
    expect(parseFloat(inv.total_amount)).toBeCloseTo(94400, 0); // 80,000 + 18% GST
    expect(['SENT', 'VIEWED'].includes(inv.status)).toBe(true); // auto-sent
    expect(sentEmails.some((e) => e.template === 'invoice-sent')).toBe(true);

    // re-run: nothing due anymore for this profile
    const again = await jobs.runSubscriptionGeneration();
    const [after] = await dbAdmin.select().from(subsTable).where(eq(subsTable.id, sub!.id));
    expect(after!.total_cycles_billed).toBe(1 + (again > 0 ? 0 : 0));
  });

  it('per-seat: seat change creates a proration event that lands on the next generated invoice', async () => {
    const created = await subsSvc.create(
      {
        customer_id: customerId,
        name: 'Team licences',
        pricing_model: 'per_seat',
        seat_rate: '1000.00',
        seat_count: 5,
        billing_period: 'monthly',
        start_date: yesterday,
      } as any,
      userId,
      tenantId,
    );
    await subsSvc.activate(created.data.id, userId, tenantId);

    const updated = await subsSvc.updateSeats(created.data.id, { seat_count: 8 }, userId, tenantId);
    expect(updated.data.seat_count).toBe(8);
    expect(updated.meta.proration).toBeTruthy();

    await jobs.runSubscriptionGeneration();
    const detail = await subsSvc.get(tenantId, created.data.id);
    const genInv = detail.data.invoices[0]!;
    // 8 seats × 1000 base line (+ proration line) + GST — at least the base
    expect(parseFloat(genInv.total_amount)).toBeGreaterThanOrEqual(8000 * 1.18 - 1);
    const [ev] = await dbAdmin
      .select()
      .from(prorTable)
      .where(eq(prorTable.subscription_id, created.data.id));
    expect(ev!.applied_to_invoice_id).toBe(genInv.id);
  });

  it('end condition after_n_cycles retires the profile to EXPIRED', async () => {
    const created = await subsSvc.create(
      {
        customer_id: customerId,
        name: 'One-cycle deal',
        pricing_model: 'flat_rate',
        flat_amount: '500.00',
        billing_period: 'monthly',
        start_date: yesterday,
        end_condition: 'after_n_cycles',
        end_after_cycles: 1,
      } as any,
      userId,
      tenantId,
    );
    await subsSvc.activate(created.data.id, userId, tenantId);
    await jobs.runSubscriptionGeneration();
    const [sub] = await dbAdmin.select().from(subsTable).where(eq(subsTable.id, created.data.id));
    expect(sub!.status).toBe('EXPIRED');
    expect(sub!.next_billing_date).toBeNull();
  });

  it('pre-debit sweep notifies once per billing date (idempotent)', async () => {
    const created = await subsSvc.create(
      {
        customer_id: customerId,
        name: 'Hosting',
        pricing_model: 'flat_rate',
        flat_amount: '4200.00',
        billing_period: 'monthly',
        start_date: tomorrow,
      } as any,
      userId,
      tenantId,
    );
    await subsSvc.activate(created.data.id, userId, tenantId);

    sentEmails.length = 0;
    const first = await jobs.runPreDebitSweep();
    expect(first).toBeGreaterThanOrEqual(1);
    expect(sentEmails.some((e) => e.template === 'subscription-pre-debit')).toBe(true);

    sentEmails.length = 0;
    const second = await jobs.runPreDebitSweep();
    expect(second).toBe(0); // audit-log marker blocks the re-send
    expect(sentEmails).toHaveLength(0);
  });

  it('dunning: 3 strikes over the retry window → PAUSED; resume clears the counter', async () => {
    const created = await subsSvc.create(
      {
        customer_id: customerId,
        name: 'Flaky payer',
        pricing_model: 'flat_rate',
        flat_amount: '900.00',
        billing_period: 'monthly',
        start_date: yesterday,
      } as any,
      userId,
      tenantId,
    );
    await subsSvc.activate(created.data.id, userId, tenantId);
    await dbAdmin.update(subsTable).set({ status: 'PAST_DUE' }).where(eq(subsTable.id, created.data.id));

    await jobs.runDunningSweep(); // 1
    await jobs.runDunningSweep(); // 2
    let [sub] = await dbAdmin.select().from(subsTable).where(eq(subsTable.id, created.data.id));
    expect(sub!.status).toBe('PAST_DUE');
    expect(sub!.failed_charge_count).toBe(2);

    await jobs.runDunningSweep(); // 3 → pause
    ;[sub] = await dbAdmin.select().from(subsTable).where(eq(subsTable.id, created.data.id));
    expect(sub!.status).toBe('PAUSED');

    const resumed = await subsSvc.resume(created.data.id, userId, tenantId);
    expect(resumed.data.status).toBe('ACTIVE');
    expect(resumed.data.failed_charge_count).toBe(0);
  });

  it('validation: per-seat needs rate+seats; pause/cancel transitions guarded', async () => {
    await expect(
      subsSvc.create(
        { customer_id: customerId, name: 'Bad', pricing_model: 'per_seat', billing_period: 'monthly', start_date: yesterday } as any,
        userId,
        tenantId,
      ),
    ).rejects.toThrow(/seat_rate/);
    const created = await subsSvc.create(
      { customer_id: customerId, name: 'Guard', pricing_model: 'flat_rate', flat_amount: '10.00', billing_period: 'monthly', start_date: tomorrow } as any,
      userId,
      tenantId,
    );
    await expect(subsSvc.resume(created.data.id, userId, tenantId)).rejects.toThrow(/Cannot resume/);
    const cancelled = await subsSvc.cancel(created.data.id, 'not needed', userId, tenantId);
    expect(cancelled.data.status).toBe('CANCELLED');
  });
});

// ─── Sprint 8: auditor role — invite, grants, switch, My Companies, seats ─────
import { MembersService } from '../modules/members/members.service';
import { resolveSwitchMembership } from '../modules/auth/switch-membership.util';
import { InvoicingGrantGuard } from '../core/auth/guards/invoicing-grant.guard';
import type { GrantRequirement } from '../core/auth/decorators/require-grant.decorator';
import {
  memberships as membershipsTable,
  membershipGrants as membershipGrantsTable,
  users as usersTable,
} from '@flicks/db/schema';
import type { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import type { JwtPayload } from '@flicks/shared/types';

describe('Members & auditor role (Sprint 8)', () => {
  // AuthService is only needed for the invite magic link — stub it.
  const authStub = {
    issueInviteMagicLink: async () => 'http://localhost:3000/verify?token=test',
  } as unknown as import('../modules/auth/auth.service').AuthService;
  const members = new MembersService(
    dbSvc,
    dbAdmin as never,
    audit,
    notificationsStub,
    authStub,
  );

  // Two isolated companies + an owner; the auditor is invited into both.
  let tenantA: string;
  let tenantB: string;
  let ownerId: string;
  let auditorUserId: string;
  let auditorMembershipA: string;
  const auditorEmail = `auditor-${rid()}@firm.test`;

  beforeAll(async () => {
    const [a] = await dbAdmin
      .insert(tenantsTable)
      .values({ name: `AudCoA${rid()}`, slug: `aud-a-${rid()}-${Date.now()}`, status: 'active' })
      .returning();
    const [b] = await dbAdmin
      .insert(tenantsTable)
      .values({ name: `AudCoB${rid()}`, slug: `aud-b-${rid()}-${Date.now()}`, status: 'active' })
      .returning();
    tenantA = a!.id;
    tenantB = b!.id;
    const [owner] = await dbAdmin
      .insert(usersTable)
      .values({ email: `owner-${rid()}@test.test`, full_name: 'Owner', status: 'active' })
      .returning();
    ownerId = owner!.id;
    await dbAdmin.insert(membershipsTable).values({
      tenant_id: tenantA,
      user_id: ownerId,
      role: 'owner',
      status: 'active',
    });
  });

  afterAll(async () => {
    await dbAdmin.delete(tenantsTable).where(eq(tenantsTable.id, tenantA));
    await dbAdmin.delete(tenantsTable).where(eq(tenantsTable.id, tenantB));
    await dbAdmin.delete(usersTable).where(eq(usersTable.id, ownerId));
    if (auditorUserId) {
      await dbAdmin.delete(usersTable).where(eq(usersTable.id, auditorUserId));
    }
  });

  // Build a guard wired to a fixed @RequireGrant requirement + JWT payload.
  const guardCheck = async (req: GrantRequirement, user: Partial<JwtPayload>) => {
    const reflector = {
      getAllAndOverride: () => req,
    } as unknown as Reflector;
    const guard = new InvoicingGrantGuard(reflector, dbSvc);
    const ctx = {
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
      getHandler: () => function handler() {},
      getClass: () => class Ctrl {},
    } as unknown as ExecutionContext;
    return guard.canActivate(ctx);
  };

  it('invite creates an invited, external, non-billable membership with review-grade default grants and emails the invite', async () => {
    sentEmails.length = 0;
    const res = await members.inviteAuditor(
      { email: auditorEmail },
      ownerId,
      tenantA,
    );
    const m = res.data.membership;
    auditorMembershipA = m.id;
    auditorUserId = m.user_id;
    expect(m.role).toBe('auditor');
    expect(m.status).toBe('invited');
    expect(m.is_external).toBe(true);
    expect(m.invited_by).toBe(ownerId);

    const grantSet = res.data.grants.map((g) => `${g.module}:${g.access_level}`).sort();
    expect(grantSet).toEqual([
      'invoicing:view',
      'org_financial:view',
      'reports:view',
    ]);

    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0]!.template).toBe('auditor-invite');
    expect(sentEmails[0]!.to).toBe(auditorEmail);
    expect(String(sentEmails[0]!.props.magicLinkUrl)).toContain('token=');
  });

  it('rejects a duplicate invite while one is pending', async () => {
    await expect(
      members.inviteAuditor({ email: auditorEmail }, ownerId, tenantA),
    ).rejects.toThrow(/pending invite|already/i);
  });

  it('grant guard allows invoicing:view but denies invoicing:edit for the default auditor', async () => {
    // A real session implies an accepted (active) membership; activate the
    // invited row so the guard's liveness gate (Sprint 10 §C) passes and we're
    // testing the grant logic itself.
    await dbAdmin
      .update(membershipsTable)
      .set({ status: 'active', accepted_at: new Date() })
      .where(eq(membershipsTable.id, auditorMembershipA));
    const jwt = {
      sub: auditorUserId,
      tenantId: tenantA,
      membershipId: auditorMembershipA,
      role: 'auditor' as const,
      isPlatformAdmin: false,
    };
    await expect(
      guardCheck({ module: 'invoicing', level: 'view' }, jwt),
    ).resolves.toBe(true);
    await expect(
      guardCheck({ module: 'invoicing', level: 'edit' }, jwt),
    ).rejects.toThrow(/Missing grant/);
  });

  it('grant elevation flips the guard: edit + send capability pass, record_payments stays denied', async () => {
    await members.updateGrants(
      auditorMembershipA,
      {
        grants: [
          { module: 'invoicing', access_level: 'edit', capabilities: { send: true } },
          { module: 'reports', access_level: 'view' },
        ],
      },
      ownerId,
      tenantA,
    );
    const jwt = {
      sub: auditorUserId,
      tenantId: tenantA,
      membershipId: auditorMembershipA,
      role: 'auditor' as const,
      isPlatformAdmin: false,
    };
    await expect(
      guardCheck({ module: 'invoicing', level: 'edit', capability: 'send' }, jwt),
    ).resolves.toBe(true);
    await expect(
      guardCheck({ module: 'invoicing', level: 'edit', capability: 'record_payments' }, jwt),
    ).rejects.toThrow(/Missing grant/);
    // org_financial grant was dropped in the replacement set.
    await expect(
      guardCheck({ module: 'org_financial', level: 'view' }, jwt),
    ).rejects.toThrow(/Missing grant/);
  });

  it('GET /me/companies lists only the caller’s own memberships, with grants', async () => {
    // Second engagement: same auditor user invited into company B.
    await members.inviteAuditor({ email: auditorEmail }, ownerId, tenantB);

    const mine = await members.getMyCompanies(auditorUserId);
    expect(mine.data.map((c) => c.tenantId).sort()).toEqual(
      [tenantA, tenantB].sort(),
    );
    const companyA = mine.data.find((c) => c.tenantId === tenantA)!;
    expect(companyA.role).toBe('auditor');
    expect(companyA.grants.some((g) => g.module === 'invoicing')).toBe(true);

    // The owner of A sees exactly their one company — never the auditor's B.
    const ownersView = await members.getMyCompanies(ownerId);
    expect(ownersView.data.map((c) => c.tenantId)).toEqual([tenantA]);
  });

  it('switch-company verifies server-side: foreign tenant rejected, invited auditor accepted on switch', async () => {
    // The owner has no membership in B — must be rejected regardless of the
    // client-supplied tenant id.
    await expect(
      resolveSwitchMembership(dbAdmin as never, ownerId, tenantB),
    ).rejects.toThrow(/No active membership/);

    // The invited auditor switching into B is accepted on switch.
    const switched = await resolveSwitchMembership(dbAdmin as never, auditorUserId, tenantB);
    expect(switched.activated).toBe(true);
    expect(switched.membership.status).toBe('active');
    expect(switched.membership.accepted_at).not.toBeNull();

    // Idempotent on the second switch.
    const again = await resolveSwitchMembership(dbAdmin as never, auditorUserId, tenantB);
    expect(again.activated).toBe(false);
  });

  it('switch-company rejects revoked memberships and elapsed access windows', async () => {
    // Revoke the B engagement.
    await dbAdmin
      .update(membershipsTable)
      .set({ status: 'deactivated' })
      .where(
        and(
          eq(membershipsTable.user_id, auditorUserId),
          eq(membershipsTable.tenant_id, tenantB),
        ),
      );
    await expect(
      resolveSwitchMembership(dbAdmin as never, auditorUserId, tenantB),
    ).rejects.toThrow(/revoked/);

    // Expired engagement window on A.
    await dbAdmin
      .update(membershipsTable)
      .set({ access_expires_at: new Date(Date.now() - 24 * 3600 * 1000) })
      .where(eq(membershipsTable.id, auditorMembershipA));
    await expect(
      resolveSwitchMembership(dbAdmin as never, auditorUserId, tenantA),
    ).rejects.toThrow(/expired/);
    await dbAdmin
      .update(membershipsTable)
      .set({ access_expires_at: null })
      .where(eq(membershipsTable.id, auditorMembershipA));
  });

  it('auditor seats are non-billable: billable count excludes auditors', async () => {
    // Activate the A engagement (invited → active via switch).
    const { membership } = await resolveSwitchMembership(
      dbAdmin as never,
      auditorUserId,
      tenantA,
    );
    expect(membership.status).toBe('active');

    const seats = await members.seats(tenantA);
    expect(seats.data.billable).toBe(1); // the owner only
    expect(seats.data.auditors).toBe(1);

    // Grants for the revoked B membership are irrelevant to A's counts.
    const grantsA = await dbAdmin
      .select()
      .from(membershipGrantsTable)
      .where(eq(membershipGrantsTable.tenant_id, tenantA));
    expect(grantsA.length).toBeGreaterThan(0);
  });
});

// ─── Sprint 9: FAM toggles + guard, settings/setup, registry, seats, metrics ──
import { InvSettingsService } from '../modules/invoicing/inv-settings.service';
import { FamService } from '../modules/fam/fam.service';

describe('Invoicing settings + setup wizard (Sprint 9)', () => {
  const settings = new InvSettingsService(dbSvc, dbAdmin as never, audit);
  let tenantId: string;
  let userId: string;

  beforeAll(async () => {
    const [t] = await dbAdmin
      .insert(tenantsTable)
      .values({ name: `SetCo${rid()}`, slug: `set-${rid()}-${Date.now()}`, status: 'active' })
      .returning();
    tenantId = t!.id;
    const [u] = await dbAdmin
      .insert(usersTable)
      .values({ email: `set-${rid()}@test.test`, full_name: 'Set User', status: 'active' })
      .returning();
    userId = u!.id;
  });

  afterAll(async () => {
    await dbAdmin.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
    await dbAdmin.delete(usersTable).where(eq(usersTable.id, userId));
  });

  it('creates a settings row on first read and persists partial updates', async () => {
    const first = await settings.getSettings(tenantId, userId);
    expect(first.data.default_currency).toBe('INR');
    // Secret never leaked; only a configured flag.
    expect('razorpay_webhook_secret' in first.data).toBe(false);
    expect(first.data.razorpay_webhook_configured).toBe(false);

    const updated = await settings.updateSettings(tenantId, userId, {
      default_payment_terms_days: 45,
      upi_id: 'acme@hdfcbank',
      email_signature: '— Acme Finance',
    });
    expect(updated.data.default_payment_terms_days).toBe(45);
    expect(updated.data.upi_id).toBe('acme@hdfcbank');

    // Persisted + other fields untouched.
    const reread = await settings.getSettings(tenantId, userId);
    expect(reread.data.default_payment_terms_days).toBe(45);
    expect(reread.data.default_gst_rate).toBe('18.00');
  });

  it('tracks setup-wizard progress with a derived percentage and completion', async () => {
    const start = await settings.getSetupProgress(tenantId, userId);
    expect(start.data.percent_complete).toBe(0);
    expect(start.data.is_complete).toBe(false);

    await settings.updateSetupProgress(tenantId, userId, {
      business_details_confirmed: true,
      numbering_configured: true,
      current_step: 'payment_terms',
    });
    const mid = await settings.getSetupProgress(tenantId, userId);
    expect(mid.data.completed_steps).toBe(2);
    expect(mid.data.percent_complete).toBe(Math.round((2 / 11) * 100));

    const done = await settings.completeWizard(tenantId, userId);
    expect(done.data.is_complete).toBe(true);
    expect(done.data.wizard_completed_at).not.toBeNull();
  });
});

describe('FAM module toggle gate + registry/seats/metrics (Sprint 9)', () => {
  const fam = new FamService(
    dbAdmin as never,
    audit,
    {} as never, // authService — unused by these methods
    {} as never, // notifications — unused
    {} as never, // analytics — unused
  );
  let tenantId: string;
  let ownerId: string;
  let auditorId: string;
  let ownerMembershipId: string;

  beforeAll(async () => {
    const [t] = await dbAdmin
      .insert(tenantsTable)
      .values({ name: `FamCo${rid()}`, slug: `fam-${rid()}-${Date.now()}`, status: 'active' })
      .returning();
    tenantId = t!.id;
    const [o] = await dbAdmin
      .insert(usersTable)
      .values({ email: `famown-${rid()}@test.test`, full_name: 'FamOwner', status: 'active' })
      .returning();
    ownerId = o!.id;
    const [a] = await dbAdmin
      .insert(usersTable)
      .values({ email: `famaud-${rid()}@test.test`, full_name: 'FamAuditor', status: 'active' })
      .returning();
    auditorId = a!.id;
    const [om] = await dbAdmin
      .insert(membershipsTable)
      .values({ tenant_id: tenantId, user_id: ownerId, role: 'owner', status: 'active' })
      .returning();
    ownerMembershipId = om!.id;
    await dbAdmin.insert(membershipsTable).values({ tenant_id: tenantId, user_id: auditorId, role: 'auditor', status: 'active', is_external: true });
  });

  afterAll(async () => {
    await dbAdmin.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
    await dbAdmin.delete(usersTable).where(eq(usersTable.id, ownerId));
    await dbAdmin.delete(usersTable).where(eq(usersTable.id, auditorId));
  });

  const guardFor = (tid: string, uid: string, membershipId: string) => {
    const reflector = { getAllAndOverride: () => ({ module: 'invoicing', level: 'view' }) } as never;
    const guard = new InvoicingGrantGuard(reflector, dbSvc);
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => ({
          user: { sub: uid, tenantId: tid, membershipId, role: 'owner', isPlatformAdmin: false },
        }),
      }),
      getHandler: () => () => {},
      getClass: () => class {},
    } as never;
    return guard.canActivate(ctx);
  };

  it('defaults invoicing ENABLED and the guard allows access', async () => {
    const mods = await fam.getTenantModules(tenantId);
    expect(mods.data.find((m) => m.module === 'invoicing')!.enabled).toBe(true);
    await expect(guardFor(tenantId, ownerId, ownerMembershipId)).resolves.toBe(true);
  });

  it('FAM disabling invoicing makes the guard deny even an owner (toggle wins over grant)', async () => {
    await fam.setTenantModule(tenantId, 'invoicing', false, ownerId);
    const mods = await fam.getTenantModules(tenantId);
    expect(mods.data.find((m) => m.module === 'invoicing')!.enabled).toBe(false);
    await expect(guardFor(tenantId, ownerId, ownerMembershipId)).rejects.toThrow(/disabled/i);

    // Re-enable restores access.
    await fam.setTenantModule(tenantId, 'invoicing', true, ownerId);
    await expect(guardFor(tenantId, ownerId, ownerMembershipId)).resolves.toBe(true);
  });

  it('seat split counts billable members vs non-billable auditors', async () => {
    const seats = await fam.getTenantSeats(tenantId);
    expect(seats.data.billable).toBe(1);
    expect(seats.data.auditors).toBe(1);
  });

  it('auditor registry groups companies by auditor and revoke deactivates the link', async () => {
    const registry = await fam.getAuditorRegistry();
    const entry = registry.data.find((e) => e.userId === auditorId);
    expect(entry).toBeTruthy();
    expect(entry!.companies.some((c) => c.tenantId === tenantId)).toBe(true);

    const revoked = await fam.revokeAuditorLink(auditorId, tenantId, ownerId);
    expect(revoked.data.status).toBe('deactivated');

    const seatsAfter = await fam.getTenantSeats(tenantId);
    expect(seatsAfter.data.auditors).toBe(0);
  });

  it('invoicing metrics return anonymized aggregates (no content)', async () => {
    const metrics = await fam.getInvoicingMetrics();
    expect(metrics.data).toHaveProperty('tenantsWithAuditor');
    expect(metrics.data).toHaveProperty('medianCompaniesPerAuditor');
    expect(typeof metrics.data.tenantsWithInvoices).toBe('number');
  });
});

describe('Invoicing guard — membership liveness on every request (Sprint 10 §C)', () => {
  // A revoked/expired auditor keeps a valid JWT until it expires; the guard
  // must re-check membership status + access window so revocation takes effect
  // immediately, regardless of still-present grant rows.
  let tenantId: string;
  let auditorUserId: string;
  let auditorMembershipId: string;

  const reflector = {
    getAllAndOverride: () => ({ module: 'invoicing', level: 'view' }),
  } as never;
  const guard = new InvoicingGrantGuard(reflector, dbSvc);
  const canActivate = (membershipId: string) => {
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => ({
          user: {
            sub: auditorUserId,
            tenantId,
            membershipId,
            role: 'auditor',
            isPlatformAdmin: false,
          },
        }),
      }),
      getHandler: () => () => {},
      getClass: () => class {},
    } as never;
    return guard.canActivate(ctx);
  };

  beforeAll(async () => {
    const [t] = await dbAdmin
      .insert(tenantsTable)
      .values({ name: `LiveCo${rid()}`, slug: `live-${rid()}-${Date.now()}`, status: 'active' })
      .returning();
    tenantId = t!.id;
    const [u] = await dbAdmin
      .insert(usersTable)
      .values({ email: `live-${rid()}@test.test`, full_name: 'Live Auditor', status: 'active' })
      .returning();
    auditorUserId = u!.id;
    const [m] = await dbAdmin
      .insert(membershipsTable)
      .values({ tenant_id: tenantId, user_id: auditorUserId, role: 'auditor', status: 'active', is_external: true })
      .returning();
    auditorMembershipId = m!.id;
    // Grant invoicing:view so the request would pass the grant gate — proving
    // the liveness gate (not the grant gate) is what denies after revocation.
    await dbSvc.withTenant(
      tenantId,
      (tx) =>
        tx.insert(membershipGrantsTable).values({
          tenant_id: tenantId,
          membership_id: auditorMembershipId,
          module: 'invoicing',
          access_level: 'view',
          capabilities: {},
        }),
      auditorUserId,
    );
  });

  afterAll(async () => {
    await dbAdmin.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
    await dbAdmin.delete(usersTable).where(eq(usersTable.id, auditorUserId));
  });

  it('allows an active granted auditor', async () => {
    await expect(canActivate(auditorMembershipId)).resolves.toBe(true);
  });

  it('denies immediately once the membership is deactivated (grants still present)', async () => {
    await dbAdmin
      .update(membershipsTable)
      .set({ status: 'deactivated' })
      .where(eq(membershipsTable.id, auditorMembershipId));
    await expect(canActivate(auditorMembershipId)).rejects.toThrow(/no longer active/i);
    // Reactivate for the next case.
    await dbAdmin
      .update(membershipsTable)
      .set({ status: 'active' })
      .where(eq(membershipsTable.id, auditorMembershipId));
  });

  it('denies when the access window has elapsed', async () => {
    await dbAdmin
      .update(membershipsTable)
      .set({ access_expires_at: new Date(Date.now() - 24 * 3600 * 1000) })
      .where(eq(membershipsTable.id, auditorMembershipId));
    await expect(canActivate(auditorMembershipId)).rejects.toThrow(/no longer active/i);
    await dbAdmin
      .update(membershipsTable)
      .set({ access_expires_at: null })
      .where(eq(membershipsTable.id, auditorMembershipId));
  });
});

describe('FAM consented-debug (Sprint 10 §E)', () => {
  const auditWithPlatform = {
    log: async () => {},
    logPlatform: async () => {},
  } as never;
  const settings = new InvSettingsService(dbSvc, dbAdmin as never, auditWithPlatform);
  const fam = new FamService(
    dbAdmin as never,
    auditWithPlatform,
    {} as never,
    {} as never,
    {} as never,
  );
  let tenantId: string;
  let ownerId: string;

  beforeAll(async () => {
    const [t] = await dbAdmin
      .insert(tenantsTable)
      .values({ name: `ConsentCo${rid()}`, slug: `con-${rid()}-${Date.now()}`, status: 'active' })
      .returning();
    tenantId = t!.id;
    const [o] = await dbAdmin
      .insert(usersTable)
      .values({ email: `con-${rid()}@test.test`, full_name: 'Consent Owner', status: 'active' })
      .returning();
    ownerId = o!.id;
  });

  afterAll(async () => {
    await dbAdmin.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
    await dbAdmin.delete(usersTable).where(eq(usersTable.id, ownerId));
  });

  it('FAM debug is denied without active consent', async () => {
    await expect(fam.getInvoicingDebug(tenantId, ownerId)).rejects.toThrow(/consent/i);
  });

  it('grant → FAM debug returns counts/metadata; revoke → denied again', async () => {
    const granted = await settings.grantFamConsent(tenantId, ownerId, {
      scope: ['invoice_counts', 'audit'],
      note: 'FY25-26 support ticket',
    });
    expect(granted.data.scope).toContain('invoice_counts');

    const current = await settings.getFamConsent(tenantId, ownerId);
    expect(current.data).not.toBeNull();

    const debug = await fam.getInvoicingDebug(tenantId, ownerId);
    expect(debug.data).toHaveProperty('invoiceStatusDistribution');
    expect(debug.data).toHaveProperty('webhookEvents');
    expect(debug.data).toHaveProperty('auditEntries');
    expect(debug.data.consent.scope).toContain('invoice_counts');

    await settings.revokeFamConsent(tenantId, ownerId);
    expect((await settings.getFamConsent(tenantId, ownerId)).data).toBeNull();
    await expect(fam.getInvoicingDebug(tenantId, ownerId)).rejects.toThrow(/consent/i);
  });
});

// Close the shared postgres pools after every describe in this file has run,
// so jest can exit cleanly.
afterAll(async () => {
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
});
