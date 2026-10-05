/**
 * Founder round P — R2, contract K6 (email half): the 'invoice-sent' template
 * gets a QUOTE variant selected by a new `documentType` param.
 *
 *   • documentType defaults to INVOICE — the invoice email is byte-for-byte
 *     what it was before this round (golden strings captured from the
 *     pre-change template, see the fixtures below).
 *   • QUOTE: subject "Quote <number> from <company>", the body names the
 *     quote and its total, says "valid until <validUntil>" when provided,
 *     carries no due / payment language and its CTA reads "View quote",
 *     pointing at the same hosted link.
 *   • InvoicesService.send() passes documentType (the stored document_type)
 *     and validUntil (the stored valid_until, raw YYYY-MM-DD like dueDate).
 *
 * Service-level against the real Postgres for the send() half, mirroring
 * founder-roundP-r1-invoicing.spec; the template half renders through the
 * real NotificationsService (no provider call — renderTemplate only).
 */
import 'dotenv/config';
import * as crypto from 'crypto';
import { eq } from 'drizzle-orm';
import { db, dbAdmin } from '@flicks/db';
import { tenants, users } from '@flicks/db/schema';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DatabaseService } from '../core/database/database.service';
import { CustomersService } from '../modules/invoicing/customers.service';
import { InvoicesService } from '../modules/invoicing/invoices.service';
import { NumberingService } from '../modules/invoicing/numbering.service';
import { OrgFinancialService } from '../modules/org-financial/org-financial.service';
import { NotificationsService } from '../modules/notifications/notifications.service';
import type { AuditService } from '../modules/audit/audit.service';

jest.setTimeout(60_000);

const rid = () => crypto.randomBytes(4).toString('hex');

// ─── Template rendering (real service, private renderTemplate) ───────────────

const realNotifications = new NotificationsService(
  db as never,
  dbAdmin as never,
  new ConfigService({ NODE_ENV: 'test', RESEND_API_KEY: 're_test' }),
  new EventEmitter2(),
);
type Rendered = { subject: string; html: string };
const render = (props: Record<string, unknown>): Rendered =>
  (
    realNotifications as unknown as {
      renderTemplate: (t: string, p: Record<string, unknown>) => Rendered;
    }
  ).renderTemplate('invoice-sent', props);

/**
 * Golden output of the pre-R2 'invoice-sent' template, captured verbatim from
 * main@62ab0bd for these exact props. Whitespace is significant: the point is
 * that the INVOICE path did not move at all.
 */
const INVOICE_FULL_PROPS = {
  invoiceNumber: 'INV/26-27/0007',
  tenantName: 'Acme Pvt Ltd',
  customerName: 'Priya Sharma',
  amount: 'INR 11800.00',
  dueDate: '2026-11-04',
  viewUrl: 'https://app.test/inv/tok-abc',
};
const INVOICE_FULL_GOLDEN: Rendered = {
  subject: 'Invoice INV/26-27/0007 from Acme Pvt Ltd',
  html:
    '\n            <p>Hi Priya Sharma,</p>\n            <p>Acme Pvt Ltd sent you invoice <strong>INV/26-27/0007</strong>\n            for <strong>INR 11800.00</strong>, due <strong>2026-11-04</strong>.</p>\n            <p style="margin:24px 0;">\n              <a href="https://app.test/inv/tok-abc" style="background:#3E7BFA;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;">View &amp; Pay</a>\n            </p>\n            <p>You can view the invoice and pay online any time from the link above.</p>\n          ',
};
const INVOICE_BARE_PROPS = {
  invoiceNumber: 'INV/26-27/0008',
  amount: 'INR 500.00',
  dueDate: '2026-11-05',
};
const INVOICE_BARE_GOLDEN: Rendered = {
  subject: 'Invoice INV/26-27/0008 from Flicks Suite',
  html:
    '\n            <p>Hi there,</p>\n            <p>We sent you invoice <strong>INV/26-27/0008</strong>\n            for <strong>INR 500.00</strong>, due <strong>2026-11-05</strong>.</p>\n            <p style="margin:24px 0;">\n              <a href="#" style="background:#3E7BFA;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;">View &amp; Pay</a>\n            </p>\n            <p>You can view the invoice and pay online any time from the link above.</p>\n          ',
};

const QUOTE_PROPS = {
  invoiceNumber: 'QTE/26-27/0003',
  tenantName: 'Acme Pvt Ltd',
  customerName: 'Priya Sharma',
  amount: 'INR 11800.00',
  dueDate: '2026-11-04',
  viewUrl: 'https://app.test/inv/tok-quote',
  documentType: 'QUOTE',
  validUntil: '2026-11-04',
};

describe('K6 — invoice-sent template: INVOICE variant is unchanged', () => {
  it('no documentType → byte-for-byte the pre-R2 output (full props)', () => {
    expect(render(INVOICE_FULL_PROPS)).toEqual(INVOICE_FULL_GOLDEN);
  });

  it('no documentType → byte-for-byte the pre-R2 output (fallback props)', () => {
    expect(render(INVOICE_BARE_PROPS)).toEqual(INVOICE_BARE_GOLDEN);
  });

  it('explicit documentType: INVOICE renders the same as the default', () => {
    expect(render({ ...INVOICE_FULL_PROPS, documentType: 'INVOICE' })).toEqual(INVOICE_FULL_GOLDEN);
    // A stray validUntil on an invoice is ignored — invoices have no validity.
    expect(render({ ...INVOICE_FULL_PROPS, documentType: 'INVOICE', validUntil: '2026-12-31' })).toEqual(
      INVOICE_FULL_GOLDEN,
    );
  });

  it('anything but QUOTE (e.g. CREDIT_NOTE / undefined / null) takes the invoice path', () => {
    for (const documentType of ['CREDIT_NOTE', undefined, null, '']) {
      expect(render({ ...INVOICE_FULL_PROPS, documentType })).toEqual(INVOICE_FULL_GOLDEN);
    }
  });
});

describe('K6 — invoice-sent template: QUOTE variant', () => {
  it('subject is "Quote <number> from <company>"', () => {
    const out = render(QUOTE_PROPS);
    expect(out.subject).toBe('Quote QTE/26-27/0003 from Acme Pvt Ltd');
    // Falls back to the app name without a tenant name, like the invoice path.
    expect(render({ ...QUOTE_PROPS, tenantName: undefined }).subject).toBe(
      'Quote QTE/26-27/0003 from Flicks Suite',
    );
  });

  it('body names the quote, its total, "valid until <date>" and a "View quote" CTA on the same link', () => {
    const { html } = render(QUOTE_PROPS);
    expect(html).toContain('Hi Priya Sharma,');
    expect(html).toContain('Acme Pvt Ltd sent you quote <strong>QTE/26-27/0003</strong>');
    expect(html).toContain('<strong>INR 11800.00</strong>');
    expect(html).toContain('valid until <strong>2026-11-04</strong>');
    expect(html).toContain('>View quote</a>');
    expect(html).toContain('href="https://app.test/inv/tok-quote"');
    // Shared layout: the same button styling as the invoice CTA.
    expect(html).toContain('background:#3E7BFA;color:#fff;padding:12px 24px;border-radius:8px;');
  });

  it('carries no due / payment language anywhere (subject + body)', () => {
    const out = render(QUOTE_PROPS);
    const text = `${out.subject}\n${out.html}`;
    expect(text).not.toMatch(/due/i);
    expect(text).not.toMatch(/pay/i);
    expect(text).not.toContain('View &amp; Pay');
    expect(text).not.toContain('invoice');
  });

  it('omits the validity sentence when validUntil is not provided (or null)', () => {
    for (const validUntil of [undefined, null, '']) {
      const { html } = render({ ...QUOTE_PROPS, validUntil });
      expect(html).not.toMatch(/valid until/i);
      expect(html).toContain('for <strong>INR 11800.00</strong>.</p>');
      expect(html).toContain('>View quote</a>');
    }
  });

  it('falls back to "there" / "We" like the invoice path when names are missing', () => {
    const { html } = render({
      invoiceNumber: 'QTE/26-27/0004',
      amount: 'INR 100.00',
      documentType: 'QUOTE',
    });
    expect(html).toContain('Hi there,');
    expect(html).toContain('We sent you quote <strong>QTE/26-27/0004</strong>');
    expect(html).toContain('href="#"');
  });
});

// ─── InvoicesService.send() passes documentType + validUntil ─────────────────

type Captured = { template: string; to: string; props: Record<string, unknown> };
const sentEmails: Captured[] = [];
const sendEmail = jest.fn(async (template: string, to: string, props: Record<string, unknown>) => {
  sentEmails.push({ template, to, props });
  return true;
});
const notificationsStub = { sendEmail } as unknown as NotificationsService;
const audit = { log: async () => undefined } as unknown as AuditService;
const configStub = {
  get: (key: string, fallback?: unknown) =>
    key === 'PUBLIC_INVOICE_BASE_URL' ? 'http://localhost:3000' : fallback,
} as unknown as ConfigService;
const domainEventsStub = { publish: async () => null } as never;

const dbSvc = new DatabaseService();
const numbering = new NumberingService(dbSvc, audit);
const orgFinancial = new OrgFinancialService(dbSvc, audit);
const customersSvc = new CustomersService(dbSvc, audit);
const invoicesSvc = new InvoicesService(
  dbSvc,
  audit,
  numbering,
  configStub,
  notificationsStub,
  orgFinancial,
  domainEventsStub,
);

const plusDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const mkLine = () => [{ item_name: 'Retainer', quantity: '1', rate: '1000.00', gst_rate: '18' }];

let tenantId: string;
let userId: string;
let customerId: string;

beforeAll(async () => {
  const [t] = await dbAdmin
    .insert(tenants)
    .values({
      name: `RpQuote${rid()}`,
      slug: `rpquote-${rid()}-${Date.now()}`,
      status: 'trialing',
      state_code: 'KA',
    })
    .returning();
  tenantId = t!.id;
  const [u] = await dbAdmin
    .insert(users)
    .values({ email: `rpquote-${rid()}@test.test`, full_name: 'RP Quote User', status: 'active' })
    .returning();
  userId = u!.id;
  const c = await customersSvc.create(
    { display_name: 'Acme Buyer', email: 'quote-buyer@test.test', state_code: 'KA' },
    userId,
    tenantId,
  );
  customerId = c.data.id;
});

afterAll(async () => {
  await dbAdmin.delete(tenants).where(eq(tenants.id, tenantId));
  await dbAdmin.delete(users).where(eq(users.id, userId));
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
});

describe('K6 — InvoicesService.send() feeds the template the document type and validity', () => {
  it('a QUOTE is sent with documentType QUOTE and validUntil = the stored valid_until', async () => {
    sentEmails.length = 0;
    const today = plusDays(0);
    const validUntil = plusDays(21);
    const quote = (
      await invoicesSvc.create(
        {
          customer_id: customerId,
          document_type: 'QUOTE',
          invoice_date: today,
          due_date: plusDays(30),
          valid_until: validUntil,
          line_items: mkLine(),
        } as never,
        userId,
        tenantId,
      )
    ).data;
    expect(quote.document_type).toBe('QUOTE');
    expect(quote.valid_until).toBe(validUntil);

    const sent = await invoicesSvc.send(quote.id, userId, tenantId);
    expect(sent.emailSent).toBe(true);
    expect(sentEmails).toHaveLength(1);
    const [mail] = sentEmails;
    expect(mail!.template).toBe('invoice-sent');
    expect(mail!.to).toBe('quote-buyer@test.test');
    expect(mail!.props).toMatchObject({
      invoiceNumber: quote.invoice_number,
      documentType: 'QUOTE',
      validUntil, // raw YYYY-MM-DD, exactly how dueDate travels
      dueDate: plusDays(30),
      viewUrl: sent.meta.public_url,
    });

    // End to end: the captured props render as the quote variant.
    const out = render(mail!.props);
    expect(out.subject).toBe(`Quote ${quote.invoice_number} from ${(await tenantName())}`);
    expect(out.html).toContain(`valid until <strong>${validUntil}</strong>`);
    expect(out.html).toContain('>View quote</a>');
    expect(out.html).toContain(`href="${sent.meta.public_url}"`);
    expect(`${out.subject}\n${out.html}`).not.toMatch(/due|pay/i);
  });

  it('an INVOICE is sent with documentType INVOICE and no validUntil — and renders as before', async () => {
    sentEmails.length = 0;
    const inv = (
      await invoicesSvc.create(
        {
          customer_id: customerId,
          invoice_date: plusDays(0),
          due_date: plusDays(30),
          line_items: mkLine(),
        } as never,
        userId,
        tenantId,
      )
    ).data;
    expect(inv.document_type).toBe('INVOICE');
    expect(inv.valid_until).toBeNull();

    const sent = await invoicesSvc.send(inv.id, userId, tenantId);
    expect(sentEmails).toHaveLength(1);
    const [mail] = sentEmails;
    expect(mail!.props.documentType).toBe('INVOICE');
    expect(mail!.props.validUntil).toBeUndefined();
    expect(mail!.props.dueDate).toBe(plusDays(30));

    const out = render(mail!.props);
    expect(out.subject).toBe(`Invoice ${inv.invoice_number} from ${(await tenantName())}`);
    expect(out.html).toContain(`due <strong>${plusDays(30)}</strong>`);
    expect(out.html).toContain('View &amp; Pay');
    expect(out.html).toContain(`href="${sent.meta.public_url}"`);
    expect(out.html).toContain('Hi Acme Buyer,');
    expect(`${out.subject}\n${out.html}`).not.toMatch(/sent you quote|View quote|valid until|^Quote /im);
  });

  it('a quote converted to an invoice is sent as an INVOICE (valid_until cleared on promotion)', async () => {
    sentEmails.length = 0;
    const quote = (
      await invoicesSvc.create(
        {
          customer_id: customerId,
          document_type: 'QUOTE',
          invoice_date: plusDays(0),
          due_date: plusDays(15),
          valid_until: plusDays(10),
          line_items: mkLine(),
        } as never,
        userId,
        tenantId,
      )
    ).data;
    const converted = await invoicesSvc.convertToInvoice(quote.id, userId, tenantId);
    expect(converted.data.document_type).toBe('INVOICE');
    expect(converted.data.valid_until).toBeNull();

    await invoicesSvc.send(converted.data.id, userId, tenantId);
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0]!.props.documentType).toBe('INVOICE');
    expect(sentEmails[0]!.props.validUntil).toBeUndefined();
    expect(render(sentEmails[0]!.props).subject).toMatch(/^Invoice /);
  });
});

async function tenantName(): Promise<string> {
  const [t] = await dbAdmin.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, tenantId));
  return t!.name;
}
