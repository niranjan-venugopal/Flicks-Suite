import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DataExportService } from '../modules/consent/data-export.service';
import { PresenceService } from '../modules/presence/presence.service';

/**
 * Trust & legal + presence background jobs (PRD v4 §3/§5/§10). In-process
 * @Cron like every other job in this codebase (BullMQ stays dormant —
 * single-instance beta).
 */
@Injectable()
export class TrustJobs {
  private readonly logger = new Logger(TrustJobs.name);

  constructor(
    private readonly exports: DataExportService,
    private readonly presence: PresenceService,
  ) {}

  /** §5 hygiene: null out manual statuses expired for over a day. */
  @Cron('30 3 * * *', { name: 'presence-hygiene', timeZone: 'Etc/UTC' })
  async presenceHygiene() {
    try {
      const swept = await this.presence.sweepExpired();
      if (swept > 0) this.logger.log(`presence-hygiene cleared ${swept} stale rows`);
    } catch (err) {
      this.logger.error(
        `presence-hygiene failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /** Prune export ZIPs older than 30 days (links expire at 7 anyway). */
  @Cron('0 4 * * *', { name: 'exports-prune', timeZone: 'Etc/UTC' })
  async pruneExports() {
    try {
      const removed = await this.exports.pruneExports();
      if (removed > 0) this.logger.log(`exports-prune removed ${removed} objects`);
    } catch (err) {
      this.logger.error(
        `exports-prune failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}
