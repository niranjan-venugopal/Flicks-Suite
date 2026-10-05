import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
// Round P R3: the data exports read company-policy acknowledgements through
// PoliciesPublicService (modules/policies/public.ts) — the module import is
// what puts that provider in scope for DataExportService.
import { PoliciesModule } from '../policies/policies.module';
import { ConsentController } from './consent.controller';
import { ConsentService } from './consent.service';
import { DataExportService } from './data-export.service';

/**
 * Trust & legal module (PRD v4 §3): consent ledger, unsubscribe, data exports.
 * ConsentService is exported for the auth signup path (clickwrap rows) and the
 * analytics consent gate.
 */
@Module({
  imports: [AuditModule, NotificationsModule, PoliciesModule],
  controllers: [ConsentController],
  providers: [ConsentService, DataExportService],
  exports: [ConsentService, DataExportService],
})
export class ConsentModule {}
