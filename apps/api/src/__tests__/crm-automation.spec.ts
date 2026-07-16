import 'dotenv/config';
import * as crypto from 'crypto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { and, eq } from 'drizzle-orm';
import { db, dbAdmin } from '@flicks/db';
import {
  activities,
  deals,
  directoryCompanies,
  directoryPeople,
  formSubmissions,
  leads,
  memberships,
  pipelines,
  pipelineStages,
  tenants,
  users,
  workflowRuns,
  workflows,
} from '@flicks/db/schema';
import { DatabaseService } from '../core/database/database.service';
import { AuditService } from '../modules/audit/audit.service';
import { ActivitiesService } from '../modules/crm/activities.service';
import { CrmEmailService } from '../modules/crm/email.service';
import { DealsService } from '../modules/crm/deals.service';
import { DirectoryService } from '../modules/crm/directory.service';
import { FormsService } from '../modules/crm/forms.service';
import { FxService } from '../modules/crm/fx.service';
import { LeadsService, scoreLead } from '../modules/crm/leads.service';
import { WorkflowsService } from '../modules/crm/workflows.service';
import { CustomersService } from '../modules/invoicing/customers.service';
import { ItemsService } from '../modules/invoicing/items.service';
import { NumberingService } from '../modules/invoicing/numbering.service';
import { InvoicesService } from '../modules/invoicing/invoices.service';
import { OrgFinancialService } from '../modules/org-financial/org-financial.service';
import { InvoicingPublicService } from '../modules/invoicing/public';
import type { DomainEventEnvelope } from '../core/events/domain-events.service';

/**
 * PRD v5 §5/§8 (Sprint 30) — automation & capture: lead scoring + convert
 * dedupe, web-form spam gates + capture, the workflows engine (conditions,
 * actions, idempotency, loop guard). Real Postgres, direct service wiring.
 */

const rid = () => crypto.randomBytes(4).toString('hex');
const dbSvc = new DatabaseService();
const audit = new AuditService(db as never, dbAdmin as never, dbSvc);
const eventsStub = { publish: jest.fn(async () => `evt-${rid()}`) };
const inAppPings: Array<{ user: string; type: string; message: string }> = [];
const notifyStub = {
  createInAppNotification: jest.fn(async (user: string, type: string, message: string) => {
    inAppPings.push({ user, type, message });
  }),
  sendRawEmail: jest.fn(async () => `prov-${rid()}`),
  sendEmail: async () => true,
};
const presenceStub = { statusOf: jest.fn(async (..._args: unknown[]) => 'available' as string) };
const configStub = { get: (k: string) => (k === 'JWT_SECRET' ? 'testsecret' : undefined) } as never;

const fx = new FxService(dbAdmin as never, { get: () => undefined } as never);
const emitter = new EventEmitter2();
const numbering = new NumberingService(dbSvc, audit);
const customersSvc = new CustomersService(dbSvc, audit);
const itemsSvc = new ItemsService(dbSvc, audit);
const orgFinancial = new OrgFinancialService(dbSvc, audit);
const invoicesSvc = new InvoicesService(dbSvc, audit, numbering, { get: (_: string, fb?: unknown) => fb } as never, { sendEmail: async () => true } as never, orgFinancial, eventsStub as never);
const invoicingFacade = new InvoicingPublicService(dbAdmin as never, dbSvc, customersSvc, invoicesSvc, itemsSvc);
const dealsSvc = new DealsService(dbSvc, audit, eventsStub as never, fx, emitter, invoicingFacade);
const directorySvc = new DirectoryService(dbSvc, audit, eventsStub as never);
const activitiesSvc = new ActivitiesService(dbSvc, audit, eventsStub as never, notifyStub as never, presenceStub as never);
const emailSvc = new CrmEmailService(dbSvc, dbAdmin as never, audit, eventsStub as never, notifyStub as never, configStub);
const leadsSvc = new LeadsService(dbSvc, audit, eventsStub as never, presenceStub as never, dealsSvc);
const formsSvc = new FormsService(dbSvc, dbAdmin as never, audit, eventsStub as never, notifyStub as never, leadsSvc, activitiesSvc, configStub);
const workflowsSvc = new WorkflowsService(dbSvc, dbAdmin as never, audit, eventsStub as never, notifyStub as never, activitiesSvc, dealsSvc, leadsSvc, emailSvc);

void directorySvc; // directory dedupe is exercised through convert()

const signTs = (token: string, ts: string) =>
  crypto.createHmac('sha256', 'testsecret').update(`${token}.${ts}`).digest('hex').slice(0, 32);

const envOf = (name: string, tenantId: string, payload: Record<string, unknown>, actor?: string): DomainEventEnvelope => ({
  id: crypto.randomUUID(),
  name: name as never,
  tenantId,
  actorUserId: actor ?? null,
  occurredAt: new Date().toISOString(),
  payload,
});

let tenantA: string;
let owner: string;
let member: string;

beforeAll(async () => {
  const [u] = await dbAdmin.insert(users).values({ email: `auto-${rid()}@test.test`, full_name: 'Auto Owner', status: 'active' }).returning();
  owner = u!.id;
  const [u2] = await dbAdmin.insert(users).values({ email: `rep-${rid()}@test.test`, full_name: 'Rep Two', status: 'active' }).returning();
  member = u2!.id;
  const [t] = await dbAdmin.insert(tenants).values({ name: `Auto${rid()}`, slug: `auto-${rid()}`, status: 'active', currency: 'INR' }).returning();
  tenantA = t!.id;
  await dbAdmin.insert(memberships).values([
    { tenant_id: tenantA, user_id: owner, role: 'owner', status: 'active' },
    { tenant_id: tenantA, user_id: member, role: 'manager', status: 'active' },
  ]);
  const [pl] = await dbAdmin.insert(pipelines).values({ tenant_id: tenantA, name: 'Sales', is_default: true }).returning();
  await dbAdmin.insert(pipelineStages).values([
    { tenant_id: tenantA, pipeline_id: pl!.id, name: 'Qualified', display_order: 0, win_probability: 10, stage_type: 'open' },
    { tenant_id: tenantA, pipeline_id: pl!.id, name: 'Won', display_order: 1, win_probability: 100, stage_type: 'won' },
  ]);
});

afterAll(async () => {
  await dbAdmin.delete(tenants).where(eq(tenants.id, tenantA));
  await dbAdmin.delete(users).where(eq(users.id, owner));
  await dbAdmin.delete(users).where(eq(users.id, member));
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
});

describe('Leads (§5.1/§5.3, C6)', () => {
  it('scores deterministically and surfaces duplicate hints', async () => {
    expect(scoreLead({ email: 'a@b.c', phone: '1', company_name: 'X', note: 'we are evaluating your product', source: 'form:pricing', utm: { utm_source: 'reddit' } }))
      .toBe(10 + 5 + 10 + 10 + 5 + 5);

    // An existing person with the same email → dupe hint on the inbox row.
    const email = `asha-${rid()}@techcorp.example`;
    await dbAdmin.insert(directoryPeople).values({ tenant_id: tenantA, first_name: 'Asha', last_name: 'Rao', email });
    await leadsSvc.create(tenantA, owner, { first_name: 'Asha', email, company_name: 'TechCorp' });
    const inbox = await leadsSvc.list(tenantA, 'new');
    const row = inbox.data.find((l) => l.email === email)!;
    expect(row.dupe_person).toBeTruthy();
    expect(row.score).toBeGreaterThanOrEqual(20);
  });

  it('convert links the existing person by email, creates the company + deal, flips the lead — and refuses a re-run', async () => {
    const email = `dan-${rid()}@verde.example`;
    const [existing] = await dbAdmin.insert(directoryPeople).values({ tenant_id: tenantA, first_name: 'Daniel', last_name: 'Costa', email }).returning();
    const lead = await leadsSvc.create(tenantA, owner, { first_name: 'Daniel', email, company_name: `Verde Foods ${rid()}` });

    const res = await leadsSvc.convert(tenantA, owner, lead.data.id, { value_amount: 5000, currency: 'INR' });
    expect(res.data.person_id).toBe(existing!.id); // linked, not duplicated
    expect(res.data.company_id).toBeTruthy();
    const [deal] = await dbAdmin.select().from(deals).where(eq(deals.id, res.data.deal_id));
    expect(deal!.primary_person_id).toBe(existing!.id);
    expect(deal!.source).toBe('manual');
    const [after] = await dbAdmin.select().from(leads).where(eq(leads.id, lead.data.id));
    expect(after!.status).toBe('converted');
    expect(after!.converted_deal_id).toBe(res.data.deal_id);

    await expect(leadsSvc.convert(tenantA, owner, lead.data.id, {})).rejects.toThrow(/already decided/i);
  });

  it('discard keeps the row for analytics', async () => {
    const lead = await leadsSvc.create(tenantA, owner, { first_name: 'Trash', email: `t-${rid()}@x.example` });
    await leadsSvc.discard(tenantA, owner, lead.data.id);
    const [after] = await dbAdmin.select().from(leads).where(eq(leads.id, lead.data.id));
    expect(after!.status).toBe('discarded');
  });

  it('concurrent convert of the same lead yields exactly ONE deal (M1 atomic claim)', async () => {
    const lead = await leadsSvc.create(tenantA, owner, { first_name: 'Race', email: `race-${rid()}@x.example`, company_name: `RaceCo ${rid()}` });
    // Fire two converts at once — the atomic claim must let only one win.
    const results = await Promise.allSettled([
      leadsSvc.convert(tenantA, owner, lead.data.id, { value_amount: 100, currency: 'INR' }),
      leadsSvc.convert(tenantA, owner, lead.data.id, { value_amount: 100, currency: 'INR' }),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    const [after] = await dbAdmin.select().from(leads).where(eq(leads.id, lead.data.id));
    expect(after!.status).toBe('converted');
    // Only ONE deal points back to this converted lead.
    const dealsForLead = await dbAdmin.select().from(deals).where(and(eq(deals.tenant_id, tenantA), eq(deals.id, after!.converted_deal_id!)));
    expect(dealsForLead).toHaveLength(1);
  });
});

describe('Web forms (§5.2, C13)', () => {
  let token: string;
  let formId: string;

  beforeAll(async () => {
    const form = await formsSvc.create(tenantA, owner, { name: `Pricing ${rid()}`, source_tag: 'pricing' });
    token = form.data.token;
    formId = form.data.id;
  });

  it('serves the public descriptor with a signed timestamp', async () => {
    const pub = await formsSvc.publicForm(token);
    expect(pub.data.fields.length).toBeGreaterThan(0);
    expect(pub.data.sig).toBe(signTs(token, pub.data.ts));
  });

  it('silently drops honeypot + too-fast submissions (bots learn nothing)', async () => {
    const ts = String(Date.now() - 10_000);
    const before = await dbAdmin.select().from(leads).where(and(eq(leads.tenant_id, tenantA), eq(leads.form_id, formId)));
    // Honeypot filled.
    const r1 = await formsSvc.submit(token, { values: { name: 'Bot', email: 'bot@spam.example' }, ts, sig: signTs(token, ts), website: 'spam.example' }, '9.9.9.1');
    expect(r1.data.ok).toBe(true);
    // Filled in under 3 seconds.
    const fast = String(Date.now() - 500);
    await formsSvc.submit(token, { values: { name: 'Fast', email: 'fast@spam.example' }, ts: fast, sig: signTs(token, fast) }, '9.9.9.1');
    // Forged signature.
    await formsSvc.submit(token, { values: { name: 'Forge', email: 'forge@spam.example' }, ts, sig: 'deadbeef' }, '9.9.9.1');
    const after = await dbAdmin.select().from(leads).where(and(eq(leads.tenant_id, tenantA), eq(leads.form_id, formId)));
    expect(after.length).toBe(before.length); // nothing landed
  });

  it('a legitimate submission becomes a scored, round-robin-assigned lead + submission row + ping', async () => {
    const ts = String(Date.now() - 8_000);
    inAppPings.length = 0;
    const res = await formsSvc.submit(
      token,
      { values: { name: 'Asha Rao', email: `form-${rid()}@techcorp.example`, company: 'TechCorp' }, ts, sig: signTs(token, ts), utm: { utm_source: 'reddit', utm_medium: 'cpc', not_utm: 'dropped' } },
      '9.9.9.2',
    );
    expect(res.data.ok).toBe(true);
    const [lead] = await dbAdmin.select().from(leads)
      .where(and(eq(leads.tenant_id, tenantA), eq(leads.form_id, formId)))
      .orderBy(leads.created_at);
    expect(lead!.source).toBe('form:pricing');
    expect(lead!.owner_user_id).toBeTruthy(); // round-robin assigned
    expect((lead!.utm as Record<string, string>).utm_source).toBe('reddit');
    expect((lead!.utm as Record<string, string>).not_utm).toBeUndefined();
    const subs = await dbAdmin.select().from(formSubmissions).where(eq(formSubmissions.form_id, formId));
    expect(subs.length).toBe(1); // spam rows were never recorded
    expect(inAppPings.some((p) => p.type === 'crm.lead.assigned')).toBe(true);

    // Speed-to-lead: the assigned owner gets a "Call within 1h" task due ~+1h.
    const [task] = await dbAdmin.select().from(activities)
      .where(and(eq(activities.tenant_id, tenantA), eq(activities.subject, 'Call within 1h — Asha @ TechCorp')));
    expect(task).toBeTruthy();
    expect(task!.type).toBe('call');
    expect(task!.assignee_user_id).toBe(lead!.owner_user_id);
    const dueInMs = new Date(task!.due_at!).getTime() - Date.now();
    expect(dueInMs).toBeGreaterThan(30 * 60_000);
    expect(dueInMs).toBeLessThan(90 * 60_000);
  });

  it('hard-limits 10 submissions/hr/IP', async () => {
    const ip = '9.9.9.3';
    for (let i = 0; i < 10; i++) {
      const ts = String(Date.now() - 8_000);
      await formsSvc.submit(token, { values: { name: `N${i}`, email: `n${i}-${rid()}@x.example` }, ts, sig: signTs(token, ts) }, ip);
    }
    const ts = String(Date.now() - 8_000);
    await expect(formsSvc.submit(token, { values: { name: 'Over', email: 'over@x.example' }, ts, sig: signTs(token, ts) }, ip))
      .rejects.toThrow(/too many/i);
  });
});

describe('Workflows engine (§8, C12)', () => {
  it('validates trigger + actions and enforces the active cap shape', async () => {
    await expect(workflowsSvc.create(tenantA, owner, { name: 'Bad', trigger: 'crm.bogus', actions: [{ type: 'notify' }] }))
      .rejects.toThrow(/unknown trigger/i);
    await expect(workflowsSvc.create(tenantA, owner, { name: 'Bad2', trigger: 'crm.lead.created', actions: [] }))
      .rejects.toThrow(/at least one action/i);
    await expect(workflowsSvc.create(tenantA, owner, { name: 'Bad3', trigger: 'crm.lead.created', actions: [{ type: 'move_stage' }] }))
      .rejects.toThrow(/stage_id/i);
  });

  it('fires on a matching event: conditions gate, actions run, run is recorded once (idempotent)', async () => {
    const wf = await workflowsSvc.create(tenantA, owner, {
      name: 'Hot form lead → task + ping',
      trigger: 'crm.lead.created',
      conditions: [
        { field: 'source', op: 'starts_with', value: 'form:' },
        { field: 'score', op: 'gte', value: 20 },
      ],
      actions: [
        { type: 'create_activity', activity_type: 'call', subject: 'Call within 1h', due_in_hours: 1, assign_to: 'owner' },
        { type: 'notify', target: 'owner', message: 'Hot lead — call within the hour' },
      ],
    });

    const hot = await leadsSvc.create(tenantA, owner, {
      first_name: 'Hot', email: `hot-${rid()}@x.example`, company_name: 'BigCo', source: 'form:demo', owner_user_id: member,
    });
    const env = envOf('crm.lead.created', tenantA, { lead_id: hot.data.id }, owner);

    inAppPings.length = 0;
    expect(await workflowsSvc.handle(env)).toBe(1);
    expect(await workflowsSvc.handle(env)).toBe(0); // same event id → idempotent

    const runs = await dbAdmin.select().from(workflowRuns).where(eq(workflowRuns.workflow_id, wf.data.id));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('ok');
    expect((runs[0]!.steps as Array<{ status: string }>).every((s) => s.status === 'ok')).toBe(true);

    const acts = await dbAdmin.select().from(activities).where(and(eq(activities.tenant_id, tenantA), eq(activities.subject, 'Call within 1h')));
    expect(acts).toHaveLength(1);
    expect(acts[0]!.assignee_user_id).toBe(member); // 'owner' → the lead's owner
    expect(inAppPings.some((p) => p.user === member && /hot lead/i.test(p.message))).toBe(true);

    // Cold lead (manual, low score) → condition miss, no run row at all.
    const cold = await leadsSvc.create(tenantA, owner, { first_name: 'Cold' });
    expect(await workflowsSvc.handle(envOf('crm.lead.created', tenantA, { lead_id: cold.data.id }, owner))).toBe(0);
    const runs2 = await dbAdmin.select().from(workflowRuns).where(eq(workflowRuns.workflow_id, wf.data.id));
    expect(runs2).toHaveLength(1);
    await workflowsSvc.setActive(tenantA, owner, wf.data.id, false);
  });

  it('loop guard: a subject churning through runs within a minute gets skipped at depth 2', async () => {
    const wf = await workflowsSvc.create(tenantA, owner, {
      name: 'Ping every lead',
      trigger: 'crm.lead.created',
      actions: [{ type: 'notify', target: 'owner', message: 'ping' }],
    });
    const lead = await leadsSvc.create(tenantA, owner, { first_name: 'Loopy', owner_user_id: member });
    const payload = { lead_id: lead.data.id };
    expect(await workflowsSvc.handle(envOf('crm.lead.created', tenantA, payload, owner))).toBe(1);
    expect(await workflowsSvc.handle(envOf('crm.lead.created', tenantA, payload, owner))).toBe(1);
    // Third distinct event on the same subject inside the window → skipped.
    expect(await workflowsSvc.handle(envOf('crm.lead.created', tenantA, payload, owner))).toBe(0);
    const runs = await dbAdmin.select().from(workflowRuns).where(eq(workflowRuns.workflow_id, wf.data.id));
    expect(runs.filter((r) => r.status === 'skipped')).toHaveLength(1);
    await workflowsSvc.setActive(tenantA, owner, wf.data.id, false);
  });

  it('round-robin assignment skips out-of-office members', async () => {
    presenceStub.statusOf.mockImplementation(async (...args: unknown[]) => (args[1] === owner ? 'out_of_office' : 'available'));
    const picked = await leadsSvc.pickRoundRobinOwner(tenantA);
    expect(picked).toBe(member);
    presenceStub.statusOf.mockImplementation(async () => 'available');
  });
});
