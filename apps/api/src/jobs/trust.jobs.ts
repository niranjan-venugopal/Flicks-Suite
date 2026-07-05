import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DataExportService } from '../modules/consent/data-export.service';

/**
 * Trust & legal background jobs (PRD v4 §3/§10). In-process @Cron like every
 * other job in this codebase (BullMQ stays dormant — single-instance beta).
 */
@Injectable()
export class TrustJobs {
  private readonly logger = new Logger(TrustJobs.name);

  constructor(private readonly exports: DataExportService) {}

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
