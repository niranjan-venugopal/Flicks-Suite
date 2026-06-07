import { Injectable } from '@nestjs/common';
import { withTenant, Db } from '@flicks/db';

@Injectable()
export class DatabaseService {
  /**
   * Runs a callback inside a transaction where app.tenant_id (and optionally
   * app.user_id) is set, ensuring RLS policies are enforced for the given
   * tenantId. Pass `userId` for user-scoped policies (e.g. the auditor
   * company-switcher memberships self-visibility policy).
   */
  async withTenant<T>(
    tenantId: string,
    callback: (tx: Db) => Promise<T>,
    userId?: string,
  ): Promise<T> {
    return withTenant(tenantId, callback, userId);
  }
}
