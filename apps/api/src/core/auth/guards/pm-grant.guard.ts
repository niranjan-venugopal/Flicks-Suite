import { Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DatabaseService } from '../../database/database.service';
import { AuditService } from '../../../modules/audit/audit.service';
import { ModuleAccessService } from '../module-access.service';
import { ModuleGrantGuard } from './module-grant.guard';

/**
 * Grant guard for the PM (Projects) module — PRD v6 §16.
 * Org-open like CRM: every pm-enabled standard member holds a DEFAULT 'edit'
 * level (ModuleAccessService.builtInDefault), narrowable per role or per
 * person by an Owner. Team-level narrowing (private teams, lead-only settings)
 * is enforced in the services via the visibility layer — this guard gates
 * module access + auditor read-only.
 *
 * GUESTS (round 7) sit at 'none' by default: the project-scoped guest invite
 * writes a membership_grants {module:'pm', access_level:'edit'} row, so module
 * access is grant-row-driven (revoking deletes the row) and per-project
 * visibility/write scoping is enforced by PmVisibilityService in the services —
 * every NEW PM mutation route must call the guest asserts.
 */
@Injectable()
export class PmGrantGuard extends ModuleGrantGuard {
  // Explicit constructor REQUIRED on every ModuleGrantGuard subclass — TS only
  // emits DI parameter metadata for classes declaring their own constructor.
  constructor(
    reflector: Reflector,
    db: DatabaseService,
    audit: AuditService,
    access: ModuleAccessService,
  ) {
    super(reflector, db, audit, access);
  }

  protected readonly module = 'pm' as const;
  protected readonly moduleDisplayName = 'Projects';
}
