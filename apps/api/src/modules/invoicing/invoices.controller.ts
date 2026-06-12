import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { InvoicesService } from './invoices.service';
import {
  InvoiceListQueryDto,
  CreateInvoiceDto,
  UpdateInvoiceDto,
  CancelInvoiceDto,
  WriteOffInvoiceDto,
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
  constructor(private readonly invoices: InvoicesService) {}

  @Get()
  @RequireGrant('invoicing', 'view')
  @ApiOperation({ summary: 'List invoices (filter by status/customer/search)' })
  list(@Query() query: InvoiceListQueryDto, @CurrentUser() user: JwtPayload) {
    return this.invoices.list(user.tenantId, query);
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
  @ApiOperation({ summary: 'Send an invoice (Sprint 4)' })
  send(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.invoices.send(id, user.sub, user.tenantId);
  }

  @Post(':id/record-payment')
  @RequireGrant('invoicing', 'edit', 'record_payment')
  @ApiOperation({ summary: 'Record a payment (Sprint 4)' })
  recordPayment(
    @Param('id') id: string,
    @Body() dto: Record<string, unknown>,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.invoices.recordPayment(id, dto, user.sub, user.tenantId);
  }
}
