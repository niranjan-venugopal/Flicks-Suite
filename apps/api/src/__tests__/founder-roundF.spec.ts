import 'dotenv/config';
import * as crypto from 'crypto';
import { sql } from 'drizzle-orm';
import { db, dbAdmin, assertTenantIsolation } from '@flicks/db';
import {
  directoryCompanies,
  directoryPeople,
  importBatches,
  leads,
  memberships,
  tenants,
  users,
} from '@flicks/db/schema';
import { DatabaseService } from '../core/database/database.service';
import { LeadsService } from '../modules/crm/leads.service';
import { ImportService } from '../modules/crm/import.service';
import { SearchService } from '../modules/crm/search.service';
import type { AuditService } from '../modules/audit/audit.service';
import type { DealsService } from '../modules/crm/deals.service';

/**
 * Round F — the production cross-tenant leak (one tenant's imported CRM leads
 * and "Recent imports" visible to EVERY workspace).
 *
 * Root cause: RLS only binds roles subject to it. Production's DATABASE_URL
 * pointed at a BYPASSRLS role (Supabase's default `postgres` connection
 * string), so FORCE RLS policies silently stopped applying and reads that
 * leaned on RLS alone returned all tenants' rows.
 *
 * The fix is four independent layers; this suite pins each:
 *  1. withTenant pins set_config('role', flicks_app) per transaction, so even
 *     a BYPASSRLS pool runs tenant work as the RLS-bound role (or fails
 *     closed if the role can't be assumed).
 *  2. Migration 0060 grants flicks_app to the admin user so layer 1 degrades
 *     a mis-configured pool to "safe", not "down".
 *  3. assertTenantIsolation() — the boot probe main.ts refuses to serve
 *     without.
 *  4. Explicit tenant predicates on the CRM list surfaces (leads list,
 *     import batches, directory lists, ⌘K search, deals board).
 */

const rid = () => crypto.randomBytes(4).toString('hex');
const audit = { log: jest.fn(async () => {}), logPlatform: jest.fn(async () => {}) } as unknown as AuditService;
const eventsStub = { publish: async () => null };
const presenceStub = { statusOf: async () => 'available' };

const dbSvc = new DatabaseService();
const leadsSvc = new LeadsService(dbSvc, audit, eventsStub as never, presenceStub as never, {} as DealsService);
const importSvc = new ImportService(dbSvc, audit, eventsStub as never);
const searchSvc = new SearchService(dbSvc);

let tenantA: string; // the "pauket" of the incident — owns all the data
let tenantB: string; // the "specflicks" — must see NONE of it
let ownerA: string;
let companyName: string;

beforeAll(async () => {
  const [uA] = await dbAdmin.insert(users).values({ email: `rf-a-${rid()}@test.test`, full_name: 'RF Owner A', status: 'active' }).returning();
  ownerA = uA!.id;
  const [tA] = await dbAdmin.insert(tenants).values({ name: `RFA${rid()}`, slug: `rf-a-${rid()}`, status: 'active', currency: 'INR' }).returning();
  tenantA = tA!.id;
  const [tB] = await dbAdmin.insert(tenants).values({ name: `RFB${rid()}`, slug: `rf-b-${rid()}`, status: 'active', currency: 'INR' }).returning();
  tenantB = tB!.id;
  await dbAdmin.insert(memberships).values({ tenant_id: tenantA, user_id: ownerA, role: 'owner', status: 'active' });

  // Tenant A's CRM data — what leaked in production.
  await dbAdmin.insert(leads).values([
    { tenant_id: tenantA, first_name: 'Pauket', last_name: 'LeadOne', owner_user_id: ownerA, status: 'new' },
    { tenant_id: tenantA, first_name: 'Pauket', last_name: 'LeadTwo', owner_user_id: ownerA, status: 'new' },
    { tenant_id: tenantA, first_name: 'Pauket', last_name: 'LeadThree', owner_user_id: ownerA, status: 'working' },
  ]);
  await dbAdmin.insert(importBatches).values({
    tenant_id: tenantA,
    object_type: 'all',
    file_name: 'pauket-leads-flicks-upload.csv',
    rows_read: 105,
    rows_created: 105,
    created_by: ownerA,
  });
  companyName = `PauketCorp${rid()}`;
  await dbAdmin.insert(directoryCompanies).values({ tenant_id: tenantA, name: companyName });
  // display_name is GENERATED ALWAYS in the DB — insert the name parts.
  await dbAdmin.insert(directoryPeople).values({ tenant_id: tenantA, first_name: 'Pauket', last_name: `Person${rid()}` });
});

afterAll(async () => {
  await dbAdmin.delete(tenants).where(sql`${tenants.id} in (${tenantA}, ${tenantB})`);
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client.end();
  await (dbAdmin as unknown as { $client: { end: () => Promise<void> } }).$client.end();
});

describe('layer 1+2 — withTenant pins the RLS-bound role even on a BYPASSRLS pool', () => {
  it('the admin (BYPASSRLS) pool, running the exact withTenant round-trip, sees ZERO rows under a foreign tenant', async () => {
    // dbAdmin connects as the service role (BYPASSRLS) — the same class of
    // connection production's DATABASE_URL was mistakenly pointed at.
    const rows = (await dbAdmin.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT set_config('role', 'flicks_app', true), set_config('app.tenant_id', ${tenantB}::text, true)`,
      );
      return (await tx.execute(
        sql`SELECT current_user AS u, (SELECT count(*) FROM leads) AS leads, (SELECT count(*) FROM import_batches) AS batches, (SELECT count(*) FROM directory_companies) AS companies`,
      )) as unknown as Array<{ u: string; leads: string | number; batches: string | number; companies: string | number }>;
    })) as Array<{ u: string; leads: string | number; batches: string | number; companies: string | number }>;
    expect(rows[0]!.u).toBe('flicks_app'); // the role actually dropped (0060 grant works)
    expect(Number(rows[0]!.leads)).toBe(0);
    expect(Number(rows[0]!.batches)).toBe(0);
    expect(Number(rows[0]!.companies)).toBe(0);
  });

  it('control: without the role pin, the same BYPASSRLS transaction sees the foreign rows (the production bug)', async () => {
    const rows = (await dbAdmin.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantB}::text, true)`);
      return (await tx.execute(
        sql`SELECT (SELECT count(*) FROM leads WHERE tenant_id = ${tenantA}) AS leads`,
      )) as unknown as Array<{ leads: string | number }>;
    })) as Array<{ leads: string | number }>;
    expect(Number(rows[0]!.leads)).toBeGreaterThanOrEqual(3);
  });
});

describe('layer 3 — the boot probe', () => {
  it('assertTenantIsolation passes on the app pool and names the pinned role', async () => {
    const { appRole } = await assertTenantIsolation();
    expect(appRole).toBe('flicks_app');
  });
});

describe('layer 4 — the leaked CRM surfaces are tenant-scoped end to end', () => {
  it('leads.list: tenant B sees none of tenant A\'s leads; tenant A sees its own', async () => {
    const b = await leadsSvc.list(tenantB);
    expect(b.data).toHaveLength(0);
    expect(Object.values(b.counts as Record<string, number>).every((n) => Number(n) === 0)).toBe(true);
    const a = await leadsSvc.list(tenantA);
    expect(a.data).toHaveLength(2); // status 'new'
    expect((a.counts as Record<string, number>).working).toBe(1);
  });

  it('import.listBatches ("Recent imports" — the founder\'s screenshot): tenant B sees an empty list', async () => {
    const b = await importSvc.listBatches(tenantB);
    expect(b.data).toHaveLength(0);
    const a = await importSvc.listBatches(tenantA);
    expect(a.data).toHaveLength(1);
    expect(a.data[0]!.file_name).toBe('pauket-leads-flicks-upload.csv');
  });

  it('a real combined import by tenant A is invisible to tenant B, and B importing the SAME email creates its own record', async () => {
    const tag = rid();
    const email = `shared-${tag}@import.test`;
    const csv = [
      'Type,First Name,Last Name,Email,Company',
      `Contact,Alice,Pauket${tag},alice-${tag}@import.test,ImportCo${tag}`,
      `Lead,Bob,Pauket${tag},${email},`,
    ].join('\n');
    const mapping = { Type: 'type', 'First Name': 'first_name', 'Last Name': 'last_name', Email: 'email', Company: 'company_name' };

    // Tenant A imports the combined file through the REAL import pipeline.
    const runA = await importSvc.run(tenantA, ownerA, 'all', csv, mapping, 'skip', `combined-${tag}.csv`);
    expect(runA.data.rows_created).toBe(2);

    // Tenant B sees NONE of it: no batch, no lead, no contact, no company.
    const bBatches = await importSvc.listBatches(tenantB);
    expect(bBatches.data.some((b) => b.file_name === `combined-${tag}.csv`)).toBe(false);
    const bSearch = await searchSvc.search(tenantB, `ImportCo${tag}`.slice(0, 12));
    expect(bSearch.data.companies).toHaveLength(0);
    expect(bSearch.data.people).toHaveLength(0);

    // Tenant B imports a lead with the SAME email under strategy 'update':
    // dedupe matching must not see tenant A's lead — B gets its OWN new row
    // and A's row is untouched.
    const csvB = ['First Name,Email', `Eve,${email}`].join('\n');
    const runB = await importSvc.run(tenantB, ownerA, 'leads', csvB, { 'First Name': 'first_name', Email: 'email' }, 'update', `b-${tag}.csv`);
    expect(runB.data.rows_created).toBe(1);
    expect(runB.data.rows_updated).toBe(0);
    const aLead = await dbAdmin.select().from(leads).where(sql`${leads.tenant_id} = ${tenantA} AND ${leads.email} = ${email}`);
    expect(aLead).toHaveLength(1);
    expect(aLead[0]!.first_name).toBe('Bob'); // A's record untouched by B's import
  });

  it('⌘K search: tenant B finds nothing for tenant A\'s company name', async () => {
    const b = await searchSvc.search(tenantB, companyName.slice(0, 10));
    expect(b.data.companies).toHaveLength(0);
    expect(b.data.people).toHaveLength(0);
    expect(b.data.deals).toHaveLength(0);
    const a = await searchSvc.search(tenantA, companyName.slice(0, 10));
    expect(a.data.companies).toHaveLength(1);
  });
});
