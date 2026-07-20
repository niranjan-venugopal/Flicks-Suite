import { Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { UserRole } from '@flicks/shared/types';
import { DatabaseService } from '../../database/database.service';
import { AuditService } from '../../../modules/audit/audit.service';
import { ModuleGrantGuard } from './module-grant.guard';

/**
 * Grant guard for the PM (Projects) module — PRD v6 §16.
 * Org-open like CRM: every pm-enabled standard member holds a DEFAULT 'edit'
 * level (issues/comments in public or member teams). Team-level narrowing
 * (private teams, lead-only settings) is enforced in the services via the
 * visibility layer — this guard gates module access + auditor read-only.
 * Auditors get 'view' ONLY via an explicit membership_grants row ('pm') and
 * every mutation is rejected server-side regardless.
 */
@Injectable()
export class PmGrantGuard extends ModuleGrantGuard {
  // Explicit constructor REQUIRED on every ModuleGrantGuard subclass — TS only
  // emits DI parameter metadata for classes declaring their own constructor.
  constructor(reflector: Reflector, db: DatabaseService, audit: AuditService) {
    super(reflector, db, audit);
  }

  protected readonly module = 'pm' as const;
  protected readonly moduleDisplayName = 'Projects';
  protected readonly fullAccessRoles: ReadonlySet<UserRole> = new Set<UserRole>([
    'owner',
    'admin',
    'super_admin',
    'fam',
  ]);

  protected override defaultLevelForRole(role: UserRole): 'none' | 'view' | 'edit' {
    if (role === 'manager' || role === 'employee' || role === 'finance') return 'edit';
    return 'none'; // auditor & anything else: explicit grants only
  }
}
