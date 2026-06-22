/**
 * Sprint 13 §B — invoice PDF generation (Puppeteer).
 *
 * Chromium is mocked so the unit test stays fast and host-independent: it
 * verifies the service navigates the hosted invoice URL and prints to PDF,
 * builds the URL from PUBLIC_INVOICE_BASE_URL, shares one browser, and
 * sanitises the file name. Real Chromium rendering is verified out-of-band.
 */
const pdfBuffer = Buffer.from('%PDF-1.7 chromium');
const page = {
  emulateMediaType: jest.fn(async () => undefined),
  goto: jest.fn(async () => undefined),
  waitForSelector: jest.fn(async () => undefined),
  pdf: jest.fn(async () => pdfBuffer),
  close: jest.fn(async () => undefined),
};
const browser = {
  connected: true,
  newPage: jest.fn(async () => page),
  close: jest.fn(async () => undefined),
};
const launch = jest.fn(async () => browser);

import { ConfigService } from '@nestjs/config';
import { InvoicePdfService } from '../modules/invoicing/invoice-pdf.service';

// puppeteer is ESM-only and loaded via a native dynamic import that jest.mock()
// can't intercept, so we stub the service's loadPuppeteer() seam instead — no
// real Chromium, host-independent.
jest
  .spyOn(
    InvoicePdfService.prototype as unknown as {
      loadPuppeteer: () => Promise<unknown>;
    },
    'loadPuppeteer',
  )
  .mockResolvedValue({ default: { launch }, launch } as unknown as typeof import('puppeteer'));

const config = {
  get: (_k: string, _fallback?: unknown) => 'https://pay.example.com',
} as unknown as ConfigService;

const service = new InvoicePdfService(config);

const isPdf = (b: Buffer) => b.subarray(0, 5).toString('latin1') === '%PDF-';

describe('Invoice PDF generation — Puppeteer (Sprint 13 §B)', () => {
  beforeEach(() => {
    launch.mockClear();
    page.goto.mockClear();
    page.pdf.mockClear();
    page.close.mockClear();
    browser.newPage.mockClear();
  });

  it('builds the print-page URL from the configured base', () => {
    expect(service.invoiceUrl('tok123')).toBe('https://pay.example.com/inv/tok123/print');
  });

  it('navigates the hosted invoice page and returns a printed PDF', async () => {
    const buf = await service.renderInvoiceByToken('tok123');
    expect(isPdf(buf)).toBe(true);
    expect(page.goto).toHaveBeenCalledWith(
      'https://pay.example.com/inv/tok123/print',
      expect.objectContaining({ waitUntil: 'networkidle0' }),
    );
    expect(page.pdf).toHaveBeenCalledWith(
      expect.objectContaining({ format: 'A4', printBackground: true }),
    );
    expect(page.close).toHaveBeenCalledTimes(1); // page always cleaned up
  });

  it('reuses a single Chromium instance across renders', async () => {
    const fresh = new InvoicePdfService(config); // starts with no browser
    await fresh.renderInvoiceByToken('a');
    await fresh.renderInvoiceByToken('b');
    expect(launch).toHaveBeenCalledTimes(1);
    expect(browser.newPage).toHaveBeenCalledTimes(2);
  });

  it('derives a safe file name from the invoice number', () => {
    expect(service.fileName('INV-2026-0001')).toBe('INV-2026-0001.pdf');
    expect(service.fileName('A/B 12')).toBe('A_B_12.pdf');
  });
});
