import { Module } from '@nestjs/common';
import { DirectoryService } from './directory.service';
import { DirectoryController } from './directory.controller';
import { DealsService } from './deals.service';
import { DealsController } from './deals.controller';
import { PipelinesService } from './pipelines.service';
import { FxService } from './fx.service';
import { FxRefreshJob } from './fx.job';
import { CrmGateway } from '../../gateways/crm.gateway';
import { CrmGrantGuard } from '../../core/auth/guards/crm-grant.guard';
import { AuditModule } from '../audit/audit.module';

/**
 * CRM module (PRD v5). Sprint 25: directory kernel (Contacts/Companies).
 * Sprint 26: pipelines, deals + kanban board (FX-aware, socket-broadcast),
 * forecast. Later sprints add activities, email, automation, capture, reports.
 * All controllers sit behind CrmGrantGuard; DomainEventsService is global.
 */
@Module({
  imports: [AuditModule],
  controllers: [DirectoryController, DealsController],
  providers: [
    DirectoryService,
    DealsService,
    PipelinesService,
    FxService,
    FxRefreshJob,
    CrmGateway,
    CrmGrantGuard,
  ],
  exports: [DirectoryService, DealsService, FxService],
})
export class CrmModule {}
