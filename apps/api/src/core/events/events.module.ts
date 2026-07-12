import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { DomainEventsService } from './domain-events.service';
import { DomainEventsDispatcher } from './domain-events.dispatcher';
import { DomainEventsProcessor } from './domain-events.processor';
import { DOMAIN_EVENTS_QUEUE, WEBHOOK_DELIVERIES_QUEUE } from './events.constants';
import { isWorkerMode } from '../worker/worker-mode';
import { WebhooksModule } from '../../modules/webhooks/webhooks.module';

/**
 * Domain-event bus (PRD v5 §2.2). Global so every module can publish without
 * imports ceremony. Queue registration happens in BOTH processes (publishing
 * side may enqueue in future), but the CONSUMERS — dispatcher cron + the
 * fan-out processor — only activate under WORKER_MODE=true (§2.5 worker split);
 * module wiring is unconditional so a misconfigured env fails visibly at the
 * isWorkerMode() call sites, not silently at DI time.
 */
@Global()
@Module({
  imports: [
    BullModule.registerQueue(
      { name: DOMAIN_EVENTS_QUEUE },
      { name: WEBHOOK_DELIVERIES_QUEUE },
    ),
    WebhooksModule,
  ],
  providers: [
    DomainEventsService,
    DomainEventsDispatcher,
    // The processor class self-registers a BullMQ worker on instantiation, so
    // THIS one is conditional: only the worker process consumes the queue.
    ...(isWorkerMode() ? [DomainEventsProcessor] : []),
  ],
  exports: [DomainEventsService, BullModule],
})
// Named DomainEventsModule — 'EventsModule' is already taken by the Sprint 19
// client-analytics ingest module (modules/events).
export class DomainEventsModule {}
