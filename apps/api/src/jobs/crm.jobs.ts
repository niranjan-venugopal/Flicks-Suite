import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { and, eq, gte, isNull, isNotNull, sql } from 'drizzle-orm';
import { activities, notifications, users } from '@flicks/db/schema';
import type { DbAdmin } from '@flicks/db';
import { DB_SERVICE_ROLE } from '../core/database/database.module';
import { NotificationsService } from '../modules/notifications/notifications.service';
import { SequencesService } from '../modules/crm/sequences.service';
import { runsWorkloads } from '../core/worker/worker-mode';

/**
 * CRM jobs (PRD v5 §6.4) — the daily activity digest. Every hour the sweep
 * finds users whose LOCAL time is 08:00 (users.timezone, default IST) and who
 * have open scheduled activities, and drops a morning summary in their bell:
 * "N overdue · M due today". Idempotent per day via the notifications ledger
 * (a crm.digest row in the last 20h = already sent). The email flavour joins
 * with the Sprint 29 email templates.
 */
@Injectable()
export class CrmJobs {
  private readonly logger = new Logger(CrmJobs.name);

  constructor(
    @Inject(DB_SERVICE_ROLE) private readonly dbAdmin: DbAdmin,
    private readonly notifications: NotificationsService,
    private readonly sequences: SequencesService,
  ) {}

  /** §7.1 sequence engine — every 5 minutes in whichever process runs workloads. */
  @Cron('*/5 * * * *', { name: 'crm-sequences-tick' })
  async sequencesTick(): Promise<void> {
    if (!runsWorkloads()) return;
    try {
      const sent = await this.sequences.tick(new Date());
      if (sent > 0) this.logger.log(`crm-sequences-tick: ${sent} step(s) sent`);
    } catch (err) {
      this.logger.error(`crm-sequences-tick failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  @Cron('0 * * * *', { name: 'crm-activity-digest' })
  async tick(): Promise<void> {
    try {
      const sent = await this.runDigestSweep(new Date());
      if (sent > 0) this.logger.log(`crm-activity-digest: ${sent} digest(s) sent`);
    } catch (err) {
      this.logger.error(`crm-activity-digest failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Exposed with an injectable `now` for the integration test. */
  async runDigestSweep(now: Date): Promise<number> {
    // Everyone with at least one OPEN scheduled activity, plus their timezone.
    const rows = await this.dbAdmin
      .select({
        tenant_id: activities.tenant_id,
        assignee: activities.assignee_user_id,
        timezone: users.timezone,
        due_at: activities.due_at,
      })
      .from(activities)
      .innerJoin(users, eq(users.id, activities.assignee_user_id))
      .where(and(isNull(activities.completed_at), isNull(activities.deleted_at), isNotNull(activities.due_at)));
    if (rows.length === 0) return 0;

    // Group per (tenant, user); compute overdue/today in the USER's timezone.
    const byUser = new Map<string, { tenantId: string; userId: string; tz: string; overdue: number; today: number }>();
    for (const r of rows) {
      const key = `${r.tenant_id}:${r.assignee}`;
      const entry = byUser.get(key) ?? { tenantId: r.tenant_id, userId: r.assignee, tz: r.timezone || 'Asia/Kolkata', overdue: 0, today: 0 };
      const due = new Date(r.due_at as unknown as string);
      if (due < now) entry.overdue++;
      else if (this.dateInTz(due, entry.tz) === this.dateInTz(now, entry.tz)) entry.today++;
      byUser.set(key, entry);
    }

    let sent = 0;
    for (const u of byUser.values()) {
      if (u.overdue + u.today === 0) continue;
      if (this.hourInTz(now, u.tz) !== 8) continue; // their morning, not ours

      // Idempotent per day: a digest in the last 20h means it's done.
      const [already] = await this.dbAdmin
        .select({ id: notifications.id })
        .from(notifications)
        .where(
          and(
            eq(notifications.user_id, u.userId),
            eq(notifications.type, 'crm.digest'),
            gte(notifications.created_at, new Date(now.getTime() - 20 * 3600_000)),
          ),
        )
        .limit(1);
      if (already) continue;

      const parts = [
        u.overdue ? `${u.overdue} overdue` : null,
        u.today ? `${u.today} due today` : null,
      ].filter(Boolean).join(' · ');
      await this.notifications.createInAppNotification(
        u.userId,
        'crm.digest',
        `Good morning — ${parts}. Keep every deal moving.`,
        '/crm/activities',
        u.tenantId,
      );
      sent++;
    }
    return sent;
  }

  private hourInTz(instant: Date, tz: string): number {
    try {
      return parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(instant), 10);
    } catch {
      return instant.getUTCHours();
    }
  }

  private dateInTz(instant: Date, tz: string): string {
    try {
      return new Intl.DateTimeFormat('sv-SE', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);
    } catch {
      return instant.toISOString().slice(0, 10);
    }
  }
}

// keep drizzle sql import referenced for future aggregation tuning
void sql;
