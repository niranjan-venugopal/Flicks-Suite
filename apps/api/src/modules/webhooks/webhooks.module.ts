import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { WebhooksService } from './webhooks.service';
import { WebhooksController } from './webhooks.controller';
import { WebhookDeliveryProcessor } from './webhook-delivery.processor';
import { WEBHOOK_DELIVERIES_QUEUE } from '../../core/events/events.constants';
import { AppCryptoService } from '../../core/crypto/app-crypto.service';
import { isWorkerMode } from '../../core/worker/worker-mode';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';

/** Outbound webhooks (PRD v5 §11) — management API + worker-side delivery. */
@Module({
  imports: [
    BullModule.registerQueue({ name: WEBHOOK_DELIVERIES_QUEUE }),
    AuditModule,
    NotificationsModule,
  ],
  controllers: [WebhooksController],
  providers: [
    WebhooksService,
    AppCryptoService,
    ...(isWorkerMode() ? [WebhookDeliveryProcessor] : []),
  ],
  exports: [WebhooksService],
})
export class WebhooksModule {}
