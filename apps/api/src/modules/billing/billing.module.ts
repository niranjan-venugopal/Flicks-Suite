import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { BillingController } from './billing.controller';
import { PlatformWebhookController } from './platform-webhook.controller';
import { BillingService } from './billing.service';
import { BillingJobs } from './billing.jobs';
import { RazorpayPlatformService } from './razorpay-platform.service';

/**
 * Platform billing (PRD v4 §8B, Sprint 21): ₹499/seat/month on Specflicks'
 * own Razorpay merchant, 7-day trial, FAM coupons, paywall. The BillingGuard
 * + BillingStateService live in core/ (guard chain); this module owns the
 * API surface, Razorpay client, webhook, and crons.
 */
@Module({
  imports: [AuditModule, NotificationsModule],
  controllers: [BillingController, PlatformWebhookController],
  providers: [BillingService, BillingJobs, RazorpayPlatformService],
  exports: [BillingService],
})
export class BillingModule {}
