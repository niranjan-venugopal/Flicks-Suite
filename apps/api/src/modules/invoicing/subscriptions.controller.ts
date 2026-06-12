import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { SubscriptionsService } from './subscriptions.service';
import {
  CreateSubscriptionDto,
  UpdateSeatsDto,
  CancelSubscriptionDto,
} from './dto/invoicing.dto';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import { RequireGrant } from '../../core/auth/decorators/require-grant.decorator';
import { InvoicingGrantGuard } from '../../core/auth/guards/invoicing-grant.guard';
import type { JwtPayload } from '@flicks/shared/types';

@ApiTags('Invoicing — Subscriptions')
@ApiBearerAuth('access-token')
@UseGuards(InvoicingGrantGuard)
@Controller('subscriptions')
export class SubscriptionsController {
  constructor(private readonly subs: SubscriptionsService) {}

  @Get()
  @RequireGrant('invoicing', 'view')
  @ApiOperation({ summary: 'List subscription profiles (+ normalised MRR)' })
  list(@CurrentUser() user: JwtPayload) {
    return this.subs.list(user.tenantId);
  }

  @Get(':id')
  @RequireGrant('invoicing', 'view')
  @ApiOperation({ summary: 'Get a subscription (+ its invoices and prorations)' })
  get(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.subs.get(user.tenantId, id);
  }

  @Post()
  @RequireGrant('invoicing', 'edit')
  @ApiOperation({ summary: 'Create a subscription (flat-rate | per-seat; currency locked)' })
  create(@Body() dto: CreateSubscriptionDto, @CurrentUser() user: JwtPayload) {
    return this.subs.create(dto, user.sub, user.tenantId);
  }

  @Get(':id/mandate-link')
  @RequireGrant('invoicing', 'view')
  @ApiOperation({ summary: 'Razorpay mandate link (stub until live keys)' })
  mandateLink(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.subs.mandateLink(id, user.tenantId);
  }

  @Post(':id/activate')
  @RequireGrant('invoicing', 'edit')
  @ApiOperation({ summary: 'Simulate mandate authorization (dev stub) → ACTIVE/TRIALING' })
  activate(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.subs.activate(id, user.sub, user.tenantId);
  }

  @Post(':id/update-seats')
  @RequireGrant('invoicing', 'edit')
  @ApiOperation({ summary: 'Mid-cycle seat change → proration on the next invoice' })
  updateSeats(
    @Param('id') id: string,
    @Body() dto: UpdateSeatsDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.subs.updateSeats(id, dto, user.sub, user.tenantId);
  }

  @Post(':id/pause')
  @RequireGrant('invoicing', 'edit')
  @ApiOperation({ summary: 'Pause the subscription' })
  pause(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.subs.pause(id, user.sub, user.tenantId);
  }

  @Post(':id/resume')
  @RequireGrant('invoicing', 'edit')
  @ApiOperation({ summary: 'Resume a paused subscription' })
  resume(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.subs.resume(id, user.sub, user.tenantId);
  }

  @Post(':id/cancel')
  @RequireGrant('invoicing', 'edit')
  @ApiOperation({ summary: 'Cancel the subscription' })
  cancel(
    @Param('id') id: string,
    @Body() dto: CancelSubscriptionDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.subs.cancel(id, dto.reason, user.sub, user.tenantId);
  }
}
