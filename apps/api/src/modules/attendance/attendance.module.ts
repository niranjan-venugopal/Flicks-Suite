import { Module } from '@nestjs/common';
import { AttendanceController } from './attendance.controller';
import { AttendanceService } from './attendance.service';
import { PresenceModule } from '../presence/presence.module';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ApprovalsModule } from '../approvals/approvals.module';

@Module({
  // ApprovalsModule (Round L): regularization routing + escalation state.
  imports: [AuditModule, NotificationsModule, PresenceModule, ApprovalsModule],
  controllers: [AttendanceController],
  providers: [AttendanceService],
  exports: [AttendanceService],
})
export class AttendanceModule {}
