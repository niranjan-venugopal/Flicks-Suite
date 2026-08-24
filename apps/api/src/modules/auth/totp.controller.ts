import {
  Controller,
  Post,
  Body,
  Req,
  Res,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { TotpCodeDto, TotpEnrollDto, TotpVerifyDto } from './auth.dto';
import { Public } from '../../core/auth/decorators/public.decorator';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import type { JwtPayload } from '@flicks/shared/types';

@ApiTags('Auth')
@Controller('auth/totp')
export class TotpController {
  constructor(private readonly authService: AuthService) {}

  @Post('enroll')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Begin FAM TOTP enrolment',
    description:
      'Generates a TOTP secret + otpauth URL for the signed-in platform admin. Authenticated; confirm with /auth/totp/confirm.',
  })
  async enroll(@Body() dto: TotpEnrollDto, @CurrentUser() user: JwtPayload) {
    return this.authService.enrollTotp(user.sub, { regenerate: dto?.regenerate });
  }

  @Post('confirm')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Confirm FAM TOTP enrolment with the first code' })
  async confirm(
    @Body() dto: TotpCodeDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.authService.confirmTotpEnrollment(user.sub, dto.code);
  }

  @Public()
  @Post('verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Complete a FAM login challenge with a TOTP code',
    description:
      'Exchanges the short-lived challenge token (from verify-otp / magic-link) + a TOTP code for a session. Sets auth cookies.',
  })
  async verify(
    @Body() dto: TotpVerifyDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ip = req.ip ?? req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];
    const deviceId = this.authService.ensureDeviceId(req, res, dto.deviceId);

    const result = await this.authService.completeTotpChallenge(
      dto.challengeToken,
      dto.code,
      deviceId,
      ip,
      userAgent,
    );

    if (result.accessToken && result.refreshToken) {
      this.authService.setAuthCookies(
        res,
        result.accessToken,
        result.refreshToken,
        (result as { refreshTtlMs?: number }).refreshTtlMs,
      );
    }
    return result;
  }
}
