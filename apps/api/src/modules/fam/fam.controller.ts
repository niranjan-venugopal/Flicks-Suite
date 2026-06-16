import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Res,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { Response as ExpressResponse } from 'express';
import { Throttle } from '@nestjs/throttler';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { FamService } from './fam.service';
import { AuthService } from '../auth/auth.service';
import {
  SuspendTenantDto,
  ExtendTrialDto,
  StartImpersonationDto,
  UpsertFeatureFlagDto,
  UpsertCohortDto,
  TenantListQueryDto,
  ToggleModuleDto,
} from './fam.dto';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import { Roles } from '../../core/auth/decorators/roles.decorator';
import type { JwtPayload } from '@flicks/shared/types';

@ApiTags('FAM')
@ApiBearerAuth('access-token')
@Controller('fam')
export class FamController {
  constructor(
    private readonly famService: FamService,
    private readonly authService: AuthService,
  ) {}

  // ─── Overview ──────────────────────────────────────────────────────────────

  @Get('overview')
  @Roles('fam')
  @ApiOperation({ summary: 'Aggregated platform-wide stats for the FAM landing page' })
  @ApiResponse({ status: 200, description: 'Platform overview' })
  async getOverview() {
    return this.famService.getPlatformOverview();
  }

  // ─── Tenants ───────────────────────────────────────────────────────────────

  @Get('tenants')
  @Roles('fam')
  @ApiOperation({ summary: 'List all tenants (platform admin)' })
  @ApiResponse({ status: 200, description: 'Tenants list' })
  async listTenants(@Query() query: TenantListQueryDto) {
    return this.famService.listTenants(query);
  }

  @Get('tenants/:id')
  @Roles('fam')
  @ApiOperation({ summary: 'Get tenant detail (platform admin)' })
  @ApiResponse({ status: 200, description: 'Tenant detail' })
  async getTenant(@Param('id') id: string) {
    return this.famService.getTenant(id);
  }

  @Post('tenants/:id/suspend')
  @Roles('fam')
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
  @Roles('fam')
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
  @Roles('fam')
  @ApiOperation({ summary: 'Get tenant health snapshot history' })
  @ApiQuery({ name: 'days', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Health snapshots' })
  async getTenantHealth(
    @Param('id') id: string,
    @Query('days') days?: string,
  ) {
    return this.famService.getTenantHealth(id, days ? Number(days) : undefined);
  }

  @Get('tenants/:id/members')
  @Roles('fam')
  @ApiOperation({ summary: 'List members (memberships) of a tenant' })
  @ApiResponse({ status: 200, description: 'Membership rows + user details' })
  async listTenantMembers(@Param('id') id: string) {
    return this.famService.listTenantMembers(id);
  }

  @Get('tenants/:id/usage')
  @Roles('fam')
  @ApiOperation({ summary: 'Per-tenant activity rollups (last 30d)' })
  @ApiResponse({ status: 200, description: 'Usage aggregates' })
  async getTenantUsage(@Param('id') id: string) {
    return this.famService.getTenantUsage(id);
  }

  @Get('tenants/:id/billing')
  @Roles('fam')
  @ApiOperation({ summary: 'Subscription + recent billing events for a tenant' })
  @ApiResponse({ status: 200, description: 'Billing payload' })
  async getTenantBilling(@Param('id') id: string) {
    return this.famService.getTenantBilling(id);
  }

  @Get('tenants/:id/audit')
  @Roles('fam')
  @ApiOperation({ summary: 'Platform audit log entries scoped to a tenant' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async getTenantAudit(
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.famService.getTenantAudit(id, {
      page: page ? Number(page) : 1,
      limit: limit ? Number(limit) : 50,
    });
  }

  @Post('tenants/:id/reactivate')
  @Roles('fam')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Lift a suspension and flip the tenant back to active' })
  @ApiResponse({ status: 200, description: 'Tenant reactivated' })
  async reactivateTenant(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.famService.reactivateTenant(id, user.sub);
  }

  // ─── Impersonation ─────────────────────────────────────────────────────────

  @Post('impersonate')
  @Roles('fam')
  @HttpCode(HttpStatus.OK)
  // Tightly rate-limit the most sensitive platform action: 5 starts / minute.
  @Throttle({ short: { limit: 5, ttl: 60000 } })
  @ApiOperation({ summary: 'Start impersonation session for a target user' })
  @ApiResponse({ status: 200, description: 'Impersonation token issued + cookies set' })
  async startImpersonation(
    @Body() dto: StartImpersonationDto,
    @CurrentUser() user: JwtPayload,
    @Res({ passthrough: true }) res: ExpressResponse,
  ) {
    const result = await this.famService.startImpersonation(user.sub, dto);
    this.authService.setAuthCookies(res, result.accessToken, result.refreshToken);
    return {
      targetUserId: result.targetUserId,
      targetEmail: result.targetEmail,
      tenantId: result.tenantId,
      expiresIn: result.expiresIn,
    };
  }

  @Post('impersonate/end')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'End the current impersonation session and restore FAM session' })
  async endImpersonation(
    @CurrentUser() user: JwtPayload,
    @Res({ passthrough: true }) res: ExpressResponse,
  ) {
    if (!user.impersonatorUserId) {
      // Not impersonating — no-op so the frontend can call this safely.
      return { ok: true };
    }
    const { accessToken, refreshToken } = await this.famService.endImpersonation(
      user.sub,
      user.impersonatorUserId,
      user.tenantId,
    );
    this.authService.setAuthCookies(res, accessToken, refreshToken);
    return { ok: true };
  }

  // ─── Feature flags ─────────────────────────────────────────────────────────

  @Get('feature-flags')
  @Roles('fam')
  @ApiOperation({ summary: 'List all feature flags' })
  @ApiResponse({ status: 200, description: 'Feature flags' })
  async listFeatureFlags() {
    return this.famService.listFeatureFlags();
  }

  @Put('feature-flags')
  @Roles('fam')
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
  @Roles('fam')
  @ApiOperation({ summary: 'List tenant cohorts' })
  @ApiResponse({ status: 200, description: 'Cohorts' })
  async listCohorts() {
    return this.famService.listCohorts();
  }

  @Put('cohorts')
  @Roles('fam')
  @ApiOperation({ summary: 'Upsert a tenant cohort (create or update by name)' })
  @ApiResponse({ status: 200, description: 'Cohort upserted' })
  async upsertCohort(
    @Body() dto: UpsertCohortDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.famService.upsertCohort(user.sub, dto);
  }

  // ─── C5: Revenue / Funnel / Feature usage / System health / Verify / Audit ─

  @Get('revenue')
  @Roles('fam')
  @ApiOperation({ summary: 'Platform-wide revenue snapshot (MRR + breakdowns)' })
  async getRevenue() {
    return this.famService.getRevenue();
  }

  @Get('funnel')
  @Roles('fam')
  @ApiOperation({ summary: 'Signup funnel counts across the 5 onboarding stages' })
  async getFunnel() {
    return this.famService.getFunnel();
  }

  @Get('feature-usage')
  @Roles('fam')
  @ApiOperation({ summary: 'Per-tenant module adoption (last 30d)' })
  async getFeatureUsage() {
    return this.famService.getFeatureUsage();
  }

  @Get('health')
  @Roles('fam')
  @ApiOperation({ summary: 'Platform health distribution + at-risk tenants' })
  async getSystemHealth() {
    return this.famService.getSystemHealth();
  }

  @Get('verify')
  @Roles('fam')
  @ApiOperation({ summary: 'Tenants pending GST + PAN verification' })
  async getVerificationQueue() {
    return this.famService.getVerificationQueue();
  }

  @Post('tenants/:id/verify')
  @Roles('fam')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark a tenant as verified' })
  async verifyTenant(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.famService.verifyTenant(id, user.sub);
  }

  @Get('audit')
  @Roles('fam')
  @ApiOperation({ summary: 'Platform-wide audit log' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async getPlatformAudit(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.famService.getPlatformAudit({
      page: page ? Number(page) : 1,
      limit: limit ? Number(limit) : 50,
    });
  }

  // ─── Invoicing v3: module toggles, auditor registry, seats, metrics (§10) ──

  @Get('tenants/:id/modules')
  @Roles('fam')
  @ApiOperation({ summary: 'Per-module enablement for a tenant' })
  async getTenantModules(@Param('id') id: string) {
    return this.famService.getTenantModules(id);
  }

  @Patch('tenants/:id/modules/:module')
  @Roles('fam')
  @ApiOperation({
    summary: 'Enable/disable a module for a tenant (toggle wins over grants)',
  })
  async toggleTenantModule(
    @Param('id') id: string,
    @Param('module') module: string,
    @Body() dto: ToggleModuleDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.famService.setTenantModule(id, module, dto.enabled, user.sub);
  }

  @Get('auditors')
  @Roles('fam')
  @ApiOperation({
    summary: 'Auditor-link registry — auditor ↔ companies ↔ status ↔ window',
  })
  async getAuditorRegistry() {
    return this.famService.getAuditorRegistry();
  }

  @Delete('auditors/:userId/companies/:tenantId')
  @Roles('fam')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke an auditor link (service-role)' })
  async revokeAuditorLink(
    @Param('userId') userId: string,
    @Param('tenantId') tenantId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.famService.revokeAuditorLink(userId, tenantId, user.sub);
  }

  @Get('tenants/:id/seats')
  @Roles('fam')
  @ApiOperation({ summary: 'Seat split — billable members vs non-billable auditors' })
  async getTenantSeats(@Param('id') id: string) {
    return this.famService.getTenantSeats(id);
  }

  @Get('invoicing-metrics')
  @Roles('fam')
  @ApiOperation({ summary: 'Anonymized aggregate invoicing/auditor metrics (no content)' })
  async getInvoicingMetrics() {
    return this.famService.getInvoicingMetrics();
  }

  @Get('tenants/:id/invoicing-debug')
  @Roles('fam')
  @ApiOperation({
    summary: 'Consented debug (§10.5) — counts/log metadata, requires active tenant consent',
  })
  @ApiResponse({ status: 403, description: 'No active debug consent from this tenant' })
  async getInvoicingDebug(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.famService.getInvoicingDebug(id, user.sub);
  }
}
