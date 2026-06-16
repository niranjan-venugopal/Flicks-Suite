/**
 * Sprint 13 §B — invoice PDF generation.
 *
 * @react-pdf/renderer is ESM-only (Node's require(esm) loads it at runtime, but
 * jest's CJS sandbox cannot). We mock the renderer here to exercise the
 * service's document-building logic across both currency branches (GST vs none)
 * and the filename helper, capturing the element tree handed to renderToBuffer.
 * Real binary rendering is verified out-of-band via the ts-node runtime smoke.
 */
const renderToBuffer = jest.fn(async (_el: unknown) => Buffer.from('%PDF-1.7 mock'));
jest.mock('@react-pdf/renderer', () => ({
  renderToBuffer,
  Document: 'Document',
  Page: 'Page',
  View: 'View',
  Text: 'Text',
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));

import { InvoicePdfService, type InvoicePdfData } from '../modules/invoicing/invoice-pdf.service';

const service = new InvoicePdfService();

const baseSeller = {
  name: 'Acme Studios',
  legal_name: 'Acme Studios Pvt Ltd',
  gstin: '29ABCDE1234F1Z5',
  address_line1: '12 MG Road',
  city: 'Bengaluru',
  state_code: '29',
  postal_code: '560001',
};
const baseCustomer = {
  display_name: 'Globex',
  legal_name: 'Globex Corporation',
  gstin: '27AAACG1234M1Z2',
  billing_address_line1: '5 Park Ave',
  billing_city: 'Mumbai',
  billing_state: 'MH',
  billing_postal_code: '400001',
  billing_country: 'India',
};

const inrInvoice: InvoicePdfData = {
  invoice: {
    invoice_number: 'INV-2026-0001',
    status: 'SENT',
    invoice_date: '2026-06-01',
    due_date: '2026-06-15',
    currency: 'INR',
    subtotal: '10000.00',
    discount_amount: '0',
    taxable_amount: '10000.00',
    cgst_amount: '900.00',
    sgst_amount: '900.00',
    igst_amount: '0',
    cess_amount: '0',
    total_amount: '11800.00',
    tds_amount: '0',
    amount_paid: '0',
    amount_outstanding: '11800.00',
    notes: 'Thanks for your business.',
    terms_and_conditions: 'Payable within 15 days.',
  },
  line_items: [
    {
      line_number: 1,
      item_name: 'Design retainer',
      description: 'June 2026',
      hsn_sac_code: '998314',
      quantity: '1',
      unit: 'mo',
      rate: '10000.00',
      gst_rate: '18',
      taxable_amount: '10000.00',
      line_total: '11800.00',
    },
  ],
  customer: baseCustomer,
  seller: baseSeller,
  payment_options: {
    bank_transfer: {
      beneficiary_name: 'Acme Studios Pvt Ltd',
      account_number: '001122334455',
      bank_name: 'HDFC Bank',
      branch: 'MG Road',
      ifsc: 'HDFC0000123',
      swift_bic: null,
    },
  },
  show_powered_by: true,
};

const usdInvoice: InvoicePdfData = {
  invoice: {
    invoice_number: 'INV-2026-0002',
    status: 'SENT',
    invoice_date: '2026-06-02',
    due_date: '2026-07-02',
    currency: 'USD',
    subtotal: '2000.00',
    discount_amount: '0',
    taxable_amount: '2000.00',
    cgst_amount: '0',
    sgst_amount: '0',
    igst_amount: '0',
    cess_amount: '0',
    total_amount: '2000.00',
    tds_amount: '0',
    amount_paid: '500.00',
    amount_outstanding: '1500.00',
  },
  line_items: [
    {
      line_number: 1,
      item_name: 'Consulting',
      quantity: '20',
      unit: 'hr',
      rate: '100.00',
      gst_rate: '0',
      taxable_amount: '2000.00',
      line_total: '2000.00',
    },
  ],
  customer: { ...baseCustomer, billing_country: 'USA' },
  seller: baseSeller,
  payment_options: {
    bank_transfer: {
      beneficiary_name: 'Acme Studios Pvt Ltd',
      account_number: '99887766',
      bank_name: 'HDFC Bank',
      ifsc: null,
      swift_bic: 'HDFCINBB',
    },
  },
  show_powered_by: false,
};

const isPdf = (b: Buffer) => b.subarray(0, 5).toString('latin1') === '%PDF-';

describe('Invoice PDF generation (Sprint 13 §B)', () => {
  beforeEach(() => renderToBuffer.mockClear());

  it('builds a document and returns the rendered buffer for an INR (GST) invoice', async () => {
    const buf = await service.render(inrInvoice);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(isPdf(buf)).toBe(true);
    // A single <Document> element tree was handed to the renderer.
    expect(renderToBuffer).toHaveBeenCalledTimes(1);
    const el = renderToBuffer.mock.calls[0]![0] as unknown as { type?: string };
    expect(el?.type).toBe('Document');
  });

  it('builds a document for a USD (no-GST) invoice without throwing', async () => {
    await expect(service.render(usdInvoice)).resolves.toBeInstanceOf(Buffer);
    expect(renderToBuffer).toHaveBeenCalledTimes(1);
  });

  it('derives a safe file name from the invoice number', () => {
    expect(service.fileName(inrInvoice)).toBe('INV-2026-0001.pdf');
    expect(service.fileName({ invoice: { invoice_number: 'A/B 12' } } as InvoicePdfData)).toBe(
      'A_B_12.pdf',
    );
  });
});
