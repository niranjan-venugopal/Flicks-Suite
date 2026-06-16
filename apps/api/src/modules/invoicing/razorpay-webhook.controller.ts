import {
  Controller,
  Post,
  Body,
  Headers,
  Inject,
  Logger,
  HttpCode,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { eq } from 'drizzle-orm';
import { razorpayWebhookEvents } from '@flicks/db/schema';
import type { DbAdmin } from '@flicks/db';
import { DB_SERVICE_ROLE } from '../../core/database/database.module';
import { Public } from '../../core/auth/decorators/public.decorator';
import { InvoicesService } from './invoices.service';

interface RazorpayEvent {
  event?: string;
  payload?: {
    payment?: {
      entity?: {
        id?: string;
        amount?: number; // paise
        method?: string;
        notes?: Record<string, string>;
      };
    };
  };
  id?: string;
  created_at?: number;
}

/**
 * Razorpay webhook (PRD §6.6) — stubbed integration, real plumbing:
 *  • idempotency via razorpay_webhook_events.event_id (unique);
 *  • HMAC-SHA256 signature verification when RAZORPAY_WEBHOOK_SECRET is set
 *    (without a key the event is stored with signature_verified=false and
 *    payment.captured is NOT applied — safe no-op until keys exist);
 *  • payment.captured with notes.invoice_id + notes.tenant_id → records the
 *    payment through the same service path as manual payments.
 * Runs on the service-role connection (no tenant context on inbound webhooks).
 */
@ApiTags('Webhooks')
@Controller('webhooks')
@SkipThrottle() // Razorpay can burst events; idempotency + signature gate it instead
export class RazorpayWebhookController {
  private readonly logger = new Logger(RazorpayWebhookController.name);

  constructor(
    @Inject(DB_SERVICE_ROLE) private readonly dbAdmin: DbAdmin,
    private readonly config: ConfigService,
    private readonly invoices: InvoicesService,
  ) {}

  @Post('razorpay')
  @Public()
  @HttpCode(200)
  @ApiOperation({ summary: 'Razorpay events (signature-verified, idempotent)' })
  async razorpay(
    @Body() body: RazorpayEvent,
    @Headers('x-razorpay-signature') signature?: string,
    @Headers('x-razorpay-event-id') headerEventId?: string,
  ) {
    const eventId = headerEventId ?? body.id ?? `evt_${crypto.randomUUID()}`;
    const eventType = body.event ?? 'unknown';

    // Verify signature when a secret is configured. NOTE: production-grade
    // verification must use the raw request body; this stub signs the parsed
    // JSON, which is replaced when live Razorpay keys are wired in.
    const secret = this.config.get<string>('RAZORPAY_WEBHOOK_SECRET');
    let verified = false;
    if (secret && signature) {
      const expected = crypto
        .createHmac('sha256', secret)
        .update(JSON.stringify(body))
        .digest('hex');
      verified =
        expected.length === signature.length &&
        crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
    }

    const notes = body.payload?.payment?.entity?.notes ?? {};
    const tenantId = notes['tenant_id'];

    // Idempotent store — a duplicate event_id is acknowledged and skipped.
    const inserted = await this.dbAdmin
      .insert(razorpayWebhookEvents)
      .values({
        tenant_id: tenantId || null,
        event_id: eventId,
        event_type: eventType,
        payload: body as Record<string, unknown>,
        signature,
        signature_verified: verified,
        processed: false,
      })
      .onConflictDoNothing({ target: razorpayWebhookEvents.event_id })
      .returning({ id: razorpayWebhookEvents.id });
    if (!inserted[0]) {
      this.logger.log(`Duplicate Razorpay event ${eventId} — skipped`);
      return { data: { received: true, duplicate: true } };
    }

    // Apply payment.captured only when verified (i.e. live keys configured).
    let processingError: string | undefined;
    if (eventType === 'payment.captured' && verified) {
      try {
        const entity = body.payload?.payment?.entity;
        const invoiceId = notes['invoice_id'];
        if (!invoiceId || !tenantId || !entity?.amount) {
          throw new Error('payment.captured missing notes.invoice_id / notes.tenant_id / amount');
        }
        await this.invoices.recordPayment(
          invoiceId,
          {
            amount: (entity.amount / 100).toFixed(2), // paise → rupees
            payment_method:
              entity.method === 'upi' ? 'RAZORPAY_UPI'
              : entity.method === 'card' ? 'RAZORPAY_CARD'
              : entity.method === 'netbanking' ? 'RAZORPAY_NETBANKING'
              : entity.method === 'wallet' ? 'RAZORPAY_WALLET'
              : 'OTHER',
            razorpay_payment_id: entity.id,
          },
          null,
          tenantId,
          'automatic_webhook',
        );
      } catch (err) {
        processingError = err instanceof Error ? err.message : 'unknown error';
        this.logger.error(`Razorpay ${eventId} processing failed: ${processingError}`);
      }
    }

    await this.dbAdmin
      .update(razorpayWebhookEvents)
      .set({
        processed: !processingError,
        processed_at: new Date(),
        processing_error: processingError,
      })
      .where(eq(razorpayWebhookEvents.id, inserted[0].id));

    return { data: { received: true, verified } };
  }
}
