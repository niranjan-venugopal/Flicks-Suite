/**
 * Founder round P — R2 numbering formats (migration 0066):
 *
 *  Per document type the series is either Financial-year (PREFIX{sep}FY{sep}NNNN,
 *  resets each FY — today's behaviour) or Continuous (PREFIX{sep?}NNNNN,
 *  never resets, e.g. LB2400001). The current-FY row holds the config
 *  (prefix / separator / zero_padding / starting_number / series_mode) and FY
 *  rollover copies it forward; the continuous counter lives in ONE sentinel
 *  row fy_label = 'ALL', fy_end_date = '9999-12-31'. invoices.fy_label still
 *  records the document's own FY in both modes (GSTR-1 period grouping).
 *
 * Service-level against the real Postgres, mirroring invoicing-services.spec
 * and founder-roundP-r1-invoicing.spec.
 */
import 'dotenv/config';
import * as crypto from 'crypto';
import { and, eq } from 'drizzle-orm';
import { db, dbAdmin } from '@flicks/db';
import { tenants, users, invoiceSequences, invoices as invoicesTable } from '@flicks/db/schema';
import type { ConfigService } from '@nestjs/config';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { DatabaseService } from '../core/database/database.service';
import { CustomersService } from '../modules/invoicing/customers.service';
import { InvoicesService } from '../modules/invoicing/invoices.service';
import { NumberingService } from '../modules/invoicing/numbering.service';
import { OrgFinancialService } from '../modules/org-financial/org-financial.service';
import { UpsertSequenceDto, PreviewNumberDto } from '../modules/invoicing/dto/invoicing.dto';
import { computeFiscalYear, formatFyLabel } from '../modules/invoicing/numbering.util';
import type { AuditService } from '../modules/audit/audit.service';
import type { NotificationsService } from '../modules/notifications/notifications.service';

const rid = () => crypto.randomBytes(4).toString('hex');
const auditLog = jest.fn(async (_entry: Record<string, unknown>) => undefined);
const audit = { log: auditLog } as unknown as AuditService;
const dbSvc = new DatabaseService();

const notifications = { sendEmail: jest.fn(async () => true) } as unknown as NotificationsService;
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

const today = new Date().toISOString().slice(0, 10);
// April-start FY of "today" — the window list()/upsert() operate on.
const fyNow = computeFiscalYear(today, 4);
// The FY before it and the April-1 boundary between the two — derived, so
// the spec does not expire on the next rollover.
const fyPrev = computeFiscalYear(`${fyNow.startYear}-03-31`, 4);
const lastDayPrevFy = fyPrev.endDate; // e.g. 2026-03-31
const firstDayFy = fyNow.startDate; // e.g. 2026-04-01
const ALL = 'ALL';
const ALL_END = '9999-12-31';

async function seedTenant(over: Partial<typeof tenants.$inferInsert> = {}) {
  const [t] = await dbAdmin
    .insert(tenants)
    .values({
      name: `RpNum${rid()}`,
      slug: `rpnum-${rid()}-${Date.now()}`,
      status: 'trialing',
      state_code: 'KA',
      fiscal_year_start_month: 4,
      ...over,
    })
    .returning();
  const [u] = await dbAdmin
    .insert(users)
    .values({ email: `rpnum-${rid()}@test.test`, full_name: 'RP Numbering', status: 'active' })
    .returning();
  return { tenantId: t!.id, userId: u!.id };
}

const rowsFor = (tenantId: string, docType: string) =>
  dbAdmin
    .select()
    .from(invoiceSequences)
    .where(
      and(
        eq(invoiceSequences.tenant_id, tenantId),
        eq(invoiceSequences.document_type, docType),
      ),
    );
const fyRowsFor = async (tenantId: string, docType: string) =>
  (await rowsFor(tenantId, docType)).filter((r) => r.fy_label !== ALL);
const allRowFor = async (tenantId: string, docType: string) =>
  (await rowsFor(tenantId, docType)).find((r) => r.fy_label === ALL);

const reserve = (tenantId: string, docType: string, isoDate: string) =>
  dbSvc.withTenant(tenantId, (tx) => numbering.reserveNext(tx, tenantId, docType, isoDate));

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

// ─── The founder's flow: continuous across April 1, back, and again ───────────

describe('Round P R2 — continuous series never resets; switching modes resumes each counter', () => {
  let tenantId: string;
  let userId: string;
  let allRowId: string;
  let allRowEnabledOn: string;
  let fyRowId: string;

  beforeAll(async () => {
    ({ tenantId, userId } = await freshTenant());
  });

  it('enabling continuous (LB24, no separator, pad 5) stores the mode on the FY row and creates the ALL counter row', async () => {
    auditLog.mockClear();
    const up = await numbering.upsert(
      tenantId,
      { document_type: 'INVOICE', series_mode: 'continuous', prefix: 'LB24', separator: '', zero_padding: 5, starting_number: 1 },
      userId,
    );
    expect(up.warning).toBeUndefined(); // nothing issued yet, nothing to warn about
    expect(up.sample).toBe('LB2400001');
    expect(up.data.series_mode).toBe('continuous');
    expect(up.data.fy_label).toBe(fyNow.label); // the FY row still carries its own label
    expect(up.data.fy_start_date).toBe(fyNow.startDate);
    expect(up.data.continuous_current_number).toBe(0);
    fyRowId = up.data.id;

    const fyRows = await fyRowsFor(tenantId, 'INVOICE');
    expect(fyRows).toHaveLength(1);
    expect(fyRows[0]).toMatchObject({ id: fyRowId, series_mode: 'continuous', prefix: 'LB24', separator: '', zero_padding: 5, current_number: 0 });

    const allRow = await allRowFor(tenantId, 'INVOICE');
    expect(allRow).toBeDefined();
    expect(allRow).toMatchObject({
      fy_label: ALL,
      fy_start_date: today,
      fy_end_date: ALL_END,
      series_mode: 'continuous',
      prefix: 'LB24',
      separator: '',
      zero_padding: 5,
      starting_number: 1,
      current_number: 0,
      branch_code: '',
    });
    allRowId = allRow!.id;
    allRowEnabledOn = allRow!.fy_start_date;

    // Audit carries the counter row so support can find it.
    const entry = auditLog.mock.calls.find(
      (c) => (c[0] as { action?: string }).action === 'invoicing.sequence.upsert',
    )?.[0] as { metadata?: { continuous_counter?: { id: string; current_number: number } } };
    expect(entry.metadata?.continuous_counter).toEqual({ id: allRowId, current_number: 0 });
  });

  it('31 Mar → 1 Apr: LB2400001, LB2400002 on the ALL row — no reset — while the fyLabel differs', async () => {
    const march = await reserve(tenantId, 'INVOICE', lastDayPrevFy);
    const april = await reserve(tenantId, 'INVOICE', firstDayFy);
    expect(march).toMatchObject({ number: 1, formatted: 'LB2400001', fyLabel: fyPrev.label, sequenceId: allRowId });
    expect(april).toMatchObject({ number: 2, formatted: 'LB2400002', fyLabel: fyNow.label, sequenceId: allRowId });

    // The counter moved on the ALL row only; the FY rows (the previous FY's
    // one was created on the fly, inheriting continuous) stay at 0.
    const allRow = await allRowFor(tenantId, 'INVOICE');
    expect(allRow!.current_number).toBe(2);
    const fyRows = await fyRowsFor(tenantId, 'INVOICE');
    expect(fyRows.map((r) => r.fy_label).sort()).toEqual([fyPrev.label, fyNow.label].sort());
    expect(fyRows.every((r) => r.current_number === 0)).toBe(true);
    expect(fyRows.every((r) => r.series_mode === 'continuous')).toBe(true);
    expect((await rowsFor(tenantId, 'INVOICE')).filter((r) => r.fy_label === ALL)).toHaveLength(1);
  });

  it('real invoices dated 31 Mar and 1 Apr get consecutive continuous numbers and their own fy_label (GSTR-1 period)', async () => {
    const c = await customersSvc.create(
      { display_name: 'Continuous Buyer', country_code: 'IN', state_code: 'KA' } as never,
      userId,
      tenantId,
    );
    const mk = (date: string) =>
      invoicesSvc.create(
        {
          customer_id: c.data.id,
          invoice_date: date,
          due_date: date,
          line_items: [{ item_name: 'Retainer', quantity: '1', rate: '1000.00', gst_rate: '18' }],
        } as never,
        userId,
        tenantId,
      );
    const a = await mk(lastDayPrevFy);
    const b = await mk(firstDayFy);
    expect(a.data.invoice_number).toBe('LB2400003');
    expect(b.data.invoice_number).toBe('LB2400004');
    expect(a.data.fy_label).toBe(fyPrev.label);
    expect(b.data.fy_label).toBe(fyNow.label);
    const stored = await dbAdmin
      .select({ n: invoicesTable.invoice_number, fy: invoicesTable.fy_label })
      .from(invoicesTable)
      .where(eq(invoicesTable.tenant_id, tenantId));
    expect(stored.sort((x, y) => x.n.localeCompare(y.n))).toEqual([
      { n: 'LB2400003', fy: fyPrev.label },
      { n: 'LB2400004', fy: fyNow.label },
    ]);
  });

  it('a config change in continuous mode keeps the ALL counter and warns about the mid-FY change only', async () => {
    const up = await numbering.upsert(tenantId, { document_type: 'INVOICE', prefix: 'LB25' }, userId);
    expect(up.data.series_mode).toBe('continuous'); // partial save keeps the mode
    expect(up.data.continuous_current_number).toBe(4);
    expect(up.sample).toBe('LB2500005');
    expect(up.warning).toMatch(/mid-financial-year/);
    expect(up.warning).not.toMatch(/resumes at/);
    const allRow = await allRowFor(tenantId, 'INVOICE');
    expect(allRow).toMatchObject({ id: allRowId, prefix: 'LB25', current_number: 4, fy_start_date: allRowEnabledOn });
    // Back to LB24 for the rest of the flow.
    await numbering.upsert(tenantId, { document_type: 'INVOICE', prefix: 'LB24' }, userId);
  });

  it('switching back to financial-year resumes this FY\'s own counter and says so', async () => {
    const up = await numbering.upsert(
      tenantId,
      { document_type: 'INVOICE', series_mode: 'fiscal_year', prefix: 'INV', separator: '/', zero_padding: 4 },
      userId,
    );
    expect(up.data.id).toBe(fyRowId);
    expect(up.data.series_mode).toBe('fiscal_year');
    expect(up.data.continuous_current_number).toBeNull();
    expect(up.sample).toBe(`INV/${fyNow.label}/0001`);
    // This FY's own counter is still at 0 — there is nothing to "resume",
    // so only the mid-FY note is shown (the continuous series issued 4).
    expect(up.warning).toMatch(/mid-financial-year/);
    expect(up.warning).not.toMatch(/resumes at/);

    const r = await reserve(tenantId, 'INVOICE', today);
    expect(r).toMatchObject({ number: 1, formatted: `INV/${fyNow.label}/0001`, fyLabel: fyNow.label, sequenceId: fyRowId });
    // The ALL row is left alone (its counter waits for a switch back).
    const allRow = await allRowFor(tenantId, 'INVOICE');
    expect(allRow).toMatchObject({ id: allRowId, current_number: 4, series_mode: 'continuous' });
    // The previous FY's row (created on the fly while continuous) follows
    // the tab too — the mode is per document type, not per FY row.
    expect((await fyRowsFor(tenantId, 'INVOICE')).every((r2) => r2.series_mode === 'fiscal_year')).toBe(true);

    const listed = await numbering.list(tenantId);
    const inv = listed.data.find((s) => s.document_type === 'INVOICE')!;
    expect(inv).toMatchObject({ id: fyRowId, series_mode: 'fiscal_year', continuous_current_number: null, current_number: 1 });
    expect(inv.next_number_preview).toBe(`INV/${fyNow.label}/0002`);
  });

  it('switching to continuous again resumes the ALL row (not the starting number) and warns', async () => {
    const up = await numbering.upsert(
      tenantId,
      { document_type: 'INVOICE', series_mode: 'continuous', prefix: 'LB24', separator: '', zero_padding: 5, starting_number: 1 },
      userId,
    );
    expect(up.data.id).toBe(fyRowId);
    expect(up.data.continuous_current_number).toBe(4);
    expect(up.sample).toBe('LB2400005');
    expect(up.warning).toMatch('Continuous series resumes at LB2400005 (not at your starting number).');
    expect(up.warning).toMatch(/mid-financial-year/);

    const r = await reserve(tenantId, 'INVOICE', today);
    expect(r).toMatchObject({ number: 5, formatted: 'LB2400005', fyLabel: fyNow.label, sequenceId: allRowId });

    // Still exactly one ALL row, first-enabled date intact; the FY row keeps its own counter at 1.
    const all = (await rowsFor(tenantId, 'INVOICE')).filter((r2) => r2.fy_label === ALL);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: allRowId, fy_start_date: allRowEnabledOn, current_number: 5 });
    const [fyRow] = (await fyRowsFor(tenantId, 'INVOICE')).filter((r2) => r2.id === fyRowId);
    expect(fyRow).toMatchObject({ current_number: 1, series_mode: 'continuous' });
  });

  it('a starting number above the ALL counter is honoured — no "resumes at" warning', async () => {
    const up = await numbering.upsert(
      tenantId,
      { document_type: 'INVOICE', series_mode: 'fiscal_year' },
      userId,
    );
    // This FY's row has issued 1 (≥ starting number 1): the sentence names
    // the number the FY counter will really issue next, under the kept
    // continuous-era config (LB24, no separator, pad 5 + the FY token).
    expect(up.warning).toMatch(`Financial-year series resumes at LB24${fyNow.label}00002.`);
    const again = await numbering.upsert(
      tenantId,
      { document_type: 'INVOICE', series_mode: 'continuous', starting_number: 100 },
      userId,
    );
    expect(again.sample).toBe('LB2400100');
    expect(again.warning).not.toMatch(/resumes at/);
    expect(again.warning).toMatch(/mid-financial-year/);
    const r = await reserve(tenantId, 'INVOICE', today);
    expect(r).toMatchObject({ number: 100, formatted: 'LB2400100', sequenceId: allRowId });
  });

  it('QUOTE stays a financial-year series while INVOICE is continuous; list() reports both shapes', async () => {
    const q = await reserve(tenantId, 'QUOTE', today);
    expect(q).toMatchObject({ number: 1, formatted: `QT/${fyNow.label}/0001`, fyLabel: fyNow.label });
    expect(await allRowFor(tenantId, 'QUOTE')).toBeUndefined();

    const listed = await numbering.list(tenantId);
    expect(listed.data.map((s) => s.document_type)).toEqual(['INVOICE', 'QUOTE', 'CREDIT_NOTE', 'DEBIT_NOTE']);
    const inv = listed.data.find((s) => s.document_type === 'INVOICE')!;
    const quote = listed.data.find((s) => s.document_type === 'QUOTE')!;
    const crn = listed.data.find((s) => s.document_type === 'CREDIT_NOTE')!;
    expect(inv).toMatchObject({
      id: fyRowId,
      series_mode: 'continuous',
      continuous_current_number: 100,
      current_number: 1, // the FY row's own counter
      prefix: 'LB24',
      separator: '',
      zero_padding: 5,
      starting_number: 100,
      fy_label: fyNow.label,
      next_number_preview: 'LB2400101',
    });
    expect(quote).toMatchObject({
      series_mode: 'fiscal_year',
      continuous_current_number: null,
      current_number: 1,
      next_number_preview: `QT/${fyNow.label}/0002`,
    });
    expect(quote.id).toBe(q.sequenceId);
    // Untouched doc types: defaults, no row.
    expect(crn).toMatchObject({ id: null, series_mode: 'fiscal_year', continuous_current_number: null, next_number_preview: `CRN/${fyNow.label}/0001` });
  });

  it('preview() honours series_mode (explicit or stored) and reports horizon warnings', async () => {
    // Stored mode (continuous) when the dto says nothing.
    const stored = await numbering.preview(tenantId, { document_type: 'INVOICE' });
    expect(stored.data).toMatchObject({ series_mode: 'continuous', next_number_preview: 'LB2400101', valid: true, errors: [], warnings: [] });
    expect(stored.data.fy_label).toBe(fyNow.label);

    // Explicit FY mode on the same tenant: the FY row's counter (1) + FY token.
    const fy = await numbering.preview(tenantId, { document_type: 'INVOICE', series_mode: 'fiscal_year', prefix: 'INV', separator: '/', zero_padding: 4, starting_number: 1 });
    expect(fy.data).toMatchObject({ series_mode: 'fiscal_year', next_number_preview: `INV/${fyNow.label}/0002`, valid: true });

    // Explicit continuous on a doc type that never had it: counter 0 → the starting number.
    const quote = await numbering.preview(tenantId, { document_type: 'QUOTE', series_mode: 'continuous', prefix: 'QLB', separator: '-', zero_padding: 6 });
    expect(quote.data).toMatchObject({ series_mode: 'continuous', next_number_preview: 'QLB-000001', valid: true, warnings: [] });

    // Horizon: pad 4 continuous at 16 chars warns; the same under FY does not.
    const narrow = await numbering.preview(tenantId, { document_type: 'DEBIT_NOTE', series_mode: 'continuous', prefix: 'ABCDEFGHIJK', separator: '/', zero_padding: 4 });
    expect(narrow.data.next_number_preview).toBe('ABCDEFGHIJK/0001');
    expect(narrow.data.valid).toBe(true);
    expect(narrow.data.warnings).toHaveLength(1);
    expect(narrow.data.warnings[0]).toMatch(/from 10000 onward/);
    const fyNarrow = await numbering.preview(tenantId, { document_type: 'DEBIT_NOTE', series_mode: 'fiscal_year', prefix: 'ABCDEF', separator: '/', fy_format: '26-27', zero_padding: 3, on_date: '2026-10-05' });
    expect(fyNarrow.data.next_number_preview).toBe('ABCDEF/26-27/001');
    expect(fyNarrow.data.warnings[0]).toMatch(/from 1000 onward/);

    // Hard errors still come back as errors, not warnings.
    const tooLong = await numbering.preview(tenantId, { document_type: 'DEBIT_NOTE', series_mode: 'continuous', prefix: 'ABCDEFGHIJK', separator: '/', zero_padding: 6 });
    expect(tooLong.data.valid).toBe(false);
    expect(tooLong.data.errors.join(' ')).toMatch(/max 16/);
    expect(tooLong.data.warnings).toEqual([]);
  });

  it('upsert refuses an over-length continuous format and leaves the rows untouched', async () => {
    const before = await rowsFor(tenantId, 'INVOICE');
    await expect(
      numbering.upsert(tenantId, { document_type: 'INVOICE', prefix: 'ABCDEFGHIJ', zero_padding: 8 }, userId),
    ).rejects.toThrow(/max 16/);
    expect(await rowsFor(tenantId, 'INVOICE')).toEqual(before);
  });
});

// ─── Concurrency + isolation ─────────────────────────────────────────────────

describe('Round P R2 — 8 parallel reservations on a continuous series', () => {
  it('yield 1..8 on exactly one ALL row, without touching the FY row counter', async () => {
    const { tenantId, userId } = await freshTenant();
    await numbering.upsert(
      tenantId,
      { document_type: 'INVOICE', series_mode: 'continuous', prefix: 'LB24', separator: '', zero_padding: 5 },
      userId,
    );
    const results = await Promise.all(
      Array.from({ length: 8 }, () => reserve(tenantId, 'INVOICE', today)),
    );
    expect(results.map((r) => r.number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(new Set(results.map((r) => r.formatted)).size).toBe(8);
    expect(results.every((r) => /^LB24\d{5}$/.test(r.formatted))).toBe(true);
    expect(new Set(results.map((r) => r.sequenceId)).size).toBe(1);

    const rows = await rowsFor(tenantId, 'INVOICE');
    const all = rows.filter((r) => r.fy_label === ALL);
    expect(all).toHaveLength(1);
    expect(all[0]!.current_number).toBe(8);
    expect(all[0]!.id).toBe(results[0]!.sequenceId);
    const fy = rows.filter((r) => r.fy_label !== ALL);
    expect(fy).toHaveLength(1);
    expect(fy[0]!.current_number).toBe(0);
  });

  it('8 parallel first reservations on a new FY of a continuous series create one FY row and keep counting', async () => {
    const { tenantId, userId } = await freshTenant();
    await numbering.upsert(
      tenantId,
      { document_type: 'INVOICE', series_mode: 'continuous', prefix: 'LB24', separator: '', zero_padding: 5 },
      userId,
    );
    await reserve(tenantId, 'INVOICE', today); // 1
    const nextFyStart = `${fyNow.endYear}-04-01`; // first day of the FY after the current one
    const results = await Promise.all(
      Array.from({ length: 8 }, () => reserve(tenantId, 'INVOICE', nextFyStart)),
    );
    expect(results.map((r) => r.number).sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    const rows = await rowsFor(tenantId, 'INVOICE');
    const newFy = rows.filter((r) => r.fy_start_date === nextFyStart);
    expect(newFy).toHaveLength(1);
    expect(newFy[0]).toMatchObject({ series_mode: 'continuous', prefix: 'LB24', separator: '', zero_padding: 5, current_number: 0 });
    expect(rows.filter((r) => r.fy_label === ALL)).toHaveLength(1);
  });
});

describe('Round P R2 — the ALL row is never mistaken for an FY row', () => {
  it('even when it was enabled on the FY start date itself', async () => {
    const { tenantId, userId } = await freshTenant();
    const up = await numbering.upsert(
      tenantId,
      { document_type: 'INVOICE', series_mode: 'continuous', prefix: 'LB24', separator: '', zero_padding: 5 },
      userId,
    );
    // Simulate "enabled on April 1": the ALL row's fy_start_date equals the FY window start.
    await dbAdmin
      .update(invoiceSequences)
      .set({ fy_start_date: fyNow.startDate })
      .where(and(eq(invoiceSequences.tenant_id, tenantId), eq(invoiceSequences.fy_label, ALL)));

    const r = await reserve(tenantId, 'INVOICE', today);
    expect(r.formatted).toBe('LB2400001');
    expect(r.sequenceId).not.toBe(up.data.id);
    const listed = await numbering.list(tenantId);
    const inv = listed.data.find((s) => s.document_type === 'INVOICE')!;
    expect(inv.id).toBe(up.data.id); // the FY row, not the sentinel
    expect(inv.continuous_current_number).toBe(1);
    expect(inv.next_number_preview).toBe('LB2400002');

    // And a save still updates the FY row in place — no twin, no 23505.
    const again = await numbering.upsert(tenantId, { document_type: 'INVOICE', zero_padding: 6 }, userId);
    expect(again.data.id).toBe(up.data.id);
    expect(await fyRowsFor(tenantId, 'INVOICE')).toHaveLength(1);
    expect((await allRowFor(tenantId, 'INVOICE'))!).toMatchObject({ zero_padding: 6, current_number: 1 });
  });
});

// ─── Rollover inheritance ────────────────────────────────────────────────────

describe('Round P R2 — FY rollover carries series_mode', () => {
  it('the FY row reserveNext() creates for a new FY inherits continuous and keeps counting on ALL', async () => {
    const { tenantId, userId } = await freshTenant();
    await numbering.upsert(
      tenantId,
      { document_type: 'INVOICE', series_mode: 'continuous', prefix: 'LB24', separator: '', zero_padding: 5 },
      userId,
    );
    await reserve(tenantId, 'INVOICE', today); // LB2400001 in the current FY
    const nextFyStart = `${fyNow.endYear}-04-01`;
    const nextFy = computeFiscalYear(nextFyStart, 4);
    const a = await reserve(tenantId, 'INVOICE', nextFyStart);
    const b = await reserve(tenantId, 'INVOICE', `${fyNow.endYear}-04-02`);
    expect(a).toMatchObject({ number: 2, formatted: 'LB2400002', fyLabel: nextFy.label });
    expect(b).toMatchObject({ number: 3, formatted: 'LB2400003', fyLabel: nextFy.label });

    const created = (await fyRowsFor(tenantId, 'INVOICE')).find((r) => r.fy_start_date === nextFyStart);
    expect(created).toMatchObject({ series_mode: 'continuous', prefix: 'LB24', separator: '', zero_padding: 5, starting_number: 1, current_number: 0, fy_label: nextFy.label });
  });

  it('between April 1 and the first document, list() and upsert() inherit the previous FY\'s mode instead of showing defaults', async () => {
    const { tenantId, userId } = await freshTenant();
    const prev = computeFiscalYear(`${fyNow.startYear - 1}-06-01`, 4);
    // A tenant that enabled continuous last FY and has not saved or issued anything this FY.
    await dbAdmin.insert(invoiceSequences).values([
      {
        tenant_id: tenantId,
        document_type: 'INVOICE',
        fy_label: prev.label,
        fy_start_date: prev.startDate,
        fy_end_date: prev.endDate,
        prefix: 'LB24',
        separator: '',
        fy_format: '26-27',
        zero_padding: 5,
        starting_number: 1,
        current_number: 0,
        branch_code: '',
        series_mode: 'continuous',
      },
      {
        tenant_id: tenantId,
        document_type: 'INVOICE',
        fy_label: ALL,
        fy_start_date: `${prev.startYear}-09-15`,
        fy_end_date: ALL_END,
        prefix: 'LB24',
        separator: '',
        fy_format: '26-27',
        zero_padding: 5,
        starting_number: 1,
        current_number: 41,
        branch_code: '',
        series_mode: 'continuous',
      },
    ]);

    const listed = await numbering.list(tenantId);
    const inv = listed.data.find((s) => s.document_type === 'INVOICE')!;
    expect(inv).toMatchObject({
      id: null, // this FY's row does not exist yet
      series_mode: 'continuous',
      continuous_current_number: 41,
      current_number: 0,
      prefix: 'LB24',
      next_number_preview: 'LB2400042',
    });
    const prev2 = await numbering.preview(tenantId, { document_type: 'INVOICE' });
    expect(prev2.data.next_number_preview).toBe('LB2400042');

    // A partial save (what the tab sends) must not flip the tenant back to FY numbering.
    const up = await numbering.upsert(tenantId, { document_type: 'INVOICE', zero_padding: 6 }, userId);
    expect(up.data).toMatchObject({ series_mode: 'continuous', prefix: 'LB24', separator: '', zero_padding: 6, fy_start_date: fyNow.startDate, current_number: 0, continuous_current_number: 41 });
    expect(up.sample).toBe('LB24000042');
    expect(up.warning).toMatch(/mid-financial-year/); // the series has issued 41 numbers
    expect(up.warning).not.toMatch(/resumes at/); // no mode switch
    const allRow = await allRowFor(tenantId, 'INVOICE');
    expect(allRow).toMatchObject({ zero_padding: 6, current_number: 41, fy_start_date: `${prev.startYear}-09-15` });

    const r = await reserve(tenantId, 'INVOICE', today);
    expect(r).toMatchObject({ number: 42, formatted: 'LB24000042', fyLabel: fyNow.label, sequenceId: allRow!.id });
  });
});

// ─── The mode is per document type, not per FY row (fix review) ──────────────

describe('Round P R2 — a mode switch applies to every FY row of the document type', () => {
  it("a document backdated into a prior FY that holds FY numbers follows the current mode and prints the continuous series' own config", async () => {
    const { tenantId, userId } = await freshTenant();
    // Financial-year mode: two backdated numbers on last FY's series, one on this FY's.
    const p1 = await reserve(tenantId, 'INVOICE', lastDayPrevFy);
    const p2 = await reserve(tenantId, 'INVOICE', lastDayPrevFy);
    const c1 = await reserve(tenantId, 'INVOICE', today);
    expect([p1.formatted, p2.formatted, c1.formatted]).toEqual([
      `INV/${fyPrev.label}/0001`,
      `INV/${fyPrev.label}/0002`,
      `INV/${fyNow.label}/0001`,
    ]);

    auditLog.mockClear();
    const up = await numbering.upsert(
      tenantId,
      { document_type: 'INVOICE', series_mode: 'continuous', prefix: 'LB24', separator: '', zero_padding: 5 },
      userId,
    );
    expect(up.sample).toBe('LB2400001');
    expect(up.warning).toMatch(/mid-financial-year/);
    expect(up.warning).not.toMatch(/resumes at/);

    // Every FY row agrees with the tab; the old FY series keeps its own
    // format and counter (never re-numbered, never advanced).
    const fyRows = await fyRowsFor(tenantId, 'INVOICE');
    expect(fyRows).toHaveLength(2);
    expect(fyRows.every((r) => r.series_mode === 'continuous')).toBe(true);
    const prevRow = fyRows.find((r) => r.fy_start_date === fyPrev.startDate)!;
    expect(prevRow).toMatchObject({ prefix: 'INV', separator: '/', zero_padding: 4, current_number: 2 });
    const entry = auditLog.mock.calls.find(
      (c) => (c[0] as { action?: string }).action === 'invoicing.sequence.upsert',
    )?.[0] as { metadata?: { propagated_rows?: Array<{ id: string; fy_label: string }> } };
    expect(entry.metadata?.propagated_rows).toEqual([{ id: prevRow.id, fy_label: fyPrev.label, fy_start_date: fyPrev.startDate }]);

    // Backdated into the previous FY: the continuous counter, printed with
    // the series' config — not INV/00001 from the old row's prefix.
    const back = await reserve(tenantId, 'INVOICE', lastDayPrevFy);
    expect(back).toMatchObject({ number: 1, formatted: 'LB2400001', fyLabel: fyPrev.label });
    const now = await reserve(tenantId, 'INVOICE', today);
    expect(now).toMatchObject({ number: 2, formatted: 'LB2400002', fyLabel: fyNow.label });
    expect(now.sequenceId).toBe(back.sequenceId);
    expect((await fyRowsFor(tenantId, 'INVOICE')).find((r) => r.id === prevRow.id)!.current_number).toBe(2);

    const inv = (await numbering.list(tenantId)).data.find((s) => s.document_type === 'INVOICE')!;
    expect(inv).toMatchObject({ series_mode: 'continuous', continuous_current_number: 2, next_number_preview: 'LB2400003' });
  });

  it('switching back to financial-year after a future-dated document created the next FY row brings that row — and its config — in line', async () => {
    const { tenantId, userId } = await freshTenant();
    await numbering.upsert(
      tenantId,
      { document_type: 'INVOICE', series_mode: 'continuous', prefix: 'LB24', separator: '', zero_padding: 5 },
      userId,
    );
    const nextFyStart = `${fyNow.endYear}-04-01`;
    const nextFy = computeFiscalYear(nextFyStart, 4);
    const future = await reserve(tenantId, 'INVOICE', nextFyStart);
    expect(future).toMatchObject({ number: 1, formatted: 'LB2400001', fyLabel: nextFy.label });
    expect((await fyRowsFor(tenantId, 'INVOICE')).find((r) => r.fy_start_date === nextFyStart)).toMatchObject({
      series_mode: 'continuous',
      prefix: 'LB24',
      separator: '',
    });

    const up = await numbering.upsert(
      tenantId,
      { document_type: 'INVOICE', series_mode: 'fiscal_year', prefix: 'INV', separator: '/', fy_format: '2026-27', zero_padding: 4 },
      userId,
    );
    const nowLabel = formatFyLabel('2026-27', fyNow.startYear, fyNow.endYear);
    const nextLabel = formatFyLabel('2026-27', nextFy.startYear, nextFy.endYear);
    expect(up.data).toMatchObject({ series_mode: 'fiscal_year', fy_start_date: fyNow.startDate, fy_label: nowLabel });
    expect(up.sample).toBe(`INV/${nowLabel}/0001`);
    expect(up.warning).toMatch(/mid-financial-year/); // the continuous series had issued 1
    expect(up.warning).not.toMatch(/resumes at/); // nothing on this FY's own row

    const fyRows = await fyRowsFor(tenantId, 'INVOICE');
    expect(fyRows).toHaveLength(2);
    expect(fyRows.every((r) => r.series_mode === 'fiscal_year')).toBe(true);
    // The future row took the whole config, its label re-derived for the new token.
    const futureRow = fyRows.find((r) => r.fy_start_date === nextFyStart)!;
    expect(futureRow).toMatchObject({
      prefix: 'INV',
      separator: '/',
      fy_format: '2026-27',
      zero_padding: 4,
      fy_label: nextLabel,
      current_number: 0,
    });

    // The next FY runs on its own FY counter with the tab's format — not on
    // the continuous series the tenant switched away from.
    const a = await reserve(tenantId, 'INVOICE', `${fyNow.endYear}-04-02`);
    expect(a).toMatchObject({ number: 1, formatted: `INV/${nextLabel}/0001`, fyLabel: nextLabel, sequenceId: futureRow.id });
    const b = await reserve(tenantId, 'INVOICE', today);
    expect(b).toMatchObject({ number: 1, formatted: `INV/${nowLabel}/0001`, fyLabel: nowLabel, sequenceId: up.data.id });
    // The ALL row keeps its counter for a later switch back.
    expect((await allRowFor(tenantId, 'INVOICE'))!.current_number).toBe(1);
    const inv = (await numbering.list(tenantId)).data.find((s) => s.document_type === 'INVOICE')!;
    expect(inv).toMatchObject({ id: up.data.id, series_mode: 'fiscal_year', continuous_current_number: null, next_number_preview: `INV/${nowLabel}/0002` });
  });
});

// ─── A config whose next number already exists is refused where it can be fixed ──

describe('Round P R2 — a format that would re-issue an existing number is refused at save time', () => {
  it('upsert and preview name the clash instead of letting every document create 409', async () => {
    const { tenantId, userId } = await freshTenant();
    // Financial-year mode, no separator, bare-year token → INV20260001.
    await numbering.upsert(
      tenantId,
      { document_type: 'INVOICE', prefix: 'INV', separator: '', fy_format: '2026', zero_padding: 4 },
      userId,
    );
    const c = await customersSvc.create(
      { display_name: 'Clash Buyer', country_code: 'IN', state_code: 'KA' } as never,
      userId,
      tenantId,
    );
    const inv = await invoicesSvc.create(
      {
        customer_id: c.data.id,
        invoice_date: today,
        due_date: today,
        line_items: [{ item_name: 'Retainer', quantity: '1', rate: '1000.00', gst_rate: '18' }],
      } as never,
      userId,
      tenantId,
    );
    const issued = `INV${fyNow.startYear}0001`;
    expect(inv.data.invoice_number).toBe(issued);

    // A continuous series with the year folded into the prefix would issue the same string.
    const clashing = {
      document_type: 'INVOICE',
      series_mode: 'continuous' as const,
      prefix: `INV${fyNow.startYear}`,
      separator: '',
      zero_padding: 4,
      starting_number: 1,
    };
    const pv = await numbering.preview(tenantId, clashing);
    expect(pv.data.next_number_preview).toBe(issued);
    expect(pv.data.valid).toBe(false);
    expect(pv.data.errors.join(' ')).toMatch(/already used by an existing document/);

    const before = await rowsFor(tenantId, 'INVOICE');
    await expect(numbering.upsert(tenantId, clashing, userId)).rejects.toThrow(
      /already used by an existing document — change the prefix or the starting number/,
    );
    expect(await rowsFor(tenantId, 'INVOICE')).toEqual(before);

    // Starting past the clash saves and issues cleanly.
    const ok = await numbering.upsert(tenantId, { ...clashing, starting_number: 2 }, userId);
    expect(ok.sample).toBe(`INV${fyNow.startYear}0002`);
    const r = await reserve(tenantId, 'INVOICE', today);
    expect(r.formatted).toBe(`INV${fyNow.startYear}0002`);
  });

  it('preview rejects a calendar-invalid on_date instead of previewing an FY of NaN-NaN', async () => {
    const { tenantId } = await freshTenant();
    for (const bad of ['2026-02-30', '2026-13-01', '2026-04-00']) {
      await expect(
        numbering.preview(tenantId, { document_type: 'INVOICE', on_date: bad }),
      ).rejects.toThrow(/on_date must be a valid YYYY-MM-DD date/);
    }
    const ok = await numbering.preview(tenantId, { document_type: 'INVOICE', on_date: firstDayFy });
    expect(ok.data.fy_label).toBe(fyNow.label);
  });
});

// ─── DTO hygiene through the real global ValidationPipe ──────────────────────

describe('Round P R2 — numbering DTOs under the global ValidationPipe', () => {
  const pipe = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    transformOptions: { enableImplicitConversion: true },
  });
  const upsertMeta = { type: 'body' as const, metatype: UpsertSequenceDto };
  const previewMeta = { type: 'body' as const, metatype: PreviewNumberDto };
  const rejects = (value: unknown, meta: typeof upsertMeta | typeof previewMeta) =>
    expect(pipe.transform(value, meta)).rejects.toThrow(BadRequestException);

  it('accepts the continuous config with an empty separator and pad 1..8', async () => {
    const ok = (await pipe.transform(
      { document_type: 'INVOICE', series_mode: 'continuous', prefix: 'LB24', separator: '', zero_padding: '5', starting_number: '1' },
      upsertMeta,
    )) as UpsertSequenceDto;
    expect({ ...ok }).toEqual({ document_type: 'INVOICE', series_mode: 'continuous', prefix: 'LB24', separator: '', zero_padding: 5, starting_number: 1 });
    for (const pad of [1, 8]) {
      const r = (await pipe.transform({ document_type: 'QUOTE', zero_padding: pad }, upsertMeta)) as UpsertSequenceDto;
      expect(r.zero_padding).toBe(pad);
    }
    for (const sep of ['/', '-']) {
      const r = (await pipe.transform({ document_type: 'QUOTE', separator: sep }, upsertMeta)) as UpsertSequenceDto;
      expect(r.separator).toBe(sep);
    }
    for (const fmt of ['26-27', '2026-27', '2026-2027', '2026']) {
      const r = (await pipe.transform({ document_type: 'QUOTE', fy_format: fmt }, upsertMeta)) as UpsertSequenceDto;
      expect(r.fy_format).toBe(fmt);
    }
    const fy = (await pipe.transform({ document_type: 'INVOICE', series_mode: 'fiscal_year' }, upsertMeta)) as UpsertSequenceDto;
    expect(fy.series_mode).toBe('fiscal_year');
  });

  it("rejects separator '.', zero_padding 9 / 0, starting_number 0, unknown fy_format / series_mode and extra keys", async () => {
    await rejects({ document_type: 'INVOICE', separator: '.' }, upsertMeta);
    await rejects({ document_type: 'INVOICE', separator: '_' }, upsertMeta);
    await rejects({ document_type: 'INVOICE', zero_padding: 9 }, upsertMeta);
    await rejects({ document_type: 'INVOICE', zero_padding: 0 }, upsertMeta);
    await rejects({ document_type: 'INVOICE', starting_number: 0 }, upsertMeta);
    await rejects({ document_type: 'INVOICE', fy_format: '26/27' }, upsertMeta);
    await rejects({ document_type: 'INVOICE', series_mode: 'weekly' }, upsertMeta);
    await rejects({ document_type: 'INVOICE', prefix: 'TOOLONGPREFIX1' }, upsertMeta);
    await rejects({ document_type: 'INVOICE', continuous: true }, upsertMeta);
    await rejects({ document_type: 'RECEIPT' }, upsertMeta);
  });

  it('PreviewNumberDto applies the same rules and accepts series_mode', async () => {
    const ok = (await pipe.transform(
      { document_type: 'INVOICE', series_mode: 'continuous', separator: '', zero_padding: 8, on_date: '2026-04-01' },
      previewMeta,
    )) as PreviewNumberDto;
    expect(ok.series_mode).toBe('continuous');
    expect(ok.separator).toBe('');
    expect(ok.zero_padding).toBe(8);
    await rejects({ document_type: 'INVOICE', separator: '.' }, previewMeta);
    await rejects({ document_type: 'INVOICE', zero_padding: 9 }, previewMeta);
    await rejects({ document_type: 'INVOICE', series_mode: 'never' }, previewMeta);
    await rejects({ document_type: 'INVOICE', fy_format: '2026/27' }, previewMeta);
    // on_date is shape-checked (YYYY-MM-DD); fy_label is bounded on both DTOs.
    await rejects({ document_type: 'INVOICE', on_date: 'xyz' }, previewMeta);
    await rejects({ document_type: 'INVOICE', on_date: '2026/04/01' }, previewMeta);
    await rejects({ document_type: 'INVOICE', on_date: '01-04-2026' }, previewMeta);
    await rejects({ document_type: 'INVOICE', fy_label: 'X'.repeat(13) }, previewMeta);
    await rejects({ document_type: 'INVOICE', fy_label: 'X'.repeat(13) }, upsertMeta);
  });
});
