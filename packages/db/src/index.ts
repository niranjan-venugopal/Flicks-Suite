// ─── Database clients ─────────────────────────────────────────────────────────
export { db, dbAdmin, withTenant, assertTenantIsolation } from './client';
export type { Db, DbAdmin } from './client';

// ─── Schema (all tables, relations, types) ────────────────────────────────────
export * from './schema/index';
