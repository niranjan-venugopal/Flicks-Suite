import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { and, isNull, lt, sql } from 'drizzle-orm';
import { domainEvents } from '@flicks/db/schema';
import type { DbAdmin } from '@flicks/db';
import { DB_SERVICE_ROLE } from '../database/database.module';

/**
 * Outbox-lag monitor (PRD v5 §2.2 safety net). Runs in EVERY process — API and
 * worker — precisely so the silent-failure mode the security review flagged
 * (no process started with WORKER_MODE=true → nothing ever drains the outbox)
 * becomes loud: if the oldest undispatched event is older than the threshold,
 * we log an error every cycle. Cheap: one indexed COUNT + MIN over the partial
 * `idx_de_undispatched` index.
 */
const LAG_THRESHOLD_MS = 5 * 60 * 1000;

@Injectable()
export class OutboxLagMonitor {
  private readonly logger = new Logger(OutboxLagMonitor.name);

  constructor(@Inject(DB_SERVICE_ROLE) private readonly dbAdmin: DbAdmin) {}

  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'outbox-lag-monitor' })
  async check(): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - LAG_THRESHOLD_MS);
      const [row] = await this.dbAdmin
        .select({
          stalled: sql<number>`count(*)::int`,
          oldest: sql<string | null>`min(${domainEvents.occurred_at})`,
        })
        .from(domainEvents)
        .where(and(isNull(domainEvents.dispatched_at), lt(domainEvents.occurred_at, cutoff)));
      const stalled = row?.stalled ?? 0;
      if (stalled > 0) {
        this.logger.error(
          `OUTBOX STALLED: ${stalled} event(s) undispatched for >5min (oldest ${row?.oldest}). ` +
            `Either run a WORKER_MODE=true process or unset INLINE_WORKER=false (single-process deployments drain inline by default). Async webhooks/workflows are not firing.`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `outbox lag check failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}
