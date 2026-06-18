import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiProduces } from '@nestjs/swagger';
import { InvoicesService } from './invoices.service';
import { InvoicePdfService } from './invoice-pdf.service';
import {
  InvoiceListQueryDto,
  CreateInvoiceDto,
  UpdateInvoiceDto,
  CancelInvoiceDto,
  WriteOffInvoiceDto,
  RecordPaymentDto,
} from './dto/invoicing.dto';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import { RequireGrant } from '../../core/auth/decorators/require-grant.decorator';
import { InvoicingGrantGuard } from '../../core/auth/guards/invoicing-grant.guard';
import type { JwtPayload } from '@flicks/shared/types';

@ApiTags('Invoicing — Invoices')
@ApiBearerAuth('access-token')
@UseGuards(InvoicingGrantGuard)
@Controller('invoices')
export class InvoicesController {
  constructor(
    private readonly invoices: InvoicesService,
    private readonly pdf: InvoicePdfService,
  ) {}

  @Get()
  @RequireGrant('invoicing', 'view')
  @ApiOperation({ summary: 'List invoices (filter by status/customer/search)' })
  list(@Query() query: InvoiceListQueryDto, @CurrentUser() user: JwtPayload) {
    return this.invoices.list(user.tenantId, query);
  }

  @Get(':id/pdf')
  @RequireGrant('invoicing', 'view')
  @ApiProduces('application/pdf')
  @ApiOperation({ summary: 'Download the invoice as a PDF (renders the hosted page)' })
  async downloadPdf(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Res() res: Response,
  ) {
    const { token, invoiceNumber } = await this.invoices.ensurePublicToken(
      user.tenantId,
      id,
    );
    const buffer = await this.pdf.renderInvoiceByToken(token);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${this.pdf.fileName(invoiceNumber)}"`,
    );
    res.send(buffer);
  }

  @Get(':id')
  @RequireGrant('invoicing', 'view')
  @ApiOperation({ summary: 'Get an invoice with line items + customer' })
  get(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.invoices.get(user.tenantId, id);
  }

  @Post()
  @RequireGrant('invoicing', 'edit')
  @ApiOperation({
    summary: 'Create a draft invoice (server computes GST/TDS totals; number reserved atomically)',
  })
  create(@Body() dto: CreateInvoiceDto, @CurrentUser() user: JwtPayload) {
    return this.invoices.create(dto, user.sub, user.tenantId);
  }

  @Patch(':id')
  @RequireGrant('invoicing', 'edit')
  @ApiOperation({ summary: 'Update a draft invoice (DRAFT only; totals recomputed)' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateInvoiceDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.invoices.update(id, dto, user.sub, user.tenantId);
  }

  @Post(':id/duplicate')
  @RequireGrant('invoicing', 'edit')
  @ApiOperation({ summary: 'Duplicate into a new draft (new number, today’s date)' })
  duplicate(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.invoices.duplicate(id, user.sub, user.tenantId);
  }

  @Post(':id/convert-to-invoice')
  @RequireGrant('invoicing', 'edit')
  @ApiOperation({ summary: 'Convert a quote into an invoice (new invoice number, DRAFT)' })
  convertToInvoice(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.invoices.convertToInvoice(id, user.sub, user.tenantId);
  }

  @Post(':id/cancel')
  @RequireGrant('invoicing', 'edit')
  @ApiOperation({ summary: 'Cancel an invoice (auto credit note arrives in Sprint 6)' })
  cancel(
    @Param('id') id: string,
    @Body() dto: CancelInvoiceDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.invoices.cancel(id, dto.reason, user.sub, user.tenantId);
  }

  @Post(':id/void')
  @RequireGrant('invoicing', 'edit')
  @ApiOperation({ summary: 'Void (within 24h, not viewed)' })
  void(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.invoices.void(id, user.sub, user.tenantId);
  }

  @Post(':id/write-off')
  @RequireGrant('invoicing', 'edit')
  @ApiOperation({ summary: 'Write off an unpaid invoice' })
  writeOff(
    @Param('id') id: string,
    @Body() dto: WriteOffInvoiceDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.invoices.writeOff(id, dto.reason, user.sub, user.tenantId);
  }

  @Post(':id/send')
  @RequireGrant('invoicing', 'edit', 'send')
  @ApiOperation({ summary: 'Send: DRAFT→SENT, email the hosted View & Pay link' })
  send(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.invoices.send(id, user.sub, user.tenantId);
  }

  @Post(':id/record-payment')
  @RequireGrant('invoicing', 'edit', 'record_payment')
  @ApiOperation({ summary: 'Record a manual payment (partial/over handled)' })
  recordPayment(
    @Param('id') id: string,
    @Body() dto: RecordPaymentDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.invoices.recordPayment(id, dto, user.sub, user.tenantId);
  }
}
