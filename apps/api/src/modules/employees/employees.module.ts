import { Module } from '@nestjs/common';
import { EmployeesController } from './employees.controller';
import { EmployeesService } from './employees.service';
import { EmployeesPublicService } from './public';
import { SeparationJob } from './separation.job';
import { OnboardingEscalationJob } from './onboarding-escalation.job';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuthModule } from '../auth/auth.module';
import { MediaModule } from '../media/media.module';

@Module({
  imports: [AuditModule, NotificationsModule, AuthModule, MediaModule],
  controllers: [EmployeesController],
  // Round Q: SeparationJob ends notice periods hourly; OnboardingEscalationJob
  // moves onboarding approvals waiting over 24 hours up a level.
  providers: [EmployeesService, SeparationJob, OnboardingEscalationJob, EmployeesPublicService],
  exports: [EmployeesService, EmployeesPublicService],
})
export class EmployeesModule {}
