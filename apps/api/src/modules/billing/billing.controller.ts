import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsString, MaxLength } from 'class-validator';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import { Roles } from '../../core/auth/decorators/roles.decorator';
import { BillingExempt } from '../../core/auth/decorators/billing-exempt.decorator';
import type { JwtPayload } from '@flicks/shared/types';
import { BillingService } from './billing.service';

class RedeemCouponDto {
  @IsString()
  @MaxLength(40)
  code!: string;
}

/**
 * Platform billing (PRD v4 §8B, D18–D20). The whole controller is
 * @BillingExempt — a locked workspace must always reach its own paywall.
 * Reads are open to every member (read-only banner for non-owners); the
 * mutations are Owner/Admin (server-enforced, D19 single self-subscribe wall).
 */
@ApiTags('Billing')
@ApiBearerAuth('access-token')
@BillingExempt()
@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get()
  @ApiOperation({ summary: 'Plan, seats, trial/grace state, coupon, history (D18)' })
  state(@CurrentUser() user: JwtPayload) {
    return this.billing.state(user.tenantId);
  }

  @Post('subscribe')
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Create the Razorpay subscription → authorization_url (D20)' })
  subscribe(@CurrentUser() user: JwtPayload) {
    return this.billing.subscribe(user.tenantId, user.sub);
  }

  @Post('coupon/redeem')
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  @Throttle({ long: { ttl: 60_000, limit: 5 } })
  @ApiOperation({ summary: 'Redeem a FAM coupon — extends the trial N months (D18)' })
  redeem(@Body() dto: RedeemCouponDto, @CurrentUser() user: JwtPayload) {
    return this.billing.redeemCoupon(user.tenantId, user.sub, dto.code);
  }

  @Post('cancel')
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Schedule cancellation at the period end' })
  cancel(@CurrentUser() user: JwtPayload) {
    return this.billing.cancel(user.tenantId, user.sub);
  }

  @Post('resume')
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revert a scheduled cancellation' })
  resume(@CurrentUser() user: JwtPayload) {
    return this.billing.resume(user.tenantId, user.sub);
  }
}
