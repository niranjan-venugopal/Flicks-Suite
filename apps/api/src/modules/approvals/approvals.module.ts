import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { ApprovalRoutingService } from './approval-routing.service';
import { ApprovalEscalationJob } from '../../jobs/approval-escalation.job';

/**
 * Round L item 2 — approval routing + 24 h escalation. The single home of the
 * routing rules (ApprovalRoutingService) and the 15-minute sweep
 * (ApprovalEscalationJob). The job is provided HERE (not in AppModule's job
 * list) so the FAM console can inject it for the manual `run` trigger
 * without a second instance — and therefore a second cron — existing.
 * Consumers (timesheet, fam; leave / attendance / dashboard in Phase 2)
 * import this module and reach the service through ./public.ts.
 */
@Module({
  imports: [NotificationsModule],
  providers: [ApprovalRoutingService, ApprovalEscalationJob],
  exports: [ApprovalRoutingService, ApprovalEscalationJob],
})
export class ApprovalsModule {}
