import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../core/auth/decorators/public.decorator';
import { SubscriptionMandatesService } from './subscription-mandates.service';

/**
 * Public mandate authorization page data (PRD v4 §8A, D14c) — the customer-
 * facing /sub/<token> page. Mirrors the public-invoice pattern exactly:
 * @Public + medium throttle, service-role reads, 404 unknown / 410 expired.
 */
@ApiTags('Public — Mandate')
@Controller('public/sub')
export class PublicMandateController {
  constructor(private readonly mandates: SubscriptionMandatesService) {}

  @Get(':token')
  @Public()
  @Throttle({ medium: { ttl: 10000, limit: 20 } })
  @ApiOperation({ summary: 'Customer-facing mandate summary + Razorpay authorize URL' })
  view(@Param('token') token: string) {
    return this.mandates.publicView(token);
  }
}
