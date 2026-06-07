import { Controller, Get, Post, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { HsnSacService } from './hsn-sac.service';
import { HsnSacSearchDto } from './dto/invoicing.dto';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import { RequireGrant } from '../../core/auth/decorators/require-grant.decorator';
import { InvoicingGrantGuard } from '../../core/auth/guards/invoicing-grant.guard';
import type { JwtPayload } from '@flicks/shared/types';

@ApiTags('Invoicing — HSN/SAC')
@ApiBearerAuth('access-token')
@UseGuards(InvoicingGrantGuard)
@Controller('hsn-sac')
export class HsnSacController {
  constructor(private readonly hsnSac: HsnSacService) {}

  @Get('search')
  @RequireGrant('invoicing', 'view')
  @ApiOperation({ summary: 'Search HSN/SAC codes' })
  search(@Query() dto: HsnSacSearchDto) {
    return this.hsnSac.search(dto);
  }

  @Post('custom')
  @RequireGrant('invoicing', 'edit')
  @ApiOperation({ summary: 'Add a tenant-specific HSN/SAC code' })
  addCustom(
    @Body() dto: Record<string, unknown>,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.hsnSac.addCustom(dto, user.sub, user.tenantId);
  }
}
