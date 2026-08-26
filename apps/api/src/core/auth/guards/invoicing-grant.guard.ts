import { Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DatabaseService } from '../../database/database.service';
import { AuditService } from '../../../modules/audit/audit.service';
import { ModuleAccessService } from '../module-access.service';
import { ModuleGrantGuard } from './module-grant.guard';

/**
 * Grant guard for the Invoicing module (PRD §3) — a thin subclass of the
 * module-parameterized ModuleGrantGuard. Owner/admin/finance hold full access
 * by role, manager/employee none without a grant, auditors via
 * membership_grants; the FAM toggle + membership liveness are re-checked on
 * every /invoicing/* request. The access rules themselves live in
 * ModuleAccessService (FULL_ACCESS_ROLES / builtInDefault).
 */
@Injectable()
export class InvoicingGrantGuard extends ModuleGrantGuard {
  // Explicit constructor required — see CrmGrantGuard: without it TypeScript
  // emits no DI metadata for the subclass and Nest injects NOTHING (this.db
  // undefined → every /invoicing/* request 500s in the running app).
  constructor(
    reflector: Reflector,
    db: DatabaseService,
    audit: AuditService,
    access: ModuleAccessService,
  ) {
    super(reflector, db, audit, access);
  }

  protected readonly module = 'invoicing' as const;
  protected readonly moduleDisplayName = 'Invoicing';
}
