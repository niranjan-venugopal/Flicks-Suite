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
import { IsInt, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { CrmGrantGuard } from '../../core/auth/guards/crm-grant.guard';
import { RequireGrant } from '../../core/auth/decorators/require-grant.decorator';
import { Roles } from '../../core/auth/decorators/roles.decorator';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import type { JwtPayload } from '@flicks/shared/types';
import { DealsService } from './deals.service';
import { PipelinesService } from './pipelines.service';

class CreateDealDto {
  @IsString() @MaxLength(200) title!: string;
  @IsOptional() @IsString() pipeline_id?: string;
  @IsOptional() @IsString() stage_id?: string;
  @IsOptional() @IsString() company_id?: string;
  @IsOptional() @IsString() primary_person_id?: string;
  @IsOptional() @IsString() owner_user_id?: string;
  @IsOptional() @IsNumber() @Min(0) value_amount?: number;
  @IsOptional() @IsString() @MaxLength(3) currency?: string;
  @IsOptional() @IsString() expected_close_date?: string;
  @IsOptional() @IsString() source?: string;
}

class MoveStageDto {
  @IsString() stage_id!: string;
  @IsOptional() @IsString() lost_reason_id?: string;
  @IsOptional() @IsString() lost_reason_note?: string;
}

@ApiTags('crm-deals')
@Controller('crm')
@UseGuards(CrmGrantGuard)
export class DealsController {
  constructor(
    private readonly deals: DealsService,
    private readonly pipelines: PipelinesService,
  ) {}

  // ─── Pipelines / reference ──────────────────────────────────────────────────
  @Get('pipelines')
  @RequireGrant('crm', 'view')
  listPipelines(@CurrentUser() user: JwtPayload) {
    return this.pipelines.list(user.tenantId);
  }

  @Get('lost-reasons')
  @RequireGrant('crm', 'view')
  lostReasons(@CurrentUser() user: JwtPayload) {
    return this.pipelines.lostReasons(user.tenantId);
  }

  // ─── Board / forecast ───────────────────────────────────────────────────────
  @Get('board')
  @RequireGrant('crm', 'view')
  @ApiOperation({ summary: 'Kanban board: open deals grouped by stage with sums + rotting' })
  board(@Query('pipeline_id') pipelineId: string | undefined, @CurrentUser() user: JwtPayload) {
    return this.deals.board(user.tenantId, pipelineId);
  }

  @Get('forecast')
  @RequireGrant('crm', 'view')
  forecast(@Query('pipeline_id') pipelineId: string | undefined, @CurrentUser() user: JwtPayload) {
    return this.deals.forecast(user.tenantId, pipelineId);
  }

  // ─── Deals ──────────────────────────────────────────────────────────────────
  @Get('deals/:id')
  @RequireGrant('crm', 'view')
  get(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.deals.get(user.tenantId, id);
  }

  @Post('deals')
  @RequireGrant('crm', 'edit')
  create(@Body() dto: CreateDealDto, @CurrentUser() user: JwtPayload) {
    return this.deals.create(user.tenantId, user.sub, dto);
  }

  @Patch('deals/:id')
  @RequireGrant('crm', 'edit')
  update(@Param('id') id: string, @Body() dto: Record<string, unknown>, @CurrentUser() user: JwtPayload) {
    return this.deals.update(user.tenantId, user.sub, id, dto);
  }

  @Post('deals/:id/move')
  @RequireGrant('crm', 'edit')
  @ApiOperation({ summary: 'Move a deal to a stage (won/lost applied on terminal stages)' })
  move(@Param('id') id: string, @Body() dto: MoveStageDto, @CurrentUser() user: JwtPayload) {
    return this.deals.moveStage(user.tenantId, user.sub, id, dto);
  }

  @Post('deals/:id/reopen')
  @Roles('owner', 'admin', 'manager')
  @RequireGrant('crm', 'edit')
  reopen(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.deals.reopen(user.tenantId, user, id);
  }

  @Delete('deals/:id')
  @Roles('owner', 'admin', 'manager')
  @RequireGrant('crm', 'edit')
  remove(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.deals.remove(user.tenantId, user.sub, id);
  }
}
