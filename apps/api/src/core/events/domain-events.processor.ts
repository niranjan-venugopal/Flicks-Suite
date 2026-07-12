import { Inject, Logger } from '@nestjs/common';
import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { webhookDeliveries, webhookEndpoints } from '@flicks/db/schema';
import type { DbAdmin } from '@flicks/db';
import { DB_SERVICE_ROLE } from '../database/database.module';
import { DOMAIN_EVENTS_QUEUE, WEBHOOK_DELIVERIES_QUEUE } from './events.constants';
import type { DomainEventEnvelope } from './domain-events.service';

/**
 * Durable-lane fan-out (worker process). Consumes the 'domain-events' queue
 * and routes each event to its durable subscribers. Sprint 24 subscriber:
 * outbound webhooks (§11) — one delivery row + one delivery job per active
 * endpoint subscribed to the event. Later sprints register more subscribers
 * here (timeline writer, workflow engine, product-events bridge).
 */
@Processor(DOMAIN_EVENTS_QUEUE)
export class DomainEventsProcessor extends WorkerHost {
  private readonly logger = new Logger(DomainEventsProcessor.name);

  constructor(
    @Inject(DB_SERVICE_ROLE) private readonly dbAdmin: DbAdmin,
    @InjectQueue(WEBHOOK_DELIVERIES_QUEUE) private readonly deliveries: Queue,
  ) {
    super();
  }

  async process(job: Job<DomainEventEnvelope>): Promise<void> {
    const event = job.data;
    await this.fanOutToWebhooks(event);
  }

  private async fanOutToWebhooks(event: DomainEventEnvelope): Promise<void> {
    if (!event.tenantId) return; // platform events never leave the platform
    const endpoints = await this.dbAdmin
      .select({ id: webhookEndpoints.id })
      .from(webhookEndpoints)
      .where(
        and(
          eq(webhookEndpoints.tenant_id, event.tenantId),
          eq(webhookEndpoints.active, true),
          isNull(webhookEndpoints.deleted_at),
          sql`${event.name} = ANY(${webhookEndpoints.events})`,
        ),
      );
    for (const ep of endpoints) {
      const [delivery] = await this.dbAdmin
        .insert(webhookDeliveries)
        .values({
          tenant_id: event.tenantId,
          endpoint_id: ep.id,
          event_id: event.id,
          event_name: event.name,
        })
        .returning({ id: webhookDeliveries.id });
      await this.deliveries.add(
        'deliver',
        { deliveryId: delivery!.id, event },
        {
          jobId: delivery!.id,
          attempts: 5,
          backoff: { type: 'exponential', delay: 60_000 }, // 1m → 2m → 4m → 8m → 16m
          removeOnComplete: 1000,
          removeOnFail: 5000,
        },
      );
    }
  }
}
