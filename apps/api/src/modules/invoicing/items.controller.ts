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
import { ItemsService } from './items.service';
import {
  ListQueryDto,
  CreateItemDto,
  UpdateItemDto,
  ImportItemsDto,
} from './dto/invoicing.dto';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import { RequireGrant } from '../../core/auth/decorators/require-grant.decorator';
import { InvoicingGrantGuard } from '../../core/auth/guards/invoicing-grant.guard';
import type { JwtPayload } from '@flicks/shared/types';

@ApiTags('Invoicing — Items')
@ApiBearerAuth('access-token')
@UseGuards(InvoicingGrantGuard)
@Controller('items')
export class ItemsController {
  constructor(private readonly items: ItemsService) {}

  @Get()
  @RequireGrant('invoicing', 'view')
  @ApiOperation({ summary: 'List items' })
  list(@Query() query: ListQueryDto, @CurrentUser() user: JwtPayload) {
    return this.items.list(user.tenantId, query);
  }

  @Get('export')
  @RequireGrant('invoicing', 'view')
  @ApiOperation({ summary: 'Export all items' })
  export(@CurrentUser() user: JwtPayload) {
    return this.items.exportAll(user.tenantId);
  }

  @Get(':id')
  @RequireGrant('invoicing', 'view')
  @ApiOperation({ summary: 'Get an item' })
  get(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.items.get(user.tenantId, id);
  }

  @Post()
  @RequireGrant('invoicing', 'edit')
  @ApiOperation({ summary: 'Create an item' })
  create(@Body() dto: CreateItemDto, @CurrentUser() user: JwtPayload) {
    return this.items.create(dto, user.sub, user.tenantId);
  }

  @Post('import')
  @RequireGrant('invoicing', 'edit')
  @ApiOperation({ summary: 'Bulk import items' })
  import(@Body() dto: ImportItemsDto, @CurrentUser() user: JwtPayload) {
    return this.items.importRows(dto, user.sub, user.tenantId);
  }

  @Patch(':id')
  @RequireGrant('invoicing', 'edit')
  @ApiOperation({ summary: 'Update an item' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateItemDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.items.update(id, dto, user.sub, user.tenantId);
  }

  @Post(':id/archive')
  @RequireGrant('invoicing', 'edit')
  @ApiOperation({ summary: 'Archive an item' })
  archive(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.items.setStatus(id, 'archived', user.sub, user.tenantId);
  }

  @Post(':id/unarchive')
  @RequireGrant('invoicing', 'edit')
  @ApiOperation({ summary: 'Unarchive an item' })
  unarchive(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.items.setStatus(id, 'active', user.sub, user.tenantId);
  }
}
