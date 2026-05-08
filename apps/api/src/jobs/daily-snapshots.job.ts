import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DatabaseService } from '../core/database/database.service';

/**
 * Computes per-employee, per-tenant attendance and tenant-health snapshots
 * for the previous calendar day. Designed to be idempotent — safe to re-run.
 */
@Injectable()
export class DailySnapshotsJob {
  private readonly logger = new Logger(DailySnapshotsJob.name);

  constructor(private readonly databaseService: DatabaseService) {}

  /**
   * Runs every day at 01:00 UTC.
   * - Closes any open attendance_records from the previous day (mark absent if no punches).
   * - Computes total_worked_minutes / late / overtime for each employee record.
   * - Upserts a tenant_health_snapshots row per active tenant.
   */
  @Cron(CronExpression.EVERY_DAY_AT_1AM, {
    name: 'daily-snapshots',
    timeZone: 'UTC',
  })
  async computeDailySnapshots(): Promise<void> {
    const startedAt = Date.now();
    this.logger.log('Starting daily snapshot computation');

    try {
      // TODO: For each active tenant, run within tenant context:
      //   1. Close open attendance_records for yesterday (status defaults to 'absent').
      //   2. Compute aggregates from attendance_punches.
      //   3. Insert a tenant_health_snapshots row (active_users_7d/30d, attendance_compliance, signal).
      //
      // Use this.databaseService.withTenant(tenantId, async (tx) => {...}) for each tenant.

      this.logger.log(
        `Daily snapshot computation finished in ${Date.now() - startedAt}ms`,
      );
    } catch (err) {
      this.logger.error('Daily snapshot computation failed', err as Error);
      throw err;
    }
  }
}
