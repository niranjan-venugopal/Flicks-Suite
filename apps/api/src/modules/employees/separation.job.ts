import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { runsWorkloads } from '../../core/worker/worker-mode';
import { EmployeesService } from './employees.service';

/**
 * Round Q — finishes notice periods. Someone off-boarded "with notice" keeps
 * working until their last working day; the hour after that day ends in the
 * company's timezone this job marks them separated, deactivates their seat and
 * signs them out of the company (EmployeesService.completeDueSeparations).
 */
@Injectable()
export class SeparationJob {
  private readonly logger = new Logger(SeparationJob.name);

  constructor(private readonly employees: EmployeesService) {}

  @Cron('7 * * * *', { name: 'notice-period-separation', timeZone: 'UTC' })
  async tick(): Promise<void> {
    if (!runsWorkloads()) return;
    try {
      const r = await this.employees.completeDueSeparations(new Date());
      if (r.separated || r.failed) {
        this.logger.log(
          `notice-period-separation: ${r.separated} separated, ${r.failed} failed of ${r.scanned} on notice`,
        );
      }
    } catch (err) {
      this.logger.error(
        `notice-period-separation failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}
