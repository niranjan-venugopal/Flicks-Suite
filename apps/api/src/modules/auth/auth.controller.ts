import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Query,
  Req,
  Res,
  Param,
  HttpCode,
  HttpStatus,
  UseGuards,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiCookieAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { Request, Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { MediaService } from '../media/media.service';
import { ModuleAccessService } from '../../core/auth/module-access.service';
import { FlagEvalService } from '../../core/flags/flag-eval.service';
import {
  RequestOtpDto,
  VerifyOtpDto,
  RefreshTokenDto,
  SelectTenantDto,
  LogoutDto,
  MagicLinkVerifyDto,
} from './auth.dto';
import { Public } from '../../core/auth/decorators/public.decorator';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import { BillingExempt } from '../../core/auth/decorators/billing-exempt.decorator';
import { JwtAuthGuard } from '../../core/auth/guards/jwt-auth.guard';
import type { JwtPayload } from '@flicks/shared/types';

@ApiTags('Auth')
@BillingExempt()
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly mediaService: MediaService,
    private readonly moduleAccess: ModuleAccessService,
    private readonly flagEval: FlagEvalService,
  ) {}

  @Public()
  @Post('request-otp')
  @HttpCode(HttpStatus.OK)
  // Override the 'short' throttler for this route: 5 OTP requests / hour / IP.
  // (The throttler is named — the previous `default` key matched nothing.)
  @Throttle({ short: { limit: 5, ttl: 3600000 } })
  @ApiOperation({
    summary: 'Request OTP',
    description:
      'Send a 6-digit OTP and magic link to the given email. Rate limited to 5/hour per email.',
  })
  @ApiResponse({ status: 200, description: 'OTP sent' })
  @ApiResponse({ status: 404, description: 'NOT_REGISTERED — signin intent with an unknown email (no OTP sent)' })
  @ApiResponse({ status: 429, description: 'Too many requests' })
  async requestOtp(
    @Body() dto: RequestOtpDto,
    @Req() req: Request,
  ): Promise<{ success: true; message: string }> {
    const ip = req.ip ?? req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];
    return this.authService.requestOtp(dto.email, ip, userAgent, dto.intent ?? 'signin');
  }

  @Public()
  @Post('verify-otp')
  @HttpCode(HttpStatus.OK)
  // Throttle brute-force on the 6-digit code: 15 attempts / minute / IP
  // (the service also caps attempts per individual OTP).
  @Throttle({ short: { limit: 15, ttl: 60000 } })
  @ApiOperation({
    summary: 'Verify OTP',
    description: 'Verify the 6-digit OTP. Issues JWT cookies on success.',
  })
  @ApiResponse({ status: 200, description: 'Authentication successful' })
  @ApiResponse({ status: 401, description: 'Invalid or expired OTP' })
  async verifyOtp(
    @Body() dto: VerifyOtpDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ip = req.ip ?? req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];
    // Stable per-browser device id (httpOnly cookie, minted on first
    // contact) — the key for trusted-device 180-day sessions.
    const deviceId = this.authService.ensureDeviceId(req, res, dto.deviceId);

    const result = await this.authService.verifyOtp(
      dto.email,
      dto.code,
      deviceId,
      ip,
      userAgent,
      dto.consents,
      dto.regionCode,
    );

    if (
      !result.requiresTenantSelection &&
      result.accessToken &&
      result.refreshToken
    ) {
      this.authService.setAuthCookies(
        res,
        result.accessToken,
        result.refreshToken,
        (result as { refreshTtlMs?: number }).refreshTtlMs,
      );
    }

    return result;
  }

  // Round H — the magic-link flow is now two-step. GET only PEEKS (never
  // consumes) so mail-security link scanners that open the /verify page at
  // delivery time can no longer burn the single-use token; the web page then
  // POSTs /consume on an explicit button press, and /recover turns a burned or
  // expired link into a fresh sign-in code for the same address.
  @Public()
  @Get('magic-link')
  @HttpCode(HttpStatus.OK)
  @Throttle({ short: { limit: 30, ttl: 60000 } })
  @ApiOperation({
    summary: 'Peek at a magic link (non-consuming)',
    description:
      'Reports whether the token is ready, already consumed, expired or invalid — without consuming it.',
  })
  @ApiQuery({ name: 'token', required: true })
  @ApiResponse({ status: 200, description: 'Token status' })
  async peekMagicLink(@Query('token') token: string) {
    return this.authService.peekMagicLink(token);
  }

  @Public()
  @Post('magic-link/recover')
  @HttpCode(HttpStatus.OK)
  @Throttle({ short: { limit: 5, ttl: 60000 } })
  @ApiOperation({
    summary: 'Recover from a consumed/expired magic link',
    description:
      'Emails a fresh 6-digit sign-in code to the address the token was issued for and returns that address.',
  })
  @ApiResponse({ status: 200, description: 'Code sent' })
  @ApiResponse({ status: 401, description: 'Unknown token' })
  async recoverMagicLink(@Body() dto: MagicLinkVerifyDto, @Req() req: Request) {
    const ip = req.ip ?? req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];
    return this.authService.recoverMagicLink(dto.token, ip, userAgent);
  }

  @Public()
  @Post('magic-link/consume')
  @HttpCode(HttpStatus.OK)
  @Throttle({ short: { limit: 20, ttl: 60000 } })
  @ApiOperation({
    summary: 'Consume a magic link (sign in)',
    description: 'Single-use. Verifies the token from the email and issues JWT cookies.',
  })
  @ApiResponse({ status: 200, description: 'Magic link verified' })
  @ApiResponse({ status: 401, description: 'Invalid, expired or already-used token' })
  async consumeMagicLink(
    @Body() dto: MagicLinkVerifyDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ip = req.ip ?? req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];
    const deviceId = this.authService.ensureDeviceId(req, res, dto.deviceId);

    const result = await this.authService.verifyMagicLink(
      dto.token,
      deviceId,
      ip,
      userAgent,
    );

    if (
      !result.requiresTenantSelection &&
      result.accessToken &&
      result.refreshToken
    ) {
      this.authService.setAuthCookies(
        res,
        result.accessToken,
        result.refreshToken,
        (result as { refreshTtlMs?: number }).refreshTtlMs,
      );
    }

    return result;
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Refresh token',
    description: 'Rotate refresh token. Detects and prevents token reuse attacks.',
  })
  @ApiResponse({ status: 200, description: 'Tokens refreshed' })
  @ApiResponse({ status: 401, description: 'Invalid or expired refresh token' })
  async refresh(
    @Body() dto: RefreshTokenDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ip = req.ip ?? req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];
    const deviceId = this.authService.ensureDeviceId(req, res, dto.deviceId);

    // Support refresh token from cookie or body
    const refreshToken = req.cookies?.['refresh_token'] ?? dto.refreshToken;
    if (!refreshToken) {
      throw new UnauthorizedException('No refresh token');
    }

    const result = await this.authService.refreshToken(
      refreshToken,
      deviceId,
      ip,
      userAgent,
    );

    // Cookie lifetime must track the rotated token's actual TTL (7d, or
    // 180d for trusted-device chains).
    this.authService.setAuthCookies(
      res,
      result.accessToken,
      result.refreshToken,
      result.refreshTtlMs,
    );

    return result;
  }

  @Post('trust-device')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Stay signed in on this device for ~180 days',
    description:
      'Records the user\'s explicit trust for the current device and upgrades the ACTIVE session in place: the refresh token is marked trusted and its expiry extended, so future silent refreshes keep the long window. Later logins on this device auto-issue trusted sessions.',
  })
  async trustDevice(
    @CurrentUser() user: JwtPayload,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ip = req.ip ?? req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];
    const deviceId = this.authService.ensureDeviceId(req, res);
    const rawRefreshToken = req.cookies?.['refresh_token'] as
      | string
      | undefined;

    const result = await this.authService.trustDevice(
      user.sub,
      deviceId,
      rawRefreshToken,
      ip,
      userAgent,
    );

    // Same refresh token, longer life — re-set the cookie with the 180-day
    // maxAge so the browser keeps it as long as the DB row lives.
    if (rawRefreshToken) {
      this.authService.setRefreshCookie(res, rawRefreshToken, result.refreshTtlMs);
    }

    return { trusted: true, expiresAt: result.expiresAt };
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth('access-token')
  @ApiCookieAuth('access_token')
  @ApiOperation({ summary: 'Logout', description: 'Revoke current session.' })
  @ApiResponse({ status: 204, description: 'Logged out successfully' })
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const refreshToken = req.cookies?.['refresh_token'];
    if (refreshToken) {
      await this.authService.logout(refreshToken);
    }
    this.authService.clearAuthCookies(res);
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Logout all sessions',
    description: 'Revoke all refresh tokens for the current user.',
  })
  @ApiResponse({ status: 204, description: 'All sessions revoked' })
  async logoutAll(
    @CurrentUser() user: JwtPayload,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.authService.logoutAll(user.sub);
    this.authService.clearAuthCookies(res);
  }

  @Get('me')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Get current user', description: 'Returns current user info and memberships.' })
  @ApiResponse({ status: 200, description: 'Current user data' })
  async getMe(@CurrentUser() user: JwtPayload, @Req() req: Request) {
    const deviceId =
      (req.cookies?.['fs_device_id'] as string | undefined) ??
      (req.headers['x-device-id'] as string | undefined);
    const raw = await this.authService.getMe(user.sub, user.tenantId, deviceId);
    // §4 media pipeline — serialization-level swap: signed URL from *_key,
    // legacy *_url fallback; the raw keys never reach the client.
    const { avatarKey, ...rest } = raw as typeof raw & { avatarKey?: string | null };
    const me = {
      ...rest,
      // PRD v6 — effective runtime flags for this tenant (pm_sync_engine
      // kill-switch etc.); the web data-source facade reads this.
      effectiveFlags: user.tenantId ? await this.flagEval.effectiveFlags(user.tenantId) : [],
      // Round 8 — effective module access (CRM / Invoicing / Projects) so the
      // sidebar shows exactly what this member can open. Resolved by the same
      // service the guards use, so the nav can never disagree with the API.
      moduleAccess: user.tenantId
        ? await this.moduleAccess.moduleAccessMap(
            user.tenantId,
            user.membershipId,
            user.role,
            user.sub,
          )
        : { crm: 'none' as const, invoicing: 'none' as const, pm: 'none' as const },
      avatarUrl: await this.mediaService.servedUrl(avatarKey ?? null, raw.avatarUrl),
      currentMembership: raw.currentMembership
        ? {
            ...raw.currentMembership,
            tenantLogoUrl: await this.mediaService.servedUrl(
              (raw.currentMembership as { tenantLogoKey?: string | null }).tenantLogoKey ?? null,
              (raw.currentMembership as { tenantLogoUrl?: string | null }).tenantLogoUrl ?? null,
            ),
            tenantLogoKey: undefined,
          }
        : raw.currentMembership,
    };
    if (!user.impersonatorUserId) return me;

    // Surface impersonation session details so the banner can render a
    // real countdown + the impersonator's identity.
    const session = await this.authService.getActiveImpersonationSession(
      user.impersonatorUserId,
      user.sub,
    );
    return {
      ...me,
      impersonatorUserId: user.impersonatorUserId,
      impersonation: session,
    };
  }

  // ─── DPDP self-service ────────────────────────────────────────────────────

  @Get('me/export')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Export all of my personal data (DPDP right to access)' })
  async exportMyData(@CurrentUser() user: JwtPayload) {
    return this.authService.exportMyData(user.sub, user.tenantId);
  }

  @Get('me/delete-account')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Current pending account-deletion request, if any' })
  async getDeletionRequest(@CurrentUser() user: JwtPayload) {
    return { request: await this.authService.getDeletionRequest(user.sub) };
  }

  @Post('me/delete-account')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Request account deletion (DPDP right to erasure, 7-day cool-off)' })
  async requestAccountDeletion(
    @CurrentUser() user: JwtPayload,
    @Body() body: { reason?: string },
    @Req() req: Request,
  ) {
    return this.authService.requestAccountDeletion(user.sub, user.tenantId, body?.reason, {
      ip: req.ip ?? req.socket?.remoteAddress ?? undefined,
      userAgent: req.headers['user-agent'] ?? undefined,
    });
  }

  @Post('me/delete-account/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Cancel a pending account-deletion request' })
  async cancelAccountDeletion(@CurrentUser() user: JwtPayload) {
    return this.authService.cancelAccountDeletion(user.sub, user.tenantId);
  }

  @Post('select-tenant')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Switch active tenant',
    description: 'Issue a new JWT with the selected tenantId.',
  })
  @ApiResponse({ status: 200, description: 'Tenant selected, new tokens issued' })
  @ApiResponse({ status: 400, description: 'No active membership for this tenant' })
  async selectTenant(
    @Body() dto: SelectTenantDto,
    @CurrentUser() user: JwtPayload,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const deviceId = this.authService.ensureDeviceId(req, res);
    const result = await this.authService.selectTenant(user.sub, dto.tenantId, deviceId);
    this.authService.setAuthCookies(
      res,
      result.accessToken,
      result.refreshToken,
      result.refreshTtlMs,
    );
    return result;
  }

  @Post('switch-company')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Switch active company (Invoicing v3 alias of select-tenant)',
    description:
      'Re-verifies the membership server-side (revoked/expired access is rejected; ' +
      'pending invites are accepted on switch) and issues a JWT scoped to the chosen tenant.',
  })
  @ApiResponse({ status: 200, description: 'Switched, new tokens issued' })
  @ApiResponse({ status: 400, description: 'No membership for this tenant' })
  @ApiResponse({ status: 403, description: 'Membership revoked or access window expired' })
  async switchCompany(
    @Body() dto: SelectTenantDto,
    @CurrentUser() user: JwtPayload,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const deviceId = this.authService.ensureDeviceId(req, res);
    const result = await this.authService.selectTenant(user.sub, dto.tenantId, deviceId);
    this.authService.setAuthCookies(
      res,
      result.accessToken,
      result.refreshToken,
      result.refreshTtlMs,
    );
    return result;
  }

  @Get('sessions')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'List active sessions' })
  @ApiResponse({ status: 200, description: 'List of active sessions' })
  async getSessions(@CurrentUser() user: JwtPayload) {
    return this.authService.getSessions(user.sub);
  }

  @Delete('sessions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Revoke a session' })
  @ApiResponse({ status: 204, description: 'Session revoked' })
  async revokeSession(
    @Param('id') sessionId: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<void> {
    await this.authService.revokeSession(sessionId, user.sub);
  }
}
