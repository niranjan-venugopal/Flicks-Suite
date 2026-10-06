import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { runsWorkloads } from '../../core/worker/worker-mode';
import { EmployeesService } from './employees.service';

/**
 * Round Q — onboarding approvals waiting over 24 hours escalate to the HR
 * admin's reporting manager (when they are an Owner / HR admin) or else the
 * Owners (EmployeesService.escalateStaleOnboarding). Same 15-minute cadence as
 * the leave / regularization / timesheet ApprovalEscalationJob.
 */
@Injectable()
export class OnboardingEscalationJob {
  private readonly logger = new Logger(OnboardingEscalationJob.name);

  constructor(private readonly employees: EmployeesService) {}

  @Cron('*/15 * * * *', { name: 'onboarding-escalation', timeZone: 'UTC' })
  async tick(): Promise<void> {
    if (!runsWorkloads()) return;
    try {
      const r = await this.employees.escalateStaleOnboarding(new Date());
      if (r.escalated || r.failed) {
        this.logger.log(
          `onboarding-escalation: ${r.escalated} escalated, ${r.failed} failed of ${r.scanned} waiting over 24h`,
        );
      }
    } catch (err) {
      this.logger.error(`onboarding-escalation failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}
