import * as crypto from 'crypto';
import {
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Post,
  Req,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { eq } from 'drizzle-orm';
import { razorpayWebhookEvents } from '@flicks/db/schema';
import type { DbAdmin } from '@flicks/db';
import { DB_SERVICE_ROLE } from '../../core/database/database.module';
import { Public } from '../../core/auth/decorators/public.decorator';
import { BillingService } from './billing.service';

/**
 * Razorpay PLATFORM webhook (PRD v4 §8B.6) — Specflicks' own merchant account,
 * subscription.* lifecycle for tenant seat billing. Mirrors the tenant-track
 * webhook exactly: raw-body HMAC over RAZORPAY_PLATFORM_WEBHOOK_SECRET,
 * event-id idempotency (shared razorpay_webhook_events table, source =
 * 'platform'), always 200 so Razorpay doesn't retry storms.
 */
@ApiTags('Webhooks')
@SkipThrottle()
@Controller('webhooks')
export class PlatformWebhookController {
  private readonly logger = new Logger(PlatformWebhookController.name);

  constructor(
    @Inject(DB_SERVICE_ROLE) private readonly dbAdmin: DbAdmin,
    private readonly config: ConfigService,
    private readonly billing: BillingService,
  ) {}

  @Post('razorpay-platform')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Razorpay platform-billing webhook (subscription.*)' })
  async handle(@Req() req: Request & { rawBody?: Buffer }) {
    const secret = this.config.get<string>('RAZORPAY_PLATFORM_WEBHOOK_SECRET') ?? '';
    const raw = req.rawBody;
    const signature = (req.headers['x-razorpay-signature'] as string | undefined) ?? '';
    // Namespaced so tenant-track deliveries (a DIFFERENT Razorpay account,
    // same shared table with a global UNIQUE event_id) can never collide with
    // or pre-claim a platform event id.
    const eventId =
      'platform:' +
      ((req.headers['x-razorpay-event-id'] as string | undefined) ??
        crypto.createHash('sha256').update(raw ?? Buffer.alloc(0)).digest('hex'));

    const verified = this.verify(raw, signature, secret);
    const body = (req.body ?? {}) as { event?: string; payload?: unknown };
    const eventType = body.event ?? 'unknown';

    // Unverified deliveries must NOT consume the idempotency key: a delivery
    // that arrives while the secret is blank/mistyped would otherwise mark
    // the event id "seen" forever and Razorpay's retry (after the secret is
    // fixed) would be dropped as a duplicate — permanently losing e.g. a
    // subscription.activated. Log and 200 without recording.
    if (!verified) {
      this.logger.warn(`platform webhook signature FAILED for ${eventType} — not recorded`);
      return { received: true };
    }

    // Idempotency: one row per (namespaced) Razorpay event id.
    const inserted = await this.dbAdmin
      .insert(razorpayWebhookEvents)
      .values({
        event_id: eventId,
        event_type: eventType,
        source: 'platform',
        payload: body as never,
        signature,
        signature_verified: true,
      })
      .onConflictDoNothing({ target: razorpayWebhookEvents.event_id })
      .returning({ id: razorpayWebhookEvents.id });
    if (!inserted[0]) {
      return { received: true, duplicate: true };
    }

    try {
      await this.billing.applyWebhook(eventType, body as Record<string, unknown>);
      await this.dbAdmin
        .update(razorpayWebhookEvents)
        .set({ processed: true, processed_at: new Date() })
        .where(eq(razorpayWebhookEvents.id, inserted[0].id));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      this.logger.error(`platform webhook ${eventType} failed: ${msg}`);
      await this.dbAdmin
        .update(razorpayWebhookEvents)
        .set({ processed: false, processed_at: new Date(), processing_error: msg })
        .where(eq(razorpayWebhookEvents.id, inserted[0].id));
    }
    return { received: true };
  }

  private verify(raw: Buffer | undefined, signature: string, secret: string): boolean {
    if (!raw || !signature || !secret) return false;
    const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
    try {
      return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
    } catch {
      return false;
    }
  }
}
