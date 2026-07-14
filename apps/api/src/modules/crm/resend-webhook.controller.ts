import { Controller, Headers, HttpCode, HttpStatus, Logger, Post, RawBodyRequest, Req, UnauthorizedException } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import type { Request } from 'express';
import { Public } from '../../core/auth/decorators/public.decorator';
import { CrmEmailService } from './email.service';

/**
 * Resend webhook (PRD v5 §7.1) — delivery lifecycle + the BCC dropbox.
 * Mirrors the Razorpay controller's posture: verify a signature over the RAW
 * request bytes, be idempotent (svix message id ledger), always 200 known
 * events so the provider doesn't retry-storm us.
 *
 * Resend signs with the svix scheme: HMAC-SHA256 over
 * `${svix-id}.${svix-timestamp}.${rawBody}` keyed by the base64 secret after
 * `whsec_`; the `svix-signature` header holds space-separated `v1,<base64>`
 * candidates. Implemented directly on node crypto — no extra dependency.
 */
@ApiExcludeController()
@Controller('webhooks/resend')
export class ResendWebhookController {
  private readonly logger = new Logger(ResendWebhookController.name);

  constructor(
    private readonly email: CrmEmailService,
    private readonly config: ConfigService,
  ) {}

  @Post()
  @Public()
  @HttpCode(HttpStatus.OK)
  async handle(
    @Req() req: RawBodyRequest<Request>,
    @Headers('svix-id') svixId?: string,
    @Headers('svix-timestamp') svixTimestamp?: string,
    @Headers('svix-signature') svixSignature?: string,
  ) {
    const secret = this.config.get<string>('RESEND_WEBHOOK_SECRET');
    const raw = req.rawBody;
    if (secret) {
      if (!svixId || !svixTimestamp || !svixSignature || !raw) {
        throw new UnauthorizedException('Missing webhook signature');
      }
      // Reject stale timestamps (svix tolerance: 5 minutes).
      const ts = Number(svixTimestamp);
      if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) {
        throw new UnauthorizedException('Webhook timestamp out of tolerance');
      }
      const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
      const expected = createHmac('sha256', key).update(`${svixId}.${svixTimestamp}.${raw.toString('utf8')}`).digest();
      const ok = svixSignature.split(/\s+/).some((part) => {
        const sig = part.split(',')[1];
        if (!sig) return false;
        try {
          const candidate = Buffer.from(sig, 'base64');
          return candidate.length === expected.length && timingSafeEqual(candidate, expected);
        } catch {
          return false;
        }
      });
      if (!ok) throw new UnauthorizedException('Invalid webhook signature');
    } else if (process.env.NODE_ENV === 'production') {
      // Never process unverified webhooks in production.
      throw new UnauthorizedException('RESEND_WEBHOOK_SECRET is not configured');
    } else {
      this.logger.warn('RESEND_WEBHOOK_SECRET unset — accepting UNVERIFIED webhook (dev only)');
    }

    // Idempotency by svix message id (falls back to a body hash key in dev).
    const eventKey = svixId ?? `dev-${createHmac('sha256', 'dev').update(raw ?? Buffer.from(JSON.stringify(req.body))).digest('hex')}`;
    const fresh = await this.email.markWebhookSeen(eventKey);
    if (!fresh) {
      this.logger.log(`Duplicate Resend event ${eventKey} — skipped`);
      return { ok: true, duplicate: true };
    }

    const body = req.body as { type?: string; data?: Record<string, unknown> };
    const type = body?.type ?? '';
    const data = body?.data ?? {};
    switch (type) {
      case 'email.delivered':
        await this.email.handleDeliveryEvent('delivered', String(data.email_id ?? ''));
        break;
      case 'email.bounced':
        await this.email.handleDeliveryEvent('bounced', String(data.email_id ?? ''));
        break;
      case 'email.complained':
        await this.email.handleDeliveryEvent('complained', String(data.email_id ?? ''));
        break;
      case 'email.received': {
        const result = await this.email.handleInbound(data as never);
        this.logger.log(`Inbound email ${result.matched ? `filed (msg ${result.message_id})` : `unmatched: ${result.reason}`}`);
        break;
      }
      default:
        this.logger.log(`Ignoring Resend event type ${type}`);
    }
    return { ok: true };
  }
}
