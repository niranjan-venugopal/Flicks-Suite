import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Post,
  Req,
  type RawBodyRequest,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Public } from '../../core/auth/decorators/public.decorator';
import { PmGithubService } from './github.service';

/**
 * POST /api/v1/webhooks/github (PRD v6 §12.2). Public route — the gate is
 * X-Hub-Signature-256 (timing-safe) + the delivery-id idempotency ledger,
 * same posture as the Razorpay/Resend hooks. Bad signature → 401; everything
 * else → 200 so GitHub doesn't retry-storm (failures are recorded on the
 * ledger row and surfaced in P16 webhook health).
 */
@ApiExcludeController()
@Controller('webhooks')
export class GithubWebhookController {
  constructor(private readonly github: PmGithubService) {}

  @Post('github')
  @Public()
  @HttpCode(200)
  @SkipThrottle()
  async handle(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-github-delivery') deliveryId: string | undefined,
    @Headers('x-github-event') event: string | undefined,
    @Headers('x-hub-signature-256') signature: string | undefined,
  ) {
    if (!deliveryId || !event) {
      throw new BadRequestException('Missing X-GitHub-Delivery / X-GitHub-Event');
    }
    const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    return this.github.handleDelivery({
      deliveryId,
      event,
      signature,
      rawBody,
      payload: (req.body ?? {}) as Record<string, unknown>,
    });
  }
}
