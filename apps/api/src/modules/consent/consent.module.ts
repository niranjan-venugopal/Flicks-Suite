import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ConsentController } from './consent.controller';
import { ConsentService } from './consent.service';
import { DataExportService } from './data-export.service';

/**
 * Trust & legal module (PRD v4 §3): consent ledger, unsubscribe, data exports.
 * ConsentService is exported for the auth signup path (clickwrap rows) and the
 * analytics consent gate.
 */
@Module({
  imports: [AuditModule, NotificationsModule],
  controllers: [ConsentController],
  providers: [ConsentService, DataExportService],
  exports: [ConsentService, DataExportService],
})
export class ConsentModule {}
