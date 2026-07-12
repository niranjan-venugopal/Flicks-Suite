import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import type { DbAdmin } from '@flicks/db';
import { DB_SERVICE_ROLE } from '../database/database.module';
import { isWorkerMode } from '../worker/worker-mode';
import { DOMAIN_EVENTS_QUEUE } from './events.constants';

/**
 * Outbox dispatcher (PRD v5 §2.2) — WORKER-process only. Every 2s it claims a
 * batch of undispatched domain_events with FOR UPDATE SKIP LOCKED (safe under
 * multiple workers), enqueues them to the 'domain-events' BullMQ queue, and
 * stamps dispatched_at in the SAME transaction — if the enqueue throws, the tx
 * rolls back and the rows are retried on the next tick. dispatch_attempts
 * counts claim attempts so poison rows are visible.
 */
const BATCH = 100;

interface ClaimedRow {
  id: string;
  tenant_id: string | null;
  event_name: string;
  actor_user_id: string | null;
  payload: Record<string, unknown>;
  occurred_at: string;
}

@Injectable()
export class DomainEventsDispatcher {
  private readonly logger = new Logger(DomainEventsDispatcher.name);
  private draining = false;

  constructor(
    @Inject(DB_SERVICE_ROLE) private readonly dbAdmin: DbAdmin,
    @InjectQueue(DOMAIN_EVENTS_QUEUE) private readonly queue: Queue,
  ) {}

  @Cron('*/2 * * * * *', { name: 'domain-events-dispatcher' })
  async tick(): Promise<void> {
    if (!isWorkerMode()) return; // API process never drains the outbox
    if (this.draining) return; // no overlapping drains
    this.draining = true;
    try {
      // Loop until the backlog is clear so a burst doesn't wait 2s per batch.
      for (;;) {
        const n = await this.drainBatch();
        if (n < BATCH) break;
      }
    } catch (err) {
      this.logger.error(
        `outbox drain failed: ${err instanceof Error ? err.message : err}`,
      );
    } finally {
      this.draining = false;
    }
  }

  private async drainBatch(): Promise<number> {
    return this.dbAdmin.transaction(async (tx) => {
      const claimed = (await tx.execute(sql`
        SELECT id, tenant_id, event_name, actor_user_id, payload, occurred_at
        FROM domain_events
        WHERE dispatched_at IS NULL
        ORDER BY occurred_at
        LIMIT ${BATCH}
        FOR UPDATE SKIP LOCKED
      `)) as unknown as ClaimedRow[];
      if (claimed.length === 0) return 0;

      await this.queue.addBulk(
        claimed.map((e) => ({
          name: e.event_name,
          data: {
            id: e.id,
            name: e.event_name,
            tenantId: e.tenant_id,
            actorUserId: e.actor_user_id,
            occurredAt: e.occurred_at,
            payload: e.payload,
          },
          opts: {
            jobId: e.id, // idempotent enqueue — a re-claimed row can't double-add
            removeOnComplete: 1000,
            removeOnFail: 5000,
          },
        })),
      );

      const ids = claimed.map((e) => e.id);
      await tx.execute(sql`
        UPDATE domain_events
        SET dispatched_at = now(), dispatch_attempts = dispatch_attempts + 1
        WHERE id = ANY(${sql.raw(`ARRAY[${ids.map((i) => `'${i}'::uuid`).join(',')}]`)})
      `);
      return claimed.length;
    });
  }
}
