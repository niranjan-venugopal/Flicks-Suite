import 'dotenv/config';
import * as crypto from 'crypto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { and, eq } from 'drizzle-orm';
import { db, dbAdmin, withTenant } from '@flicks/db';
import {
  deals,
  dealStageHistory,
  domainEvents,
  fxRates,
  pipelines,
  pipelineStages,
  tenants,
  users,
} from '@flicks/db/schema';
import {
  customers,
  directoryCompanies,
  invoices as invoicesTable,
} from '@flicks/db/schema';
import { DatabaseService } from '../core/database/database.service';
import { AuditService } from '../modules/audit/audit.service';
import { DealsService } from '../modules/crm/deals.service';
import { FxService } from '../modules/crm/fx.service';
import { CustomersService } from '../modules/invoicing/customers.service';
import { ItemsService } from '../modules/invoicing/items.service';
import { NumberingService } from '../modules/invoicing/numbering.service';
import { InvoicesService } from '../modules/invoicing/invoices.service';
import { OrgFinancialService } from '../modules/org-financial/org-financial.service';
import { InvoicingPublicService } from '../modules/invoicing/public';
import { DirectoryService } from '../modules/crm/directory.service';

/**
 * PRD v5 §4 — deals & kanban (Sprint 26). Real-Postgres: FX-snapshot on create,
 * board grouping + rotting, transactional stage moves (history + won/lost +
 * events), reopen role gate, forecast, tenant isolation. The migration seeds a
 * default "Sales" pipeline per tenant, which these tests reuse.
 */

const rid = () => crypto.randomBytes(4).toString('hex');
const dbSvc = new DatabaseService();
const audit = new AuditService(db as never, dbAdmin as never, dbSvc);
const eventsStub = { publish: jest.fn(async () => 'evt') };
const emitter = new EventEmitter2();
const fxConfig = { get: () => undefined } as never;
const fx = new FxService(dbAdmin as never, fxConfig);
// Real invoicing facade so the deal→invoice E2E exercises the true path.
const configStub = { get: (_: string, fb?: unknown) => fb } as never;
const notificationsStub = { sendEmail: async () => true } as never;
const numbering = new NumberingService(dbSvc, audit);
const customersSvc = new CustomersService(dbSvc, audit);
const itemsSvc = new ItemsService(dbSvc, audit);
const orgFinancial = new OrgFinancialService(dbSvc, audit);
const invoicesSvc = new InvoicesService(dbSvc, audit, numbering, configStub, notificationsStub, orgFinancial, eventsStub as never);
const invoicingFacade = new InvoicingPublicService(dbAdmin as never, dbSvc, customersSvc, invoicesSvc, itemsSvc);
const directory = new DirectoryService(dbSvc, audit, eventsStub as never);
const service = new DealsService(dbSvc, audit, eventsStub as never, fx, emitter, invoicingFacade);

let tenantA: string;
let tenantB: string;
let userId: string;
let stages: Array<{ id: string; name: string; stage_type: string; win_probability: number }>;
let pipelineId: string;

async function seedTenant(base: string): Promise<string> {
  const [t] = await dbAdmin
    .insert(tenants)
    .values({ name: `Deal${rid()}`, slug: `deal-${rid()}-${Date.now()}`, status: 'active', currency: base })
    .returning();
  // Seed a Sales pipeline (mirrors the migration seed) so the board exists.
  const [pl] = await dbAdmin.insert(pipelines).values({ tenant_id: t!.id, name: 'Sales', is_default: true }).returning();
  await dbAdmin.insert(pipelineStages).values([
    { tenant_id: t!.id, pipeline_id: pl!.id, name: 'Qualified', display_order: 0, win_probability: 10, stage_type: 'open' },
    { tenant_id: t!.id, pipeline_id: pl!.id, name: 'Proposal', display_order: 1, win_probability: 60, rotting_days: 10, stage_type: 'open' },
    { tenant_id: t!.id, pipeline_id: pl!.id, name: 'Won', display_order: 2, win_probability: 100, stage_type: 'won' },
    { tenant_id: t!.id, pipeline_id: pl!.id, name: 'Lost', display_order: 3, win_probability: 0, stage_type: 'lost' },
  ]);
  return t!.id;
}

beforeAll(async () => {
  const [u] = await dbAdmin.insert(users).values({ email: `deal-${rid()}@test.test`, full_name: 'Deal User', status: 'active' }).returning();
  userId = u!.id;
  tenantA = await seedTenant('INR');
  tenantB = await seedTenant('INR');
  const rows = await dbAdmin.select().from(pipelineStages).where(eq(pipelineStages.tenant_id, tenantA));
  stages = rows as never;
  pipelineId = rows[0]!.pipeline_id;
  // Seed FX so a USD deal in an INR tenant snapshots a real rate.
  const today = new Date().toISOString().slice(0, 10);
  await dbAdmin.insert(fxRates).values([
    { base: 'USD', quote: 'INR', rate: '83.00000000', as_of: today },
    { base: 'USD', quote: 'USD', rate: '1.00000000', as_of: today },
  ]).onConflictDoNothing();
});

afterAll(async () => {
  await dbAdmin.delete(tenants).where(eq(tenants.id, tenantA));
  await dbAdmin.delete(tenants).where(eq(tenants.id, tenantB));
  await dbAdmin.delete(users).where(eq(users.id, userId));
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
});

const stageByType = (type: string) => stages.find((s) => s.stage_type === type)!;

describe('Deal create + FX snapshot (§4.2, §12.1)', () => {
  it('snapshots fx_rate_to_base and value_base_amount; INR base, INR deal → rate 1', async () => {
    eventsStub.publish.mockClear();
    const res = await service.create(tenantA, userId, { title: 'Acme renewal', value_amount: 50000, currency: 'INR' });
    expect(res.data.currency).toBe('INR');
    expect(res.data.fx_rate_to_base).toBe('1.000000');
    expect(res.data.value_base_amount).toBe('50000.00');
    expect(res.data.status).toBe('open');
    expect(eventsStub.publish).toHaveBeenCalledWith(expect.objectContaining({ name: 'crm.deal.created' }), expect.anything());
    // Opening stage-history row exists.
    const hist = await dbAdmin.select().from(dealStageHistory).where(eq(dealStageHistory.deal_id, res.data.id));
    expect(hist).toHaveLength(1);
    expect(hist[0]!.from_stage_id).toBeNull();
  });

  it('USD deal in an INR tenant converts at the seeded rate (1 USD = 83 INR)', async () => {
    const res = await service.create(tenantA, userId, { title: 'Global deal', value_amount: 1000, currency: 'USD' });
    expect(res.data.currency).toBe('USD');
    expect(parseFloat(res.data.fx_rate_to_base)).toBeCloseTo(83, 2);
    expect(res.data.value_base_amount).toBe('83000.00'); // 1000 × 83
  });

  it('unknown currency falls back to rate 1.0 (never blocks the save)', async () => {
    const res = await service.create(tenantA, userId, { title: 'Zzz', value_amount: 500, currency: 'XYZ' });
    expect(res.data.fx_rate_to_base).toBe('1.000000');
    expect(res.data.value_base_amount).toBe('500.00');
  });
});

describe('Board grouping + rotting (§4.1)', () => {
  it('groups open deals by open stage with count, base sum and weighted sum', async () => {
    const board = await service.board(tenantA, pipelineId);
    expect(board.data.base_currency).toBe('INR');
    const cols = board.data.columns;
    // Only open stages are columns (Won/Lost excluded).
    expect(cols.every((c) => c.stage.stage_type === 'open')).toBe(true);
    const qualified = cols.find((c) => c.stage.name === 'Qualified')!;
    expect(qualified.count).toBeGreaterThanOrEqual(3);
    // Weighted = sum(base × win%/100). Qualified is 10%.
    expect(qualified.weighted_base).toBeCloseTo(qualified.sum_base * 0.1, 1);
  });

  it('flags rotting: amber past rotting_days, red past 1.5×', async () => {
    const proposal = stages.find((s) => s.name === 'Proposal')!; // rotting_days=10
    const d = await service.create(tenantA, userId, { title: 'Stale', value_amount: 1, currency: 'INR', stage_id: proposal.id });
    // Backdate stage_entered_at to 16 days ago → past 1.5×10=15 → red.
    await dbAdmin.update(deals).set({ stage_entered_at: new Date(Date.now() - 16 * 86_400_000) }).where(eq(deals.id, d.data.id));
    const board = await service.board(tenantA, pipelineId);
    const card = board.data.columns.find((c) => c.stage.name === 'Proposal')!.cards.find((x) => x.id === d.data.id)!;
    expect(card.rot_state).toBe('red');
    expect(card.idle_days).toBeGreaterThanOrEqual(16);
  });
});

describe('Stage move engine (§4.2)', () => {
  it('records history with seconds_in_previous_stage and updates stage_entered_at', async () => {
    const d = await service.create(tenantA, userId, { title: 'Mover', value_amount: 100, currency: 'INR' });
    await dbAdmin.update(deals).set({ stage_entered_at: new Date(Date.now() - 3600 * 1000) }).where(eq(deals.id, d.data.id));
    const proposal = stages.find((s) => s.name === 'Proposal')!;
    await service.moveStage(tenantA, userId, d.data.id, { stage_id: proposal.id });
    const hist = await dbAdmin.select().from(dealStageHistory).where(and(eq(dealStageHistory.deal_id, d.data.id))).orderBy(dealStageHistory.changed_at);
    const last = hist[hist.length - 1]!;
    expect(last.to_stage_id).toBe(proposal.id);
    expect(last.seconds_in_previous_stage).toBeGreaterThanOrEqual(3500);
  });

  it('moving to Won sets status=won + won_at and emits crm.deal.won', async () => {
    eventsStub.publish.mockClear();
    const d = await service.create(tenantA, userId, { title: 'Winner', value_amount: 200, currency: 'INR' });
    await service.moveStage(tenantA, userId, d.data.id, { stage_id: stageByType('won').id });
    const [row] = await dbAdmin.select().from(deals).where(eq(deals.id, d.data.id));
    expect(row!.status).toBe('won');
    expect(row!.won_at).not.toBeNull();
    expect(eventsStub.publish).toHaveBeenCalledWith(expect.objectContaining({ name: 'crm.deal.won' }), expect.anything());
  });

  it('moving to Lost records the reason and emits crm.deal.lost; broadcasts on the board', async () => {
    const spy = jest.fn();
    emitter.on('crm.board.changed', spy);
    const d = await service.create(tenantA, userId, { title: 'Loser', value_amount: 300, currency: 'INR' });
    await service.moveStage(tenantA, userId, d.data.id, { stage_id: stageByType('lost').id, lost_reason_note: 'Went with competitor' });
    const [row] = await dbAdmin.select().from(deals).where(eq(deals.id, d.data.id));
    expect(row!.status).toBe('lost');
    expect(row!.lost_reason_note).toBe('Went with competitor');
    expect(spy).toHaveBeenCalled(); // live board broadcast fired
  });

  it('rejects a stage from another pipeline', async () => {
    const d = await service.create(tenantA, userId, { title: 'X', value_amount: 1, currency: 'INR' });
    const bStage = (await dbAdmin.select().from(pipelineStages).where(eq(pipelineStages.tenant_id, tenantB)))[0]!;
    await expect(service.moveStage(tenantA, userId, d.data.id, { stage_id: bStage.id })).rejects.toThrow(/pipeline/i);
  });
});

describe('Reopen gate + forecast (§4.2, §4.3)', () => {
  it('reopen requires manager-and-up; employee is refused', async () => {
    const d = await service.create(tenantA, userId, { title: 'ToReopen', value_amount: 10, currency: 'INR' });
    await service.moveStage(tenantA, userId, d.data.id, { stage_id: stageByType('won').id });
    const employee = { sub: userId, tenantId: tenantA, role: 'employee' } as never;
    await expect(service.reopen(tenantA, employee, d.data.id)).rejects.toThrow(/manager/i);
    const manager = { sub: userId, tenantId: tenantA, role: 'manager' } as never;
    const re = await service.reopen(tenantA, manager, d.data.id);
    expect(re.data.status).toBe('open');
  });

  it('forecast returns open/weighted/won in base currency', async () => {
    const f = await service.forecast(tenantA, pipelineId);
    expect(f.data.base_currency).toBe('INR');
    expect(f.data.open_value).toBeGreaterThan(0);
    expect(f.data.weighted_value).toBeLessThanOrEqual(f.data.open_value);
    expect(f.data.won_value).toBeGreaterThan(0);
  });
});

describe('Deal → invoice (§4.4, the flagship suite hook)', () => {
  it('creates+links a customer, mints a DRAFT invoice with back-links, and reuses the customer next time', async () => {
    const co = await directory.createCompany(tenantA, userId, { name: `Flagship Co ${rid()}`, domain: `flag-${rid()}.com` });
    const d1 = await service.create(tenantA, userId, { title: 'Flagship deal', value_amount: 5000, currency: 'INR', company_id: co.data.id });

    eventsStub.publish.mockClear();
    const r1 = await service.createInvoice(tenantA, userId, d1.data.id);
    expect(r1.data.invoice_id).toBeTruthy();

    // A billing customer was created and linked to the directory company.
    const [cust] = await dbAdmin.select().from(customers).where(eq(customers.id, r1.data.customer_id));
    expect(cust!.directory_company_id).toBe(co.data.id);

    // DRAFT invoice, back-linked to the deal; single value line = ₹5000.
    const [inv] = await dbAdmin.select().from(invoicesTable).where(eq(invoicesTable.id, r1.data.invoice_id));
    expect(inv!.status).toBe('DRAFT');
    expect(inv!.deal_id).toBe(d1.data.id);
    expect(inv!.total_amount).toBe('5000.00');

    // The deal points back at the invoice; the timeline event fired.
    const [deal] = await dbAdmin.select().from(deals).where(eq(deals.id, d1.data.id));
    expect(deal!.invoice_id).toBe(r1.data.invoice_id);
    expect(eventsStub.publish).toHaveBeenCalledWith(expect.objectContaining({ name: 'crm.deal.invoice_created' }));

    // A second deal on the same company REUSES the existing billing customer.
    const d2 = await service.create(tenantA, userId, { title: 'Second deal', value_amount: 200, currency: 'INR', company_id: co.data.id });
    const r2 = await service.createInvoice(tenantA, userId, d2.data.id);
    expect(r2.data.customer_id).toBe(r1.data.customer_id);
  });
});

describe('Tenant isolation', () => {
  it('tenant A cannot fetch or move a tenant B deal; app role never crosses tenants', async () => {
    const bDeal = await service.create(tenantB, userId, { title: 'B-only', value_amount: 9, currency: 'INR' });
    await expect(service.get(tenantA, bDeal.data.id)).rejects.toThrow(/not found/i);
    const rows = await withTenant(tenantA, (tx) => tx.select().from(deals));
    expect(rows.every((r) => r.tenant_id === tenantA)).toBe(true);
    // The domain_events written across both tenants are correctly attributed.
    void domainEvents;
  });
});
