import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { and, count, eq, isNotNull, lt, sql } from 'drizzle-orm';
import { auditLogPlatform, subscriptions, tenants } from '@flicks/db/schema';
import type { DbAdmin } from '@flicks/db';
import { PLATFORM_PLAN } from '@flicks/shared/constants';
import { DB_SERVICE_ROLE } from '../../core/database/database.module';
import { AuditService } from '../audit/audit.service';
import { AnalyticsService } from '../../core/analytics/analytics.service';
import { NotificationsService } from '../notifications/notifications.service';
import { BillingService } from './billing.service';
import { RazorpayPlatformService } from './razorpay-platform.service';

const SPECFLICKS_TENANT_ID = '00000000-0000-0000-0000-000000000001';
const IST = 'Asia/Kolkata';

/**
 * Platform billing crons (PRD v4 §8B) — replaces the Sprint-1 trial stubs.
 *
 * Reliability rules baked in (each fixed a reviewed failure mode):
 *  • dedupe markers (platform-audit rows, metadata->>'marker') are written
 *    ONLY after ≥1 email actually reached Resend — an outage retries next run;
 *  • every per-tenant iteration has its own try/catch — one bad row never
 *    aborts the rest of a sweep;
 *  • windows OVERLAP the cron cadence (pre-debit scans a 25h horizon hourly;
 *    reminders use bands, not equality) so a missed tick self-heals;
 *  • the scheduled-cancellation push happens BEFORE the boundary charge —
 *    pushing after the lapse never works because each charge rolls
 *    current_period_end forward.
 */
@Injectable()
export class BillingJobs {
  private readonly logger = new Logger(BillingJobs.name);

  constructor(
    @Inject(DB_SERVICE_ROLE) private readonly dbAdmin: DbAdmin,
    private readonly audit: AuditService,
    private readonly analytics: AnalyticsService,
    private readonly notifications: NotificationsService,
    private readonly billing: BillingService,
    private readonly rzp: RazorpayPlatformService,
  ) {}

  /** T-3 / T-1 trial reminders, 09:00 IST (§8B.4 — 7-day trial → no T-7). */
  @Cron('0 9 * * *', { name: 'trial-reminders', timeZone: IST })
  async trialReminders(): Promise<void> {
    const rows = await this.dbAdmin
      .select({
        tenant_id: subscriptions.tenant_id,
        trial_ends_at: subscriptions.trial_ends_at,
        tenant_name: tenants.name,
      })
      .from(subscriptions)
      .innerJoin(tenants, eq(tenants.id, subscriptions.tenant_id))
      .where(
        and(
          eq(subscriptions.status, 'trialing'),
          isNotNull(subscriptions.trial_ends_at),
          sql`${subscriptions.trial_ends_at} BETWEEN now() AND now() + interval '4 days'`,
          sql`${subscriptions.tenant_id} <> ${SPECFLICKS_TENANT_ID}::uuid`,
        ),
      );
    let sent = 0;
    for (const row of rows) {
      try {
        const daysLeft =
          (new Date(row.trial_ends_at!).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
        // Bands, not equality: a run skipped on the exact T-3 day still sends
        // the reminder the next day instead of dropping it.
        const band = daysLeft <= 1 ? 'T-1' : daysLeft <= 3 ? 'T-3' : null;
        if (!band) continue;
        const marker = `${row.tenant_id}:${band}:${new Date(row.trial_ends_at!).toISOString().slice(0, 10)}`;
        if (await this.markerExists('billing.trial_reminder', marker)) continue;
        const owners = await this.billing.ownerEmails(row.tenant_id);
        // ALL sends must succeed before the marker is written — a partial
        // outage retries the batch next run (one duplicate for the owner who
        // did get it beats an owner who never does).
        let delivered = true;
        for (const o of owners) {
          const ok = await this.notifications.sendEmail('trial-ending-soon', o.email, {
            tenantName: row.tenant_name,
            trialEndsAt: new Date(row.trial_ends_at!).toLocaleDateString('en-IN', {
              timeZone: IST,
              day: 'numeric',
              month: 'long',
              year: 'numeric',
            }),
            upgradeUrl: `${process.env.APP_URL ?? 'http://localhost:3000'}/settings/billing`,
          });
          delivered = delivered && ok;
        }
        if (!delivered) continue; // Resend outage → retry next run
        await this.audit.logPlatform({
          action: 'billing.trial_reminder',
          targetTenantId: row.tenant_id,
          metadata: { marker, band },
        });
        sent++;
      } catch (err) {
        this.logger.warn(
          `trial reminder for ${row.tenant_id} failed (continuing): ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    this.logger.log(`trial-reminders: ${sent} reminder batch(es) sent`);
  }

  /**
   * Trial-expiry sweep, 02:00 UTC. The lock derives live from dates
   * (BillingStateService) — this is the one-time bookkeeping per lapsed
   * trial: platform audit + trial_expired product event.
   */
  @Cron(CronExpression.EVERY_DAY_AT_2AM, { name: 'trial-expiry-sweep', timeZone: 'UTC' })
  async trialExpirySweep(): Promise<void> {
    const lapsed = await this.dbAdmin
      .select({ tenant_id: subscriptions.tenant_id, tenant_name: tenants.name })
      .from(subscriptions)
      .innerJoin(tenants, eq(tenants.id, subscriptions.tenant_id))
      .where(
        and(
          eq(subscriptions.status, 'trialing'),
          isNotNull(subscriptions.trial_ends_at),
          lt(subscriptions.trial_ends_at, new Date()),
          sql`${subscriptions.razorpay_subscription_id} IS NULL`,
          sql`${subscriptions.tenant_id} <> ${SPECFLICKS_TENANT_ID}::uuid`,
        ),
      );
    let marked = 0;
    for (const row of lapsed) {
      try {
        // Unbounded lookback: lapsed tenants stay in this query forever, so a
        // time-bounded marker would re-fire the event every N days.
        if (await this.markerExists('billing.trial_expired', row.tenant_id, null)) continue;
        // D23 'trial-ended' email to owners — a failed send retries tomorrow
        // (the marker is only written after a confirmed delivery).
        const owners = await this.billing.ownerEmails(row.tenant_id);
        let delivered = true; // all-or-retry (see trialReminders)
        for (const o of owners) {
          const ok = await this.notifications.sendEmail('trial-ended', o.email, {
            tenantName: row.tenant_name,
            upgradeUrl: `${process.env.APP_URL ?? 'http://localhost:3000'}/settings/billing`,
          });
          delivered = delivered && ok;
        }
        if (!delivered) continue;
        await this.audit.logPlatform({
          action: 'billing.trial_expired',
          targetTenantId: row.tenant_id,
          metadata: { marker: row.tenant_id },
        });
        void this.analytics.track({ event: 'trial_expired', tenantId: row.tenant_id });
        marked++;
      } catch (err) {
        this.logger.warn(
          `trial-expiry bookkeeping for ${row.tenant_id} failed (continuing): ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    this.logger.log(`trial-expiry-sweep: ${marked} newly-lapsed trial(s) recorded`);
  }

  /**
   * Hourly boundary work for ACTIVE subscriptions whose current_period_end is
   * within the next 25 hours (a self-healing horizon — the marker dedupe
   * makes rescans free, so a skipped tick is covered by the next one):
   *   1. scheduled cancellations get pushed to Razorpay (cancel_at_cycle_end)
   *      BEFORE the boundary charge can fire;
   *   2. everyone else gets the seat-count sync + the pre-debit notice.
   */
  @Cron(CronExpression.EVERY_HOUR, { name: 'platform-pre-debit-notices' })
  async preDebitNotices(): Promise<void> {
    const upcoming = await this.dbAdmin
      .select({
        tenant_id: subscriptions.tenant_id,
        tenant_name: tenants.name,
        period_end: subscriptions.current_period_end,
        rzp_id: subscriptions.razorpay_subscription_id,
        user_count: subscriptions.user_count,
        cancel_at_period_end: subscriptions.cancel_at_period_end,
      })
      .from(subscriptions)
      .innerJoin(tenants, eq(tenants.id, subscriptions.tenant_id))
      .where(
        and(
          eq(subscriptions.status, 'active'),
          isNotNull(subscriptions.current_period_end),
          sql`${subscriptions.current_period_end} BETWEEN now() AND now() + interval '25 hours'`,
        ),
      );
    for (const row of upcoming) {
      try {
        if (row.cancel_at_period_end) {
          await this.pushScheduledCancel(row.tenant_id, row.rzp_id, row.period_end!);
          continue; // cancelling — no seat sync, no pre-debit notice
        }

        // Seat sync EVERY pass through the window (not gated by the email
        // marker) — a failed Razorpay call gets retried on the next tick.
        const prevSeats = row.user_count;
        const seats = await this.billing.recountSeats(row.tenant_id);
        let syncedSeats = prevSeats;
        if (this.rzp.isConfigured() && row.rzp_id) {
          if (seats !== prevSeats) {
            try {
              await this.rzp.updateQuantity(row.rzp_id, seats);
              syncedSeats = seats;
            } catch (err) {
              this.logger.warn(
                `quantity sync for ${row.rzp_id} failed (retrying next tick): ${err instanceof Error ? err.message : err}`,
              );
            }
          } else {
            syncedSeats = seats;
          }
        }

        const marker = `${row.tenant_id}:${new Date(row.period_end!).toISOString()}`;
        if (await this.markerExists('billing.pre_debit_notice', marker)) continue;

        // Disclose what Razorpay will actually debit: the synced quantity —
        // fall back to the previously-committed count when the sync failed.
        const amount = `₹${(syncedSeats * PLATFORM_PLAN.priceRupees).toLocaleString('en-IN')}`;
        const owners = await this.billing.ownerEmails(row.tenant_id);
        let delivered = true; // all-or-retry (see trialReminders)
        for (const o of owners) {
          const ok = await this.notifications.sendEmail('subscription-pre-debit', o.email, {
            customerName: row.tenant_name,
            name: `Flicks Suite · ${syncedSeats} seat${syncedSeats === 1 ? '' : 's'}`,
            amount,
            chargeDate: new Date(row.period_end!).toLocaleDateString('en-IN', {
              timeZone: IST,
              day: 'numeric',
              month: 'long',
              year: 'numeric',
            }),
          });
          delivered = delivered && ok;
        }
        if (!delivered) continue; // retry next tick
        await this.audit.logPlatform({
          action: 'billing.pre_debit_notice',
          targetTenantId: row.tenant_id,
          metadata: { marker, seats: syncedSeats },
        });
      } catch (err) {
        this.logger.warn(
          `pre-debit pass for ${row.tenant_id} failed (continuing): ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }

  /**
   * Push a scheduled cancellation to Razorpay before the boundary charge.
   * The DB status flip is the webhook's job (subscription.cancelled fires at
   * the cycle end) — flipping locally on a failed API call would strand a
   * live, still-charging Razorpay subscription behind a 'canceled' row.
   */
  private async pushScheduledCancel(
    tenantId: string,
    rzpId: string | null,
    periodEnd: Date,
  ): Promise<void> {
    if (!this.rzp.isConfigured() || !rzpId) return;
    const marker = `${tenantId}:cancel:${new Date(periodEnd).toISOString()}`;
    if (await this.markerExists('billing.cancel_pushed', marker)) return;
    await this.rzp.cancel(rzpId, true); // throws on failure → retried next tick
    await this.audit.logPlatform({
      action: 'billing.cancel_pushed',
      targetTenantId: tenantId,
      metadata: { marker, razorpay_subscription_id: rzpId },
    });
    this.logger.log(`scheduled cancellation pushed to Razorpay for tenant ${tenantId}`);
  }

  /** lookbackDays=null → unbounded (for markers that must never re-fire). */
  private async markerExists(
    action: string,
    marker: string,
    lookbackDays: number | null = 90,
  ): Promise<boolean> {
    const conds = [
      eq(auditLogPlatform.action, action),
      sql`${auditLogPlatform.metadata}->>'marker' = ${marker}`,
    ];
    if (lookbackDays !== null) {
      conds.push(
        sql`${auditLogPlatform.created_at} > now() - (${lookbackDays} || ' days')::interval`,
      );
    }
    const [{ n }] = await this.dbAdmin
      .select({ n: count() })
      .from(auditLogPlatform)
      .where(and(...conds));
    return Number(n) > 0;
  }
}
