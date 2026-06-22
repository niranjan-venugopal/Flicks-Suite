import { Controller, Get, Post, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiTags, ApiOperation, ApiProduces } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../core/auth/decorators/public.decorator';
import { PublicInvoiceService } from './public-invoice.service';
import { InvoicePdfService } from './invoice-pdf.service';

/**
 * Public hosted-invoice endpoints (PRD §9.3) — no auth; the signed token
 * scopes to exactly one invoice and cannot enumerate others. Tighter throttle
 * than authenticated routes since these are internet-facing.
 */
@ApiTags('Public — Hosted invoice')
@Controller('public/inv')
export class PublicInvoiceController {
  constructor(
    private readonly publicInvoices: PublicInvoiceService,
    private readonly pdf: InvoicePdfService,
  ) {}

  @Get(':token')
  @Public()
  @Throttle({ medium: { ttl: 10000, limit: 20 } })
  @ApiOperation({ summary: 'Customer view: invoice + payment options' })
  get(@Param('token') token: string) {
    return this.publicInvoices.getByToken(token);
  }

  @Get(':token/pdf')
  @Public()
  @Throttle({ medium: { ttl: 10000, limit: 20 } })
  @ApiProduces('application/pdf')
  @ApiOperation({ summary: 'Customer: download the invoice as a PDF' })
  async pdfByToken(
    @Param('token') token: string,
    @Res() res: Response,
    @Query('theme') theme?: string,
  ) {
    // Validates the token (throws 404/410 if bad/expired) and gives us the
    // invoice number for the file name; the render then prints the print page.
    const { data } = await this.publicInvoices.getByToken(token);
    const buffer = await this.pdf.renderInvoiceByToken(token, theme);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${this.pdf.fileName(String(data.invoice.invoice_number))}"`,
    );
    res.send(buffer);
  }

  @Post(':token/track')
  @Public()
  @Throttle({ medium: { ttl: 10000, limit: 20 } })
  @ApiOperation({ summary: 'View-tracking pixel (SENT → VIEWED)' })
  track(@Param('token') token: string) {
    return this.publicInvoices.trackView(token);
  }
}
