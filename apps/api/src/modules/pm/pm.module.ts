import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PmGrantGuard } from '../../core/auth/guards/pm-grant.guard';
import { PmSyncGateway } from '../../gateways/pm-sync.gateway';
import { PmTeamsService } from './teams.service';
import { PmIssuesService } from './issues.service';
import { PmController } from './pm.controller';
import { PmVisibilityService } from './sync/visibility.service';
import { PmSyncService } from './sync/sync.service';
import { PmMutationExecutor } from './sync/mutation-executor.service';
import { PmSyncController } from './sync/sync.controller';

/**
 * PM — Projects module (PRD v6). Ships behind the `pm` tenant toggle +
 * membership grants; the sync engine additionally sits behind the
 * `pm_sync_engine` FAM flag (kill-switch → the same UI on plain REST).
 */
@Module({
  imports: [AuditModule],
  controllers: [PmController, PmSyncController],
  providers: [
    PmGrantGuard,
    PmSyncGateway,
    PmTeamsService,
    PmIssuesService,
    PmVisibilityService,
    PmSyncService,
    PmMutationExecutor,
  ],
  exports: [PmTeamsService, PmIssuesService],
})
export class PmModule {}
