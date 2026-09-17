import { Module } from '@nestjs/common';
import { FamController } from './fam.controller';
import { FamService } from './fam.service';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { MediaModule } from '../media/media.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ApprovalsModule } from '../approvals/approvals.module';

@Module({
  // ApprovalsModule (Round L): the manual escalation-sweep trigger.
  imports: [AuditModule, AuthModule, MediaModule, NotificationsModule, ApprovalsModule],
  controllers: [FamController],
  providers: [FamService],
  exports: [FamService],
})
export class FamModule {}
