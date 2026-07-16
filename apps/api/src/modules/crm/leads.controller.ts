import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsEmail, IsNumber, IsOptional, IsString, MaxLength } from 'class-validator';
import { CrmGrantGuard } from '../../core/auth/guards/crm-grant.guard';
import { RequireGrant } from '../../core/auth/decorators/require-grant.decorator';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import type { JwtPayload } from '@flicks/shared/types';
import { LeadsService } from './leads.service';

class CreateLeadDto {
  @IsOptional() @IsString() @MaxLength(120) first_name?: string;
  @IsOptional() @IsString() @MaxLength(120) last_name?: string;
  @IsOptional() @IsString() @MaxLength(200) company_name?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsString() @MaxLength(4000) note?: string;
  @IsOptional() @IsString() @MaxLength(60) source?: string;
  @IsOptional() @IsString() owner_user_id?: string;
}

class ConvertLeadDto {
  @IsOptional() @IsString() link_person_id?: string;
  @IsOptional() @IsString() link_company_id?: string;
  @IsOptional() @IsString() @MaxLength(200) person_name?: string;
  @IsOptional() @IsString() @MaxLength(200) company_name?: string;
  @IsOptional() @IsString() @MaxLength(200) deal_title?: string;
  @IsOptional() @IsString() pipeline_id?: string;
  @IsOptional() @IsString() stage_id?: string;
  @IsOptional() @IsNumber() value_amount?: number;
  @IsOptional() @IsString() @MaxLength(3) currency?: string;
}

/** Leads inbox (C6, §5.1): triage rows → convert or discard. */
@ApiTags('crm-leads')
@Controller('crm')
@UseGuards(CrmGrantGuard)
export class LeadsController {
  constructor(private readonly leads: LeadsService) {}

  @Get('leads')
  @RequireGrant('crm', 'view')
  list(@Query('status') status: string | undefined, @CurrentUser() user: JwtPayload) {
    return this.leads.list(user.tenantId, status);
  }

  @Post('leads')
  @RequireGrant('crm', 'edit')
  @ApiOperation({ summary: 'Add a lead manually (web forms and the public API create them too)' })
  create(@Body() dto: CreateLeadDto, @CurrentUser() user: JwtPayload) {
    return this.leads.create(user.tenantId, user.sub, dto);
  }

  @Post('leads/:id/claim')
  @RequireGrant('crm', 'edit')
  claim(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.leads.claim(user.tenantId, user.sub, id);
  }

  @Post('leads/:id/discard')
  @RequireGrant('crm', 'edit')
  discard(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.leads.discard(user.tenantId, user.sub, id);
  }

  @Post('leads/:id/convert')
  @RequireGrant('crm', 'edit')
  @ApiOperation({ summary: 'One action: link/create person + company, open a deal, flip the lead (§5.1)' })
  convert(@Param('id') id: string, @Body() dto: ConvertLeadDto, @CurrentUser() user: JwtPayload) {
    return this.leads.convert(user.tenantId, user.sub, id, dto);
  }
}
