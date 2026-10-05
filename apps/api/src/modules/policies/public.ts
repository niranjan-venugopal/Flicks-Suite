import { Injectable } from '@nestjs/common';
import { PoliciesService } from './policies.service';

/**
 * Public facade for the policies module (house rule 3: cross-module imports
 * only via public.ts). Consumed by consent/data-export for the personal and
 * organisation exports — nothing else leaks.
 */
@Injectable()
export class PoliciesPublicService {
  constructor(private readonly policies: PoliciesService) {}

  /** Personal export rows: [{ policy_title, version, acknowledged_at }]. */
  exportForUser(tenantId: string, userId: string) {
    return this.policies.exportForUser(tenantId, userId);
  }

  /** Org export: { policies: [...flat rows], acknowledgements: [...flat rows] }. */
  exportForTenant(tenantId: string) {
    return this.policies.exportForTenant(tenantId);
  }
}

export type { Policy, PolicyDetail, PendingPolicy } from './policies.service';
