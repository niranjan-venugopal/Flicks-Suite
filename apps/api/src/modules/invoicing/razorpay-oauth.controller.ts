import { Controller, Get, Query, Res, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Public } from '../../core/auth/decorators/public.decorator';
import { InvSettingsService } from './inv-settings.service';

/**
 * Razorpay OAuth callback (PRD §6.6, Sprint 15). Razorpay redirects the seller's
 * browser here after they authorize — there is no tenant JWT, so this route is
 * @Public() and lives outside the InvoicingGrantGuard. The tenant is resolved
 * from the opaque `state` minted at connect time; on success/failure we 302 back
 * to the web settings page.
 */
@ApiTags('Invoicing — Razorpay OAuth')
@Controller('invoicing/razorpay')
export class RazorpayOAuthController {
  private readonly logger = new Logger(RazorpayOAuthController.name);

  constructor(
    private readonly settings: InvSettingsService,
    private readonly config: ConfigService,
  ) {}

  @Get('callback')
  @Public()
  @ApiOperation({ summary: 'OAuth redirect target — exchanges code, stores tokens' })
  async callback(
    @Res() res: Response,
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error') error?: string,
  ) {
    const webBase = this.config.get<string>('APP_URL') ?? 'http://localhost:3000';
    const dest = (status: string) =>
      `${webBase}/invoicing/settings?tab=Payments&razorpay=${status}`;
    if (error || !code || !state) {
      return res.redirect(dest('error'));
    }
    try {
      await this.settings.razorpayCallback(code, state);
      return res.redirect(dest('connected'));
    } catch (err) {
      this.logger.error(
        `Razorpay OAuth callback failed: ${
          err instanceof Error ? err.message : 'unknown'
        }`,
      );
      return res.redirect(dest('error'));
    }
  }
}
