import {
  Controller,
  Get,
  Post,
  Patch,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { OrgFinancialService } from './org-financial.service';
import {
  UpdateOrgFinancialDto,
  CreateBankAccountDto,
  UpdateBankAccountDto,
  SetCurrencyDefaultDto,
} from './org-financial.dto';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import { RequireGrant } from '../../core/auth/decorators/require-grant.decorator';
import { InvoicingGrantGuard } from '../../core/auth/guards/invoicing-grant.guard';
import type { JwtPayload } from '@flicks/shared/types';

@ApiTags('Organization — Financial details')
@ApiBearerAuth('access-token')
@UseGuards(InvoicingGrantGuard)
@Controller('org/financial')
export class OrgFinancialController {
  constructor(private readonly org: OrgFinancialService) {}

  @Get()
  @RequireGrant('org_financial', 'view')
  @ApiOperation({ summary: 'Legal name, GSTIN, PAN, FY (single source of truth)' })
  getFinancial(@CurrentUser() user: JwtPayload) {
    return this.org.getFinancial(user.tenantId);
  }

  @Patch()
  @RequireGrant('org_financial', 'edit')
  @ApiOperation({ summary: 'Update GSTIN/PAN/FY/legal name on the tenant' })
  updateFinancial(@Body() dto: UpdateOrgFinancialDto, @CurrentUser() user: JwtPayload) {
    return this.org.updateFinancial(dto, user.sub, user.tenantId);
  }

  // ── bank accounts ───────────────────────────────────────────────────────────

  @Get('bank-accounts')
  @RequireGrant('org_financial', 'view')
  @ApiOperation({ summary: 'List bank accounts (numbers masked for non-privileged roles)' })
  listAccounts(@CurrentUser() user: JwtPayload) {
    return this.org.listBankAccounts(user.tenantId, user.role);
  }

  @Get('bank-accounts/:id')
  @RequireGrant('org_financial', 'view')
  @ApiOperation({ summary: 'Get a bank account' })
  getAccount(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.org.getBankAccount(user.tenantId, id, user.role);
  }

  @Post('bank-accounts')
  @RequireGrant('org_financial', 'edit')
  @ApiOperation({ summary: 'Add a bank account (conditional IFSC / SWIFT+address)' })
  createAccount(@Body() dto: CreateBankAccountDto, @CurrentUser() user: JwtPayload) {
    return this.org.createBankAccount(dto, user.sub, user.tenantId);
  }

  @Patch('bank-accounts/:id')
  @RequireGrant('org_financial', 'edit')
  @ApiOperation({ summary: 'Update a bank account' })
  updateAccount(
    @Param('id') id: string,
    @Body() dto: UpdateBankAccountDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.org.updateBankAccount(id, dto, user.sub, user.tenantId);
  }

  @Delete('bank-accounts/:id')
  @RequireGrant('org_financial', 'edit')
  @ApiOperation({ summary: 'Remove a bank account (soft delete)' })
  deleteAccount(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.org.deleteBankAccount(id, user.sub, user.tenantId);
  }

  @Post('bank-accounts/:id/set-default')
  @RequireGrant('org_financial', 'edit')
  @ApiOperation({ summary: 'Make this the overall default account' })
  setDefault(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.org.setDefault(id, user.sub, user.tenantId);
  }

  @Put('currency-default')
  @RequireGrant('org_financial', 'edit')
  @ApiOperation({ summary: 'Set the default account for a currency' })
  setCurrencyDefault(@Body() dto: SetCurrencyDefaultDto, @CurrentUser() user: JwtPayload) {
    return this.org.setCurrencyDefault(dto, user.sub, user.tenantId);
  }
}
