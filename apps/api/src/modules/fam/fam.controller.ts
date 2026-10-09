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
  Req,
  Res,
  Header,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';
import { Request, Response as ExpressResponse } from 'express';
import { Throttle } from '@nestjs/throttler';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { FamService, type FamActor } from './fam.service';
import { AuthService } from '../auth/auth.service';
import {
  SuspendTenantDto,
  ExtendTrialDto,
  StartImpersonationDto,
  UpsertFeatureFlagDto,
  UpsertCohortDto,
  TenantListQueryDto,
  ToggleModuleDto,
  VerifyTenantDto,
  FamSearchQueryDto,
  GrantFreeMonthsDto,
  TenantNoteDto,
  UpdateTenantNoteDto,
  FamAuditQueryDto,
  TenantActivityQueryDto,
} from './fam.dto';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import { Roles } from '../../core/auth/decorators/roles.decorator';
import { BillingExempt } from '../../core/auth/decorators/billing-exempt.decorator';
import { FamGuard } from '../../core/auth/guards/fam.guard';
import { FamMfaGuard } from '../../core/auth/guards/fam-mfa.guard';
import { clientMeta } from '../../core/common/request-meta';
import { ApprovalEscalationJob } from '../approvals/public';
import type { JwtPayload } from '@flicks/shared/types';

/** Who is acting, from where — every FAM write audits this (Round R R2). */
function actorOf(user: JwtPayload, req: Request): FamActor {
  const { ip, userAgent } = clientMeta(req);
  return { userId: user.sub, ip, userAgent };
}

@ApiTags('FAM')
@ApiBearerAuth('access-token')
// Round R R2: platform staff are never behind a customer paywall (their token
// carries the role of whatever company they are scoped to), and when TOTP
// enforcement is on, only a session that finished the second factor may use
// the console.
@BillingExempt()
@UseGuards(FamMfaGuard)
@Controller('fam')
export class FamController {
  constructor(
    private readonly famService: FamService,
    private readonly authService: AuthService,
    private readonly approvalEscalation: ApprovalEscalationJob,
  ) {}

  // ─── Jobs (Round L) ────────────────────────────────────────────────────────

  @Post('jobs/approval-escalation/run')
  @Roles('fam')
  @UseGuards(FamGuard)
  @HttpCode(HttpStatus.OK)
  @Throttle({ short: { limit: 5, ttl: 60000 } })
  @ApiOperation({
    summary: 'Run the approval-escalation sweep now (platform admin only)',
    description:
      'Round L — the same 15-minute sweep the scheduler runs (`runSweep(new Date())`), for live verification. Idempotent: an item already moved is skipped.',
  })
  @ApiResponse({ status: 200, description: 'Sweep counters' })
  async runApprovalEscalation(@CurrentUser() user: JwtPayload) {
    const result = await this.approvalEscalation.runSweep(new Date());
    return { ...result, triggeredBy: user.sub };
  }

  // ─── Overview ──────────────────────────────────────────────────────────────

  @Get('overview')
  @Roles('fam')
  @ApiOperation({ summary: 'Aggregated platform-wide stats for the FAM landing page' })
  @ApiResponse({ status: 200, description: 'Platform overview' })
  async getOverview() {
    return this.famService.getPlatformOverview();
  }

  // ─── Round R R2: find anyone ───────────────────────────────────────────────

  @Get('search')
  @Roles('fam')
  @ApiOperation({ summary: 'Find a person (email / name) or a company (name / slug / GSTIN)' })
  async search(@Query() q: FamSearchQueryDto) {
    return this.famService.search(q.q ?? '');
  }

  // ─── Round R R2: a person across companies ─────────────────────────────────

  @Get('users/:id')
  @Roles('fam')
  @ApiOperation({ summary: 'A person: profile, companies, lockout state, live sessions, trusted devices' })
  async getUser(@Param('id', ParseUUIDPipe) id: string) {
    return this.famService.getUser(id);
  }

  @Get('users/:id/auth-events')
  @Roles('fam')
  @ApiOperation({ summary: 'Sign-in history of a person (newest first)' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async getUserAuthEvents(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.famService.getUserAuthEvents(id, {
      page: page ? Number(page) : 1,
      limit: limit ? Number(limit) : 50,
    });
  }

  @Post('users/:id/clear-lockout')
  @Roles('fam')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Clear every sign-in lockout (OTP quota, failed-code counter, TOTP lock)' })
  async clearUserLockout(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
    @Req() req: Request,
  ) {
    return this.famService.clearUserLockout(id, actorOf(user, req));
  }

  @Post('users/:id/send-sign-in-link')
  @Roles('fam')
  @HttpCode(HttpStatus.OK)
  @Throttle({ short: { limit: 10, ttl: 60000 } })
  @ApiOperation({ summary: 'Email the person a 30-minute sign-in link (bypasses the OTP quota)' })
  async sendUserSignInLink(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
    @Req() req: Request,
  ) {
    return this.famService.sendUserSignInLink(id, actorOf(user, req));
  }

  @Post('users/:id/sign-out-everywhere')
  @Roles('fam')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Retire every live session and trusted device of a person' })
  async signOutUserEverywhere(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
    @Req() req: Request,
  ) {
    return this.famService.signOutUserEverywhere(id, actorOf(user, req));
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
  @ApiOperation({ summary: 'Suspend a tenant — blocks every sign-in, retires live sessions, tells the Owners' })
  @ApiResponse({ status: 200, description: 'Tenant suspended' })
  async suspendTenant(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SuspendTenantDto,
    @CurrentUser() user: JwtPayload,
    @Req() req: Request,
  ) {
    return this.famService.suspendTenant(id, actorOf(user, req), dto);
  }

  @Post('tenants/:id/reactivate')
  @Roles('fam')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Lift a suspension — restores the status the suspension interrupted' })
  @ApiResponse({ status: 200, description: 'Tenant reactivated' })
  async reactivateTenant(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
    @Req() req: Request,
  ) {
    return this.famService.reactivateTenant(id, actorOf(user, req));
  }

  @Post('tenants/:id/extend-trial')
  @Roles('fam')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Extend tenant trial by N days from today or the current end, whichever is later' })
  @ApiResponse({ status: 200, description: 'Trial extended' })
  async extendTrial(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ExtendTrialDto,
    @CurrentUser() user: JwtPayload,
    @Req() req: Request,
  ) {
    return this.famService.extendTrial(id, actorOf(user, req), dto);
  }

  @Post('tenants/:id/free-months')
  @Roles('fam')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Give free months (a private coupon applied on the company’s behalf)' })
  async grantFreeMonths(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: GrantFreeMonthsDto,
    @CurrentUser() user: JwtPayload,
    @Req() req: Request,
  ) {
    return this.famService.grantFreeMonths(id, actorOf(user, req), dto);
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

  @Post('tenants/:id/members/:membershipId/resend-invite')
  @Roles('fam')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Re-send the invite email to a seat that has not joined yet' })
  async resendMemberInvite(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('membershipId', ParseUUIDPipe) membershipId: string,
    @CurrentUser() user: JwtPayload,
    @Req() req: Request,
  ) {
    return this.famService.resendMemberInvite(id, membershipId, actorOf(user, req));
  }

  @Post('tenants/:id/members/:membershipId/sign-out')
  @Roles('fam')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sign one member out of this company (their other companies keep working)' })
  async signOutMember(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('membershipId', ParseUUIDPipe) membershipId: string,
    @CurrentUser() user: JwtPayload,
    @Req() req: Request,
  ) {
    return this.famService.signOutMember(id, membershipId, actorOf(user, req));
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
  @ApiOperation({ summary: 'Subscription (seats, MRR, coupon, grace) + recent billing events' })
  @ApiResponse({ status: 200, description: 'Billing payload' })
  async getTenantBilling(@Param('id') id: string) {
    return this.famService.getTenantBilling(id);
  }

  // ─── Round R R2: the company's own activity log (support tab) ──────────────

  @Get('tenants/:id/activity')
  @Roles('fam')
  @ApiOperation({ summary: "The company's own audit log, paged and filtered (what its Owner sees)" })
  async getTenantActivity(@Param('id', ParseUUIDPipe) id: string, @Query() q: TenantActivityQueryDto) {
    return this.famService.getTenantActivity(id, q);
  }

  @Get('tenants/:id/activity.csv')
  @Roles('fam')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="company-activity.csv"')
  @ApiOperation({ summary: "CSV of the company's own audit log (same filters)" })
  async exportTenantActivity(@Param('id', ParseUUIDPipe) id: string, @Query() q: TenantActivityQueryDto) {
    return this.famService.exportTenantActivityCsv(id, q);
  }

  @Get('tenants/:id/notes')
  @Roles('fam')
  @ApiOperation({ summary: 'Specflicks support notes about a company (never visible to the company)' })
  async listTenantNotes(@Param('id', ParseUUIDPipe) id: string) {
    return this.famService.listTenantNotes(id);
  }

  @Post('tenants/:id/notes')
  @Roles('fam')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Add a support note' })
  async addTenantNote(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TenantNoteDto,
    @CurrentUser() user: JwtPayload,
    @Req() req: Request,
  ) {
    return this.famService.addTenantNote(id, actorOf(user, req), dto.body);
  }

  @Patch('tenants/:id/notes/:noteId')
  @Roles('fam')
  @ApiOperation({ summary: 'Edit or pin a support note' })
  async updateTenantNote(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('noteId', ParseUUIDPipe) noteId: string,
    @Body() dto: UpdateTenantNoteDto,
    @CurrentUser() user: JwtPayload,
    @Req() req: Request,
  ) {
    return this.famService.updateTenantNote(id, noteId, actorOf(user, req), dto);
  }

  @Delete('tenants/:id/notes/:noteId')
  @Roles('fam')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove a support note' })
  async deleteTenantNote(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('noteId', ParseUUIDPipe) noteId: string,
    @CurrentUser() user: JwtPayload,
    @Req() req: Request,
  ) {
    return this.famService.deleteTenantNote(id, noteId, actorOf(user, req));
  }

  // ─── Platform audit (per company + platform-wide), with filters + CSV ──────

  @Get('tenants/:id/audit')
  @Roles('fam')
  @ApiOperation({ summary: 'Platform audit log entries scoped to a tenant (filters: action, actor, from, to)' })
  async getTenantAudit(@Param('id', ParseUUIDPipe) id: string, @Query() q: FamAuditQueryDto) {
    return this.famService.getTenantAudit(id, q);
  }

  @Get('tenants/:id/audit.csv')
  @Roles('fam')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="platform-audit.csv"')
  @ApiOperation({ summary: 'CSV of the platform audit log entries scoped to a tenant' })
  async exportTenantAudit(@Param('id', ParseUUIDPipe) id: string, @Query() q: FamAuditQueryDto) {
    return this.famService.exportPlatformAuditCsv(q, id);
  }

  @Get('audit')
  @Roles('fam')
  @ApiOperation({ summary: 'Platform-wide audit log (filters: action, actor, tenantId, from, to)' })
  async getPlatformAudit(@Query() q: FamAuditQueryDto) {
    return this.famService.getPlatformAudit(q);
  }

  @Get('audit.csv')
  @Roles('fam')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="platform-audit.csv"')
  @ApiOperation({ summary: 'CSV of the platform-wide audit log (same filters, up to 5 000 rows)' })
  async exportPlatformAudit(@Query() q: FamAuditQueryDto) {
    return this.famService.exportPlatformAuditCsv(q);
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

  // ─── C5: Revenue / Funnel / Feature usage / System health / Verify ─────────

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

  @Get('funnel/invoicing')
  // Round R: platform-wide counts were readable by any signed-in customer.
  @Roles('fam')
  @ApiOperation({ summary: 'Invoicing activation funnel F1–F5 (PRD v4 §6/D13)' })
  getInvoicingFunnel() {
    return this.famService.getInvoicingFunnel();
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
    @Body() dto: VerifyTenantDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.famService.verifyTenant(id, user.sub, dto?.notes);
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
