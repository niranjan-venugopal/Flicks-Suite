import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DatabaseService } from '../core/database/database.service';

/**
 * Accrues leave balances per leave-type policy (monthly/quarterly/annually).
 * For monthly accrual, runs at 00:30 on the 1st of every month and credits
 * the configured monthly amount to every active employee's leave_balances.
 */
@Injectable()
export class LeaveAccrualJob {
  private readonly logger = new Logger(LeaveAccrualJob.name);

  constructor(private readonly databaseService: DatabaseService) {}

  /**
   * Runs at 00:30 on the 1st of every month.
   * Cron: '30 0 1 * *'
   */
  @Cron('30 0 1 * *', {
    name: 'leave-accrual-monthly',
    timeZone: 'Asia/Kolkata',
  })
  async runMonthlyAccrual(): Promise<void> {
    const startedAt = Date.now();
    this.logger.log('Starting monthly leave accrual');

    try {
      // TODO:
      //   1. For each active tenant, scan leave_types where accrual_method in
      //      ('monthly', 'per_working_day').
      //   2. For each active employee, credit pro-rated accrual to leave_balances
      //      for the current leave_year.
      //   3. Update leave_balances.last_accrued_at.
      //   4. Skip employees whose date_of_joining is in the future or who are inactive.

      this.logger.log(
        `Monthly leave accrual finished in ${Date.now() - startedAt}ms`,
      );
    } catch (err) {
      this.logger.error('Monthly leave accrual failed', err as Error);
      throw err;
    }
  }

  /**
   * Quarterly + annual accrual sweep — runs on the 1st of every month at 01:00
   * and is a no-op for tenants whose policies are not currently due.
   */
  @Cron(CronExpression.EVERY_1ST_DAY_OF_MONTH_AT_MIDNIGHT, {
    name: 'leave-accrual-periodic',
    timeZone: 'Asia/Kolkata',
  })
  async runPeriodicAccrual(): Promise<void> {
    this.logger.log('Starting periodic (quarterly/annual) leave accrual sweep');

    try {
      // TODO: handle quarterly + annual methods, anniversary-based accruals,
      // and carry-forward computations at year boundary.
    } catch (err) {
      this.logger.error('Periodic leave accrual failed', err as Error);
      throw err;
    }
  }
}
