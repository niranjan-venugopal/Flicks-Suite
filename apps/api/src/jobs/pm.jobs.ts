import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { and, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { domainEvents, syncMutations, pmProjects, pmProjectUpdates } from '@flicks/db/schema';
import type { DbAdmin } from '@flicks/db';
import { DB_SERVICE_ROLE } from '../core/database/database.module';
import { runsWorkloads } from '../core/worker/worker-mode';
import { NotificationsService } from '../modules/notifications/notifications.service';
import { PmCyclesService } from '../modules/pm/cycles.service';

const EVENT_RETENTION_DAYS = 90; // §3.7 — dispatched outbox rows
const MUTATION_RETENTION_DAYS = 30; // §3.2 — idempotency ledger
const UPDATE_STALE_DAYS = 7; // §6.3 — nudge leads when the latest update is older

/**
 * PM/FSE maintenance (PRD v6 §3.7, §19). Deleting old outbox rows advances
 * min(sync_seq) — the delta horizon — so clients parked past retention get a
 * clean 410 RE_BOOTSTRAP instead of a silent gap. Only DISPATCHED events are
 * pruned; an undispatched row is a stuck pipeline, not history.
 */
@Injectable()
export class PmJobs {
  private readonly logger = new Logger(PmJobs.name);

  constructor(
    @Inject(DB_SERVICE_ROLE) private readonly dbAdmin: DbAdmin,
    private readonly notifications: NotificationsService,
    private readonly cycles: PmCyclesService,
  ) {}

  /** §7.1 — hourly, tz-aware via stored team-midnight boundaries. */
  @Cron('7 * * * *', { name: 'pm-cycle-sweep', timeZone: 'UTC' })
  async cycleSweep(): Promise<void> {
    if (!runsWorkloads()) return;
    try {
      const r = await this.cycles.runCycleSweep(new Date());
      if (r.created || r.activated || r.ended || r.snapshots) {
        this.logger.log(`pm-cycle-sweep: +${r.created} created, ${r.activated} activated, ${r.ended} ended, ${r.snapshots} snapshots`);
      }
    } catch (err) {
      this.logger.error(`pm-cycle-sweep failed: ${err instanceof Error ? err.message : err}`);
    }
  }

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

  /**
   * §6.3 — weekly nudge to project leads whose in-progress project has no
   * health update in the last 7 days. Inbox only, never auto-generated
   * updates. Exposed with an injectable `now` for tests.
   */
  @Cron('0 5 * * 1', { name: 'pm-update-staleness', timeZone: 'UTC' })
  async nudgeStaleProjects(): Promise<void> {
    if (!runsWorkloads()) return;
    try {
      const nudged = await this.runStalenessSweep(new Date());
      if (nudged) this.logger.log(`pm-update-staleness: nudged ${nudged} project leads`);
    } catch (err) {
      this.logger.error(`pm-update-staleness failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  async runStalenessSweep(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - UPDATE_STALE_DAYS * 86_400_000);
    const projects = await this.dbAdmin
      .select({
        id: pmProjects.id,
        tenant_id: pmProjects.tenant_id,
        name: pmProjects.name,
        lead_user_id: pmProjects.lead_user_id,
        created_at: pmProjects.created_at,
      })
      .from(pmProjects)
      .where(and(eq(pmProjects.status, 'in_progress'), isNull(pmProjects.deleted_at), isNotNull(pmProjects.lead_user_id)));
    if (!projects.length) return 0;

    const latest = await this.dbAdmin
      .select({
        project_id: pmProjectUpdates.project_id,
        last: sql<string>`max(${pmProjectUpdates.created_at})`,
      })
      .from(pmProjectUpdates)
      .groupBy(pmProjectUpdates.project_id);
    const lastByProject = new Map(latest.map((l) => [l.project_id, new Date(l.last)]));

    let nudged = 0;
    for (const p of projects) {
      const last = lastByProject.get(p.id) ?? p.created_at;
      if (last >= cutoff) continue;
      const days = Math.floor((now.getTime() - last.getTime()) / 86_400_000);
      await this.notifications.createInAppNotification(
        p.lead_user_id!,
        'pm.project.stale',
        `"${p.name}" has no health update in ${days} days — post one so the team stays honest.`,
        `/pm/projects/${p.id}`,
        p.tenant_id,
      );
      nudged++;
    }
    return nudged;
  }
}
