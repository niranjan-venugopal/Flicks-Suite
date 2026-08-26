import { Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DatabaseService } from '../../database/database.service';
import { AuditService } from '../../../modules/audit/audit.service';
import { ModuleAccessService } from '../module-access.service';
import { ModuleGrantGuard } from './module-grant.guard';

/**
 * Grant guard for the CRM module (PRD v5 §13). Visibility model v1 is
 * org-open: every CRM-enabled standard member sees and works all records — so
 * manager/employee/finance hold a DEFAULT 'edit' level with no grant row
 * (ModuleAccessService.builtInDefault). An Owner can narrow that per role
 * (Settings → Module access) or per person (an explicit grant row, which wins).
 * Destructive/config surfaces (delete/merge/import, pipelines, workflows, API
 * keys) are narrowed with @Roles on their endpoints, not by this default.
 * Auditors have NO CRM access unless granted read-only.
 */
@Injectable()
export class CrmGrantGuard extends ModuleGrantGuard {
  // An explicit constructor is REQUIRED on every ModuleGrantGuard subclass:
  // TypeScript only emits DI parameter metadata for classes that declare their
  // own constructor, so without this Nest instantiates the guard with ZERO
  // dependencies and every request dies on `this.db` being undefined.
  constructor(
    reflector: Reflector,
    db: DatabaseService,
    audit: AuditService,
    access: ModuleAccessService,
  ) {
    super(reflector, db, audit, access);
  }

  protected readonly module = 'crm' as const;
  protected readonly moduleDisplayName = 'CRM';
}
