import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Browser } from 'puppeteer';

// puppeteer v23+ ships ESM-only. This API compiles to CommonJS (ts-node in dev,
// Nest's CJS build in prod), where a static `import puppeteer from 'puppeteer'`
// — or even a dynamic import(), which TypeScript down-levels to require() under
// `module: commonjs` — throws ERR_REQUIRE_ESM. The Function wrapper hides the
// import from the compiler so it stays a *native* dynamic import that Node
// resolves as ESM at runtime. Types are imported type-only above (erased).
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const importPuppeteer = new Function(
  'return import("puppeteer")',
) as () => Promise<typeof import('puppeteer')>;

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

  /**
   * Load the (ESM-only) puppeteer module. Isolated behind a method so unit
   * tests can stub Chromium without a real browser — `jest.mock('puppeteer')`
   * can't intercept the native dynamic import above, so tests spy on this seam
   * instead.
   */
  protected loadPuppeteer(): Promise<typeof import('puppeteer')> {
    return importPuppeteer();
  }

  private async browser(): Promise<Browser> {
    if (!this.browserPromise) {
      this.browserPromise = this.loadPuppeteer().then(({ default: puppeteer }) =>
        puppeteer.launch({
          headless: true,
          args: this.launchArgs(),
        }),
      );
    }
    const b = await this.browserPromise;
    if (!b.connected) {
      this.browserPromise = null;
      return this.browser();
    }
    return b;
  }

  /**
   * Print/PDF view URL for a given public-view token. We render the dedicated
   * `/print` page (document-only: no app chrome, no interactive pay buttons,
   * static UPI QR + bank details) rather than the interactive customer page.
   */
  invoiceUrl(token: string): string {
    const base = this.config
      .get<string>('PUBLIC_INVOICE_BASE_URL', 'http://localhost:3000')
      .replace(/\/+$/, '');
    return `${base}/inv/${token}/print`;
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
      // Zero margins: the print page is full-bleed dark, so any PDF margin would
      // show as a white border around the document. The page supplies its own
      // padding.
      const pdf = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '0', bottom: '0', left: '0', right: '0' },
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
