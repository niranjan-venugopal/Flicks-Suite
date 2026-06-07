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
import { CustomersService } from './customers.service';
import { ListQueryDto, CreateCustomerDto } from './dto/invoicing.dto';
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

  @Get(':id')
  @RequireGrant('invoicing', 'view')
  @ApiOperation({ summary: 'Get a customer' })
  get(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.customers.get(user.tenantId, id);
  }

  @Post()
  @RequireGrant('invoicing', 'edit', 'manage_customers')
  @ApiOperation({ summary: 'Create a customer' })
  create(@Body() dto: CreateCustomerDto, @CurrentUser() user: JwtPayload) {
    return this.customers.create(dto, user.sub, user.tenantId);
  }

  @Patch(':id')
  @RequireGrant('invoicing', 'edit', 'manage_customers')
  @ApiOperation({ summary: 'Update a customer' })
  update(
    @Param('id') id: string,
    @Body() dto: CreateCustomerDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.customers.update(id, dto, user.sub, user.tenantId);
  }

  @Post(':id/archive')
  @RequireGrant('invoicing', 'edit', 'manage_customers')
  @ApiOperation({ summary: 'Archive a customer' })
  archive(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.customers.archive(id, user.sub, user.tenantId);
  }
}
