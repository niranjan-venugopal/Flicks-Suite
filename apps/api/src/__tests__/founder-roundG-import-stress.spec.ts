import 'dotenv/config';
import * as crypto from 'crypto';
import { sql } from 'drizzle-orm';
import { db, dbAdmin } from '@flicks/db';
import { memberships, tenants, users } from '@flicks/db/schema';
import { DatabaseService } from '../core/database/database.service';
import { LeadsService } from '../modules/crm/leads.service';
import { ImportService } from '../modules/crm/import.service';
import { SearchService } from '../modules/crm/search.service';
import type { AuditService } from '../modules/audit/audit.service';
import type { DealsService } from '../modules/crm/deals.service';

/**
 * Round G — bulk two-tenant import isolation stress proof (founder ask after
 * the round-F leak: "test the import with 1000's of data … check for all").
 *
 * Tenant A imports at scale through the REAL ImportService (leads file,
 * contacts file with auto-created companies, companies file, and the combined
 * "consolidated" file). Tenant B then imports the SAME emails / domains /
 * company names under strategy "update" — the dangerous mode, because dedupe
 * matching decides which EXISTING row gets rewritten. Every row must stay
 * inside its own workspace: B's imports create B's rows, update only B's rows
 * on re-import, and never read or touch a byte of A's. A's tables are
 * checksummed before B acts and re-verified after every step, undo included.
 *
 * Volumes (10,500 rows total, within the MAX_ROWS=10,000 per-file beta cap):
 *   A: 2,000 leads · 1,000 contacts (250 auto companies) · 500 companies
 *      · 1,000 combined (600 contacts + 400 leads)  → 2,400/1,600/750
 *   B: the same 2,000 + 1,000 + 500 under "update", then the leads file AGAIN
 *      (update path at scale), then undo.
 */

jest.setTimeout(600_000);

const rid = () => crypto.randomBytes(4).toString('hex');
const audit = { log: jest.fn(async () => {}), logPlatform: jest.fn(async () => {}) } as unknown as AuditService;
const eventsStub = { publish: async () => null };
const presenceStub = { statusOf: async () => 'available' };

const dbSvc = new DatabaseService();
const importSvc = new ImportService(dbSvc, audit, eventsStub as never);
const leadsSvc = new LeadsService(dbSvc, audit, eventsStub as never, presenceStub as never, {} as DealsService);
const searchSvc = new SearchService(dbSvc);

const LEADS = 2000;
const PEOPLE = 1000;
const COMPANIES = 500;
const MIX = 1000; // 600 contacts + 400 leads
const MIX_CONTACTS = 600;
const PEOPLE_COMPANIES = 250;

let tenantA: string;
let tenantB: string;
let ownerA: string;
let ownerB: string;
let tag: string;

// One shared corpus — B imports the exact same identities as A.
let leadsCsv: string;
let peopleCsv: string;
let companiesCsv: string;
let mixCsv: string;

const LEADS_MAP = { 'First Name': 'first_name', 'Last Name': 'last_name', Email: 'email' };
const PEOPLE_MAP = { 'First Name': 'first_name', Email: 'email', Company: 'company_name' };
const COMPANIES_MAP = { Name: 'name', Domain: 'domain' };
const MIX_MAP = { Type: 'type', 'First Name': 'first_name', Email: 'email', Company: 'company_name' };

/** md5 fingerprint of every CRM row tenant A owns — any touch by B flips it. */
async function checksumA(): Promise<string> {
  const rows = (await dbAdmin.execute(sql`
    SELECT md5(concat(
      (SELECT coalesce(string_agg(concat(email, '|', first_name, '|', status, '|', updated_at::text), ',' ORDER BY email), '') FROM leads WHERE tenant_id = ${tenantA}),
      (SELECT coalesce(string_agg(concat(email, '|', first_name, '|', updated_at::text), ',' ORDER BY email), '') FROM directory_people WHERE tenant_id = ${tenantA}),
      (SELECT coalesce(string_agg(concat(name, '|', coalesce(domain, ''), '|', updated_at::text), ',' ORDER BY name), '') FROM directory_companies WHERE tenant_id = ${tenantA})
    )) AS sum`)) as unknown as Array<{ sum: string }>;
  return rows[0]!.sum;
}

async function tableCounts(tenantId: string) {
  const rows = (await dbAdmin.execute(sql`
    SELECT
      (SELECT count(*) FROM leads WHERE tenant_id = ${tenantId} AND status <> 'discarded') AS leads,
      (SELECT count(*) FROM directory_people WHERE tenant_id = ${tenantId} AND deleted_at IS NULL) AS people,
      (SELECT count(*) FROM directory_companies WHERE tenant_id = ${tenantId} AND deleted_at IS NULL) AS companies
  `)) as unknown as Array<{ leads: string; people: string; companies: string }>;
  const r = rows[0]!;
  return { leads: Number(r.leads), people: Number(r.people), companies: Number(r.companies) };
}

/** Rows stamped by this tenant's batches must ALL carry this tenant's id. */
async function strayRows(tenantId: string): Promise<number> {
  const rows = (await dbAdmin.execute(sql`
    WITH mine AS (SELECT id FROM import_batches WHERE tenant_id = ${tenantId})
    SELECT
      (SELECT count(*) FROM leads WHERE import_batch_id IN (SELECT id FROM mine) AND tenant_id <> ${tenantId})
    + (SELECT count(*) FROM directory_people WHERE import_batch_id IN (SELECT id FROM mine) AND tenant_id <> ${tenantId})
    + (SELECT count(*) FROM directory_companies WHERE import_batch_id IN (SELECT id FROM mine) AND tenant_id <> ${tenantId})
      AS stray`)) as unknown as Array<{ stray: string }>;
  return Number(rows[0]!.stray);
}

beforeAll(async () => {
  tag = rid();
  const [uA] = await dbAdmin.insert(users).values({ email: `rg-a-${tag}@test.test`, full_name: 'RG Owner A', status: 'active' }).returning();
  const [uB] = await dbAdmin.insert(users).values({ email: `rg-b-${tag}@test.test`, full_name: 'RG Owner B', status: 'active' }).returning();
  ownerA = uA!.id; ownerB = uB!.id;
  const [tA] = await dbAdmin.insert(tenants).values({ name: `RGA${tag}`, slug: `rg-a-${tag}`, status: 'active', currency: 'INR' }).returning();
  const [tB] = await dbAdmin.insert(tenants).values({ name: `RGB${tag}`, slug: `rg-b-${tag}`, status: 'active', currency: 'INR' }).returning();
  tenantA = tA!.id; tenantB = tB!.id;
  await dbAdmin.insert(memberships).values([
    { tenant_id: tenantA, user_id: ownerA, role: 'owner', status: 'active' },
    { tenant_id: tenantB, user_id: ownerB, role: 'owner', status: 'active' },
  ]);

  const leadRows = ['First Name,Last Name,Email'];
  for (let i = 0; i < LEADS; i++) leadRows.push(`Lead${i},Stress${tag},lead-${i}-${tag}@stress.test`);
  leadsCsv = leadRows.join('\n');

  const peopleRows = ['First Name,Email,Company'];
  for (let i = 0; i < PEOPLE; i++) peopleRows.push(`Person${i},person-${i}-${tag}@stress.test,PeopleCo${i % PEOPLE_COMPANIES}-${tag}`);
  peopleCsv = peopleRows.join('\n');

  const companyRows = ['Name,Domain'];
  for (let i = 0; i < COMPANIES; i++) companyRows.push(`DomCo${i}-${tag},domco${i}-${tag}.test`);
  companiesCsv = companyRows.join('\n');

  const mixRows = ['Type,First Name,Email,Company'];
  for (let i = 0; i < MIX; i++) {
    const isContact = i < MIX_CONTACTS;
    mixRows.push(isContact
      ? `Contact,MixC${i},mix-c-${i}-${tag}@stress.test,PeopleCo${i % PEOPLE_COMPANIES}-${tag}`
      : `Lead,MixL${i},mix-l-${i}-${tag}@stress.test,`);
  }
  mixCsv = mixRows.join('\n');
});

afterAll(async () => {
  await dbAdmin.delete(tenants).where(sql`${tenants.id} in (${tenantA}, ${tenantB})`);
  await dbAdmin.delete(users).where(sql`${users.id} in (${ownerA}, ${ownerB})`);
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client.end();
  await (dbAdmin as unknown as { $client: { end: () => Promise<void> } }).$client.end();
});

describe('Round G — bulk two-tenant import isolation', () => {
  it('tenant A imports 4,500 rows across all four file types; every row lands in A', async () => {
    const t0 = Date.now();
    const r1 = await importSvc.run(tenantA, ownerA, 'leads', leadsCsv, LEADS_MAP, 'skip', 'a-leads.csv');
    const r2 = await importSvc.run(tenantA, ownerA, 'people', peopleCsv, PEOPLE_MAP, 'skip', 'a-people.csv');
    const r3 = await importSvc.run(tenantA, ownerA, 'companies', companiesCsv, COMPANIES_MAP, 'skip', 'a-companies.csv');
    const r4 = await importSvc.run(tenantA, ownerA, 'all', mixCsv, MIX_MAP, 'skip', 'a-combined.csv');
    console.log(`[stress] tenant A: 4 imports (${LEADS + PEOPLE + COMPANIES + MIX} rows) in ${Date.now() - t0}ms`);

    expect(r1.data.rows_created).toBe(LEADS);
    expect(r2.data.rows_created).toBe(PEOPLE);
    expect(r3.data.rows_created).toBe(COMPANIES);
    expect(r4.data.rows_created).toBe(MIX);
    expect(r1.data.errors).toHaveLength(0);
    expect(r4.data.errors).toHaveLength(0);

    const a = await tableCounts(tenantA);
    expect(a).toEqual({
      leads: LEADS + (MIX - MIX_CONTACTS),          // 2,400
      people: PEOPLE + MIX_CONTACTS,                // 1,600
      companies: PEOPLE_COMPANIES + COMPANIES,      // 750 (mix contacts reuse PeopleCo)
    });
    expect(await strayRows(tenantA)).toBe(0);
  });

  it('tenant B imports the SAME identities under "update": all created in B, zero of A\'s rows touched', async () => {
    const before = await checksumA();
    const t0 = Date.now();
    const r1 = await importSvc.run(tenantB, ownerB, 'leads', leadsCsv, LEADS_MAP, 'update', 'b-leads.csv');
    const r2 = await importSvc.run(tenantB, ownerB, 'people', peopleCsv, PEOPLE_MAP, 'update', 'b-people.csv');
    const r3 = await importSvc.run(tenantB, ownerB, 'companies', companiesCsv, COMPANIES_MAP, 'update', 'b-companies.csv');
    console.log(`[stress] tenant B: 3 overlapping imports (${LEADS + PEOPLE + COMPANIES} rows) in ${Date.now() - t0}ms`);

    // B's dedupe saw NOTHING of A's identical emails/domains/names.
    expect(r1.data.rows_created).toBe(LEADS);
    expect(r1.data.rows_updated).toBe(0);
    expect(r2.data.rows_created).toBe(PEOPLE);
    expect(r2.data.rows_updated).toBe(0);
    expect(r3.data.rows_created).toBe(COMPANIES);
    expect(r3.data.rows_updated).toBe(0);

    expect(await tableCounts(tenantB)).toEqual({
      leads: LEADS,
      people: PEOPLE,
      companies: PEOPLE_COMPANIES + COMPANIES,
    });
    expect(await strayRows(tenantB)).toBe(0);
    expect(await checksumA()).toBe(before); // not one byte of A changed
  });

  it('tenant B re-imports the leads file: 2,000 UPDATES land only on B\'s rows', async () => {
    const before = await checksumA();
    const r = await importSvc.run(tenantB, ownerB, 'leads', leadsCsv, LEADS_MAP, 'update', 'b-leads-again.csv');
    expect(r.data.rows_created).toBe(0);
    expect(r.data.rows_updated).toBe(LEADS); // within-tenant dedupe works…
    expect(await checksumA()).toBe(before);  // …and never crosses the fence
    expect((await tableCounts(tenantB)).leads).toBe(LEADS);
  });

  it('each tenant\'s lists/search see only their own volumes', async () => {
    const aBatches = await importSvc.listBatches(tenantA);
    const bBatches = await importSvc.listBatches(tenantB);
    expect(aBatches.data).toHaveLength(4);
    expect(bBatches.data).toHaveLength(4);
    expect(aBatches.data.every((b) => b.file_name!.startsWith('a-'))).toBe(true);
    expect(bBatches.data.every((b) => b.file_name!.startsWith('b-'))).toBe(true);

    const aLeads = await leadsSvc.list(tenantA);
    const bLeads = await leadsSvc.list(tenantB);
    expect((aLeads.counts as Record<string, number>).new).toBe(LEADS + (MIX - MIX_CONTACTS));
    expect((bLeads.counts as Record<string, number>).new).toBe(LEADS);

    // The corpus names are shared, so search must return each tenant ONLY its
    // own copy — capped bucket, but never a row owned by the other tenant.
    const probe = `DomCo1-${tag}`;
    const aHit = await searchSvc.search(tenantA, probe);
    const bHit = await searchSvc.search(tenantB, probe);
    for (const [who, hit] of [[tenantA, aHit], [tenantB, bHit]] as const) {
      const ids = hit.data.companies.map((c) => c.id);
      if (ids.length === 0) continue;
      const owned = (await dbAdmin.execute(
        sql`SELECT count(*) AS n FROM directory_companies WHERE id::text IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)}) AND tenant_id = ${who}`,
      )) as unknown as Array<{ n: string }>;
      expect(Number(owned[0]!.n)).toBe(ids.length);
    }
  });

  it('undoing B\'s big lead batch retracts exactly those 2,000 rows; A untouched', async () => {
    const before = await checksumA();
    const bBatches = await importSvc.listBatches(tenantB);
    const bigLeadBatch = bBatches.data.find((b) => b.file_name === 'b-leads.csv')!;
    await importSvc.undo(tenantB, ownerB, bigLeadBatch.id);

    expect((await tableCounts(tenantB)).leads).toBe(0); // all 2,000 discarded
    expect(await checksumA()).toBe(before);
    expect((await tableCounts(tenantA)).leads).toBe(LEADS + (MIX - MIX_CONTACTS));
  });
});
