import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PoliciesGrantGuard } from '../../core/auth/guards/policies-grant.guard';
import { PoliciesController } from './policies.controller';
import { PoliciesService } from './policies.service';
import { PoliciesPublicService } from './public';

/**
 * Company policies (Round P R3) — rich-text / PDF policies, publish,
 * acknowledgement gate, HR signed/pending + reminders. Storage (R2),
 * database and module-access services come from the global core modules.
 * PoliciesPublicService is exported for consent/data-export.
 */
@Module({
  imports: [AuditModule, NotificationsModule],
  controllers: [PoliciesController],
  providers: [PoliciesGrantGuard, PoliciesService, PoliciesPublicService],
  exports: [PoliciesPublicService],
})
export class PoliciesModule {}
