import { Injectable } from '@nestjs/common';
import type { UserRole } from '@flicks/shared/types';
import { ModuleGrantGuard } from './module-grant.guard';

/**
 * Grant guard for the CRM module (PRD v5 §13). Visibility model v1 is
 * org-open: every CRM-enabled standard member sees and works all records —
 * so manager/employee/finance hold a DEFAULT 'edit' level with no grant row.
 * Destructive/config surfaces (delete/merge/import, pipelines, workflows,
 * API keys) are narrowed with @Roles / capability grants on their endpoints,
 * not by this default. Auditors have NO CRM access unless granted read-only
 * (module value 'crm' in membership_grants).
 */
@Injectable()
export class CrmGrantGuard extends ModuleGrantGuard {
  protected readonly module = 'crm' as const;
  protected readonly moduleDisplayName = 'CRM';
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
