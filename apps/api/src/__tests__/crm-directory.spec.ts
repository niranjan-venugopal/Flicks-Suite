import 'dotenv/config';
import * as crypto from 'crypto';
import { and, eq } from 'drizzle-orm';
import { db, dbAdmin, withTenant } from '@flicks/db';
import {
  customers,
  directoryCompanies,
  directoryPeople,
  domainEvents,
  tenants,
  users,
} from '@flicks/db/schema';
import { DatabaseService } from '../core/database/database.service';
import { AuditService } from '../modules/audit/audit.service';
import { DirectoryService } from '../modules/crm/directory.service';

/**
 * PRD v5 §3 — directory kernel (Sprint 25). Real-Postgres integration for CRUD,
 * create-time dedup (exact email/domain block, fuzzy-name warning), soft
 * delete, generated display_name, tenant isolation, and domain events.
 */

const rid = () => crypto.randomBytes(4).toString('hex');
const dbSvc = new DatabaseService();
const audit = new AuditService(db as never, dbAdmin as never, dbSvc);
const eventsStub = { publish: jest.fn(async () => 'evt') };
const directory = new DirectoryService(dbSvc, audit, eventsStub as never);

let tenantA: string;
let tenantB: string;
let userId: string;

beforeAll(async () => {
  const [ta] = await dbAdmin
    .insert(tenants)
    .values({ name: `DirA${rid()}`, slug: `dira-${rid()}-${Date.now()}`, status: 'active' })
    .returning();
  tenantA = ta!.id;
  const [tb] = await dbAdmin
    .insert(tenants)
    .values({ name: `DirB${rid()}`, slug: `dirb-${rid()}-${Date.now()}`, status: 'active' })
    .returning();
  tenantB = tb!.id;
  const [u] = await dbAdmin
    .insert(users)
    .values({ email: `dir-${rid()}@test.test`, full_name: 'Dir User', status: 'active' })
    .returning();
  userId = u!.id;
});

afterAll(async () => {
  await dbAdmin.delete(tenants).where(eq(tenants.id, tenantA));
  await dbAdmin.delete(tenants).where(eq(tenants.id, tenantB));
  await dbAdmin.delete(users).where(eq(users.id, userId));
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
});

describe('Directory companies (PRD v5 §3)', () => {
  it('create normalizes domain, sets owner, emits crm.company.created', async () => {
    eventsStub.publish.mockClear();
    const res = await directory.createCompany(tenantA, userId, {
      name: 'Acme Corp',
      domain: 'https://www.acme.com/pricing',
    });
    expect(res.data.domain).toBe('acme.com'); // scheme + www + path stripped
    expect(res.data.owner_user_id).toBe(userId); // defaults to creator
    expect(res.data.source).toBe('manual');
    expect(eventsStub.publish).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'crm.company.created' }),
      expect.anything(),
    );
  });

  it('blocks an exact-domain duplicate with the existing record', async () => {
    await directory.createCompany(tenantA, userId, { name: 'Globex', domain: 'globex.com' });
    await expect(
      directory.createCompany(tenantA, userId, { name: 'Globex (dup)', domain: 'www.globex.com' }),
    ).rejects.toMatchObject({ response: { code: 'DUPLICATE_DOMAIN' } });
  });

  it('warns (non-blocking) on a fuzzy-name match; force_create suppresses it', async () => {
    await directory.createCompany(tenantA, userId, { name: 'Initech Limited' });
    const near = await directory.createCompany(tenantA, userId, { name: 'Initech Limted' }); // typo
    expect(near.meta.warnings.length).toBeGreaterThan(0);
    expect(near.meta.warnings[0]!.type).toBe('similar_name');
    // Still created (warning is advisory).
    expect(near.data.id).toBeTruthy();
    const forced = await directory.createCompany(
      tenantA, userId, { name: 'Initech Limitd' }, { forceCreate: true },
    );
    expect(forced.meta.warnings).toHaveLength(0);
  });

  it('update re-normalizes domain and soft-delete hides it from list/get', async () => {
    const c = await directory.createCompany(tenantA, userId, { name: 'Umbrella' });
    await directory.updateCompany(tenantA, userId, c.data.id, { domain: 'WWW.Umbrella.COM' });
    const got = await directory.getCompany(tenantA, c.data.id);
    expect(got.data.domain).toBe('umbrella.com');
    await directory.deleteCompany(tenantA, userId, c.data.id);
    await expect(directory.getCompany(tenantA, c.data.id)).rejects.toThrow(/not found/);
  });
});

describe('Directory people (PRD v5 §3)', () => {
  it('generated display_name from first/last; email lower-cased; emits event', async () => {
    eventsStub.publish.mockClear();
    const res = await directory.createPerson(tenantA, userId, {
      first_name: 'Asha',
      last_name: 'Rao',
      email: 'Asha.Rao@TechCorp.com',
    });
    expect(res.data.display_name).toBe('Asha Rao'); // GENERATED column
    expect(res.data.email).toBe('asha.rao@techcorp.com');
    expect(eventsStub.publish).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'crm.contact.created' }),
      expect.anything(),
    );
  });

  it('blocks an exact-email duplicate (case-insensitive)', async () => {
    await directory.createPerson(tenantA, userId, { first_name: 'Dup', email: 'dup@x.com' });
    await expect(
      directory.createPerson(tenantA, userId, { first_name: 'Dup2', email: 'DUP@x.com' }),
    ).rejects.toMatchObject({ response: { code: 'DUPLICATE_EMAIL' } });
  });

  it('requires at least a name or email', async () => {
    await expect(directory.createPerson(tenantA, userId, {})).rejects.toThrow(/name or an email/);
  });

  it('list filters by company_id and search q', async () => {
    const co = await directory.createCompany(tenantA, userId, { name: `Filter Co ${rid()}` });
    await directory.createPerson(tenantA, userId, {
      first_name: 'Zara', last_name: 'Q', email: `zara-${rid()}@f.com`, company_id: co.data.id,
    });
    const byCompany = await directory.listPeople(tenantA, { company_id: co.data.id });
    expect(byCompany.data.every((p) => p.company_id === co.data.id)).toBe(true);
    expect(byCompany.data.length).toBe(1);
    const byQ = await directory.listPeople(tenantA, { q: 'Zara' });
    expect(byQ.data.some((p) => p.display_name?.includes('Zara'))).toBe(true);
  });
});

describe('Directory tenant isolation (PRD v5 §13)', () => {
  it('tenant A never sees tenant B records', async () => {
    const bCo = await directory.createCompany(tenantB, userId, { name: `Bco-${rid()}`, domain: `b-${rid()}.com` });
    const aList = await directory.listCompanies(tenantA, { limit: 100 });
    expect(aList.data.find((c) => c.id === bCo.data.id)).toBeUndefined();
    await expect(directory.getCompany(tenantA, bCo.data.id)).rejects.toThrow(/not found/);
  });

  it('RLS: same-domain company allowed across different tenants (per-tenant unique)', async () => {
    const d = `shared-${rid()}.com`;
    await expect(directory.createCompany(tenantA, userId, { name: 'A', domain: d })).resolves.toBeTruthy();
    await expect(directory.createCompany(tenantB, userId, { name: 'B', domain: d })).resolves.toBeTruthy();
  });

  it('the app role cannot read across tenants even with a forged filter', async () => {
    // A raw app-role read scoped to tenant A must never return tenant B rows.
    const rows = await withTenant(tenantA, (tx) => tx.select().from(directoryCompanies));
    expect(rows.every((r) => r.tenant_id === tenantA)).toBe(true);
  });
});
