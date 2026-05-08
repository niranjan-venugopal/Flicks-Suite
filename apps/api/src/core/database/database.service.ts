import { Injectable } from '@nestjs/common';
import { withTenant, Db } from '@flicks/db';

@Injectable()
export class DatabaseService {
  /**
   * Runs a callback inside a transaction where app.tenant_id is set,
   * ensuring RLS policies are enforced for the given tenantId.
   */
  async withTenant<T>(
    tenantId: string,
    callback: (tx: Db) => Promise<T>,
  ): Promise<T> {
    return withTenant(tenantId, callback);
  }
}
