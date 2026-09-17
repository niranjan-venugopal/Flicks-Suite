import { Module } from '@nestjs/common';
import { TimesheetController } from './timesheet.controller';
import { TimesheetService } from './timesheet.service';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ApprovalsModule } from '../approvals/approvals.module';

@Module({
  // ApprovalsModule (Round L): routing + escalation state for submit /
  // pending / review — consumed through modules/approvals/public.ts.
  imports: [AuditModule, NotificationsModule, ApprovalsModule],
  controllers: [TimesheetController],
  providers: [TimesheetService],
  exports: [TimesheetService],
})
export class TimesheetModule {}
