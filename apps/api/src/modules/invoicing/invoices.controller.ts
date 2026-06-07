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
import { ListQueryDto, CreateInvoiceDto } from './dto/invoicing.dto';
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
  @ApiOperation({ summary: 'List invoices' })
  list(@Query() query: ListQueryDto, @CurrentUser() user: JwtPayload) {
    return this.invoices.list(user.tenantId, query);
  }

  @Get(':id')
  @RequireGrant('invoicing', 'view')
  @ApiOperation({ summary: 'Get an invoice' })
  get(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.invoices.get(user.tenantId, id);
  }

  @Post()
  @RequireGrant('invoicing', 'edit')
  @ApiOperation({ summary: 'Create a draft invoice' })
  create(@Body() dto: CreateInvoiceDto, @CurrentUser() user: JwtPayload) {
    return this.invoices.create(dto, user.sub, user.tenantId);
  }

  @Patch(':id')
  @RequireGrant('invoicing', 'edit')
  @ApiOperation({ summary: 'Update a draft invoice (DRAFT only)' })
  update(
    @Param('id') id: string,
    @Body() dto: CreateInvoiceDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.invoices.update(id, dto, user.sub, user.tenantId);
  }

  @Post(':id/send')
  @RequireGrant('invoicing', 'edit', 'send')
  @ApiOperation({ summary: 'Send an invoice' })
  send(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.invoices.send(id, user.sub, user.tenantId);
  }

  @Post(':id/record-payment')
  @RequireGrant('invoicing', 'edit', 'record_payment')
  @ApiOperation({ summary: 'Record a payment against an invoice' })
  recordPayment(
    @Param('id') id: string,
    @Body() dto: Record<string, unknown>,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.invoices.recordPayment(id, dto, user.sub, user.tenantId);
  }
}
