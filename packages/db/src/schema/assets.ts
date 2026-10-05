import {
  pgTable,
  uuid,
  text,
  numeric,
  date,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { tenants, users } from './platform';
import { employees } from './employees';

// ─── Company asset register (Round P R4, migration 0068) ─────────────────────
//
// `assets` is the equipment register (laptop, phone, SIM, ID card, …): tag
// (unique per tenant among live rows), photo (private R2 key of the 256 px
// variant, 64 px derives from it like avatars), serial/brand/model, purchase
// info, `condition` and a lifecycle `status`. `assigned` is never set by
// hand — it follows the open `asset_assignments` row (at most one per asset,
// partial unique WHERE returned_at IS NULL). Returned rows are history: the
// employees module counts them in the removal footprint so a person with any
// equipment history is archived, never hard-deleted. Mirrors 0068 exactly,
// indexes included.

export const ASSET_CATEGORIES = [
  'laptop',
  'desktop',
  'monitor',
  'phone',
  'sim',
  'tablet',
  'id_card',
  'access_card',
  'keys',
  'peripheral',
  'furniture',
  'vehicle',
  'other',
] as const;
export type AssetCategory = (typeof ASSET_CATEGORIES)[number];

export const ASSET_CONDITIONS = ['new', 'good', 'fair', 'poor', 'damaged'] as const;
export type AssetCondition = (typeof ASSET_CONDITIONS)[number];

export const ASSET_STATUSES = ['in_stock', 'assigned', 'under_repair', 'retired', 'lost'] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];

export const assets = pgTable(
  'assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    asset_tag: text('asset_tag').notNull(),
    name: text('name').notNull(),
    category: text('category').notNull().default('other'), // ASSET_CATEGORIES
    brand: text('brand'),
    model: text('model'),
    serial_number: text('serial_number'),
    photo_key: text('photo_key'), // 256 px variant key; 64 px derives from it
    photo_updated_at: timestamp('photo_updated_at', { withTimezone: true }),
    purchase_date: date('purchase_date'),
    purchase_value: numeric('purchase_value', { precision: 15, scale: 2 }),
    currency: text('currency').notNull().default('INR'),
    condition: text('condition').notNull().default('good'), // ASSET_CONDITIONS
    status: text('status').notNull().default('in_stock'), // ASSET_STATUSES
    notes: text('notes'),
    created_by: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updated_by: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deleted_at: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('assets_tenant_tag_unique')
      .on(t.tenant_id, t.asset_tag)
      .where(sql`${t.deleted_at} IS NULL`),
    index('idx_assets_tenant_status').on(t.tenant_id, t.status),
  ],
);

export const assetAssignments = pgTable(
  'asset_assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    asset_id: uuid('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    employee_id: uuid('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'cascade' }),
    assigned_at: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
    assigned_by: uuid('assigned_by').references(() => users.id, { onDelete: 'set null' }),
    issue_condition: text('issue_condition'), // ASSET_CONDITIONS | null
    notes: text('notes'),
    acknowledged_at: timestamp('acknowledged_at', { withTimezone: true }),
    returned_at: timestamp('returned_at', { withTimezone: true }),
    returned_by: uuid('returned_by').references(() => users.id, { onDelete: 'set null' }),
    return_condition: text('return_condition'), // ASSET_CONDITIONS | null
    return_notes: text('return_notes'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('asset_assignments_open_unique')
      .on(t.asset_id)
      .where(sql`${t.returned_at} IS NULL`),
    index('idx_asset_assignments_tenant_employee').on(t.tenant_id, t.employee_id),
    index('idx_asset_assignments_tenant_asset').on(t.tenant_id, t.asset_id),
  ],
);

export const assetsRelations = relations(assets, ({ one, many }) => ({
  tenant: one(tenants, { fields: [assets.tenant_id], references: [tenants.id] }),
  assignments: many(assetAssignments),
}));

export const assetAssignmentsRelations = relations(assetAssignments, ({ one }) => ({
  asset: one(assets, { fields: [assetAssignments.asset_id], references: [assets.id] }),
  employee: one(employees, { fields: [assetAssignments.employee_id], references: [employees.id] }),
}));

export type Asset = typeof assets.$inferSelect;
export type NewAsset = typeof assets.$inferInsert;
export type AssetAssignment = typeof assetAssignments.$inferSelect;
export type NewAssetAssignment = typeof assetAssignments.$inferInsert;
