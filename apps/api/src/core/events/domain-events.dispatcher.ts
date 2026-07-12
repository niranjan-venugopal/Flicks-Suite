import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { domainEvents } from '@flicks/db/schema';
import type { DbAdmin } from '@flicks/db';
import { DB_SERVICE_ROLE } from '../database/database.module';
import { isWorkerMode } from '../worker/worker-mode';
import { DOMAIN_EVENTS_QUEUE } from './events.constants';

/**
 * Outbox dispatcher (PRD v5 §2.2) — WORKER-process only. Every 2s it claims a
 * batch of undispatched events (FOR UPDATE SKIP LOCKED, safe under multiple
 * workers), bumps dispatch_attempts in the claim transaction, then enqueues
 * each event to BullMQ INDEPENDENTLY and stamps dispatched_at per success —
 * so one un-enqueueable "poison" row can never stall the events behind it, and
 * a row that fails MAX_ATTEMPTS times drops out of the claim (quarantined +
 * logged) instead of blocking the pipeline forever. Enqueue is idempotent by
 * jobId=event.id, so a re-claim before the stamp can't double-deliver.
 */
const BATCH = 100;
const MAX_ATTEMPTS = 10;

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
      for (;;) {
        const claimed = await this.claimBatch();
        if (claimed.length === 0) break;
        await this.dispatch(claimed);
        if (claimed.length < BATCH) break;
      }
    } catch (err) {
      this.logger.error(
        `outbox drain failed: ${err instanceof Error ? err.message : err}`,
      );
    } finally {
      this.draining = false;
    }
  }

  /** Claim + attempt-bump in one tx; returns the claimed envelopes. */
  private async claimBatch(): Promise<
    Array<{
      id: string;
      tenant_id: string | null;
      event_name: string;
      actor_user_id: string | null;
      payload: Record<string, unknown>;
      occurred_at: string;
    }>
  > {
    return this.dbAdmin.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(domainEvents)
        .where(
          and(isNull(domainEvents.dispatched_at), lt(domainEvents.dispatch_attempts, MAX_ATTEMPTS)),
        )
        .orderBy(domainEvents.occurred_at)
        .limit(BATCH)
        .for('update', { skipLocked: true });
      if (rows.length === 0) return [];

      const ids = rows.map((r) => r.id);
      // Bump attempts NOW so the count reflects the claim even if the enqueue
      // below fails; a row that reaches MAX_ATTEMPTS falls out of the claim.
      await tx
        .update(domainEvents)
        .set({ dispatch_attempts: sql`${domainEvents.dispatch_attempts} + 1` })
        .where(inArray(domainEvents.id, ids));

      return rows.map((r) => ({
        id: r.id,
        tenant_id: r.tenant_id,
        event_name: r.event_name,
        actor_user_id: r.actor_user_id,
        payload: r.payload as Record<string, unknown>,
        occurred_at: (r.occurred_at as Date).toISOString(),
      }));
    });
  }

  /** Enqueue each event independently; stamp dispatched_at only on success. */
  private async dispatch(
    claimed: Awaited<ReturnType<DomainEventsDispatcher['claimBatch']>>,
  ): Promise<void> {
    for (const e of claimed) {
      try {
        await this.queue.add(
          e.event_name,
          {
            id: e.id,
            name: e.event_name,
            tenantId: e.tenant_id,
            actorUserId: e.actor_user_id,
            occurredAt: e.occurred_at,
            payload: e.payload,
          },
          { jobId: e.id, removeOnComplete: 1000, removeOnFail: 5000 },
        );
        await this.dbAdmin
          .update(domainEvents)
          .set({ dispatched_at: new Date() })
          .where(eq(domainEvents.id, e.id));
      } catch (err) {
        // Leave dispatched_at NULL — it retries next tick until MAX_ATTEMPTS,
        // then quarantines out of the claim. One bad row never blocks others.
        this.logger.warn(
          `outbox enqueue failed for event ${e.id} (${e.event_name}): ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }
}
