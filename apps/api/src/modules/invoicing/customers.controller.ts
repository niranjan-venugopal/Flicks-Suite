import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
  Delete,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { CustomersService } from './customers.service';
import {
  ListQueryDto,
  CreateCustomerDto,
  UpdateCustomerDto,
  ImportCustomersDto,
} from './dto/invoicing.dto';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import { RequireGrant } from '../../core/auth/decorators/require-grant.decorator';
import { InvoicingGrantGuard } from '../../core/auth/guards/invoicing-grant.guard';
import type { JwtPayload } from '@flicks/shared/types';

@ApiTags('Invoicing — Customers')
@ApiBearerAuth('access-token')
@UseGuards(InvoicingGrantGuard)
@Controller('customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  @RequireGrant('invoicing', 'view')
  @ApiOperation({ summary: 'List customers' })
  list(@Query() query: ListQueryDto, @CurrentUser() user: JwtPayload) {
    return this.customers.list(user.tenantId, query);
  }

  @Get('export')
  @RequireGrant('invoicing', 'view')
  @ApiOperation({ summary: 'Export all customers' })
  export(@CurrentUser() user: JwtPayload) {
    return this.customers.exportAll(user.tenantId);
  }

  @Get(':id')
  @RequireGrant('invoicing', 'view')
  @ApiOperation({ summary: 'Get a customer' })
  get(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.customers.get(user.tenantId, id);
  }

  @Get(':id/statement')
  @RequireGrant('invoicing', 'view')
  @ApiOperation({ summary: 'Customer statement / ledger' })
  statement(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.customers.statement(user.tenantId, id);
  }

  @Post()
  @RequireGrant('invoicing', 'edit', 'manage_customers')
  @ApiOperation({ summary: 'Create a customer' })
  create(@Body() dto: CreateCustomerDto, @CurrentUser() user: JwtPayload) {
    return this.customers.create(dto, user.sub, user.tenantId);
  }

  @Post('import')
  @RequireGrant('invoicing', 'edit', 'manage_customers')
  @ApiOperation({ summary: 'Bulk import customers' })
  import(@Body() dto: ImportCustomersDto, @CurrentUser() user: JwtPayload) {
    return this.customers.importRows(dto, user.sub, user.tenantId);
  }

  @Patch(':id')
  @RequireGrant('invoicing', 'edit', 'manage_customers')
  @ApiOperation({ summary: 'Update a customer' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateCustomerDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.customers.update(id, dto, user.sub, user.tenantId);
  }

  @Post(':id/archive')
  @RequireGrant('invoicing', 'edit', 'manage_customers')
  @ApiOperation({ summary: 'Archive a customer' })
  archive(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.customers.setStatus(id, 'archived', user.sub, user.tenantId);
  }

  @Post(':id/unarchive')
  @RequireGrant('invoicing', 'edit', 'manage_customers')
  @ApiOperation({ summary: 'Unarchive a customer' })
  unarchive(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.customers.setStatus(id, 'active', user.sub, user.tenantId);
  }

  // Round 18: hard delete when nothing references the client, soft otherwise
  // (invoices.customer_id is NOT NULL + RESTRICT, so a billed client has to
  // keep resolving on its past documents).
  @Delete(':id')
  @RequireGrant('invoicing', 'edit', 'manage_customers')
  @ApiOperation({ summary: 'Delete a client (soft when it has been billed)' })
  remove(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.customers.remove(id, user.sub, user.tenantId);
  }
}
