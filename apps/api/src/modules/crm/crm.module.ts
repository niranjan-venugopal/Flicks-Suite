import { Module } from '@nestjs/common';
import { DirectoryService } from './directory.service';
import { DirectoryController } from './directory.controller';
import { CrmGrantGuard } from '../../core/auth/guards/crm-grant.guard';
import { AuditModule } from '../audit/audit.module';

/**
 * CRM module (PRD v5). Sprint 25 ships the directory kernel (Contacts/
 * Companies); deals, activities, email, automation, etc. mount here in later
 * sprints. All controllers sit behind CrmGrantGuard (FAM toggle + membership
 * liveness + org-open grant model). DomainEventsService is global.
 */
@Module({
  imports: [AuditModule],
  controllers: [DirectoryController],
  providers: [DirectoryService, CrmGrantGuard],
  exports: [DirectoryService],
})
export class CrmModule {}
