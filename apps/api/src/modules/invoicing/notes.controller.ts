import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { NotesService } from './notes.service';
import { InvoicesService } from './invoices.service';
import { InvReportsService } from './inv-reports.service';
import {
  CreateNoteDto,
  CreateAdjustmentDto,
  GenerateGstr1Dto,
  ListQueryDto,
} from './dto/invoicing.dto';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import { RequireGrant } from '../../core/auth/decorators/require-grant.decorator';
import { InvoicingGrantGuard } from '../../core/auth/guards/invoicing-grant.guard';
import type { JwtPayload } from '@flicks/shared/types';

@ApiTags('Invoicing — Notes & adjustments')
@ApiBearerAuth('access-token')
@UseGuards(InvoicingGrantGuard)
@Controller()
export class NotesController {
  constructor(private readonly notes: NotesService) {}

  @Get('credit-notes')
  @RequireGrant('invoicing', 'view')
  @ApiOperation({ summary: 'List credit + debit notes' })
  list(@CurrentUser() user: JwtPayload) {
    return this.notes.list(user.tenantId);
  }

  @Post('credit-notes')
  @RequireGrant('invoicing', 'edit')
  @ApiOperation({ summary: 'Issue a credit note (books to customer credit balance)' })
  createCredit(@Body() dto: CreateNoteDto, @CurrentUser() user: JwtPayload) {
    return this.notes.create('credit', dto, user.sub, user.tenantId);
  }

  @Post('debit-notes')
  @RequireGrant('invoicing', 'edit')
  @ApiOperation({ summary: 'Issue a debit note' })
  createDebit(@Body() dto: CreateNoteDto, @CurrentUser() user: JwtPayload) {
    return this.notes.create('debit', dto, user.sub, user.tenantId);
  }

  @Get('adjustments')
  @RequireGrant('invoicing', 'view')
  @ApiOperation({ summary: 'List balance adjustments' })
  listAdjustments(@CurrentUser() user: JwtPayload) {
    return this.notes.listAdjustments(user.tenantId);
  }

  @Post('adjustments')
  @RequireGrant('invoicing', 'edit')
  @ApiOperation({ summary: 'Create a balance adjustment' })
  createAdjustment(@Body() dto: CreateAdjustmentDto, @CurrentUser() user: JwtPayload) {
    return this.notes.createAdjustment(dto, user.sub, user.tenantId);
  }

  @Delete('adjustments/:id')
  @RequireGrant('invoicing', 'edit')
  @ApiOperation({ summary: 'Delete an adjustment (within 24h; audit-logged)' })
  deleteAdjustment(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.notes.deleteAdjustment(id, user.sub, user.tenantId);
  }
}

@ApiTags('Invoicing — Payments')
@ApiBearerAuth('access-token')
@UseGuards(InvoicingGrantGuard)
@Controller('payments')
export class PaymentsController {
  constructor(private readonly invoices: InvoicesService) {}

  @Get()
  @RequireGrant('invoicing', 'view')
  @ApiOperation({ summary: 'Tenant-wide payments ledger' })
  list(@Query() query: ListQueryDto, @CurrentUser() user: JwtPayload) {
    return this.invoices.listPayments(user.tenantId, query);
  }
}

@ApiTags('Invoicing — Reports')
@ApiBearerAuth('access-token')
@UseGuards(InvoicingGrantGuard)
@Controller('invoicing/reports')
export class InvReportsController {
  constructor(private readonly reports: InvReportsService) {}

  @Get('context')
  @RequireGrant('reports', 'view')
  @ApiOperation({ summary: 'Country + base/available currencies for the reports UI' })
  context(@CurrentUser() user: JwtPayload) {
    return this.reports.reportsContext(user.tenantId);
  }

  @Get('dashboard')
  @RequireGrant('reports', 'view')
  @ApiOperation({ summary: 'Headline counts + outstanding/collected/TDS (per currency)' })
  dashboard(@CurrentUser() user: JwtPayload, @Query('currency') currency?: string) {
    return this.reports.dashboard(user.tenantId, currency);
  }

  @Get('aging')
  @RequireGrant('reports', 'view')
  @ApiOperation({ summary: 'Receivables aging buckets (per currency)' })
  aging(@CurrentUser() user: JwtPayload, @Query('currency') currency?: string) {
    return this.reports.aging(user.tenantId, currency);
  }

  @Get('revenue')
  @RequireGrant('reports', 'view')
  @ApiOperation({ summary: 'Monthly invoiced revenue (6 months, per currency)' })
  revenue(@CurrentUser() user: JwtPayload, @Query('currency') currency?: string) {
    return this.reports.revenue(user.tenantId, currency);
  }

  @Get('tds-receivable')
  @RequireGrant('reports', 'view')
  @ApiOperation({ summary: 'TDS withheld by customers, per invoice' })
  tds(@CurrentUser() user: JwtPayload) {
    return this.reports.tdsReceivable(user.tenantId);
  }

  @Post('gstr1/generate')
  @RequireGrant('reports', 'view', 'export_gstr1')
  @ApiOperation({ summary: 'Generate the GSTR-1 period file (B2B/B2CL/B2CS/EXP/CDNR)' })
  generateGstr1(@Body() dto: GenerateGstr1Dto, @CurrentUser() user: JwtPayload) {
    return this.reports.generateGstr1(dto, user.sub, user.tenantId);
  }

  @Get('gstr1/history')
  @RequireGrant('reports', 'view')
  @ApiOperation({ summary: 'Past GSTR-1 exports (hash + counts)' })
  gstr1History(@CurrentUser() user: JwtPayload) {
    return this.reports.gstr1History(user.tenantId);
  }

  @Get('form-131-tracking')
  @RequireGrant('reports', 'view')
  @ApiOperation({ summary: 'Form 131 (TDS certificate) tracking per customer × quarter' })
  form131(@CurrentUser() user: JwtPayload) {
    return this.reports.form131Tracking(user.tenantId);
  }

  @Post('form-131/mark-received')
  @RequireGrant('invoicing', 'edit')
  @ApiOperation({ summary: 'Mark a quarter’s Form 131 as received' })
  markForm131(
    @Body() body: { customer_id: string; fy_label: string; quarter: number; total_tds_amount?: string },
    @CurrentUser() user: JwtPayload,
  ) {
    return this.reports.markForm131Received(body, user.sub, user.tenantId);
  }
}
