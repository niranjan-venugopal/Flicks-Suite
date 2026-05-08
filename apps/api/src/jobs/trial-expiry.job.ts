import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DatabaseService } from '../core/database/database.service';

/**
 * Identifies tenants whose trial is ending soon (T-7, T-3, T-1) and dispatches
 * the `trial-ending-soon` notification. Also flips `tenants.status` to
 * `past_due` once the trial has lapsed without an active subscription.
 */
@Injectable()
export class TrialExpiryJob {
  private readonly logger = new Logger(TrialExpiryJob.name);

  constructor(private readonly databaseService: DatabaseService) {}

  /**
   * Runs every day at 09:00 IST. Cron: '0 9 * * *'.
   */
  @Cron('0 9 * * *', {
    name: 'trial-expiry-warnings',
    timeZone: 'Asia/Kolkata',
  })
  async sendExpiryWarnings(): Promise<void> {
    const startedAt = Date.now();
    this.logger.log('Starting trial-expiry warning sweep');

    try {
      // TODO:
      //   1. Select tenants where status='trialing' and trial_ends_at - now()
      //      is approximately 7d / 3d / 1d.
      //   2. For each, send a 'trial-ending-soon' email to admin members.
      //   3. Optionally write a tenant_health_snapshots row with signal='at_risk'.

      this.logger.log(
        `Trial-expiry warning sweep finished in ${Date.now() - startedAt}ms`,
      );
    } catch (err) {
      this.logger.error('Trial-expiry warning sweep failed', err as Error);
      throw err;
    }
  }

  /**
   * Runs every day at 02:00 UTC and transitions trials that have lapsed
   * without an active subscription to `past_due`.
   */
  @Cron(CronExpression.EVERY_DAY_AT_2AM, {
    name: 'trial-expiry-transition',
    timeZone: 'UTC',
  })
  async transitionLapsedTrials(): Promise<void> {
    this.logger.log('Starting trial-expiry transition sweep');

    try {
      // TODO:
      //   1. Find tenants where status='trialing' and trial_ends_at < now().
      //   2. For each, set tenants.status='past_due' if no active subscription,
      //      otherwise transition to 'active'.
      //   3. Write a platform audit log entry per transition.
    } catch (err) {
      this.logger.error('Trial-expiry transition sweep failed', err as Error);
      throw err;
    }
  }
}
