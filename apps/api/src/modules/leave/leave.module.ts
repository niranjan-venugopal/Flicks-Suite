import { Module } from '@nestjs/common';
import { LeaveController } from './leave.controller';
import { LeaveService } from './leave.service';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ApprovalsModule } from '../approvals/approvals.module';
import { MediaModule } from '../media/media.module';

@Module({
  // ApprovalsModule (Round L): routing + escalation state for apply /
  // pending / team / review — consumed through modules/approvals/public.ts.
  // MediaModule (Round N): Team → Leave rows carry the requester's photo —
  // users.avatar_key needs signing.
  imports: [AuditModule, NotificationsModule, ApprovalsModule, MediaModule],
  controllers: [LeaveController],
  providers: [LeaveService],
  exports: [LeaveService],
})
export class LeaveModule {}
