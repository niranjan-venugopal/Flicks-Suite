import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { and, eq, gt, inArray, isNotNull, isNull, lt, lte, sql } from 'drizzle-orm';
import {
  domainEvents,
  syncMutations,
  pmProjects,
  pmProjectUpdates,
  notifications,
  users,
} from '@flicks/db/schema';
import type { DbAdmin } from '@flicks/db';
import { DB_SERVICE_ROLE } from '../core/database/database.module';
import { runsWorkloads } from '../core/worker/worker-mode';
import {
  NotificationsService,
  emailEventForInAppType,
} from '../modules/notifications/notifications.service';
import { PmCyclesService } from '../modules/pm/cycles.service';

const EVENT_RETENTION_DAYS = 90; // §3.7 — dispatched outbox rows
const MUTATION_RETENTION_DAYS = 30; // §3.2 — idempotency ledger
const UPDATE_STALE_DAYS = 7; // §6.3 — nudge leads when the latest update is older
const URGENT_TYPES = ['pm.issue.assigned', 'pm.issue.mention']; // §11.4 5-min email
const URGENT_DELAY_MS = 5 * 60_000;

function hourInTz(now: Date, tz: string): number {
  try {
    return Number(
      new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: 'numeric', hour12: false }).format(now),
    );
  } catch {
    return now.getUTCHours();
  }
}

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

  /**
   * §11.4 — mention/assignment emails send 5 minutes later ONLY if the inbox
   * row is still unread (read-suppression). emailed_at is the exactly-once
   * marker; the guarded claim makes concurrent sweeps safe.
   */
  @Cron('*/5 * * * *', { name: 'pm-inbox-urgent-email', timeZone: 'UTC' })
  async urgentEmailTick(): Promise<void> {
    if (!runsWorkloads()) return;
    try {
      const sent = await this.runUrgentEmailSweep(new Date());
      if (sent) this.logger.log(`pm-inbox-urgent-email: ${sent} sent`);
    } catch (err) {
      this.logger.error(`pm-inbox-urgent-email failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  async runUrgentEmailSweep(now: Date): Promise<number> {
    const due = new Date(now.getTime() - URGENT_DELAY_MS);
    const floor = new Date(now.getTime() - 24 * 3_600_000); // never email ancient backlog
    const rows = await this.dbAdmin
      .select({
        id: notifications.id,
        user_id: notifications.user_id,
        type: notifications.type,
        message: notifications.message,
        link_url: notifications.link_url,
        email: users.email,
      })
      .from(notifications)
      .innerJoin(users, eq(users.id, notifications.user_id))
      .where(
        and(
          inArray(notifications.type, URGENT_TYPES),
          isNull(notifications.read_at),
          isNull(notifications.archived_at),
          isNull(notifications.emailed_at),
          lte(notifications.created_at, due),
          gt(notifications.created_at, floor),
        ),
      )
      .limit(200);

    let sent = 0;
    for (const row of rows) {
      // Claim first — exactly-once even if two workers sweep simultaneously.
      const claimed = await this.dbAdmin
        .update(notifications)
        .set({ emailed_at: now })
        .where(and(eq(notifications.id, row.id), isNull(notifications.emailed_at)))
        .returning({ id: notifications.id });
      if (!claimed.length) continue;
      const event = emailEventForInAppType(row.type);
      const ok = await this.notifications.sendEmail(
        'pm-inbox-urgent',
        row.email,
        { line: row.message, linkUrl: row.link_url ?? '/pm/inbox' },
        event ? { userId: row.user_id, event } : undefined,
      );
      if (ok) sent++;
    }
    return sent;
  }

  /**
   * §11.4 — the ambient fold. Hourly cadence sends every tick; daily waits for
   * 08:00 in the user's timezone; 'urgent' users get no fold at all. Only
   * unread rows fold in (reading in-app removes them) and each row is folded
   * exactly once via emailed_at.
   */
  @Cron('10 * * * *', { name: 'pm-inbox-digest-email', timeZone: 'UTC' })
  async digestEmailTick(): Promise<void> {
    if (!runsWorkloads()) return;
    try {
      const sent = await this.runInboxDigestSweep(new Date());
      if (sent) this.logger.log(`pm-inbox-digest-email: ${sent} digests sent`);
    } catch (err) {
      this.logger.error(`pm-inbox-digest-email failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  async runInboxDigestSweep(now: Date): Promise<number> {
    const floor = new Date(now.getTime() - 7 * 86_400_000);
    const rows = await this.dbAdmin
      .select({
        id: notifications.id,
        user_id: notifications.user_id,
        type: notifications.type,
        message: notifications.message,
        email: users.email,
        timezone: users.timezone,
        freq: users.notification_email_digest,
      })
      .from(notifications)
      .innerJoin(users, eq(users.id, notifications.user_id))
      .where(
        and(
          sql`${notifications.type} LIKE 'pm.%'`,
          sql`${notifications.type} NOT IN (${sql.join(
            URGENT_TYPES.map((t) => sql`${t}`),
            sql`, `,
          )})`,
          isNull(notifications.read_at),
          isNull(notifications.archived_at),
          isNull(notifications.emailed_at),
          gt(notifications.created_at, floor),
          lte(notifications.created_at, now),
        ),
      )
      .orderBy(notifications.created_at)
      .limit(1000);
    if (!rows.length) return 0;

    const byUser = new Map<string, typeof rows>();
    for (const r of rows) {
      const list = byUser.get(r.user_id) ?? [];
      list.push(r);
      byUser.set(r.user_id, list);
    }

    let digests = 0;
    for (const [userId, list] of byUser) {
      const { email, timezone, freq } = list[0]!;
      if (freq === 'urgent') continue; // urgent-only users get no fold
      if (freq === 'daily' && hourInTz(now, timezone) !== 8) continue;

      // Per-row email-preference gate (a disabled event never folds in).
      const allowed: typeof list = [];
      const prefCache = new Map<string, boolean>();
      for (const r of list) {
        const event = emailEventForInAppType(r.type);
        if (!event) continue;
        let ok = prefCache.get(event);
        if (ok === undefined) {
          ok = await this.notifications.isChannelEnabled(userId, event, 'email');
          prefCache.set(event, ok);
        }
        if (ok) allowed.push(r);
      }
      if (!allowed.length) continue;

      const ids = allowed.map((r) => r.id);
      const claimed = await this.dbAdmin
        .update(notifications)
        .set({ emailed_at: now })
        .where(and(inArray(notifications.id, ids), isNull(notifications.emailed_at)))
        .returning({ id: notifications.id });
      if (!claimed.length) continue;

      const ok = await this.notifications.sendEmail('pm-inbox-digest', email, {
        count: claimed.length,
        lines: allowed.map((r) => r.message),
        inboxUrl: '/pm/inbox',
        cadence: freq === 'hourly' ? 'hourly' : 'daily',
      });
      if (!ok) {
        // Un-claim on provider failure so the next tick retries.
        await this.dbAdmin
          .update(notifications)
          .set({ emailed_at: null })
          .where(inArray(notifications.id, claimed.map((c) => c.id)));
        continue;
      }
      digests++;
    }
    return digests;
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
