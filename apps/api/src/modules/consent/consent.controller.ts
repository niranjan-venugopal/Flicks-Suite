import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../core/auth/decorators/public.decorator';
import { Roles } from '../../core/auth/decorators/roles.decorator';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import { BillingExempt } from '../../core/auth/decorators/billing-exempt.decorator';
import type { JwtPayload } from '@flicks/shared/types';
import { ConsentService } from './consent.service';
import { DataExportService } from './data-export.service';
import { BannerSyncDto, RecordConsentsDto } from './consent.dto';

/**
 * Trust & legal surfaces (PRD v4 §3): the consent ledger, the signed-out
 * unsubscribe endpoint, and self-service data exports.
 */
@ApiTags('Consent & privacy')
@BillingExempt()
@Controller()
export class ConsentController {
  constructor(
    private readonly consent: ConsentService,
    private readonly exports: DataExportService,
  ) {}

  @Post('consents')
  @ApiBearerAuth('access-token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Record consent decisions (append-only ledger)' })
  async record(
    @Body() dto: RecordConsentsDto,
    @CurrentUser() user: JwtPayload,
    @Req() req: Request,
  ) {
    await this.consent.record(user.sub, dto.consents, {
      tenantId: user.tenantId ?? null,
      source: 'settings',
      regionCode: dto.region_code,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    return { data: { recorded: dto.consents.length, ...this.consent.meta() } };
  }

  @Post('consents/banner-sync')
  @ApiBearerAuth('access-token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Ledger the pre-login banner choice once per state change',
  })
  async bannerSync(
    @Body() dto: BannerSyncDto,
    @CurrentUser() user: JwtPayload,
    @Req() req: Request,
  ) {
    const res = await this.consent.syncBannerChoice(user.sub, dto.analytics, {
      tenantId: user.tenantId ?? null,
      regionCode: dto.region_code,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    return { data: res };
  }

  @Get('me/consents')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Latest consent state + policy versions' })
  async myConsents(@CurrentUser() user: JwtPayload) {
    const latest = await this.consent.latest(user.sub);
    const requires_reacceptance = await this.consent.requiresReacceptance(
      user.sub,
    );
    return { data: { latest, requires_reacceptance, ...this.consent.meta() } };
  }

  // One-click unsubscribe — works signed-out (link lives in marketing emails).
  @Get('unsubscribe')
  @Public()
  @Throttle({ medium: { ttl: 10000, limit: 20 } })
  @ApiOperation({ summary: 'One-click marketing unsubscribe (signed token)' })
  async unsubscribe(
    @Query('token') token: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const { email } = await this.consent.unsubscribe(
      token ?? '',
      req.ip,
      req.headers['user-agent'],
    );
    res
      .status(200)
      .type('html')
      .send(
        `<!doctype html><meta charset="utf-8"><title>Unsubscribed</title>
         <body style="font-family:sans-serif;max-width:520px;margin:80px auto;text-align:center">
         <h2>You're unsubscribed</h2>
         <p>${email} will no longer receive product updates or offers from Flicks Suite.
         Transactional emails (invoices, approvals, security) continue as required for your account.</p>
         </body>`,
      );
  }

  // ─── Data exports (§3.5) ───────────────────────────────────────────────────

  @Post('me/data-export')
  @ApiBearerAuth('access-token')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Personal data export → emailed 7-day link (1/day)' })
  myExport(@CurrentUser() user: JwtPayload) {
    return this.exports.requestMyExport(user.sub, user.tenantId);
  }

  @Post('org/data-export')
  @Roles('owner', 'admin')
  @ApiBearerAuth('access-token')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Organization data export (CSV+JSON, RLS-scoped) → emailed link',
  })
  orgExport(@CurrentUser() user: JwtPayload) {
    return this.exports.requestOrgExport(user.sub, user.tenantId);
  }
}
