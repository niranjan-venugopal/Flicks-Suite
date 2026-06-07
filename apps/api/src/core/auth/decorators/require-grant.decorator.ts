import { SetMetadata } from '@nestjs/common';

/**
 * Invoicing v3 grant requirement (PRD §3.2/§3.3).
 *
 * Declares the module + access level (and optional capability) an endpoint
 * needs. The InvoicingGrantGuard resolves this against the role hierarchy for
 * standard tenant roles and against `membership_grants` for the `auditor` role.
 *
 *   @RequireGrant('invoicing', 'view')
 *   @RequireGrant('invoicing', 'edit', 'send')
 */
export type GrantModule =
  | 'invoicing'
  | 'reports'
  | 'org_financial'
  | 'payroll'
  | 'expenses';

export type GrantLevel = 'view' | 'edit';

export interface GrantRequirement {
  module: GrantModule;
  level: GrantLevel;
  capability?: string;
}

export const REQUIRE_GRANT_KEY = 'require_grant';

export const RequireGrant = (
  module: GrantModule,
  level: GrantLevel,
  capability?: string,
) => SetMetadata(REQUIRE_GRANT_KEY, { module, level, capability });
