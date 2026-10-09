/**
 * Round R · R3 — closed things are editable (founder item 8, 2026-10-07).
 *
 *  Deals:   POST /outcome switches won ↔ lost (a real stage move with history
 *           and events), edits the lost reason / note, corrects the won / lost
 *           date; reopen goes into a CHOSEN open stage; moving a closed deal
 *           off its terminal stage needs a manager; PATCH stays open.
 *  Leads:   PATCH edits a lead still in play (fields, owner, new ↔ working);
 *           a discarded lead can be restored.
 *  Activities: PATCH edits subject / notes / due / assignee; a completed task
 *           can be marked not done (the deal's next-activity stamp follows).
 */
import 'dotenv/config';
import * as crypto from 'crypto';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { and, desc, eq } from 'drizzle-orm';
import { db, dbAdmin } from '@flicks/db';
import {
  activities,
  auditLog,
  deals,
  dealStageHistory,
  directoryCompanies,
  directoryPeople,
  leads,
  lostReasons,
  memberships,
  pipelines,
  pipelineStages,
  tenants,
  users,
} from '@flicks/db/schema';
import type { JwtPayload } from '@flicks/shared/types';
import { DatabaseService } from '../core/database/database.service';
import { AuditService } from '../modules/audit/audit.service';
import { DealsService } from '../modules/crm/deals.service';
import { LeadsService } from '../modules/crm/leads.service';
import { ActivitiesService } from '../modules/crm/activities.service';
import { FxService } from '../modules/crm/fx.service';

const rid = () => crypto.randomBytes(4).toString('hex');
const dbSvc = new DatabaseService();
const audit = new AuditService(db as never, dbAdmin as never, dbSvc);
const published: Array<{ name: string; payload: Record<string, unknown> }> = [];
const eventsStub = { publish: jest.fn(async (e: { name: string; payload: Record<string, unknown> }) => { published.push(e); return 'evt'; }) };
const pings: string[] = [];
const notifyStub = { createInAppNotification: jest.fn(async (userId: string) => { pings.push(userId); }), sendEmail: async () => true };
const presenceStub = { statusOf: async () => 'online' };
const emitter = new EventEmitter2();
const boardPushes: unknown[] = [];
emitter.on('crm.board.changed', (p) => boardPushes.push(p));
const fx = new FxService(dbAdmin as never, { get: () => undefined } as never);
const dealsSvc = new DealsService(dbSvc, audit, eventsStub as never, fx, emitter, {} as never);
const leadsSvc = new LeadsService(dbSvc, audit, eventsStub as never, presenceStub as never, {} as DealsService);
const activitiesSvc = new ActivitiesService(dbSvc, audit, eventsStub as never, notifyStub as never, presenceStub as never);

const DAY = 86_400_000;
let A: string;
let B: string;
let manager: string;
let rep: string;
let other: string; // active member of A, not the owner of anything
let stagesA: Array<typeof pipelineStages.$inferSelect>;
let stagesB: Array<typeof pipelineStages.$inferSelect>;
let otherPipelineStage: string; // an open stage of a SECOND pipeline in A
let reasonA: string;
let reasonA2: string;
let reasonB: string;
const asUser = (sub: string, role: string) => ({ sub, role, tenantId: A, isPlatformAdmin: false } as JwtPayload);
const byType = (list: typeof stagesA, type: string) => list.find((s) => s.stage_type === type)!;
const byName = (list: typeof stagesA, name: string) => list.find((s) => s.name === name)!;

async function seedTenant(label: string) {
  const [t] = await dbAdmin
    .insert(tenants)
    .values({ name: `RR3 ${label} ${rid()}`, slug: `rr3-${label.toLowerCase()}-${rid()}`, status: 'active', currency: 'INR', state_code: 'KA' })
    .returning();
  const [pl] = await dbAdmin.insert(pipelines).values({ tenant_id: t!.id, name: 'Sales', is_default: true }).returning();
  await dbAdmin.insert(pipelineStages).values([
    { tenant_id: t!.id, pipeline_id: pl!.id, name: 'Qualified', display_order: 0, win_probability: 10, stage_type: 'open' },
    { tenant_id: t!.id, pipeline_id: pl!.id, name: 'Proposal', display_order: 1, win_probability: 60, stage_type: 'open' },
    { tenant_id: t!.id, pipeline_id: pl!.id, name: 'Won', display_order: 2, win_probability: 100, stage_type: 'won' },
    { tenant_id: t!.id, pipeline_id: pl!.id, name: 'Lost', display_order: 3, win_probability: 0, stage_type: 'lost' },
  ]);
  const stages = await dbAdmin.select().from(pipelineStages).where(eq(pipelineStages.tenant_id, t!.id));
  return { id: t!.id, pipelineId: pl!.id, stages };
}
async function mkUser(label: string, tenantId: string, role: 'owner' | 'manager' | 'employee') {
  const [u] = await dbAdmin.insert(users).values({ email: `rr3-${label}-${rid()}@test.test`, full_name: `${label} R3`, status: 'active' }).returning();
  await dbAdmin.insert(memberships).values({ tenant_id: tenantId, user_id: u!.id, role, status: 'active', accepted_at: new Date() });
  return u!.id;
}
const lastEvents = (name: string) => published.filter((e) => e.name === name);
async function historyOf(dealId: string) {
  return dbAdmin.select().from(dealStageHistory).where(eq(dealStageHistory.deal_id, dealId)).orderBy(desc(dealStageHistory.changed_at));
}
async function dealRow(id: string) {
  const [d] = await dbAdmin.select().from(deals).where(eq(deals.id, id));
  return d!;
}
async function wonDeal(title: string) {
  const d = await dealsSvc.create(A, manager, { title, value_amount: 1000 });
  await dealsSvc.moveStage(A, manager, d.data.id, { stage_id: byType(stagesA, 'won').id });
  return d.data.id;
}

beforeAll(async () => {
  const a = await seedTenant('Alpha');
  const b = await seedTenant('Bravo');
  A = a.id; B = b.id; stagesA = a.stages; stagesB = b.stages;
  manager = await mkUser('manager', A, 'manager');
  rep = await mkUser('rep', A, 'employee');
  other = await mkUser('other', A, 'employee');
  const [pl2] = await dbAdmin.insert(pipelines).values({ tenant_id: A, name: 'Partners' }).returning();
  const [s2] = await dbAdmin.insert(pipelineStages).values({ tenant_id: A, pipeline_id: pl2!.id, name: 'Intro', display_order: 0, win_probability: 5, stage_type: 'open' }).returning();
  otherPipelineStage = s2!.id;
  const [r1] = await dbAdmin.insert(lostReasons).values({ tenant_id: A, label: 'Price', display_order: 0 }).returning();
  const [r2] = await dbAdmin.insert(lostReasons).values({ tenant_id: A, label: 'Timing', display_order: 1 }).returning();
  const [rb] = await dbAdmin.insert(lostReasons).values({ tenant_id: B, label: 'Bravo reason', display_order: 0 }).returning();
  reasonA = r1!.id; reasonA2 = r2!.id; reasonB = rb!.id;
});

afterAll(async () => {
  const uids = (await dbAdmin.select({ u: memberships.user_id }).from(memberships).where(eq(memberships.tenant_id, A))).map((r) => r.u);
  await dbAdmin.delete(tenants).where(eq(tenants.id, A));
  await dbAdmin.delete(tenants).where(eq(tenants.id, B));
  for (const u of uids) await dbAdmin.delete(users).where(eq(users.id, u)).catch(() => {});
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
});

// ─── Deals: outcome ──────────────────────────────────────────────────────────

describe('deal outcome (won ↔ lost, reason, date)', () => {
  it('won → lost: a real stage move onto the Lost stage with history, reason, events and a board push; the close moment is kept', async () => {
    const id = await wonDeal('Acme renewal');
    const before = await dealRow(id);
    published.length = 0; boardPushes.length = 0;
    const res = await dealsSvc.setOutcome(A, asUser(manager, 'manager'), id, { outcome: 'lost', lost_reason_id: reasonA, lost_reason_note: 'Chose a cheaper tool' });
    expect(res.data).toMatchObject({ status: 'lost', stage_id: byType(stagesA, 'lost').id, lost_reason_id: reasonA, lost_reason_note: 'Chose a cheaper tool', won_at: null });
    // the verdict changed, not the moment: lost_at inherits the old won_at
    expect(res.data.lost_at!.getTime()).toBe(before.won_at!.getTime());
    const hist = await historyOf(id);
    expect(hist[0]).toMatchObject({ from_stage_id: byType(stagesA, 'won').id, to_stage_id: byType(stagesA, 'lost').id, changed_by: manager });
    expect(lastEvents('crm.deal.stage_changed')).toHaveLength(1);
    expect(lastEvents('crm.deal.lost')[0]?.payload).toMatchObject({ deal_id: id, lost_reason_id: reasonA });
    expect(lastEvents('crm.deal.won')).toHaveLength(0);
    expect(boardPushes).toHaveLength(1);
    const [a] = await dbAdmin.select().from(auditLog).where(and(eq(auditLog.resource_id, id), eq(auditLog.action, 'crm.deal.outcome_change')));
    expect(a?.before_state).toMatchObject({ status: 'won' });
    expect(a?.after_state).toMatchObject({ status: 'lost', lost_reason_id: reasonA });
  });

  it('lost → won: the reason is cleared, crm.deal.won fires with the base value', async () => {
    const id = await wonDeal('Beta pilot');
    await dealsSvc.setOutcome(A, asUser(manager, 'manager'), id, { outcome: 'lost', lost_reason_note: 'went silent' });
    published.length = 0;
    const res = await dealsSvc.setOutcome(A, asUser(manager, 'manager'), id, { outcome: 'won' });
    expect(res.data).toMatchObject({ status: 'won', stage_id: byType(stagesA, 'won').id, lost_reason_id: null, lost_reason_note: null, lost_at: null });
    expect(res.data.won_at).not.toBeNull();
    expect(lastEvents('crm.deal.won')[0]?.payload).toMatchObject({ deal_id: id, value_base: 1000 });
    expect(lastEvents('crm.deal.lost')).toHaveLength(0);
  });

  it('editing the reason of a deal that stays lost is a plain update: no second lost event, no history row, the date untouched', async () => {
    const id = await wonDeal('Gamma');
    await dealsSvc.setOutcome(A, asUser(manager, 'manager'), id, { outcome: 'lost', lost_reason_id: reasonA, lost_reason_note: 'first note' });
    const before = await dealRow(id);
    const histBefore = (await historyOf(id)).length;
    published.length = 0; boardPushes.length = 0;
    const res = await dealsSvc.setOutcome(A, asUser(manager, 'manager'), id, { outcome: 'lost', lost_reason_id: reasonA2, lost_reason_note: 'second note' });
    expect(res.data).toMatchObject({ status: 'lost', lost_reason_id: reasonA2, lost_reason_note: 'second note' });
    expect(res.data.lost_at!.getTime()).toBe(before.lost_at!.getTime());
    expect((await historyOf(id)).length).toBe(histBefore);
    expect(lastEvents('crm.deal.lost')).toHaveLength(0);
    expect(lastEvents('crm.deal.updated')).toHaveLength(1);
    expect(boardPushes).toHaveLength(0);
    const [a] = await dbAdmin.select().from(auditLog).where(and(eq(auditLog.resource_id, id), eq(auditLog.action, 'crm.deal.outcome_update')));
    expect(a).toBeDefined();
    // correcting only the date keeps the reason
    const when = new Date(Date.now() - 40 * DAY);
    const dated = await dealsSvc.setOutcome(A, asUser(manager, 'manager'), id, { outcome: 'lost', closed_at: when.toISOString() });
    expect(dated.data.lost_reason_id).toBe(reasonA2);
    expect(Math.abs(dated.data.lost_at!.getTime() - when.getTime())).toBeLessThan(1000);
  });

  it('correcting the won date moves what the reports read (won_at); switching with a date uses that date', async () => {
    const id = await wonDeal('Delta');
    const when = new Date(Date.now() - 10 * DAY);
    const res = await dealsSvc.setOutcome(A, asUser(manager, 'manager'), id, { outcome: 'won', closed_at: when.toISOString() });
    expect(Math.abs(res.data.won_at!.getTime() - when.getTime())).toBeLessThan(1000);
    const when2 = new Date(Date.now() - 3 * DAY);
    const sw = await dealsSvc.setOutcome(A, asUser(manager, 'manager'), id, { outcome: 'lost', closed_at: when2.toISOString(), lost_reason_note: 'late loss' });
    expect(Math.abs(sw.data.lost_at!.getTime() - when2.getTime())).toBeLessThan(1000);
    expect(sw.data.won_at).toBeNull();
  });

  it('refuses: an open deal, a future or invalid date, a foreign reason, a rep, another company; a back-dated close is fine', async () => {
    const open = await dealsSvc.create(A, manager, { title: 'Still open', value_amount: 5 });
    await expect(dealsSvc.setOutcome(A, asUser(manager, 'manager'), open.data.id, { outcome: 'lost' })).rejects.toBeInstanceOf(BadRequestException);
    const id = await wonDeal('Epsilon');
    await expect(dealsSvc.setOutcome(A, asUser(manager, 'manager'), id, { outcome: 'won', closed_at: new Date(Date.now() + DAY).toISOString() })).rejects.toThrow(/future/);
    // a date before the deal was entered is fine (backfilled history)
    expect(Math.abs((await dealsSvc.setOutcome(A, asUser(manager, 'manager'), id, { outcome: 'won', closed_at: new Date(Date.now() - 365 * DAY).toISOString() })).data.won_at!.getTime() - (Date.now() - 365 * DAY))).toBeLessThan(5000);
    await expect(dealsSvc.setOutcome(A, asUser(manager, 'manager'), id, { outcome: 'won', closed_at: 'not-a-date' })).rejects.toThrow(/valid date/);
    await expect(dealsSvc.setOutcome(A, asUser(manager, 'manager'), id, { outcome: 'lost', lost_reason_id: reasonB })).rejects.toThrow(/does not belong/);
    await expect(dealsSvc.setOutcome(A, asUser(manager, 'manager'), id, { outcome: 'lost', lost_reason_id: crypto.randomUUID() })).rejects.toThrow(/does not belong/);
    await expect(dealsSvc.setOutcome(A, asUser(rep, 'employee'), id, { outcome: 'lost' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(dealsSvc.setOutcome(B, { sub: manager, role: 'manager', tenantId: B } as JwtPayload, id, { outcome: 'lost' })).rejects.toBeInstanceOf(NotFoundException);
    expect((await dealRow(id)).status).toBe('won');
  });
});

// ─── Deals: reopen into a chosen stage, move off a terminal stage ────────────

describe('reopen into a chosen stage; moving a closed deal', () => {
  it('reopen picks the stage; without one it is the first open stage; won / foreign-pipeline stages are refused', async () => {
    const id = await wonDeal('Zeta');
    published.length = 0;
    const res = await dealsSvc.reopen(A, asUser(manager, 'manager'), id, { stage_id: byName(stagesA, 'Proposal').id });
    expect(res.data).toMatchObject({ status: 'open', stage_id: byName(stagesA, 'Proposal').id, won_at: null, lost_at: null });
    expect((await historyOf(id))[0]).toMatchObject({ from_stage_id: byType(stagesA, 'won').id, to_stage_id: byName(stagesA, 'Proposal').id });
    expect(lastEvents('crm.deal.reopened')[0]?.payload).toMatchObject({ deal_id: id, to_stage: byName(stagesA, 'Proposal').id });
    await dealsSvc.moveStage(A, manager, id, { stage_id: byType(stagesA, 'lost').id, lost_reason_note: 'x' });
    const def = await dealsSvc.reopen(A, asUser(manager, 'manager'), id);
    expect(def.data.stage_id).toBe(byName(stagesA, 'Qualified').id);
    await dealsSvc.moveStage(A, manager, id, { stage_id: byType(stagesA, 'won').id });
    await expect(dealsSvc.reopen(A, asUser(manager, 'manager'), id, { stage_id: byType(stagesA, 'lost').id })).rejects.toThrow(/open stage/);
    await expect(dealsSvc.reopen(A, asUser(manager, 'manager'), id, { stage_id: otherPipelineStage })).rejects.toThrow(/different pipeline/);
    await expect(dealsSvc.reopen(A, asUser(manager, 'manager'), id, { stage_id: stagesB[0]!.id })).rejects.toBeInstanceOf(BadRequestException);
    await expect(dealsSvc.reopen(A, asUser(rep, 'employee'), id)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('a rep can move an open deal but not a closed one; a manager can; internal callers are unaffected', async () => {
    const id = await wonDeal('Eta');
    await expect(dealsSvc.moveStage(A, rep, id, { stage_id: byName(stagesA, 'Proposal').id }, { role: 'employee' })).rejects.toBeInstanceOf(ForbiddenException);
    expect((await dealRow(id)).status).toBe('won');
    await dealsSvc.moveStage(A, manager, id, { stage_id: byName(stagesA, 'Proposal').id }, { role: 'manager' });
    expect((await dealRow(id)).status).toBe('open');
    await dealsSvc.moveStage(A, rep, id, { stage_id: byName(stagesA, 'Qualified').id }, { role: 'employee' });
    expect((await dealRow(id)).stage_id).toBe(byName(stagesA, 'Qualified').id);
    await dealsSvc.moveStage(A, rep, id, { stage_id: byType(stagesA, 'won').id }, { role: 'employee' });
    // automation / quote-acceptance path carries no role → still allowed
    await dealsSvc.moveStage(A, manager, id, { stage_id: byName(stagesA, 'Proposal').id });
    expect((await dealRow(id)).status).toBe('open');
  });

  it('PATCH stays open for a closed deal (title, owner, value, source)', async () => {
    const id = await wonDeal('Theta');
    const res = await dealsSvc.update(A, rep, id, { title: 'Theta (renamed)', owner_user_id: other, value_amount: 2500, source: 'referral' });
    expect(res.data).toMatchObject({ title: 'Theta (renamed)', owner_user_id: other, value_amount: '2500.00', source: 'referral', status: 'won' });
    // review fix: moving the deal to another company drops a primary contact of
    // the old company; a contact with no company, or the same company, stays.
    const [c1] = await dbAdmin.insert(directoryCompanies).values({ tenant_id: A, name: 'Acme' }).returning();
    const [c2] = await dbAdmin.insert(directoryCompanies).values({ tenant_id: A, name: 'Zed' }).returning();
    const [p1] = await dbAdmin.insert(directoryPeople).values({ tenant_id: A, first_name: 'Asha', company_id: c1!.id }).returning();
    const [p0] = await dbAdmin.insert(directoryPeople).values({ tenant_id: A, first_name: 'Nomad' }).returning();
    const linked = await dealsSvc.update(A, manager, id, { company_id: c1!.id, primary_person_id: p1!.id });
    expect(linked.data).toMatchObject({ company_id: c1!.id, primary_person_id: p1!.id });
    const same = await dealsSvc.update(A, manager, id, { company_id: c1!.id });
    expect(same.data.primary_person_id).toBe(p1!.id);
    const moved = await dealsSvc.update(A, manager, id, { company_id: c2!.id });
    expect(moved.data).toMatchObject({ company_id: c2!.id, primary_person_id: null });
    await dealsSvc.update(A, manager, id, { primary_person_id: p0!.id });
    const movedBack = await dealsSvc.update(A, manager, id, { company_id: c1!.id });
    expect(movedBack.data.primary_person_id).toBe(p0!.id);
  });
});

// ─── Leads ───────────────────────────────────────────────────────────────────

describe('leads: edit in play, restore a discarded one', () => {
  it('PATCH edits fields, owner and status; the score follows; owner changes imply the status', async () => {
    const l = await leadsSvc.create(A, manager, { first_name: 'Priya', email: 'priya@example.test', source: 'manual' });
    expect(l.data.status).toBe('new');
    const res = await leadsSvc.update(A, manager, l.data.id, { last_name: 'Nair', company_name: 'Nair Traders', phone: '+91 98765 43210', note: 'Wants a demo next week, two sites in Kochi.' });
    expect(res.data).toMatchObject({ first_name: 'Priya', last_name: 'Nair', company_name: 'Nair Traders', status: 'new' });
    expect(res.data.score).toBeGreaterThan(l.data.score);
    const owned = await leadsSvc.update(A, manager, l.data.id, { owner_user_id: rep });
    expect(owned.data).toMatchObject({ owner_user_id: rep, status: 'working' });
    const back = await leadsSvc.update(A, manager, l.data.id, { status: 'new' });
    expect(back.data).toMatchObject({ status: 'new', owner_user_id: rep });
    const unowned = await leadsSvc.update(A, manager, l.data.id, { owner_user_id: null });
    expect(unowned.data).toMatchObject({ owner_user_id: null, status: 'new' });
    // "working" with nobody on it becomes the editor's (same rule as claim)
    const working = await leadsSvc.update(A, manager, l.data.id, { status: 'working' });
    expect(working.data).toMatchObject({ status: 'working', owner_user_id: manager });
    // review fix: "working" + an explicit nobody is a contradiction, not a silent self-assign
    await expect(leadsSvc.update(A, manager, l.data.id, { status: 'working', owner_user_id: null })).rejects.toThrow(/needs an owner/);
    expect(lastEvents('crm.lead.updated').length).toBeGreaterThanOrEqual(4);
    await expect(leadsSvc.update(A, manager, l.data.id, { first_name: '   ' })).rejects.toThrow(/first name/);
    await expect(leadsSvc.update(A, manager, l.data.id, { owner_user_id: crypto.randomUUID() })).rejects.toThrow(/not an active member/);
    await expect(leadsSvc.update(A, manager, l.data.id, { status: 'converted' as never })).rejects.toBeInstanceOf(BadRequestException);
    await expect(leadsSvc.update(B, manager, l.data.id, { note: 'x' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('a discarded lead cannot be edited until restored; restore goes to new (no owner) or working (owner); only discarded leads restore', async () => {
    const l = await leadsSvc.create(A, manager, { first_name: 'Arjun', email: 'arjun@example.test' });
    await leadsSvc.discard(A, manager, l.data.id);
    await expect(leadsSvc.update(A, manager, l.data.id, { note: 'x' })).rejects.toThrow(/restore/i);
    published.length = 0;
    const r = await leadsSvc.restore(A, manager, l.data.id);
    expect(r.data.status).toBe('new');
    expect(lastEvents('crm.lead.restored')[0]?.payload).toMatchObject({ lead_id: l.data.id, status: 'new' });
    await expect(leadsSvc.restore(A, manager, l.data.id)).rejects.toThrow(/Only a discarded/);
    const o = await leadsSvc.create(A, manager, { first_name: 'Meera', owner_user_id: rep });
    await leadsSvc.discard(A, manager, o.data.id);
    expect((await leadsSvc.restore(A, manager, o.data.id)).data.status).toBe('working');
    await expect(leadsSvc.restore(B, manager, o.data.id)).rejects.toBeInstanceOf(NotFoundException);
    const [row] = await dbAdmin.select({ s: leads.status }).from(leads).where(eq(leads.id, o.data.id));
    expect(row?.s).toBe('working');
  });
});

// ─── Activities ──────────────────────────────────────────────────────────────

describe('activities: edit, mark not done', () => {
  it('PATCH edits subject / notes / due / assignee (pinging the new assignee) and keeps the deal stamps true', async () => {
    const d = await dealsSvc.create(A, manager, { title: 'Follow-up deal', value_amount: 1 });
    const due = new Date(Date.now() + 2 * DAY);
    const a = await activitiesSvc.create(A, manager, { type: 'call', subject: 'Intro call', deal_id: d.data.id, due_at: due.toISOString() });
    pings.length = 0;
    const later = new Date(Date.now() + 5 * DAY);
    const res = await activitiesSvc.update(A, manager, a.data.id, { subject: 'Discovery call', body: 'Ask about sites', due_at: later.toISOString(), assignee_user_id: rep, type: 'meeting' });
    expect(res.data).toMatchObject({ subject: 'Discovery call', body: 'Ask about sites', assignee_user_id: rep, type: 'meeting' });
    expect(Math.abs(res.data.due_at!.getTime() - later.getTime())).toBeLessThan(1000);
    await new Promise((r) => setTimeout(r, 30));
    expect(pings).toEqual([rep]);
    expect(Math.abs((await dealRow(d.data.id)).next_activity_at!.getTime() - later.getTime())).toBeLessThan(1000);
    expect(lastEvents('crm.activity.updated').length).toBeGreaterThanOrEqual(1);
    await expect(activitiesSvc.update(A, manager, a.data.id, { due_at: null })).rejects.toThrow(/need a due time/);
    await expect(activitiesSvc.update(A, manager, a.data.id, { subject: ' ' })).rejects.toThrow(/Subject/);
    await expect(activitiesSvc.update(A, manager, a.data.id, { assignee_user_id: crypto.randomUUID() })).rejects.toThrow(/not an active member/);
    await expect(activitiesSvc.update(A, manager, a.data.id, { outcome: 'nope' })).rejects.toThrow(/outcome/);
    await expect(activitiesSvc.update(A, manager, a.data.id, { type: 'note' })).rejects.toThrow(/cannot become a note/);
    await expect(activitiesSvc.update(B, manager, a.data.id, { subject: 'x' })).rejects.toBeInstanceOf(NotFoundException);
    // review fix: re-attributing a FINISHED item saves but never pings "assigned to you"
    await activitiesSvc.complete(A, rep, a.data.id);
    pings.length = 0;
    const done = await activitiesSvc.update(A, manager, a.data.id, { assignee_user_id: other });
    expect(done.data.assignee_user_id).toBe(other);
    await new Promise((r) => setTimeout(r, 30));
    expect(pings).toEqual([]);
  });

  it('mark not done reopens a completed task (deal next-activity comes back); notes cannot be reopened; idempotent', async () => {
    const d = await dealsSvc.create(A, manager, { title: 'Reopen deal', value_amount: 1 });
    const due = new Date(Date.now() + DAY);
    const a = await activitiesSvc.create(A, manager, { type: 'task', subject: 'Send proposal', deal_id: d.data.id, due_at: due.toISOString() });
    await activitiesSvc.complete(A, manager, a.data.id);
    expect((await dealRow(d.data.id)).next_activity_at).toBeNull();
    published.length = 0;
    const res = await activitiesSvc.reopen(A, manager, a.data.id);
    expect(res.data.completed_at).toBeNull();
    expect(res.data.completed_by).toBeNull();
    expect(Math.abs((await dealRow(d.data.id)).next_activity_at!.getTime() - due.getTime())).toBeLessThan(1000);
    expect(lastEvents('crm.activity.reopened')[0]?.payload).toMatchObject({ activity_id: a.data.id, deal_id: d.data.id });
    expect((await activitiesSvc.reopen(A, manager, a.data.id)).data.completed_at).toBeNull();
    const n = await activitiesSvc.create(A, manager, { type: 'note', subject: 'Called them', deal_id: d.data.id });
    await expect(activitiesSvc.reopen(A, manager, n.data.id)).rejects.toThrow(/note/i);
    await expect(activitiesSvc.reopen(B, manager, a.data.id)).rejects.toBeInstanceOf(NotFoundException);
    const [row] = await dbAdmin.select({ c: activities.completed_at }).from(activities).where(eq(activities.id, a.data.id));
    expect(row?.c).toBeNull();
  });
});
