import { Controller, Get, Post, Param } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../core/auth/decorators/public.decorator';
import { PublicInvoiceService } from './public-invoice.service';

/**
 * Public hosted-invoice endpoints (PRD §9.3) — no auth; the signed token
 * scopes to exactly one invoice and cannot enumerate others. Tighter throttle
 * than authenticated routes since these are internet-facing.
 */
@ApiTags('Public — Hosted invoice')
@Controller('public/inv')
export class PublicInvoiceController {
  constructor(private readonly publicInvoices: PublicInvoiceService) {}

  @Get(':token')
  @Public()
  @Throttle({ medium: { ttl: 10000, limit: 20 } })
  @ApiOperation({ summary: 'Customer view: invoice + payment options' })
  get(@Param('token') token: string) {
    return this.publicInvoices.getByToken(token);
  }

  @Post(':token/track')
  @Public()
  @Throttle({ medium: { ttl: 10000, limit: 20 } })
  @ApiOperation({ summary: 'View-tracking pixel (SENT → VIEWED)' })
  track(@Param('token') token: string) {
    return this.publicInvoices.trackView(token);
  }
}
