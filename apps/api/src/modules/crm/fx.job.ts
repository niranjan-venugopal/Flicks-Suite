import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { FxService } from './fx.service';

/**
 * Daily FX refresh (PRD v5 §12.1) — replaces the old refresh-fx-rates stub.
 * No-op without OPENEXCHANGERATES_APP_ID; also runs once at boot so a fresh
 * deploy has rates before the first daily tick.
 */
@Injectable()
export class FxRefreshJob {
  private readonly logger = new Logger(FxRefreshJob.name);

  constructor(private readonly fx: FxService) {
    void this.fx.refresh().catch(() => undefined);
  }

  @Cron(CronExpression.EVERY_DAY_AT_2AM, { name: 'crm-fx-refresh' })
  async refresh(): Promise<void> {
    const n = await this.fx.refresh();
    if (n > 0) this.logger.log(`crm-fx-refresh: ${n} rates updated`);
  }
}
