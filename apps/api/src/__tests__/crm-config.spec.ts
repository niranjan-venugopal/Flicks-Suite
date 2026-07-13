import 'dotenv/config';
import * as crypto from 'crypto';
import { eq } from 'drizzle-orm';
import { db, dbAdmin } from '@flicks/db';
import {
  customFieldDefs,
  deals,
  directoryCompanies,
  directoryPeople,
  pipelines,
  pipelineStages,
  savedViews,
  tenants,
  users,
} from '@flicks/db/schema';
import { DatabaseService } from '../core/database/database.service';
import { AuditService } from '../modules/audit/audit.service';
import { CustomFieldsService } from '../modules/crm/custom-fields.service';
import { SavedViewsService } from '../modules/crm/saved-views.service';
import { SearchService } from '../modules/crm/search.service';

/**
 * PRD v5 §9.1-9.2 + §19.8 — custom fields, saved views, global search
 * (Sprint 27). Real-Postgres: field CRUD + de-dup, view owner/shared visibility
 * and owner-only mutation, ⌘K search across companies/people/deals, isolation.
 */

const rid = () => crypto.randomBytes(4).toString('hex');
const dbSvc = new DatabaseService();
const audit = new AuditService(db as never, dbAdmin as never, dbSvc);
const fields = new CustomFieldsService(dbSvc, audit);
const views = new SavedViewsService(dbSvc, audit);
const search = new SearchService(dbSvc);

let tenantA: string;
let tenantB: string;
let userA: string;
let userB: string;

beforeAll(async () => {
  const [ua] = await dbAdmin.insert(users).values({ email: `cfg-a-${rid()}@test.test`, full_name: 'Cfg A', status: 'active' }).returning();
  const [ub] = await dbAdmin.insert(users).values({ email: `cfg-b-${rid()}@test.test`, full_name: 'Cfg B', status: 'active' }).returning();
  userA = ua!.id;
  userB = ub!.id;
  const [ta] = await dbAdmin.insert(tenants).values({ name: `Cfg${rid()}`, slug: `cfg-${rid()}-${Date.now()}`, status: 'active', currency: 'INR' }).returning();
  const [tb] = await dbAdmin.insert(tenants).values({ name: `Cfg${rid()}`, slug: `cfg-${rid()}-${Date.now()}b`, status: 'active', currency: 'INR' }).returning();
  tenantA = ta!.id;
  tenantB = tb!.id;
});

afterAll(async () => {
  await dbAdmin.delete(tenants).where(eq(tenants.id, tenantA));
  await dbAdmin.delete(tenants).where(eq(tenants.id, tenantB));
  await dbAdmin.delete(users).where(eq(users.id, userA));
  await dbAdmin.delete(users).where(eq(users.id, userB));
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
});

describe('Custom fields (§9.1)', () => {
  it('creates a field, derives a snake_case key, and rejects duplicates', async () => {
    const f = await fields.create(tenantA, userA, { object_type: 'deal', label: 'Contract Value!', field_type: 'number' });
    expect(f.data.key).toBe('contract_value');
    expect(f.data.field_type).toBe('number');
    await expect(
      fields.create(tenantA, userA, { object_type: 'deal', label: 'Contract Value', field_type: 'text' }),
    ).rejects.toThrow(/already exists/i);
  });

  it('rejects invalid object_type / field_type', async () => {
    await expect(fields.create(tenantA, userA, { object_type: 'widget', label: 'X', field_type: 'text' })).rejects.toThrow(/object_type/i);
    await expect(fields.create(tenantA, userA, { object_type: 'deal', label: 'Y', field_type: 'rainbow' })).rejects.toThrow(/field_type/i);
  });

  it('lists active fields scoped to an object type and hides archived ones', async () => {
    const f = await fields.create(tenantA, userA, { object_type: 'person', label: 'LinkedIn', field_type: 'url' });
    const personFields = await fields.list(tenantA, 'person');
    expect(personFields.data.some((x) => x.key === 'linkedin')).toBe(true);
    // Archiving removes it from the active list but keeps the row.
    await fields.archive(tenantA, userA, f.data.id);
    const after = await fields.list(tenantA, 'person');
    expect(after.data.some((x) => x.id === f.data.id)).toBe(false);
    const [row] = await dbAdmin.select().from(customFieldDefs).where(eq(customFieldDefs.id, f.data.id));
    expect(row!.archived).toBe(true);
  });

  it('does not leak field defs across tenants', async () => {
    await fields.create(tenantB, userB, { object_type: 'deal', label: 'B Secret', field_type: 'text' });
    const aFields = await fields.list(tenantA, 'deal');
    expect(aFields.data.every((x) => x.tenant_id === tenantA)).toBe(true);
    expect(aFields.data.some((x) => x.key === 'b_secret')).toBe(false);
  });
});

describe('Saved views (§9.2)', () => {
  it('shows a user their own + shared views but not others’ private ones', async () => {
    const mine = await views.create(tenantA, userA, { object_type: 'deal', name: 'My private board' });
    const shared = await views.create(tenantA, userB, { object_type: 'deal', name: 'Team board', is_shared: true });
    const secret = await views.create(tenantA, userB, { object_type: 'deal', name: 'B private', is_shared: false });

    const visible = await views.list(tenantA, userA, 'deal');
    const ids = visible.data.map((v) => v.id);
    expect(ids).toContain(mine.data.id);
    expect(ids).toContain(shared.data.id);
    expect(ids).not.toContain(secret.data.id);
  });

  it('lets only the owner edit or delete a view', async () => {
    const v = await views.create(tenantA, userB, { object_type: 'company', name: 'Owned by B' });
    await expect(views.update(tenantA, userA, v.data.id, { name: 'hijack' })).rejects.toThrow(/owner/i);
    await expect(views.remove(tenantA, userA, v.data.id)).rejects.toThrow(/owner/i);
    const ok = await views.update(tenantA, userB, v.data.id, { name: 'renamed' });
    expect(ok.data.name).toBe('renamed');
    const gone = await views.remove(tenantA, userB, v.data.id);
    expect(gone.data.deleted).toBe(true);
    const [row] = await dbAdmin.select().from(savedViews).where(eq(savedViews.id, v.data.id));
    expect(row).toBeUndefined();
  });
});

describe('Global search (§19.8)', () => {
  let companyId: string;
  beforeAll(async () => {
    const uniq = rid();
    const [co] = await dbAdmin.insert(directoryCompanies).values({ tenant_id: tenantA, name: `Zephyr Logistics ${uniq}`, domain: `zephyr-${uniq}.com` }).returning();
    companyId = co!.id;
    await dbAdmin.insert(directoryPeople).values({ tenant_id: tenantA, first_name: 'Marisol', last_name: 'Vega', email: `marisol-${uniq}@zephyr.com`, company_id: companyId });
    const [pl] = await dbAdmin.insert(pipelines).values({ tenant_id: tenantA, name: 'Sales', is_default: true }).returning();
    const [st] = await dbAdmin.insert(pipelineStages).values({ tenant_id: tenantA, pipeline_id: pl!.id, name: 'Qualified', display_order: 0, win_probability: 10, stage_type: 'open' }).returning();
    await dbAdmin.insert(deals).values({ tenant_id: tenantA, pipeline_id: pl!.id, stage_id: st!.id, title: `Zephyr renewal ${uniq}`, owner_user_id: userA, currency: 'INR', value_amount: '1000', value_base_amount: '1000' });
  });

  it('finds companies by name, people by email, and deals by title', async () => {
    const r = await search.search(tenantA, 'zephyr');
    expect(r.data.companies.length).toBeGreaterThanOrEqual(1);
    expect(r.data.people.length).toBeGreaterThanOrEqual(1);
    expect(r.data.deals.length).toBeGreaterThanOrEqual(1);
    expect(r.data.companies[0]!.name.toLowerCase()).toContain('zephyr');
  });

  it('returns nothing for a too-short query', async () => {
    const r = await search.search(tenantA, 'z');
    expect(r.data.companies).toHaveLength(0);
    expect(r.data.deals).toHaveLength(0);
  });

  it('never returns another tenant’s records', async () => {
    const r = await search.search(tenantB, 'zephyr');
    expect(r.data.companies).toHaveLength(0);
    expect(r.data.people).toHaveLength(0);
    expect(r.data.deals).toHaveLength(0);
  });
});
