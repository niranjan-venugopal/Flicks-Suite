import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { and, isNotNull, lt, sql } from 'drizzle-orm';
import { domainEvents, syncMutations } from '@flicks/db/schema';
import type { DbAdmin } from '@flicks/db';
import { DB_SERVICE_ROLE } from '../core/database/database.module';
import { runsWorkloads } from '../core/worker/worker-mode';

const EVENT_RETENTION_DAYS = 90; // §3.7 — dispatched outbox rows
const MUTATION_RETENTION_DAYS = 30; // §3.2 — idempotency ledger

/**
 * PM/FSE maintenance (PRD v6 §3.7, §19). Deleting old outbox rows advances
 * min(sync_seq) — the delta horizon — so clients parked past retention get a
 * clean 410 RE_BOOTSTRAP instead of a silent gap. Only DISPATCHED events are
 * pruned; an undispatched row is a stuck pipeline, not history.
 */
@Injectable()
export class PmJobs {
  private readonly logger = new Logger(PmJobs.name);

  constructor(@Inject(DB_SERVICE_ROLE) private readonly dbAdmin: DbAdmin) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM, { name: 'pm-sync-prune', timeZone: 'UTC' })
  async pruneSyncData(): Promise<void> {
    if (!runsWorkloads()) return;
    try {
      const eventCutoff = new Date(Date.now() - EVENT_RETENTION_DAYS * 86_400_000);
      const events = await this.dbAdmin
        .delete(domainEvents)
        .where(and(lt(domainEvents.occurred_at, eventCutoff), isNotNull(domainEvents.dispatched_at)))
        .returning({ id: domainEvents.id });

      const mutationCutoff = new Date(Date.now() - MUTATION_RETENTION_DAYS * 86_400_000);
      const mutations = await this.dbAdmin
        .delete(syncMutations)
        .where(lt(syncMutations.created_at, mutationCutoff))
        .returning({ id: syncMutations.id });

      if (events.length || mutations.length) {
        const [horizon] = await this.dbAdmin
          .select({ min: sql<number>`coalesce(min(${domainEvents.sync_seq}), 0)` })
          .from(domainEvents);
        this.logger.log(
          `pm-sync-prune: ${events.length} events, ${mutations.length} ledger rows removed; horizon now ${horizon?.min ?? 0}`,
        );
      }
    } catch (err) {
      this.logger.error(`pm-sync-prune failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}
