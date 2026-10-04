/**
 * Founder round P — R1 invoicing fixes (go-live hardening, no migration):
 *
 *  R1.4 Numbering: the current-FY sequence row is matched by fy_start_date,
 *       not by the format-derived label — a saved '2026-27' format used to be
 *       invisible to list() and upsert() wrote a parallel row at 0. Legacy
 *       twins resolve to the row that issued numbers and fold away on the
 *       next save. reserveNext() serialises per (tenant, doc type) with an
 *       advisory lock so the first two documents of a new FY can't race the
 *       unique index.
 *  R1.5 Quotes are not revenue: every aggregate (dashboard, aging, revenue,
 *       TDS, GSTR-1, Form 131, customer statement) is INVOICE-only. Quote
 *       validity (valid_until) is finally stored, defaulting to the due date.
 *  C9   send() reports whether the email actually went out.
 *  C10  IGST-by-default guard: no explicit treatment + Indian customer +
 *       workspace without a state → 400 SUPPLIER_STATE_UNKNOWN.
 *
 * Service-level against the real Postgres, mirroring invoicing-services.spec.
 */
import 'dotenv/config';
import * as crypto from 'crypto';
import { and, eq } from 'drizzle-orm';
import { db, dbAdmin } from '@flicks/db';
import {
  tenants,
  users,
  invoiceSequences,
  invoices as invoicesTable,
} from '@flicks/db/schema';
import type { ConfigService } from '@nestjs/config';
import { HttpException } from '@nestjs/common';
import { stateCodeFromGstin } from '@flicks/shared/constants';
import { DatabaseService } from '../core/database/database.service';
import { CustomersService } from '../modules/invoicing/customers.service';
import { InvoicesService } from '../modules/invoicing/invoices.service';
import { NumberingService } from '../modules/invoicing/numbering.service';
import { InvReportsService } from '../modules/invoicing/inv-reports.service';
import { computeFiscalYear } from '../modules/invoicing/numbering.util';
import { OrgFinancialService } from '../modules/org-financial/org-financial.service';
import { SettingsService } from '../modules/settings/settings.service';
import type { AuditService } from '../modules/audit/audit.service';
import type { NotificationsService } from '../modules/notifications/notifications.service';

const rid = () => crypto.randomBytes(4).toString('hex');
// Captured so the numbering fold can be asserted from the audit trail.
const auditLog = jest.fn(async (_entry: Record<string, unknown>) => undefined);
const audit = { log: auditLog } as unknown as AuditService;
const dbSvc = new DatabaseService();

// The provider outcome is configurable per test (C9): sendEmail never
// throws — it reports delivery as a boolean.
let emailOutcome = true;
const sendEmail = jest.fn(async () => emailOutcome);
const notifications = { sendEmail } as unknown as NotificationsService;
const configStub = {
  get: (key: string, fallback?: unknown) =>
    key === 'PUBLIC_INVOICE_BASE_URL' ? 'http://localhost:3000' : fallback,
} as unknown as ConfigService;
const domainEventsStub = { publish: async () => null } as never;

const numbering = new NumberingService(dbSvc, audit);
const orgFinancial = new OrgFinancialService(dbSvc, audit);
const customersSvc = new CustomersService(dbSvc, audit);
const invoicesSvc = new InvoicesService(
  dbSvc,
  audit,
  numbering,
  configStub,
  notifications,
  orgFinancial,
  domainEventsStub,
);
const reportsSvc = new InvReportsService(dbSvc, audit);
// The real Settings → General save path (GSTIN → state derivation), stubbed
// the same way founder-roundA / the invites spec do.
const settingsSvc = new SettingsService(
  db as never,
  dbAdmin as never,
  audit,
  { servedUrl: async () => null } as never,
  domainEventsStub,
);

const today = new Date().toISOString().slice(0, 10);
const plusDays = (n: number) =>
  new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const mkLine = () => [
  { item_name: 'Retainer', quantity: '1', rate: '1000.00', gst_rate: '18' },
];

async function seedTenant(over: Partial<typeof tenants.$inferInsert> = {}) {
  const [t] = await dbAdmin
    .insert(tenants)
    .values({
      name: `RpInv${rid()}`,
      slug: `rpinv-${rid()}-${Date.now()}`,
      status: 'trialing',
      state_code: 'KA',
      ...over,
    })
    .returning();
  const [u] = await dbAdmin
    .insert(users)
    .values({ email: `rpinv-${rid()}@test.test`, full_name: 'RP User', status: 'active' })
    .returning();
  return { tenantId: t!.id, userId: u!.id };
}

const sequenceRows = (tenantId: string, docType: string) =>
  dbAdmin
    .select()
    .from(invoiceSequences)
    .where(
      and(
        eq(invoiceSequences.tenant_id, tenantId),
        eq(invoiceSequences.document_type, docType),
      ),
    );

const createdTenants: string[] = [];
const createdUsers: string[] = [];

afterAll(async () => {
  for (const id of createdTenants) await dbAdmin.delete(tenants).where(eq(tenants.id, id));
  for (const id of createdUsers) await dbAdmin.delete(users).where(eq(users.id, id));
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
});

async function freshTenant(over: Partial<typeof tenants.$inferInsert> = {}) {
  const ids = await seedTenant(over);
  createdTenants.push(ids.tenantId);
  createdUsers.push(ids.userId);
  return ids;
}

// ─── R1.4 numbering ───────────────────────────────────────────────────────────

describe('Round P R1.4 — numbering matches the FY row by window, not label', () => {
  it('a saved non-default fy_format is what list() returns, with the row id', async () => {
    const { tenantId, userId } = await freshTenant();
    const up = await numbering.upsert(
      tenantId,
      { document_type: 'INVOICE', fy_format: '2026-27' },
      userId,
    );
    expect(up.data!.fy_format).toBe('2026-27');
    expect(up.data!.fy_label).toMatch(/^\d{4}-\d{2}$/);

    const listed = await numbering.list(tenantId);
    const inv = listed.data.find((s) => s.document_type === 'INVOICE')!;
    expect(inv.id).toBe(up.data!.id);
    expect(inv.fy_format).toBe('2026-27');
    expect(inv.fy_label).toBe(up.data!.fy_label);
    expect(inv.next_number_preview).toMatch(/^INV\/\d{4}-\d{2}\/0001$/);
  });

  it('a second upsert updates the same row (never a twin) and warns once numbers exist', async () => {
    const { tenantId, userId } = await freshTenant();
    const first = await numbering.upsert(
      tenantId,
      { document_type: 'INVOICE', fy_format: '2026-27', prefix: 'INV' },
      userId,
    );
    expect(first.warning).toBeUndefined();

    // Issue a number on the row, then change the format: in place + warning.
    const reserved = await dbSvc.withTenant(tenantId, (tx) =>
      numbering.reserveNext(tx, tenantId, 'INVOICE', today),
    );
    expect(reserved.sequenceId).toBe(first.data!.id);
    expect(reserved.formatted).toMatch(/^INV\/\d{4}-\d{2}\/0001$/);

    const second = await numbering.upsert(
      tenantId,
      { document_type: 'INVOICE', fy_format: '26-27', prefix: 'FLK' },
      userId,
    );
    expect(second.data!.id).toBe(first.data!.id);
    expect(second.data!.current_number).toBe(1); // the counter survived the format change
    expect(second.warning).toMatch(/mid-financial-year/);

    const rows = await sequenceRows(tenantId, 'INVOICE');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fy_label).toMatch(/^\d{2}-\d{2}$/);

    // A partial upsert keeps the stored format instead of resetting it.
    const third = await numbering.upsert(tenantId, { document_type: 'INVOICE', zero_padding: 5 }, userId);
    expect(third.data!.id).toBe(first.data!.id);
    expect(third.data!.fy_format).toBe('26-27');
    expect(third.data!.prefix).toBe('FLK');
  });

  it('8 parallel first reservations on a fresh tenant yield 1..8 with no unique violation', async () => {
    const { tenantId } = await freshTenant();
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        dbSvc.withTenant(tenantId, (tx) =>
          numbering.reserveNext(tx, tenantId, 'INVOICE', today),
        ),
      ),
    );
    const numbers = results.map((r) => r.number).sort((a, b) => a - b);
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(new Set(results.map((r) => r.formatted)).size).toBe(8);
    expect(new Set(results.map((r) => r.sequenceId)).size).toBe(1);
    const rows = await sequenceRows(tenantId, 'INVOICE');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.current_number).toBe(8);
  });

  it('reserveNext after a format change prints the new label; deleted numbers stay burned', async () => {
    const { tenantId, userId } = await freshTenant();
    const a = await dbSvc.withTenant(tenantId, (tx) =>
      numbering.reserveNext(tx, tenantId, 'QUOTE', today),
    );
    expect(a.formatted).toMatch(/^QT\/\d{2}-\d{2}\/0001$/);

    await numbering.upsert(tenantId, { document_type: 'QUOTE', fy_format: '2026-27' }, userId);
    const b = await dbSvc.withTenant(tenantId, (tx) =>
      numbering.reserveNext(tx, tenantId, 'QUOTE', today),
    );
    expect(b.number).toBe(2);
    expect(b.fyLabel).toMatch(/^\d{4}-\d{2}$/);
    expect(b.formatted).toBe(`QT/${b.fyLabel}/0002`);
    expect(b.sequenceId).toBe(a.sequenceId);

    const listed = await numbering.list(tenantId);
    const q = listed.data.find((s) => s.document_type === 'QUOTE')!;
    expect(q.current_number).toBe(2);
    expect(q.next_number_preview).toBe(`QT/${b.fyLabel}/0003`);
  });

  it('legacy twin rows for one FY: the row that issued numbers wins and the twin folds away on save', async () => {
    const { tenantId, userId } = await freshTenant();
    // Create the real row and issue 3 numbers on it.
    for (let i = 0; i < 3; i++) {
      await dbSvc.withTenant(tenantId, (tx) =>
        numbering.reserveNext(tx, tenantId, 'INVOICE', today),
      );
    }
    const [real] = await sequenceRows(tenantId, 'INVOICE');
    // Simulate what the old label-keyed upsert left behind: a parallel row
    // for the SAME FY window under the other format's label, at 0.
    await dbAdmin.insert(invoiceSequences).values({
      tenant_id: tenantId,
      document_type: 'INVOICE',
      fy_label: `20${real!.fy_label}`, // '26-27' → '2026-27'
      fy_start_date: real!.fy_start_date,
      fy_end_date: real!.fy_end_date,
      prefix: 'INV',
      separator: '/',
      fy_format: '2026-27',
      zero_padding: 4,
      starting_number: 1,
      current_number: 0,
      branch_code: '',
    });
    expect(await sequenceRows(tenantId, 'INVOICE')).toHaveLength(2);

    const listed = await numbering.list(tenantId);
    const inv = listed.data.find((s) => s.document_type === 'INVOICE')!;
    expect(inv.id).toBe(real!.id);
    expect(inv.current_number).toBe(3);

    // Saving the '2026-27' format moves the real row onto that label and
    // removes the never-used twin instead of tripping the unique index.
    const up = await numbering.upsert(tenantId, { document_type: 'INVOICE', fy_format: '2026-27' }, userId);
    expect(up.data!.id).toBe(real!.id);
    expect(up.data!.fy_label).toBe(`20${real!.fy_label}`);
    expect(up.data!.current_number).toBe(3);
    const after = await sequenceRows(tenantId, 'INVOICE');
    expect(after).toHaveLength(1);

    const next = await dbSvc.withTenant(tenantId, (tx) =>
      numbering.reserveNext(tx, tenantId, 'INVOICE', today),
    );
    expect(next.number).toBe(4);
    expect(next.formatted).toBe(`INV/${up.data!.fy_label}/0004`);
  });

  it('a same-label twin from another FY window folds its HIGHER counter into the winner (audited)', async () => {
    const { tenantId, userId } = await freshTenant(); // FY starts in April
    const fy = computeFiscalYear(today, 4);
    // Row A: the series this tenant issued 50 numbers on back when its FY
    // started in January — same '26-27' label, a different window.
    const [twin] = await dbAdmin
      .insert(invoiceSequences)
      .values({
        tenant_id: tenantId,
        document_type: 'INVOICE',
        fy_label: `${String(fy.startYear).slice(2)}-${String(fy.endYear).slice(2)}`,
        fy_start_date: `${fy.startYear}-01-01`,
        fy_end_date: `${fy.startYear}-12-31`,
        prefix: 'INV',
        separator: '/',
        fy_format: '26-27',
        zero_padding: 4,
        starting_number: 1,
        current_number: 50,
        branch_code: '',
      })
      .returning();
    // Row B: the current-window row the old upsert created under the long
    // label, never used.
    const [winner] = await dbAdmin
      .insert(invoiceSequences)
      .values({
        tenant_id: tenantId,
        document_type: 'INVOICE',
        fy_label: `${fy.startYear}-${String(fy.endYear).slice(2)}`,
        fy_start_date: fy.startDate,
        fy_end_date: fy.endDate,
        prefix: 'INV',
        separator: '/',
        fy_format: '2026-27',
        zero_padding: 4,
        starting_number: 1,
        current_number: 0,
        branch_code: '',
      })
      .returning();

    auditLog.mockClear();
    const up = await numbering.upsert(tenantId, { document_type: 'INVOICE', fy_format: '26-27' }, userId);
    expect(up.data!.id).toBe(winner!.id);
    expect(up.data!.fy_label).toBe(twin!.fy_label);
    expect(up.data!.current_number).toBe(50); // adopted, so 0001..0050 can't repeat
    expect(await sequenceRows(tenantId, 'INVOICE')).toHaveLength(1);

    const entry = auditLog.mock.calls.find(
      (c) => (c[0] as { action?: string }).action === 'invoicing.sequence.upsert',
    )?.[0] as { metadata?: { folded_twins?: Array<{ id: string; current_number: number }> } };
    expect(entry.metadata?.folded_twins).toEqual([
      expect.objectContaining({ id: twin!.id, current_number: 50 }),
    ]);

    const next = await dbSvc.withTenant(tenantId, (tx) =>
      numbering.reserveNext(tx, tenantId, 'INVOICE', today),
    );
    expect(next.number).toBe(51);
    expect(next.formatted).toBe(`INV/${twin!.fy_label}/0051`);
  });

  it('list() follows the label fallback after the FY start month moves, agreeing with reserveNext', async () => {
    const { tenantId } = await freshTenant();
    for (let i = 0; i < 2; i++) {
      await dbSvc.withTenant(tenantId, (tx) =>
        numbering.reserveNext(tx, tenantId, 'INVOICE', today),
      );
    }
    const [row] = await sequenceRows(tenantId, 'INVOICE');
    // Settings → General lets a tenant move its FY start; the label stays
    // the same but the window changes, so a window-only lookup sees nothing.
    // January keeps the start year from April–December; from January–March
    // only a December start does, so the label is identical either way.
    const movedStartMonth = Number(today.slice(5, 7)) >= 4 ? 1 : 12;
    expect(computeFiscalYear(today, movedStartMonth).label).toBe(row!.fy_label);
    expect(computeFiscalYear(today, movedStartMonth).startDate).not.toBe(row!.fy_start_date);
    await dbAdmin
      .update(tenants)
      .set({ fiscal_year_start_month: movedStartMonth })
      .where(eq(tenants.id, tenantId));

    const listed = await numbering.list(tenantId);
    const inv = listed.data.find((s) => s.document_type === 'INVOICE')!;
    expect(inv.id).toBe(row!.id);
    expect(inv.current_number).toBe(2);
    expect(inv.next_number_preview).toBe(`INV/${row!.fy_label}/0003`);

    const next = await dbSvc.withTenant(tenantId, (tx) =>
      numbering.reserveNext(tx, tenantId, 'INVOICE', today),
    );
    expect(next.sequenceId).toBe(row!.id);
    expect(next.formatted).toBe(inv.next_number_preview);
  });
});

// ─── R1.5 quotes are not revenue; valid_until ─────────────────────────────────

describe('Round P R1.5 — quotes stay out of revenue, receivables and GSTR-1', () => {
  let tenantId: string;
  let userId: string;
  let customerId: string;
  let invoiceId: string;
  let quoteId: string;
  let invoiceNumber: string;
  let quoteNumber: string;

  beforeAll(async () => {
    ({ tenantId, userId } = await freshTenant());
    const c = await customersSvc.create(
      {
        display_name: 'Quote Buyer',
        email: 'buyer@rp.test',
        country_code: 'IN',
        state_code: 'KA',
        gstin: '29ABCDE1234F1Z5',
      } as never,
      userId,
      tenantId,
    );
    customerId = c.data.id;

    const inv = await invoicesSvc.create(
      { customer_id: customerId, invoice_date: today, due_date: plusDays(15), line_items: mkLine() } as never,
      userId,
      tenantId,
    );
    invoiceId = inv.data.id;
    invoiceNumber = inv.data.invoice_number;
    await invoicesSvc.send(invoiceId, userId, tenantId);

    const quote = await invoicesSvc.create(
      {
        customer_id: customerId,
        document_type: 'QUOTE',
        invoice_date: today,
        due_date: plusDays(30),
        line_items: [{ item_name: 'Big project', quantity: '1', rate: '50000.00', gst_rate: '18' }],
      } as never,
      userId,
      tenantId,
    );
    quoteId = quote.data.id;
    quoteNumber = quote.data.invoice_number;
    const sentQuote = await invoicesSvc.send(quoteId, userId, tenantId);
    expect(sentQuote.data.status).toBe('SENT');
    expect(sentQuote.data.document_type).toBe('QUOTE');
  });

  it('dashboard counts and sums the invoice only', async () => {
    const dash = await reportsSvc.dashboard(tenantId);
    expect(dash.data.total).toBe(1);
    expect(dash.data.open).toBe(1);
    expect(dash.data.outstanding).toBe('1180.00');
  });

  it('revenue sums the invoice only', async () => {
    const rev = await reportsSvc.revenue(tenantId);
    const total = rev.data.reduce((a, r) => a + parseFloat(r.total), 0);
    expect(total).toBeCloseTo(1180, 2);
    expect(rev.data.reduce((a, r) => a + r.count, 0)).toBe(1);
  });

  it('receivables aging excludes the quote', async () => {
    const aging = await reportsSvc.aging(tenantId);
    expect(aging.data.total).toBe('1180.00');
  });

  it('GSTR-1 omits the quote from every bucket and the logged counts', async () => {
    // Same UTC calendar day the invoice was dated with — a process-local
    // month would miss it in the IST early hours of the 1st.
    const [y, m] = today.split('-');
    const res = await reportsSvc.generateGstr1(
      { period_month: Number(m), period_year: Number(y) } as never,
      userId,
      tenantId,
    );
    const payload = res.data.payload.gstr1;
    const numbers = [...payload.b2b, ...payload.b2cl, ...payload.b2cs, ...payload.exp].map(
      (r) => r.invoice_number,
    );
    expect(numbers).toContain(invoiceNumber);
    expect(numbers).not.toContain(quoteNumber);
    expect(res.data.export.invoice_count).toBe(1);
    expect(res.data.summary.b2b.count).toBe(1);
  });

  it('the customer statement lists the invoice, not the quote', async () => {
    const stmt = await customersSvc.statement(tenantId, customerId);
    const refs = stmt.data.lines.filter((l) => l.type === 'invoice').map((l) => l.ref);
    expect(refs).toEqual([invoiceNumber]);
    expect(stmt.data.closing_balance).toBe('1180.00');
  });

  it('the reports currency selector ignores quote-only currencies', async () => {
    const usdQuote = await invoicesSvc.create(
      {
        customer_id: customerId,
        document_type: 'QUOTE',
        currency: 'USD',
        invoice_date: today,
        due_date: plusDays(30),
        line_items: [{ item_name: 'Offshore', quantity: '1', rate: '100.00' }],
      } as never,
      userId,
      tenantId,
    );
    expect(usdQuote.data.currency).toBe('USD');
    const ctx = await reportsSvc.reportsContext(tenantId);
    expect(ctx.data.currencies).toEqual(['INR']);
  });

  it('lists and detail keep both document types', async () => {
    const all = await invoicesSvc.list(tenantId, {} as never);
    const ids = all.data.map((r) => r.id);
    expect(ids).toContain(invoiceId);
    expect(ids).toContain(quoteId);
    const detail = await invoicesSvc.get(tenantId, quoteId);
    expect(detail.data.document_type).toBe('QUOTE');
  });
});

describe('Round P R1.5 — quote validity is stored', () => {
  let tenantId: string;
  let userId: string;
  let customerId: string;

  beforeAll(async () => {
    ({ tenantId, userId } = await freshTenant());
    const c = await customersSvc.create(
      { display_name: 'Validity Co', country_code: 'IN', state_code: 'KA' } as never,
      userId,
      tenantId,
    );
    customerId = c.data.id;
  });

  it('a QUOTE defaults valid_until to its due date; an explicit value is kept', async () => {
    const byDefault = await invoicesSvc.create(
      { customer_id: customerId, document_type: 'QUOTE', invoice_date: today, due_date: plusDays(30), line_items: mkLine() } as never,
      userId,
      tenantId,
    );
    expect(byDefault.data.valid_until).toBe(plusDays(30));

    const explicit = await invoicesSvc.create(
      {
        customer_id: customerId,
        document_type: 'QUOTE',
        invoice_date: today,
        due_date: plusDays(30),
        valid_until: plusDays(10),
        line_items: mkLine(),
      } as never,
      userId,
      tenantId,
    );
    expect(explicit.data.valid_until).toBe(plusDays(10));

    // Update: explicit wins; otherwise a changed due date carries it.
    const u1 = await invoicesSvc.update(
      explicit.data.id,
      { valid_until: plusDays(12) } as never,
      userId,
      tenantId,
    );
    expect(u1.data.valid_until).toBe(plusDays(12));
    const u2 = await invoicesSvc.update(
      explicit.data.id,
      { due_date: plusDays(45) } as never,
      userId,
      tenantId,
    );
    expect(u2.data.valid_until).toBe(plusDays(45));
    const u3 = await invoicesSvc.update(explicit.data.id, { notes: 'unchanged' } as never, userId, tenantId);
    expect(u3.data.valid_until).toBe(plusDays(45));
  });

  it('an INVOICE never carries valid_until', async () => {
    const inv = await invoicesSvc.create(
      { customer_id: customerId, invoice_date: today, due_date: plusDays(15), valid_until: plusDays(5), line_items: mkLine() } as never,
      userId,
      tenantId,
    );
    expect(inv.data.valid_until).toBeNull();
    const [row] = await dbAdmin
      .select({ valid_until: invoicesTable.valid_until })
      .from(invoicesTable)
      .where(and(eq(invoicesTable.id, inv.data.id), eq(invoicesTable.tenant_id, tenantId)));
    expect(row!.valid_until).toBeNull();
  });

  it('converting a quote drops its valid_until along with the QUOTE type', async () => {
    const quote = await invoicesSvc.create(
      { customer_id: customerId, document_type: 'QUOTE', invoice_date: today, due_date: plusDays(30), line_items: mkLine() } as never,
      userId,
      tenantId,
    );
    expect(quote.data.valid_until).toBe(plusDays(30));
    const converted = await invoicesSvc.convertToInvoice(quote.data.id, userId, tenantId);
    expect(converted.data.document_type).toBe('INVOICE');
    expect(converted.data.quote_number).toBe(quote.data.invoice_number);
    expect(converted.data.valid_until).toBeNull();
    const [row] = await dbAdmin
      .select({ valid_until: invoicesTable.valid_until })
      .from(invoicesTable)
      .where(and(eq(invoicesTable.id, quote.data.id), eq(invoicesTable.tenant_id, tenantId)));
    expect(row!.valid_until).toBeNull();
  });

  it('an explicit valid_until before the quote date is refused on create and on update', async () => {
    await expect(
      invoicesSvc.create(
        {
          customer_id: customerId,
          document_type: 'QUOTE',
          invoice_date: today,
          due_date: plusDays(30),
          valid_until: plusDays(-1),
          line_items: mkLine(),
        } as never,
        userId,
        tenantId,
      ),
    ).rejects.toThrow(/Valid until cannot be before the quote date/);

    const quote = await invoicesSvc.create(
      { customer_id: customerId, document_type: 'QUOTE', invoice_date: today, due_date: plusDays(30), line_items: mkLine() } as never,
      userId,
      tenantId,
    );
    await expect(
      invoicesSvc.update(quote.data.id, { valid_until: plusDays(-1) } as never, userId, tenantId),
    ).rejects.toThrow(/Valid until cannot be before the quote date/);
    // The derived default is never second-guessed.
    const ok = await invoicesSvc.update(quote.data.id, { due_date: plusDays(20) } as never, userId, tenantId);
    expect(ok.data.valid_until).toBe(plusDays(20));
  });
});

// ─── C10 IGST guard ───────────────────────────────────────────────────────────

describe('Round P C10 — IGST-by-default guard', () => {
  let tenantId: string;
  let userId: string;
  let customerId: string;

  const codeOf = async (p: Promise<unknown>): Promise<string | undefined> => {
    try {
      await p;
      return undefined;
    } catch (err) {
      if (err instanceof HttpException) {
        const body = err.getResponse() as { code?: string };
        return body.code;
      }
      throw err;
    }
  };

  beforeAll(async () => {
    ({ tenantId, userId } = await freshTenant({ state_code: null }));
    const c = await customersSvc.create(
      { display_name: 'Domestic Co', country_code: 'IN', state_code: 'MH' } as never,
      userId,
      tenantId,
    );
    customerId = c.data.id;
  });

  it('blocks a derived treatment when the workspace has no state, naming the fix', async () => {
    const attempt = invoicesSvc.create(
      { customer_id: customerId, invoice_date: today, due_date: plusDays(15), line_items: mkLine() } as never,
      userId,
      tenantId,
    );
    await expect(attempt).rejects.toThrow(/Settings → General/);
    expect(
      await codeOf(
        invoicesSvc.create(
          { customer_id: customerId, invoice_date: today, due_date: plusDays(15), line_items: mkLine() } as never,
          userId,
          tenantId,
        ),
      ),
    ).toBe('SUPPLIER_STATE_UNKNOWN');
    // Nothing was written (no burned number either).
    expect(await sequenceRows(tenantId, 'INVOICE')).toHaveLength(0);
  });

  it('an explicit treatment and a foreign customer are not blocked', async () => {
    const explicit = await invoicesSvc.create(
      { customer_id: customerId, invoice_date: today, due_date: plusDays(15), tax_treatment: 'INTER_STATE', line_items: mkLine() } as never,
      userId,
      tenantId,
    );
    expect(explicit.data.tax_treatment).toBe('INTER_STATE');

    const abroad = await customersSvc.create(
      { display_name: 'Overseas LLC', country_code: 'US' } as never,
      userId,
      tenantId,
    );
    const exp = await invoicesSvc.create(
      { customer_id: abroad.data.id, invoice_date: today, due_date: plusDays(15), currency: 'USD', line_items: mkLine() } as never,
      userId,
      tenantId,
    );
    expect(exp.data.tax_treatment).toBe('EXPORT');
  });

  it('passes once the GSTIN-derived state is saved, and splits CGST/SGST correctly', async () => {
    // The real Settings → General save: only the GSTIN is sent and the
    // service derives the state from its prefix (29 → KA). This is the path
    // the C10 message sends the user down, so it must actually unblock them.
    expect(stateCodeFromGstin('29ABCDE1234F1Z5')).toBe('KA');
    await settingsSvc.updateOrganization(tenantId, userId, { gstin: '29ABCDE1234F1Z5' } as never);
    const [t] = await dbAdmin
      .select({ state_code: tenants.state_code, gstin: tenants.gstin })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    expect(t!.gstin).toBe('29ABCDE1234F1Z5');
    expect(t!.state_code).toBe('KA');

    const interState = await invoicesSvc.create(
      { customer_id: customerId, invoice_date: today, due_date: plusDays(15), line_items: mkLine() } as never,
      userId,
      tenantId,
    );
    expect(interState.data.tax_treatment).toBe('INTER_STATE'); // KA → MH
    expect(interState.data.igst_amount).toBe('180.00');

    const local = await customersSvc.create(
      { display_name: 'Bengaluru Co', country_code: 'IN', state_code: 'KA' } as never,
      userId,
      tenantId,
    );
    const intraState = await invoicesSvc.create(
      { customer_id: local.data.id, invoice_date: today, due_date: plusDays(15), line_items: mkLine() } as never,
      userId,
      tenantId,
    );
    expect(intraState.data.tax_treatment).toBe('INTRA_STATE');
    expect(intraState.data.cgst_amount).toBe('90.00');
    expect(intraState.data.sgst_amount).toBe('90.00');

    // Update re-derives too — and is equally unblocked now.
    const edited = await invoicesSvc.update(
      intraState.data.id,
      { notes: 'edited' } as never,
      userId,
      tenantId,
    );
    expect(edited.data.tax_treatment).toBe('INTRA_STATE');
  });

  it('a non-Indian workspace is never asked for an Indian state', async () => {
    const { tenantId: usTenant, userId: usUser } = await freshTenant({
      state_code: null,
      country_code: 'US',
      currency: 'USD',
    });
    const c = await customersSvc.create(
      { display_name: 'Any Buyer' } as never, // country_code defaults to IN
      usUser,
      usTenant,
    );
    const inv = await invoicesSvc.create(
      { customer_id: c.data.id, invoice_date: today, due_date: plusDays(15), line_items: mkLine() } as never,
      usUser,
      usTenant,
    );
    expect(inv.data.id).toBeTruthy();
  });
});

// ─── C9 send reports delivery ────────────────────────────────────────────────

describe('Round P C9 — send() returns emailSent', () => {
  it('reports true when the provider accepted the mail and false when it did not; status flips regardless', async () => {
    const { tenantId, userId } = await freshTenant();
    const c = await customersSvc.create(
      { display_name: 'Mail Co', email: 'mail@rp.test', country_code: 'IN', state_code: 'KA' } as never,
      userId,
      tenantId,
    );
    const mk = async () =>
      (
        await invoicesSvc.create(
          { customer_id: c.data.id, invoice_date: today, due_date: plusDays(15), line_items: mkLine() } as never,
          userId,
          tenantId,
        )
      ).data;

    const emailSentAtOf = async (id: string) => {
      const [row] = await dbAdmin
        .select({ email_sent_at: invoicesTable.email_sent_at })
        .from(invoicesTable)
        .where(and(eq(invoicesTable.id, id), eq(invoicesTable.tenant_id, tenantId)));
      return row!.email_sent_at;
    };

    emailOutcome = true;
    const ok = await invoicesSvc.send((await mk()).id, userId, tenantId);
    expect(ok.emailSent).toBe(true);
    expect(ok.meta.emailSent).toBe(true);
    expect(ok.data.status).toBe('SENT');
    expect(ok.meta.public_url).toContain('/inv/');
    expect(ok.data.email_sent_at).toBeTruthy();
    expect(await emailSentAtOf(ok.data.id)).toBeTruthy();

    emailOutcome = false;
    const failed = await invoicesSvc.send((await mk()).id, userId, tenantId);
    expect(failed.emailSent).toBe(false);
    expect(failed.meta.emailSent).toBe(false);
    expect(failed.data.status).toBe('SENT'); // marked sent; the UI offers the link
    expect(failed.data.public_view_token).toBeTruthy();
    // The ledger doesn't claim an email went out that the provider refused.
    expect(failed.data.email_sent_at).toBeNull();
    expect(await emailSentAtOf(failed.data.id)).toBeNull();

    // A failed RE-send keeps the earlier successful timestamp.
    const again = await invoicesSvc.send(ok.data.id, userId, tenantId);
    expect(again.emailSent).toBe(false);
    expect(again.data.email_sent_at?.getTime()).toBe(ok.data.email_sent_at!.getTime());
    expect((await emailSentAtOf(ok.data.id))?.getTime()).toBe(ok.data.email_sent_at!.getTime());
    emailOutcome = true;
  });
});
