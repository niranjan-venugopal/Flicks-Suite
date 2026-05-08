// ─── Database clients ─────────────────────────────────────────────────────────
export { db, dbAdmin, withTenant } from './client.js';
export type { Db, DbAdmin } from './client.js';

// ─── Schema (all tables, relations, types) ────────────────────────────────────
export * from './schema/index.js';
