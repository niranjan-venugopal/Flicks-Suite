import {
  Controller,
  Optional,
  Post,
  Body,
  Headers,
  Inject,
  Logger,
  HttpCode,
  Req,
  RawBodyRequest,
} from '@nestjs/common';
import type { Request } from 'express';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SkipThrottle } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { eq } from 'drizzle-orm';
import {
  razorpayWebhookEvents,
  razorpayOrders,
  invoicingSettings,
} from '@flicks/db/schema';
import type { DbAdmin } from '@flicks/db';
import { DB_SERVICE_ROLE } from '../../core/database/database.module';
import { Public } from '../../core/auth/decorators/public.decorator';
import { InvoicesService } from './invoices.service';

interface RazorpayEntity {
  id?: string;
  amount?: number; // paise
  method?: string;
  order_id?: string;
  notes?: Record<string, string>;
}

interface RazorpayEvent {
  event?: string;
  payload?: {
    payment?: { entity?: RazorpayEntity };
    order?: { entity?: RazorpayEntity };
  };
  id?: string;
  created_at?: number;
}

/**
 * Razorpay webhook (PRD §6.6). Live integration (Sprint 15):
 *  • idempotency via razorpay_webhook_events.event_id (unique);
 *  • HMAC-SHA256 over the RAW request body (req.rawBody) against the
 *    partner-level RAZORPAY_WEBHOOK_SECRET — re-serialized JSON would not match
 *    Razorpay's signature;
 *  • routes the event to its tenant via the X-Razorpay-Account-Id header
 *    (→ invoicing_settings.razorpay_account_id), and to its invoice via the
 *    razorpay_orders mapping (entity.order_id), then records the payment through
 *    the same service path as a manual payment — only when the signature verifies.
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
    // Optional: spec fixtures construct with 3 args; runtime DI provides it.
    @Optional() private readonly events?: EventEmitter2,
  ) {}

  @Post('razorpay')
  @Public()
  @HttpCode(200)
  @ApiOperation({ summary: 'Razorpay events (signature-verified, idempotent)' })
  async razorpay(
    @Req() req: RawBodyRequest<Request>,
    @Body() body: RazorpayEvent,
    @Headers('x-razorpay-signature') signature?: string,
    @Headers('x-razorpay-event-id') headerEventId?: string,
    @Headers('x-razorpay-account-id') accountId?: string,
  ) {
    const eventId = headerEventId ?? body.id ?? `evt_${crypto.randomUUID()}`;
    const eventType = body.event ?? 'unknown';

    // Verify the HMAC over the EXACT bytes Razorpay signed (req.rawBody), not a
    // re-serialized parse. No secret/signature/raw-body ⇒ unverified (and a
    // payment is never applied).
    const secret = this.config.get<string>('RAZORPAY_WEBHOOK_SECRET');
    const verified = this.verify(req.rawBody, signature, secret);

    const paymentEntity = body.payload?.payment?.entity;
    const orderEntity = body.payload?.order?.entity;
    const notes = paymentEntity?.notes ?? orderEntity?.notes ?? {};

    // Resolve the tenant: prefer the connected-account header (authentic once
    // the signature verifies), fall back to notes.tenant_id.
    let tenantId = await this.tenantForAccount(accountId);
    if (!tenantId) tenantId = notes['tenant_id'] || null;

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

    // Apply payment.captured only when verified.
    let processingError: string | undefined;
    if (eventType === 'payment.captured' && verified) {
      try {
        await this.applyCapture(paymentEntity, notes, tenantId);
      } catch (err) {
        processingError = err instanceof Error ? err.message : 'unknown error';
        this.logger.error(
          `Razorpay ${eventId} processing failed: ${processingError}`,
        );
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

  /** Constant-time HMAC-SHA256 check over the raw request bytes. */
  private verify(
    raw: Buffer | undefined,
    signature: string | undefined,
    secret: string | undefined,
  ): boolean {
    if (!secret || !signature || !raw) return false;
    const expected = crypto
      .createHmac('sha256', secret)
      .update(raw)
      .digest('hex');
    return (
      expected.length === signature.length &&
      crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
    );
  }

  /** Map a connected-account id (acc_…) to its tenant via settings. */
  private async tenantForAccount(
    accountId: string | undefined,
  ): Promise<string | null> {
    if (!accountId) return null;
    const [row] = await this.dbAdmin
      .select({ tenant_id: invoicingSettings.tenant_id })
      .from(invoicingSettings)
      .where(eq(invoicingSettings.razorpay_account_id, accountId))
      .limit(1);
    return row?.tenant_id ?? null;
  }

  private async applyCapture(
    entity: RazorpayEntity | undefined,
    notes: Record<string, string>,
    tenantFromAccount: string | null,
  ) {
    const orderId = entity?.order_id;
    let invoiceId = notes['invoice_id'] || null;
    let tenantId = tenantFromAccount;

    // The razorpay_orders mapping is the reliable order→invoice/tenant link
    // (order notes are not echoed onto the payment entity).
    if (orderId) {
      const [ord] = await this.dbAdmin
        .select({
          invoice_id: razorpayOrders.invoice_id,
          tenant_id: razorpayOrders.tenant_id,
        })
        .from(razorpayOrders)
        .where(eq(razorpayOrders.order_id, orderId))
        .limit(1);
      if (ord) {
        invoiceId = ord.invoice_id;
        tenantId = ord.tenant_id;
      }
    }

    if (!invoiceId || !tenantId || !entity?.amount) {
      throw new Error(
        'payment.captured could not resolve invoice/tenant/amount (order mapping + notes both missing)',
      );
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
        razorpay_order_id: orderId,
      },
      null,
      tenantId,
      'automatic_webhook',
    );

    if (orderId) {
      await this.dbAdmin
        .update(razorpayOrders)
        .set({ status: 'paid' })
        .where(eq(razorpayOrders.order_id, orderId));
    }

    // PRD v4 §6 F5 — webhook-recorded payments count toward the funnel too.
    this.events?.emit('analytics.track', {
      event: 'payment_received',
      tenantId,
      markFirst: true,
      source: 'api',
      properties: { method: entity.method ?? 'razorpay' },
    });
  }
}
