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
import {
  RequestOtpDto,
  VerifyOtpDto,
  RefreshTokenDto,
  SelectTenantDto,
  LogoutDto,
} from './auth.dto';
import { Public } from '../../core/auth/decorators/public.decorator';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../core/auth/guards/jwt-auth.guard';
import type { JwtPayload } from '@flicks/shared/types';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('request-otp')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 3600000 } })
  @ApiOperation({
    summary: 'Request OTP',
    description:
      'Send a 6-digit OTP and magic link to the given email. Rate limited to 5/hour per email.',
  })
  @ApiResponse({ status: 200, description: 'OTP sent (generic success)' })
  @ApiResponse({ status: 429, description: 'Too many requests' })
  async requestOtp(
    @Body() dto: RequestOtpDto,
    @Req() req: Request,
  ): Promise<{ success: true; message: string }> {
    const ip = req.ip ?? req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];
    return this.authService.requestOtp(dto.email, ip, userAgent);
  }

  @Public()
  @Post('verify-otp')
  @HttpCode(HttpStatus.OK)
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
    const deviceId =
      (req.headers['x-device-id'] as string | undefined) ?? dto.deviceId;

    const result = await this.authService.verifyOtp(
      dto.email,
      dto.code,
      deviceId,
      ip,
      userAgent,
    );

    if (
      !result.requiresTenantSelection &&
      result.accessToken &&
      result.refreshToken
    ) {
      this.authService.setAuthCookies(res, result.accessToken, result.refreshToken);
    }

    return result;
  }

  @Public()
  @Get('magic-link')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Verify magic link',
    description: 'Verify the magic link token from email.',
  })
  @ApiQuery({ name: 'token', required: true })
  @ApiResponse({ status: 200, description: 'Magic link verified' })
  @ApiResponse({ status: 401, description: 'Invalid or expired token' })
  async verifyMagicLink(
    @Query('token') token: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ip = req.ip ?? req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];
    const deviceId = req.headers['x-device-id'] as string | undefined;

    const result = await this.authService.verifyMagicLink(
      token,
      deviceId,
      ip,
      userAgent,
    );

    if (
      !result.requiresTenantSelection &&
      result.accessToken &&
      result.refreshToken
    ) {
      this.authService.setAuthCookies(res, result.accessToken, result.refreshToken);
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
    const deviceId =
      (req.headers['x-device-id'] as string | undefined) ?? dto.deviceId;

    // Support refresh token from cookie or body
    const refreshToken = req.cookies?.['refresh_token'] ?? dto.refreshToken;

    const result = await this.authService.refreshToken(
      refreshToken,
      deviceId,
      ip,
      userAgent,
    );

    this.authService.setAuthCookies(res, result.accessToken, result.refreshToken);

    return result;
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
  async getMe(@CurrentUser() user: JwtPayload) {
    const me = await this.authService.getMe(user.sub, user.tenantId);
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
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.selectTenant(user.sub, dto.tenantId);
    this.authService.setAuthCookies(res, result.accessToken, result.refreshToken);
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
