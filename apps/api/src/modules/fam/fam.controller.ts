import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { FamService } from './fam.service';
import {
  SuspendTenantDto,
  ExtendTrialDto,
  StartImpersonationDto,
  UpsertFeatureFlagDto,
  UpsertCohortDto,
  TenantListQueryDto,
} from './fam.dto';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import { Roles } from '../../core/auth/decorators/roles.decorator';
import type { JwtPayload } from '@flicks/shared/types';

@ApiTags('FAM')
@ApiBearerAuth('access-token')
@Controller('fam')
export class FamController {
  constructor(private readonly famService: FamService) {}

  // ─── Tenants ───────────────────────────────────────────────────────────────

  @Get('tenants')
  @Roles('super_admin')
  @ApiOperation({ summary: 'List all tenants (platform admin)' })
  @ApiResponse({ status: 200, description: 'Tenants list' })
  async listTenants(@Query() query: TenantListQueryDto) {
    return this.famService.listTenants(query);
  }

  @Get('tenants/:id')
  @Roles('super_admin')
  @ApiOperation({ summary: 'Get tenant detail (platform admin)' })
  @ApiResponse({ status: 200, description: 'Tenant detail' })
  async getTenant(@Param('id') id: string) {
    return this.famService.getTenant(id);
  }

  @Post('tenants/:id/suspend')
  @Roles('super_admin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Suspend a tenant' })
  @ApiResponse({ status: 200, description: 'Tenant suspended' })
  async suspendTenant(
    @Param('id') id: string,
    @Body() dto: SuspendTenantDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.famService.suspendTenant(id, user.sub, dto);
  }

  @Post('tenants/:id/extend-trial')
  @Roles('super_admin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Extend tenant trial by N days' })
  @ApiResponse({ status: 200, description: 'Trial extended' })
  async extendTrial(
    @Param('id') id: string,
    @Body() dto: ExtendTrialDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.famService.extendTrial(id, user.sub, dto);
  }

  @Get('tenants/:id/health')
  @Roles('super_admin')
  @ApiOperation({ summary: 'Get tenant health snapshot history' })
  @ApiQuery({ name: 'days', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Health snapshots' })
  async getTenantHealth(
    @Param('id') id: string,
    @Query('days') days?: string,
  ) {
    return this.famService.getTenantHealth(id, days ? Number(days) : undefined);
  }

  // ─── Impersonation ─────────────────────────────────────────────────────────

  @Post('impersonate')
  @Roles('super_admin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Start impersonation session for a target user' })
  @ApiResponse({ status: 200, description: 'Impersonation token issued' })
  async startImpersonation(
    @Body() dto: StartImpersonationDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.famService.startImpersonation(user.sub, dto);
  }

  // ─── Feature flags ─────────────────────────────────────────────────────────

  @Get('feature-flags')
  @Roles('super_admin')
  @ApiOperation({ summary: 'List all feature flags' })
  @ApiResponse({ status: 200, description: 'Feature flags' })
  async listFeatureFlags() {
    return this.famService.listFeatureFlags();
  }

  @Put('feature-flags')
  @Roles('super_admin')
  @ApiOperation({ summary: 'Upsert a feature flag (create or update by key)' })
  @ApiResponse({ status: 200, description: 'Feature flag upserted' })
  async upsertFeatureFlag(
    @Body() dto: UpsertFeatureFlagDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.famService.upsertFeatureFlag(user.sub, dto);
  }

  // ─── Cohorts ───────────────────────────────────────────────────────────────

  @Get('cohorts')
  @Roles('super_admin')
  @ApiOperation({ summary: 'List tenant cohorts' })
  @ApiResponse({ status: 200, description: 'Cohorts' })
  async listCohorts() {
    return this.famService.listCohorts();
  }

  @Put('cohorts')
  @Roles('super_admin')
  @ApiOperation({ summary: 'Upsert a tenant cohort (create or update by name)' })
  @ApiResponse({ status: 200, description: 'Cohort upserted' })
  async upsertCohort(
    @Body() dto: UpsertCohortDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.famService.upsertCohort(user.sub, dto);
  }
}
