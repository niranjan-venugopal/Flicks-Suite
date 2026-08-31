import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsNumber, IsObject, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { CrmGrantGuard } from '../../core/auth/guards/crm-grant.guard';
import { RequireGrant } from '../../core/auth/decorators/require-grant.decorator';
import { Roles } from '../../core/auth/decorators/roles.decorator';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import type { JwtPayload } from '@flicks/shared/types';
import { ReportsService } from './reports.service';
import { ImportService, type DupeStrategy, type ImportObject } from './import.service';
import { MergeService } from './merge.service';
import { SampleDataService } from './sample-data.service';

class SetGoalDto {
  @Matches(/^\d{4}-\d{2}$/) period!: string;
  @IsOptional() @IsString() user_id?: string | null;
  @IsNumber() target_base!: number;
}

class ImportParseDto {
  @IsIn(['people', 'companies', 'leads']) object!: ImportObject;
  @IsString() @MaxLength(5_000_000) csv!: string;
  @IsOptional() @IsString() @MaxLength(200) file_name?: string;
}

class ImportRunDto extends ImportParseDto {
  // @Type(() => Object): the pipe's implicit conversion would mangle the
  // untyped JSON map otherwise (same gotcha as workflow actions).
  @IsObject() @Type(() => Object) mapping!: Record<string, string>;
  @IsIn(['skip', 'update', 'create']) strategy!: DupeStrategy;
}

class MergeDto {
  @IsIn(['person', 'company']) type!: 'person' | 'company';
  @IsString() winner_id!: string;
  @IsString() loser_id!: string;
  @IsOptional() @IsObject() @Type(() => Object) patch?: Record<string, string>;
}

class ReassignDto {
  @IsString() from_user_id!: string;
  @IsString() to_user_id!: string;
}

/**
 * Sprint 31 surfaces: reports/forecast/goals (C16/C17, §19.6), CSV import
 * (C14), merge + dedupe finder (C15), §19.7 offboarding reassignment and the
 * C22 sample-data toggle. Bulk writes are Manager+ (§13).
 */
@ApiTags('crm-reports')
@Controller('crm')
@UseGuards(CrmGrantGuard)
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly imports: ImportService,
    private readonly merge: MergeService,
    private readonly sample: SampleDataService,
  ) {}

  // ─── Reports & goals ─────────────────────────────────────────────────────────

  @Get('reports/overview')
  @RequireGrant('crm', 'view')
  overview(@Query('days') days: string | undefined, @Query('pipeline_id') pipelineId: string | undefined, @CurrentUser() user: JwtPayload) {
    return this.reports.overview(user.tenantId, { days: days ? parseInt(days, 10) : undefined, pipeline_id: pipelineId });
  }

  @Get('reports/forecast')
  @RequireGrant('crm', 'view')
  forecast(@Query('months') months: string | undefined, @CurrentUser() user: JwtPayload) {
    return this.reports.forecast(user.tenantId, { months: months ? parseInt(months, 10) : undefined });
  }

  @Get('goals')
  @RequireGrant('crm', 'view')
  goals(@Query('period') period: string | undefined, @CurrentUser() user: JwtPayload) {
    return this.reports.listGoals(user.tenantId, period);
  }

  @Post('goals')
  @RequireGrant('crm', 'edit')
  @Roles('owner', 'admin', 'manager')
  @ApiOperation({ summary: 'Upsert a monthly won-revenue target (§19.6); 0 removes it' })
  setGoal(@Body() dto: SetGoalDto, @CurrentUser() user: JwtPayload) {
    return this.reports.setGoal(user.tenantId, user.sub, dto);
  }

  // ─── Import (C14; round B parity) ────────────────────────────────────────────

  @Get('import/template')
  @RequireGrant('crm', 'view')
  @ApiOperation({ summary: 'Starter CSV per entity — its columns auto-map 100% on upload' })
  template(@Query('object') object: string) {
    return this.imports.template(object as ImportObject);
  }

  @Post('import/parse')
  @RequireGrant('crm', 'edit')
  @Roles('owner', 'admin', 'manager')
  parse(@Body() dto: ImportParseDto) {
    return this.imports.parse(dto.object, dto.csv, dto.file_name);
  }

  @Post('import/dry-run')
  @RequireGrant('crm', 'edit')
  @Roles('owner', 'admin', 'manager')
  @ApiOperation({ summary: 'Plan the import — nothing is written' })
  dryRun(@Body() dto: ImportRunDto, @CurrentUser() user: JwtPayload) {
    return this.imports.dryRun(user.tenantId, dto.object, dto.csv, dto.mapping, dto.strategy);
  }

  @Post('import/run')
  @RequireGrant('crm', 'edit')
  @Roles('owner', 'admin', 'manager')
  run(@Body() dto: ImportRunDto, @CurrentUser() user: JwtPayload) {
    return this.imports.run(user.tenantId, user.sub, dto.object, dto.csv, dto.mapping, dto.strategy, dto.file_name);
  }

  @Get('import/batches')
  @RequireGrant('crm', 'view')
  batches(@CurrentUser() user: JwtPayload) {
    return this.imports.listBatches(user.tenantId);
  }

  @Post('import/:id/undo')
  @RequireGrant('crm', 'edit')
  @Roles('owner', 'admin', 'manager')
  @ApiOperation({ summary: 'Retract everything a batch created (24h window)' })
  undo(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.imports.undo(user.tenantId, user.sub, id);
  }

  // ─── Merge & dedupe (C15) ────────────────────────────────────────────────────

  @Get('merge/candidates')
  @RequireGrant('crm', 'view')
  candidates(@CurrentUser() user: JwtPayload) {
    return this.merge.candidates(user.tenantId);
  }

  @Get('merge/preview')
  @RequireGrant('crm', 'view')
  preview(
    @Query('type') type: 'person' | 'company',
    @Query('winner_id') winnerId: string,
    @Query('loser_id') loserId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return type === 'company'
      ? this.merge.previewCompanyMerge(user.tenantId, winnerId, loserId)
      : this.merge.previewPersonMerge(user.tenantId, winnerId, loserId);
  }

  @Post('merge')
  @RequireGrant('crm', 'edit')
  @Roles('owner', 'admin', 'manager')
  @ApiOperation({ summary: 'Merge two records — refs move to the winner, loser gets a tombstone' })
  doMerge(@Body() dto: MergeDto, @CurrentUser() user: JwtPayload) {
    return dto.type === 'company'
      ? this.merge.mergeCompanies(user.tenantId, user.sub, dto.winner_id, dto.loser_id, dto.patch ?? {})
      : this.merge.mergePeople(user.tenantId, user.sub, dto.winner_id, dto.loser_id, dto.patch ?? {});
  }

  // ─── §19.7 offboarding reassignment ─────────────────────────────────────────

  @Get('reassign/preview')
  @RequireGrant('crm', 'view')
  reassignPreview(@Query('from_user_id') fromUserId: string, @CurrentUser() user: JwtPayload) {
    return this.merge.reassignPreview(user.tenantId, fromUserId);
  }

  @Post('reassign')
  @RequireGrant('crm', 'edit')
  @Roles('owner', 'admin', 'manager')
  @ApiOperation({ summary: 'Move all open deals/activities/leads from one member to another (§19.7)' })
  reassign(@Body() dto: ReassignDto, @CurrentUser() user: JwtPayload) {
    return this.merge.reassign(user.tenantId, user.sub, dto.from_user_id, dto.to_user_id);
  }

  // ─── C22 sample data ─────────────────────────────────────────────────────────

  @Get('sample-data')
  @RequireGrant('crm', 'view')
  sampleStatus(@CurrentUser() user: JwtPayload) {
    return this.sample.status(user.tenantId);
  }

  @Post('sample-data')
  @RequireGrant('crm', 'edit')
  @Roles('owner', 'admin', 'manager')
  sampleSeed(@CurrentUser() user: JwtPayload) {
    return this.sample.seed(user.tenantId, user.sub);
  }

  @Post('sample-data/remove')
  @RequireGrant('crm', 'edit')
  @Roles('owner', 'admin', 'manager')
  sampleRemove(@CurrentUser() user: JwtPayload) {
    return this.sample.remove(user.tenantId, user.sub);
  }
}
