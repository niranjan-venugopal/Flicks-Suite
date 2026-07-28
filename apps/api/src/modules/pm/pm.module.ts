import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { CrmModule } from '../crm/crm.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PmGrantGuard } from '../../core/auth/guards/pm-grant.guard';
import { PmSyncGateway } from '../../gateways/pm-sync.gateway';
import { PmTeamsService } from './teams.service';
import { PmIssuesService } from './issues.service';
import { PmProjectsService } from './projects.service';
import { PmCyclesService } from './cycles.service';
import { PmSampleDataService } from './sample-data.service';
import { PmViewsService } from './views.service';
import { PmSearchService } from './search.service';
import { PmController } from './pm.controller';
import { PmVisibilityService } from './sync/visibility.service';
import { PmSyncService } from './sync/sync.service';
import { PmMutationExecutor } from './sync/mutation-executor.service';
import { PmSyncThrottleGuard } from './sync/sync-throttle.guard';
import { PmSyncController } from './sync/sync.controller';
import { GithubAppService } from './github-app.service';
import { PmImportService } from './import.service';
import { PmTemplatesService } from './templates.service';
import { PmPublicService } from './public';
import { PmGithubService } from './github.service';
import { GithubWebhookController } from './github-webhook.controller';

/**
 * PM — Projects module (PRD v6). Ships behind the `pm` tenant toggle +
 * membership grants; the sync engine additionally sits behind the
 * `pm_sync_engine` FAM flag (kill-switch → the same UI on plain REST).
 */
@Module({
  imports: [AuditModule, CrmModule, NotificationsModule],
  controllers: [PmController, PmSyncController, GithubWebhookController],
  providers: [
    PmGrantGuard,
    PmSyncGateway,
    PmTeamsService,
    PmIssuesService,
    PmProjectsService,
    PmCyclesService,
    PmSampleDataService,
    PmViewsService,
    PmSearchService,
    PmVisibilityService,
    PmSyncService,
    PmMutationExecutor,
    PmSyncThrottleGuard,
    GithubAppService,
    PmGithubService,
    PmImportService,
    PmTemplatesService,
    PmPublicService,
  ],
  exports: [PmTeamsService, PmIssuesService, PmProjectsService, PmCyclesService, PmPublicService],
})
export class PmModule {}
