import { Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DatabaseService } from '../../database/database.service';
import { AuditService } from '../../../modules/audit/audit.service';
import { ModuleAccessService } from '../module-access.service';
import { ModuleGrantGuard } from './module-grant.guard';

/**
 * Grant guard for the company-policies module (Round P R3). Owners and
 * Admins (HR) hold it by role (FULL_ACCESS_ROLES.policies); every other seat
 * starts at 'none' (ModuleAccessService.builtInDefault) and is let in per
 * person from Settings → Access — that is how "any position the Owner gives
 * access to" manages policies. The self-service routes (pending / acknowledge
 * / my history) are deliberately NOT behind this guard: every tenant member
 * must be able to read and agree to what applies to them.
 */
@Injectable()
export class PoliciesGrantGuard extends ModuleGrantGuard {
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

  protected readonly module = 'policies' as const;
  protected readonly moduleDisplayName = 'Policies';
  // Security audit 2026-10-06: external auditors (a CA firm) and project
  // guests never manage or read company policies, even if a grant row or a
  // role default says otherwise. Members' own self-service routes carry no
  // @RequireGrant and are unaffected (they already return [] for these seats).
  protected readonly excludedRoles = ['auditor', 'guest'] as const;
}
