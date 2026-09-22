import { Module } from '@nestjs/common';
import { AttendanceController } from './attendance.controller';
import { AttendanceService } from './attendance.service';
import { PresenceModule } from '../presence/presence.module';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ApprovalsModule } from '../approvals/approvals.module';
import { MediaModule } from '../media/media.module';

@Module({
  // ApprovalsModule (Round L): regularization routing + escalation state.
  // MediaModule (Round N): Team-today rows and the reviewer's regularization
  // view carry the person's photo — users.avatar_key needs signing.
  imports: [AuditModule, NotificationsModule, PresenceModule, ApprovalsModule, MediaModule],
  controllers: [AttendanceController],
  providers: [AttendanceService],
  exports: [AttendanceService],
})
export class AttendanceModule {}
