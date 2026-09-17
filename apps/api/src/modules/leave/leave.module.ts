import { Module } from '@nestjs/common';
import { LeaveController } from './leave.controller';
import { LeaveService } from './leave.service';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ApprovalsModule } from '../approvals/approvals.module';

@Module({
  // ApprovalsModule (Round L): routing + escalation state for apply /
  // pending / team / review — consumed through modules/approvals/public.ts.
  imports: [AuditModule, NotificationsModule, ApprovalsModule],
  controllers: [LeaveController],
  providers: [LeaveService],
  exports: [LeaveService],
})
export class LeaveModule {}
