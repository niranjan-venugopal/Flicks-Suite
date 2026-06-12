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

describe('Invoicing services (Sprint 3 — invoices)', () => {
  const invoicesSvc = new InvoicesService(dbSvc, audit, numbering);
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

// Close the shared postgres pools after every describe in this file has run,
// so jest can exit cleanly.
afterAll(async () => {
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
});
