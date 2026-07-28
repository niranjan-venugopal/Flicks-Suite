import { Module } from '@nestjs/common';
import { ApiKeysService } from './api-keys.service';
import { ApiKeysController } from './api-keys.controller';
import { PublicV1Controller } from './public-v1.controller';
import { ApiKeyGuard } from './api-key.guard';
import { AuditModule } from '../audit/audit.module';
import { CrmModule } from '../crm/crm.module';
import { PmModule } from '../pm/pm.module';

/**
 * Public API framework (PRD v5 §11): key management (app API, Owner/Admin) +
 * the key-authenticated /api/public/v1 surface with the CRM resources
 * (people/companies/deals/leads) mounted since Sprint 30.
 */
@Module({
  imports: [AuditModule, CrmModule, PmModule],
  controllers: [ApiKeysController, PublicV1Controller],
  providers: [ApiKeysService, ApiKeyGuard],
  exports: [ApiKeysService],
})
export class PublicApiModule {}
