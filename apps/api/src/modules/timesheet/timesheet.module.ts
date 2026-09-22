import { Module } from '@nestjs/common';
import { TimesheetController } from './timesheet.controller';
import { TimesheetService } from './timesheet.service';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ApprovalsModule } from '../approvals/approvals.module';
import { MediaModule } from '../media/media.module';

@Module({
  // ApprovalsModule (Round L): routing + escalation state for submit /
  // pending / review — consumed through modules/approvals/public.ts.
  // MediaModule (Round N): the team list and the utilization report render
  // faces — users.avatar_key is a private R2 key and needs signing.
  imports: [AuditModule, NotificationsModule, ApprovalsModule, MediaModule],
  controllers: [TimesheetController],
  providers: [TimesheetService],
  exports: [TimesheetService],
})
export class TimesheetModule {}
