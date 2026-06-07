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
    await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
    await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
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
