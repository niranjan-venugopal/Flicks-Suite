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
  IsInt,
  IsOptional,
  IsString,
  Min,
  MaxLength,
  IsBoolean,
} from 'class-validator';
import { Type } from 'class-transformer';
import { CrmGrantGuard } from '../../core/auth/guards/crm-grant.guard';
import { RequireGrant } from '../../core/auth/decorators/require-grant.decorator';
import { Roles } from '../../core/auth/decorators/roles.decorator';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import type { JwtPayload } from '@flicks/shared/types';
import { DirectoryService } from './directory.service';

class ListQueryDto {
  @IsOptional() @IsString() q?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) limit?: number;
  @IsOptional() @IsString() company_id?: string;
}

class CreateCompanyDto {
  @IsString() @MaxLength(200) name!: string;
  @IsOptional() @IsString() domain?: string;
  @IsOptional() @IsString() website?: string;
  @IsOptional() @IsString() industry?: string;
  @IsOptional() @IsString() size_band?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() address_line1?: string;
  @IsOptional() @IsString() address_line2?: string;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() state?: string;
  @IsOptional() @IsString() postal_code?: string;
  @IsOptional() @IsString() @MaxLength(2) country_code?: string;
  @IsOptional() @IsString() owner_user_id?: string;
  @IsOptional() @IsBoolean() force_create?: boolean;
}

class CreatePersonDto {
  @IsOptional() @IsString() @MaxLength(120) first_name?: string;
  @IsOptional() @IsString() @MaxLength(120) last_name?: string;
  @IsOptional() @IsString() email?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() company_id?: string;
  @IsOptional() @IsString() owner_user_id?: string;
}

/**
 * Directory (Contacts/Companies) API (PRD v5 §3, design C4/C5). CRM is org-open
 * for standard members (CrmGrantGuard defaults them to edit); auditors need an
 * explicit grant. Delete requires edit + the 'delete' capability.
 */
@ApiTags('crm-directory')
@Controller('crm')
@UseGuards(CrmGrantGuard)
export class DirectoryController {
  constructor(private readonly directory: DirectoryService) {}

  // ─── Companies ────────────────────────────────────────────────────────────
  @Get('companies')
  @RequireGrant('crm', 'view')
  @ApiOperation({ summary: 'List companies (search, paginated)' })
  listCompanies(@Query() q: ListQueryDto, @CurrentUser() user: JwtPayload) {
    return this.directory.listCompanies(user.tenantId, q);
  }

  @Get('companies/name-candidates')
  @RequireGrant('crm', 'view')
  @ApiOperation({ summary: 'Fuzzy company-name dedupe candidates' })
  companyCandidates(@Query('name') name: string, @CurrentUser() user: JwtPayload) {
    return this.directory.companyNameCandidates(user.tenantId, name ?? '');
  }

  @Get('companies/:id')
  @RequireGrant('crm', 'view')
  getCompany(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.directory.getCompany(user.tenantId, id);
  }

  @Post('companies')
  @RequireGrant('crm', 'edit')
  @ApiOperation({ summary: 'Create a company (blocks on exact domain dup)' })
  createCompany(@Body() dto: CreateCompanyDto, @CurrentUser() user: JwtPayload) {
    const { force_create, ...rest } = dto;
    return this.directory.createCompany(user.tenantId, user.sub, rest, { forceCreate: force_create });
  }

  @Patch('companies/:id')
  @RequireGrant('crm', 'edit')
  updateCompany(
    @Param('id') id: string,
    @Body() dto: Record<string, unknown>,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.directory.updateCompany(user.tenantId, user.sub, id, dto);
  }

  @Delete('companies/:id')
  @Roles('owner', 'admin', 'manager') // §13: delete = manager-and-up, not employee/auditor
  @RequireGrant('crm', 'edit')
  deleteCompany(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.directory.deleteCompany(user.tenantId, user.sub, id);
  }

  // ─── People (Contacts) ──────────────────────────────────────────────────────
  @Get('contacts')
  @RequireGrant('crm', 'view')
  @ApiOperation({ summary: 'List contacts (search, filter by company, paginated)' })
  listPeople(@Query() q: ListQueryDto, @CurrentUser() user: JwtPayload) {
    return this.directory.listPeople(user.tenantId, q);
  }

  @Get('contacts/:id')
  @RequireGrant('crm', 'view')
  getPerson(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.directory.getPerson(user.tenantId, id);
  }

  @Post('contacts')
  @RequireGrant('crm', 'edit')
  @ApiOperation({ summary: 'Create a contact (blocks on exact email dup)' })
  createPerson(@Body() dto: CreatePersonDto, @CurrentUser() user: JwtPayload) {
    return this.directory.createPerson(user.tenantId, user.sub, dto);
  }

  @Patch('contacts/:id')
  @RequireGrant('crm', 'edit')
  updatePerson(
    @Param('id') id: string,
    @Body() dto: Record<string, unknown>,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.directory.updatePerson(user.tenantId, user.sub, id, dto);
  }

  @Delete('contacts/:id')
  @Roles('owner', 'admin', 'manager') // §13: delete = manager-and-up
  @RequireGrant('crm', 'edit')
  deletePerson(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.directory.deletePerson(user.tenantId, user.sub, id);
  }
}
