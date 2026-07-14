import { Module } from '@nestjs/common';
import { DirectoryService } from './directory.service';
import { DirectoryController } from './directory.controller';
import { DealsService } from './deals.service';
import { DealsController } from './deals.controller';
import { CrmConfigController } from './crm-config.controller';
import { CustomFieldsService } from './custom-fields.service';
import { SavedViewsService } from './saved-views.service';
import { SearchService } from './search.service';
import { TagsService } from './tags.service';
import { ActivitiesService } from './activities.service';
import { ActivitiesController } from './activities.controller';
import { PipelinesService } from './pipelines.service';
import { FxService } from './fx.service';
import { FxRefreshJob } from './fx.job';
import { CrmGateway } from '../../gateways/crm.gateway';
import { CrmEventsSubscriber } from './crm-events.subscriber';
import { CrmGrantGuard } from '../../core/auth/guards/crm-grant.guard';
import { AuditModule } from '../audit/audit.module';
import { InvoicingModule } from '../invoicing/invoicing.module';

/**
 * CRM module (PRD v5). Sprint 25: directory kernel (Contacts/Companies).
 * Sprint 26: pipelines, deals + kanban board (FX-aware, socket-broadcast),
 * forecast. Later sprints add activities, email, automation, capture, reports.
 * All controllers sit behind CrmGrantGuard; DomainEventsService is global.
 */
@Module({
  // InvoicingModule provides the InvoicingPublicService facade (deal→invoice).
  imports: [AuditModule, InvoicingModule],
  controllers: [DirectoryController, DealsController, CrmConfigController, ActivitiesController],
  providers: [
    DirectoryService,
    DealsService,
    PipelinesService,
    CustomFieldsService,
    SavedViewsService,
    SearchService,
    TagsService,
    ActivitiesService,
    FxService,
    FxRefreshJob,
    CrmGateway,
    CrmEventsSubscriber,
    CrmGrantGuard,
  ],
  exports: [DirectoryService, DealsService, FxService],
})
export class CrmModule {}
