import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import puppeteer, { type Browser } from 'puppeteer';

/**
 * Sprint 13 §B — invoice PDF generation.
 *
 * Renders the *actual hosted invoice page* (`/inv/:token`) with headless
 * Chromium and prints it to PDF, so the download is pixel-identical to what the
 * customer sees online. A single Chromium instance is shared across requests
 * (launch is ~1s) and relaunched if it disconnects.
 */
@Injectable()
export class InvoicePdfService implements OnModuleDestroy {
  private readonly logger = new Logger(InvoicePdfService.name);
  private browserPromise: Promise<Browser> | null = null;

  constructor(private readonly config: ConfigService) {}

  private launchArgs(): string[] {
    // --no-sandbox is required in most container/CI hosts; dev-shm avoids
    // Chromium crashing on small /dev/shm.
    return ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'];
  }

  private async browser(): Promise<Browser> {
    if (!this.browserPromise) {
      this.browserPromise = puppeteer.launch({
        headless: true,
        args: this.launchArgs(),
      });
    }
    const b = await this.browserPromise;
    if (!b.connected) {
      this.browserPromise = null;
      return this.browser();
    }
    return b;
  }

  /** Hosted page URL for a given public-view token. */
  invoiceUrl(token: string): string {
    const base = this.config
      .get<string>('PUBLIC_INVOICE_BASE_URL', 'http://localhost:3000')
      .replace(/\/+$/, '');
    return `${base}/inv/${token}`;
  }

  /** Render the hosted invoice page to a PDF buffer. */
  async renderInvoiceByToken(token: string): Promise<Buffer> {
    return this.renderUrl(this.invoiceUrl(token));
  }

  async renderUrl(url: string): Promise<Buffer> {
    const browser = await this.browser();
    const page = await browser.newPage();
    try {
      await page.emulateMediaType('print');
      await page.goto(url, { waitUntil: 'networkidle0', timeout: 30_000 });
      // The hosted page renders an invoice container once its data loads; wait
      // for it when present, but don't fail the render if the hook isn't there.
      await page
        .waitForSelector('[data-invoice-root]', { timeout: 5_000 })
        .catch(() => undefined);
      const pdf = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '16px', bottom: '16px', left: '16px', right: '16px' },
      });
      return Buffer.from(pdf);
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  /** A safe file name for the Content-Disposition header. */
  fileName(invoiceNumber: string): string {
    const n = String(invoiceNumber ?? '').replace(/[^A-Za-z0-9._-]/g, '_') || 'invoice';
    return `${n}.pdf`;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.browserPromise) {
      try {
        const b = await this.browserPromise;
        await b.close();
      } catch (err) {
        this.logger.warn(`Failed to close Chromium: ${(err as Error).message}`);
      }
    }
  }
}
