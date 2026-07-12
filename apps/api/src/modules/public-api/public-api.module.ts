import { Module } from '@nestjs/common';
import { ApiKeysService } from './api-keys.service';
import { ApiKeysController } from './api-keys.controller';
import { PublicV1Controller } from './public-v1.controller';
import { ApiKeyGuard } from './api-key.guard';
import { AuditModule } from '../audit/audit.module';

/**
 * Public API framework (PRD v5 §11): key management (app API, Owner/Admin) +
 * the key-authenticated /api/public/v1 surface. CRM resource endpoints mount
 * onto this module in Sprint 30.
 */
@Module({
  imports: [AuditModule],
  controllers: [ApiKeysController, PublicV1Controller],
  providers: [ApiKeysService, ApiKeyGuard],
  exports: [ApiKeysService],
})
export class PublicApiModule {}
