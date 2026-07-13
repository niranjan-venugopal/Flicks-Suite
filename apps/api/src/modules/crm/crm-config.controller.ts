import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { CrmGrantGuard } from '../../core/auth/guards/crm-grant.guard';
import { RequireGrant } from '../../core/auth/decorators/require-grant.decorator';
import { Roles } from '../../core/auth/decorators/roles.decorator';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import type { JwtPayload } from '@flicks/shared/types';
import { CustomFieldsService } from './custom-fields.service';
import { SavedViewsService } from './saved-views.service';
import { SearchService } from './search.service';

class CreateCustomFieldDto {
  @IsString() object_type!: string;
  @IsOptional() @IsString() @MaxLength(60) key?: string;
  @IsString() @MaxLength(80) label!: string;
  @IsString() field_type!: string;
  @IsOptional() @IsArray() options?: string[];
  @IsOptional() @IsBoolean() is_required?: boolean;
  @IsOptional() @IsInt() display_order?: number;
}

class CreateSavedViewDto {
  @IsString() object_type!: string;
  @IsString() @MaxLength(80) name!: string;
  @IsOptional() @IsBoolean() is_shared?: boolean;
  @IsOptional() @IsObject() filters?: Record<string, unknown>;
  @IsOptional() @IsObject() sort?: Record<string, unknown>;
  @IsOptional() @IsArray() columns?: string[];
}

/**
 * CRM configuration + search surface (PRD v5 §9.1, §9.2, §19.8): custom field
 * definitions, saved views, and the ⌘K global search. Custom fields are Owner/
 * Admin-managed; views are per-user; search needs only view access.
 */
@ApiTags('crm-config')
@Controller('crm')
@UseGuards(CrmGrantGuard)
export class CrmConfigController {
  constructor(
    private readonly customFields: CustomFieldsService,
    private readonly views: SavedViewsService,
    private readonly search: SearchService,
  ) {}

  // ─── Custom fields (§9.1) — Owner/Admin manage ───────────────────────────────
  @Get('custom-fields')
  @RequireGrant('crm', 'view')
  @ApiOperation({ summary: 'List active custom field definitions' })
  listFields(@CurrentUser() user: JwtPayload, @Query('object_type') objectType?: string) {
    return this.customFields.list(user.tenantId, objectType);
  }

  @Post('custom-fields')
  @Roles('owner', 'admin')
  @RequireGrant('crm', 'edit')
  @ApiOperation({ summary: 'Define a custom field (§9.1)' })
  createField(@Body() dto: CreateCustomFieldDto, @CurrentUser() user: JwtPayload) {
    return this.customFields.create(user.tenantId, user.sub, dto);
  }

  @Patch('custom-fields/:id')
  @Roles('owner', 'admin')
  @RequireGrant('crm', 'edit')
  updateField(@Param('id') id: string, @Body() dto: Record<string, unknown>, @CurrentUser() user: JwtPayload) {
    return this.customFields.update(user.tenantId, user.sub, id, dto);
  }

  @Delete('custom-fields/:id')
  @Roles('owner', 'admin')
  @RequireGrant('crm', 'edit')
  @ApiOperation({ summary: 'Archive a custom field (values are kept in `custom`)' })
  archiveField(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.customFields.archive(user.tenantId, user.sub, id);
  }

  // ─── Saved views (§9.2) — per user ───────────────────────────────────────────
  @Get('views')
  @RequireGrant('crm', 'view')
  @ApiOperation({ summary: 'List saved views visible to me (mine + shared)' })
  listViews(@CurrentUser() user: JwtPayload, @Query('object_type') objectType?: string) {
    return this.views.list(user.tenantId, user.sub, objectType);
  }

  @Post('views')
  @RequireGrant('crm', 'edit')
  @ApiOperation({ summary: 'Save a view (filters/sort/columns)' })
  createView(@Body() dto: CreateSavedViewDto, @CurrentUser() user: JwtPayload) {
    return this.views.create(user.tenantId, user.sub, dto);
  }

  @Patch('views/:id')
  @RequireGrant('crm', 'edit')
  updateView(@Param('id') id: string, @Body() dto: Record<string, unknown>, @CurrentUser() user: JwtPayload) {
    return this.views.update(user.tenantId, user.sub, id, dto);
  }

  @Delete('views/:id')
  @RequireGrant('crm', 'edit')
  removeView(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.views.remove(user.tenantId, user.sub, id);
  }

  // ─── Global search (§19.8) ────────────────────────────────────────────────────
  @Get('search')
  @RequireGrant('crm', 'view')
  @ApiOperation({ summary: '⌘K search across companies, people & deals' })
  globalSearch(@CurrentUser() user: JwtPayload, @Query('q') q?: string) {
    return this.search.search(user.tenantId, q ?? '');
  }
}
