import { Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { UserRole } from '@flicks/shared/types';
import { DatabaseService } from '../../database/database.service';
import { AuditService } from '../../../modules/audit/audit.service';
import { ModuleGrantGuard } from './module-grant.guard';

/**
 * Grant guard for the Invoicing module (PRD §3) — now a thin subclass of the
 * module-parameterized ModuleGrantGuard (PRD v5 §2.3). Behavior is unchanged:
 * owner/admin/finance full access by default, manager/employee none without a
 * grant, auditors via membership_grants, FAM toggle + membership liveness on
 * every /invoicing/* request. The existing invoicing test suite is the
 * regression net for this refactor.
 */
@Injectable()
export class InvoicingGrantGuard extends ModuleGrantGuard {
  // Explicit constructor required — see CrmGrantGuard: without it TypeScript
  // emits no DI metadata for the subclass and Nest injects NOTHING (this.db
  // undefined → every /invoicing/* request 500s in the running app).
  constructor(reflector: Reflector, db: DatabaseService, audit: AuditService) {
    super(reflector, db, audit);
  }

  protected readonly module = 'invoicing' as const;
  protected readonly moduleDisplayName = 'Invoicing';
  protected readonly fullAccessRoles: ReadonlySet<UserRole> = new Set<UserRole>([
    'owner',
    'admin',
    'finance',
    'super_admin',
    'fam',
  ]);
}
