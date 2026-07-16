import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { CrmGrantGuard } from '../../core/auth/guards/crm-grant.guard';
import { RequireGrant } from '../../core/auth/decorators/require-grant.decorator';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import type { JwtPayload } from '@flicks/shared/types';
import { ActivitiesService } from './activities.service';

class CreateActivityDto {
  @IsIn(['task', 'call', 'meeting', 'note']) type!: string;
  @IsString() @MaxLength(200) subject!: string;
  @IsOptional() @IsString() @MaxLength(5000) body?: string;
  @IsOptional() @IsString() deal_id?: string;
  @IsOptional() @IsString() person_id?: string;
  @IsOptional() @IsString() company_id?: string;
  @IsOptional() @IsString() assignee_user_id?: string;
  @IsOptional() @IsString() due_at?: string;
  @IsOptional() @IsString() outcome?: string;
}

class CompleteActivityDto {
  @IsOptional() @IsString() outcome?: string;
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
}

/** Activities & the follow-up loop (PRD v5 §6, C8). */
@ApiTags('crm-activities')
@Controller('crm')
@UseGuards(CrmGrantGuard)
export class ActivitiesController {
  constructor(private readonly activities: ActivitiesService) {}

  @Get('activities/mine')
  @RequireGrant('crm', 'view')
  @ApiOperation({ summary: 'My activities — overdue / today / upcoming / recently completed (C8)' })
  mine(@CurrentUser() user: JwtPayload) {
    return this.activities.mine(user.tenantId, user.sub);
  }

  @Get('deals/:id/activities')
  @RequireGrant('crm', 'view')
  listForDeal(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.activities.listForDeal(user.tenantId, id);
  }

  @Get('contacts/:id/activities')
  @RequireGrant('crm', 'view')
  listForContact(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.activities.listForContact(user.tenantId, id);
  }

  @Get('companies/:id/activities')
  @RequireGrant('crm', 'view')
  listForCompany(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.activities.listForCompany(user.tenantId, id);
  }

  @Post('activities')
  @RequireGrant('crm', 'edit')
  @ApiOperation({ summary: 'Schedule a task/call/meeting or log a note' })
  create(@Body() dto: CreateActivityDto, @CurrentUser() user: JwtPayload) {
    return this.activities.create(user.tenantId, user.sub, dto);
  }

  @Post('activities/:id/complete')
  @RequireGrant('crm', 'edit')
  @ApiOperation({ summary: 'Complete an activity (idempotent; optional call outcome + note)' })
  complete(@Param('id') id: string, @Body() dto: CompleteActivityDto, @CurrentUser() user: JwtPayload) {
    return this.activities.complete(user.tenantId, user.sub, id, dto);
  }

  @Delete('activities/:id')
  @RequireGrant('crm', 'edit')
  remove(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.activities.remove(user.tenantId, user.sub, id);
  }
}
