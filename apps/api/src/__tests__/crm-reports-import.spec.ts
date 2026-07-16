import 'dotenv/config';
import * as crypto from 'crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db, dbAdmin } from '@flicks/db';
import {
  activities,
  deals,
  directoryCompanies,
  directoryPeople,
  leads,
  memberships,
  pipelineStages,
  pipelines,
  samplePacks,
  tenants,
  users,
} from '@flicks/db/schema';
import { DatabaseService } from '../core/database/database.service';
import { AuditService } from '../modules/audit/audit.service';
import { ImportService, parseCsv } from '../modules/crm/import.service';
import { MergeService } from '../modules/crm/merge.service';
import { ReportsService } from '../modules/crm/reports.service';
import { SampleDataService } from '../modules/crm/sample-data.service';

/**
 * PRD v5 Sprint 31 — reports/forecast/goals (§10, §19.6), CSV import (C14),
 * merge + dedupe (C15), §19.7 reassignment, C22 sample data. Real Postgres.
 */

const rid = () => crypto.randomBytes(4).toString('hex');
const dbSvc = new DatabaseService();
const audit = new AuditService(db as never, dbAdmin as never, dbSvc);
const eventsStub = { publish: jest.fn(async () => 'evt') };
const reports = new ReportsService(dbSvc, audit);
const imports = new ImportService(dbSvc, audit, eventsStub as never);
const merge = new MergeService(dbSvc, audit, eventsStub as never);
const sample = new SampleDataService(dbSvc, audit);

let tenantA: string;
let owner: string;
let rep: string;
let pipelineId: string;
let stageQualified: string;
let stageProposal: string;
let stageWon: string;
let stageLost: string;

beforeAll(async () => {
  const [u] = await dbAdmin.insert(users).values({ email: `rpt-${rid()}@test.test`, full_name: 'Rpt Owner', status: 'active' }).returning();
  owner = u!.id;
  const [u2] = await dbAdmin.insert(users).values({ email: `rep-${rid()}@test.test`, full_name: 'Rep One', status: 'active' }).returning();
  rep = u2!.id;
  const [t] = await dbAdmin.insert(tenants).values({ name: `Rpt${rid()}`, slug: `rpt-${rid()}`, status: 'active', currency: 'INR' }).returning();
  tenantA = t!.id;
  await dbAdmin.insert(memberships).values([
    { tenant_id: tenantA, user_id: owner, role: 'owner', status: 'active' },
    { tenant_id: tenantA, user_id: rep, role: 'manager', status: 'active' },
  ]);
  const [pl] = await dbAdmin.insert(pipelines).values({ tenant_id: tenantA, name: 'Sales', is_default: true }).returning();
  pipelineId = pl!.id;
  const st = await dbAdmin.insert(pipelineStages).values([
    { tenant_id: tenantA, pipeline_id: pipelineId, name: 'Qualified', display_order: 0, win_probability: 20, stage_type: 'open' },
    { tenant_id: tenantA, pipeline_id: pipelineId, name: 'Proposal', display_order: 1, win_probability: 75, stage_type: 'open' },
    { tenant_id: tenantA, pipeline_id: pipelineId, name: 'Won', display_order: 2, win_probability: 100, stage_type: 'won' },
    { tenant_id: tenantA, pipeline_id: pipelineId, name: 'Lost', display_order: 3, win_probability: 0, stage_type: 'lost' },
  ]).returning();
  [stageQualified, stageProposal, stageWon, stageLost] = st.map((s) => s.id) as [string, string, string, string];

  // Deals: two open (one per stage, closing this month), one won, one lost.
  const thisMonth = new Date().toISOString().slice(0, 7);
  const mkDeal = (over: {
    title: string; stage_id: string; status: string;
    value_amount: string; value_base_amount: string;
    expected_close_date?: string; won_at?: Date; lost_at?: Date; source?: string;
  }) => ({
    tenant_id: tenantA, pipeline_id: pipelineId, owner_user_id: owner,
    currency: 'INR', fx_rate_to_base: '1.000000',
    created_at: new Date(Date.now() - 20 * 86_400_000),
    ...over,
  });
  await dbAdmin.insert(deals).values([
    mkDeal({ title: 'Open A', stage_id: stageQualified, status: 'open', value_amount: '100000', value_base_amount: '100000', expected_close_date: `${thisMonth}-25` }),
    mkDeal({ title: 'Open B', stage_id: stageProposal, status: 'open', value_amount: '200000', value_base_amount: '200000', expected_close_date: `${thisMonth}-26` }),
    mkDeal({ title: 'Won A', stage_id: stageWon, status: 'won', value_amount: '150000', value_base_amount: '150000', won_at: new Date(), source: 'referral' }),
    mkDeal({ title: 'Lost A', stage_id: stageLost, status: 'lost', value_amount: '80000', value_base_amount: '80000', lost_at: new Date(), source: 'outbound' }),
  ]);
});

afterAll(async () => {
  await dbAdmin.delete(tenants).where(eq(tenants.id, tenantA));
  await dbAdmin.delete(users).where(eq(users.id, owner));
  await dbAdmin.delete(users).where(eq(users.id, rep));
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
});

describe('Reports & forecast (§10, C16/C17)', () => {
  it('overview: snapshot raw/weighted per stage, win rate, lost reasons', async () => {
    const { data } = await reports.overview(tenantA, { days: 90 });
    const q = data!.snapshot.find((s) => s.stage === 'Qualified')!;
    expect(q.count).toBe(1);
    expect(q.raw).toBe(100000);
    expect(q.weighted).toBe(20000); // 20%
    const p = data!.snapshot.find((s) => s.stage === 'Proposal')!;
    expect(p.weighted).toBe(150000); // 75%
    expect(data!.win_loss.overall_win_rate).toBe(50); // 1 won / 2 decided
    expect(data!.lost_reasons[0]).toEqual({ label: 'Unspecified', count: 1 });
    expect(data!.velocity).toHaveLength(6);
  });

  it('forecast: weighted + committed by close month, team goal gap (§19.6)', async () => {
    const thisMonth = new Date().toISOString().slice(0, 7);
    await reports.setGoal(tenantA, owner, { period: thisMonth, target_base: 500000 });
    const { data } = await reports.forecast(tenantA, { months: 3 });
    const m = data.find((r) => r.period === thisMonth)!;
    expect(m.weighted).toBe(20000 + 150000); // 100k×20% + 200k×75%
    expect(m.committed).toBe(200000); // only Proposal ≥70%
    expect(m.won).toBe(150000);
    expect(m.goal).toBe(500000);
    expect(m.gap_to_goal).toBe(500000 - 150000 - 200000);
    expect(m.deals.length).toBe(2);
  });

  it('per-user goal drives the leaderboard progress bar', async () => {
    const thisMonth = new Date().toISOString().slice(0, 7);
    await reports.setGoal(tenantA, owner, { period: thisMonth, user_id: owner, target_base: 300000 });
    const { data } = await reports.overview(tenantA, {});
    const row = data!.leaderboard.find((r) => r.user_id === owner)!;
    expect(row.goal_pct).toBe(50); // won 150k of 300k
    // Target 0 removes it.
    await reports.setGoal(tenantA, owner, { period: thisMonth, user_id: owner, target_base: 0 });
    const again = await reports.overview(tenantA, {});
    expect(again.data!.leaderboard.find((r) => r.user_id === owner)!.goal_pct).toBeNull();
  });
});

describe('CSV import (C14)', () => {
  it('parseCsv handles quotes, embedded commas and CRLF', () => {
    const rows = parseCsv('name,email\r\n"Rao, Asha",asha@x.example\r\n"He said ""hi""",b@x.example\n');
    expect(rows).toEqual([
      ['name', 'email'],
      ['Rao, Asha', 'asha@x.example'],
      ['He said "hi"', 'b@x.example'],
    ]);
  });

  it('suggests mappings from messy headers', () => {
    const { data } = imports.parse('people', 'Person - Name,Person - Email,Org - Name\nAsha,a@x.example,TechCorp');
    expect(data.headers.map((h) => h.suggested)).toEqual(['first_name', 'email', 'company_name']);
  });

  it('dry-run plans, run writes + stamps the batch, undo retracts within 24h', async () => {
    // Existing person to collide with.
    const email = `dup-${rid()}@imp.example`;
    await dbAdmin.insert(directoryPeople).values({ tenant_id: tenantA, first_name: 'Existing', email });
    const csv = `name,email,company\nNew One,new1-${rid()}@imp.example,ImpCo\nDupe,${email},ImpCo\nBadRow,not-an-email,X`;
    const mapping = { name: 'first_name', email: 'email', company: 'company_name' };

    const dry = await imports.dryRun(tenantA, 'people', csv, mapping, 'skip');
    expect(dry.data).toMatchObject({ rows_read: 3, will_create: 1, will_skip: 1, errors: 1 });

    const run = await imports.run(tenantA, owner, 'people', csv, mapping, 'skip', 'test.csv');
    expect(run.data.rows_created).toBe(1);
    expect(run.data.rows_skipped).toBe(2); // dupe + error
    const created = await dbAdmin.select().from(directoryPeople)
      .where(and(eq(directoryPeople.import_batch_id, run.data.id), isNull(directoryPeople.deleted_at)));
    expect(created).toHaveLength(1);
    // ImpCo company was auto-created and stamped too.
    const [co] = await dbAdmin.select().from(directoryCompanies).where(eq(directoryCompanies.import_batch_id, run.data.id));
    expect(co!.name).toBe('ImpCo');

    const undo = await imports.undo(tenantA, owner, run.data.id);
    expect(undo.data.status).toBe('undone');
    const after = await dbAdmin.select().from(directoryPeople)
      .where(and(eq(directoryPeople.import_batch_id, run.data.id), isNull(directoryPeople.deleted_at)));
    expect(after).toHaveLength(0);
    await expect(imports.undo(tenantA, owner, run.data.id)).rejects.toThrow(/already/i);
  });

  it('update strategy patches the matched row instead of skipping', async () => {
    const email = `upd-${rid()}@imp.example`;
    const [p] = await dbAdmin.insert(directoryPeople).values({ tenant_id: tenantA, first_name: 'Old', email }).returning();
    const csv = `first,email,phone\nNewName,${email},+91 99999`;
    const run = await imports.run(tenantA, owner, 'people', csv, { first: 'first_name', email: 'email', phone: 'phone' }, 'update');
    expect(run.data.rows_updated).toBe(1);
    const [after] = await dbAdmin.select().from(directoryPeople).where(eq(directoryPeople.id, p!.id));
    expect(after!.first_name).toBe('NewName');
    expect(after!.phone).toBe('+91 99999');
  });
});

describe('Merge & dedupe (C15) + §19.7 reassignment', () => {
  it('finds candidates, merges people (refs repointed, tombstone left)', async () => {
    const email = `merge-${rid()}@m.example`;
    const [winner] = await dbAdmin.insert(directoryPeople).values({ tenant_id: tenantA, first_name: 'Winner', email }).returning();
    const [loser] = await dbAdmin.insert(directoryPeople).values({ tenant_id: tenantA, first_name: 'Loser', email }).returning();
    const [deal] = await dbAdmin.insert(deals).values({
      tenant_id: tenantA, pipeline_id: pipelineId, stage_id: stageQualified, title: 'Merge deal',
      primary_person_id: loser!.id, owner_user_id: owner, currency: 'INR', value_amount: '10', value_base_amount: '10',
    }).returning();

    const cands = await merge.candidates(tenantA);
    expect(cands.data.some((c) => c.type === 'person' && [c.a.id, c.b.id].includes(loser!.id))).toBe(true);

    await merge.mergePeople(tenantA, owner, winner!.id, loser!.id);
    const [d] = await dbAdmin.select().from(deals).where(eq(deals.id, deal!.id));
    expect(d!.primary_person_id).toBe(winner!.id);
    const [tomb] = await dbAdmin.select().from(directoryPeople).where(eq(directoryPeople.id, loser!.id));
    expect(tomb!.deleted_at).not.toBeNull();
    expect(tomb!.merged_into_id).toBe(winner!.id);
    expect(eventsStub.publish).toHaveBeenCalledWith(expect.objectContaining({ name: 'crm.contact.merged' }), expect.anything());
  });

  it('opposing concurrent people-merges serialize instead of cross-tombstoning (M3 row lock)', async () => {
    const email = `dbl-${rid()}@m.example`;
    const [a] = await dbAdmin.insert(directoryPeople).values({ tenant_id: tenantA, first_name: 'AA', email }).returning();
    const [b] = await dbAdmin.insert(directoryPeople).values({ tenant_id: tenantA, first_name: 'BB', email }).returning();
    // A→B and B→A fired together: the FOR UPDATE lock lets one win and the
    // other fail its "both must exist" check — never both tombstoned.
    const results = await Promise.allSettled([
      merge.mergePeople(tenantA, owner, a!.id, b!.id),
      merge.mergePeople(tenantA, owner, b!.id, a!.id),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const rows = await dbAdmin.select().from(directoryPeople).where(inArray(directoryPeople.id, [a!.id, b!.id]));
    // Exactly one survivor (not deleted), one tombstone.
    expect(rows.filter((r) => r.deleted_at === null)).toHaveLength(1);
    expect(rows.filter((r) => r.merged_into_id !== null)).toHaveLength(1);
  });

  it('merges companies (people + deals move to the survivor)', async () => {
    const [winner] = await dbAdmin.insert(directoryCompanies).values({ tenant_id: tenantA, name: `Acme ${rid()}`, domain: `acme-${rid()}.example` }).returning();
    const [loser] = await dbAdmin.insert(directoryCompanies).values({ tenant_id: tenantA, name: `Acme Pvt Ltd ${rid()}` }).returning();
    const [p] = await dbAdmin.insert(directoryPeople).values({ tenant_id: tenantA, first_name: 'Emp', company_id: loser!.id }).returning();
    await merge.mergeCompanies(tenantA, owner, winner!.id, loser!.id);
    const [after] = await dbAdmin.select().from(directoryPeople).where(eq(directoryPeople.id, p!.id));
    expect(after!.company_id).toBe(winner!.id);
    const [tomb] = await dbAdmin.select().from(directoryCompanies).where(eq(directoryCompanies.id, loser!.id));
    expect(tomb!.merged_into_id).toBe(winner!.id);
  });

  it('reassign moves open work only (§19.7)', async () => {
    await dbAdmin.insert(deals).values({
      tenant_id: tenantA, pipeline_id: pipelineId, stage_id: stageQualified, title: 'Rep open deal',
      owner_user_id: rep, currency: 'INR', value_amount: '5', value_base_amount: '5',
    });
    await dbAdmin.insert(activities).values([
      { tenant_id: tenantA, type: 'task', subject: 'Open task', assignee_user_id: rep, created_by: owner },
      { tenant_id: tenantA, type: 'task', subject: 'Done task', assignee_user_id: rep, completed_at: new Date(), created_by: owner },
    ]);
    await dbAdmin.insert(leads).values({ tenant_id: tenantA, first_name: 'RepLead', owner_user_id: rep, status: 'working' });

    const preview = await merge.reassignPreview(tenantA, rep);
    expect(preview.data).toEqual({ open_deals: 1, open_activities: 1, active_leads: 1 });
    const res = await merge.reassign(tenantA, owner, rep, owner);
    expect(res.data).toEqual({ deals: 1, activities: 1, leads: 1 });
    const [doneTask] = await dbAdmin.select().from(activities)
      .where(and(eq(activities.tenant_id, tenantA), eq(activities.subject, 'Done task')));
    expect(doneTask!.assignee_user_id).toBe(rep); // completed work stays put
  });
});

describe('Sample data toggle (C22)', () => {
  it('seeds a labelled pack and removes exactly those records', async () => {
    const before = await dbAdmin.select().from(deals).where(and(eq(deals.tenant_id, tenantA), isNull(deals.deleted_at)));
    const seeded = await sample.seed(tenantA, owner);
    expect(seeded.data.loaded).toBe(true);
    expect((await sample.status(tenantA)).data.loaded).toBe(true);
    await expect(sample.seed(tenantA, owner)).rejects.toThrow(/already/i);

    await sample.remove(tenantA, owner);
    expect((await sample.status(tenantA)).data.loaded).toBe(false);
    const after = await dbAdmin.select().from(deals).where(and(eq(deals.tenant_id, tenantA), isNull(deals.deleted_at)));
    expect(after.length).toBe(before.length); // everything else untouched
    const [pack] = await dbAdmin.select().from(samplePacks).where(eq(samplePacks.tenant_id, tenantA));
    expect(pack).toBeUndefined();
  });
});
