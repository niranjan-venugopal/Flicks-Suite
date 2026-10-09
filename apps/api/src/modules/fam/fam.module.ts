import { Module } from '@nestjs/common';
import { FamController } from './fam.controller';
import { FamService } from './fam.service';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { MediaModule } from '../media/media.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ApprovalsModule } from '../approvals/approvals.module';
import { BillingModule } from '../billing/public';
import { EmployeesModule } from '../employees/employees.module';
import { BillingStateModule } from '../../core/billing/billing-state.module';

@Module({
  // ApprovalsModule (Round L): the manual escalation-sweep trigger.
  // Round R R2: BillingModule (free months, subscription panel),
  // EmployeesModule (resend invite facade), BillingStateModule (cache
  // invalidation after trial / status changes).
  imports: [
    AuditModule,
    AuthModule,
    MediaModule,
    NotificationsModule,
    ApprovalsModule,
    BillingModule,
    EmployeesModule,
    BillingStateModule,
  ],
  controllers: [FamController],
  providers: [FamService],
  exports: [FamService],
})
export class FamModule {}
