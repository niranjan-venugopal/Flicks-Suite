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
import { HsnSacService } from './hsn-sac.service';
import { HsnSacSearchDto, AddCustomHsnDto } from './dto/invoicing.dto';
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
  @ApiOperation({ summary: 'Search HSN/SAC codes (global + tenant additions)' })
  search(@Query() dto: HsnSacSearchDto, @CurrentUser() user: JwtPayload) {
    return this.hsnSac.search(user.tenantId, dto);
  }

  @Post('custom')
  @RequireGrant('invoicing', 'edit')
  @ApiOperation({ summary: 'Add a tenant-specific HSN/SAC code' })
  addCustom(@Body() dto: AddCustomHsnDto, @CurrentUser() user: JwtPayload) {
    return this.hsnSac.addCustom(dto, user.sub, user.tenantId);
  }

  @Delete('custom/:id')
  @RequireGrant('invoicing', 'edit')
  @ApiOperation({ summary: 'Delete a tenant-specific HSN/SAC code' })
  removeCustom(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.hsnSac.removeCustom(id, user.sub, user.tenantId);
  }
}
