import 'dotenv/config';
import * as crypto from 'crypto';
import { eq } from 'drizzle-orm';
import { db, dbAdmin } from '@flicks/db';
import { activities, deals, pipelines, pipelineStages, tenants, users } from '@flicks/db/schema';
import { DatabaseService } from '../core/database/database.service';
import { AuditService } from '../modules/audit/audit.service';
import { ActivitiesService } from '../modules/crm/activities.service';

/**
 * PRD v5 §6 — activities & the follow-up loop (Sprint 28). Real-Postgres:
 * schedule/complete/log, deal next/last_activity_at maintenance, My Activities
 * buckets, cross-tenant refusal, isolation.
 */

const rid = () => crypto.randomBytes(4).toString('hex');
const dbSvc = new DatabaseService();
const audit = new AuditService(db as never, dbAdmin as never, dbSvc);
const eventsStub = { publish: jest.fn(async () => 'evt') };
const service = new ActivitiesService(dbSvc, audit, eventsStub as never);

let tenantA: string;
let tenantB: string;
let userId: string;
let dealA: string;

beforeAll(async () => {
  const [u] = await dbAdmin.insert(users).values({ email: `act-${rid()}@test.test`, full_name: 'Act User', status: 'active' }).returning();
  userId = u!.id;
  const mk = async () => {
    const [t] = await dbAdmin.insert(tenants).values({ name: `Act${rid()}`, slug: `act-${rid()}-${Date.now()}`, status: 'active', currency: 'INR' }).returning();
    const [pl] = await dbAdmin.insert(pipelines).values({ tenant_id: t!.id, name: 'Sales', is_default: true }).returning();
    const [st] = await dbAdmin.insert(pipelineStages).values({ tenant_id: t!.id, pipeline_id: pl!.id, name: 'Qualified', display_order: 0, win_probability: 10, stage_type: 'open' }).returning();
    const [d] = await dbAdmin.insert(deals).values({ tenant_id: t!.id, pipeline_id: pl!.id, stage_id: st!.id, title: `Deal ${rid()}`, owner_user_id: userId, currency: 'INR', value_amount: '100', value_base_amount: '100' }).returning();
    return { tenant: t!.id, deal: d!.id };
  };
  const a = await mk();
  const b = await mk();
  tenantA = a.tenant; dealA = a.deal; tenantB = b.tenant;
});

afterAll(async () => {
  await dbAdmin.delete(tenants).where(eq(tenants.id, tenantA));
  await dbAdmin.delete(tenants).where(eq(tenants.id, tenantB));
  await dbAdmin.delete(users).where(eq(users.id, userId));
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
});

describe('Activity loop (§6)', () => {
  it('scheduling sets the deal’s next_activity_at; completing moves it to last_activity_at', async () => {
    eventsStub.publish.mockClear();
    const due = new Date(Date.now() + 3600_000).toISOString();
    const a = await service.create(tenantA, userId, { type: 'call', subject: 'Intro call', deal_id: dealA, due_at: due });
    expect(eventsStub.publish).toHaveBeenCalledWith(expect.objectContaining({ name: 'crm.activity.created' }), expect.anything());
    let [d] = await dbAdmin.select().from(deals).where(eq(deals.id, dealA));
    expect(d!.next_activity_at?.toISOString()).toBe(new Date(due).toISOString());
    expect(d!.last_activity_at).toBeNull();

    const done = await service.complete(tenantA, userId, a.data.id, { outcome: 'connected', note: 'Great chat' });
    expect(done.data.completed_at).not.toBeNull();
    expect(done.data.outcome).toBe('connected');
    expect(done.data.body).toContain('Great chat');
    ;[d] = await dbAdmin.select().from(deals).where(eq(deals.id, dealA));
    expect(d!.next_activity_at).toBeNull(); // nothing open anymore
    expect(d!.last_activity_at).not.toBeNull();
    expect(eventsStub.publish).toHaveBeenCalledWith(expect.objectContaining({ name: 'crm.activity.completed' }), expect.anything());
    // Completing again is a no-op (idempotent).
    const again = await service.complete(tenantA, userId, a.data.id);
    expect(again.data.completed_at).toEqual(done.data.completed_at);
  });

  it('next_activity_at is the EARLIEST open due; deleting recomputes it', async () => {
    const soon = new Date(Date.now() + 2 * 3600_000).toISOString();
    const later = new Date(Date.now() + 48 * 3600_000).toISOString();
    const a1 = await service.create(tenantA, userId, { type: 'task', subject: 'Send proposal', deal_id: dealA, due_at: later });
    const a2 = await service.create(tenantA, userId, { type: 'meeting', subject: 'Demo', deal_id: dealA, due_at: soon });
    let [d] = await dbAdmin.select().from(deals).where(eq(deals.id, dealA));
    expect(d!.next_activity_at?.toISOString()).toBe(new Date(soon).toISOString());
    await service.remove(tenantA, userId, a2.data.id);
    ;[d] = await dbAdmin.select().from(deals).where(eq(deals.id, dealA));
    expect(d!.next_activity_at?.toISOString()).toBe(new Date(later).toISOString());
    await service.remove(tenantA, userId, a1.data.id);
  });

  it('a note is born completed and stamps last_activity_at without touching next', async () => {
    const before = await dbAdmin.select().from(deals).where(eq(deals.id, dealA));
    const n = await service.create(tenantA, userId, { type: 'note', subject: 'Left a voicemail', deal_id: dealA });
    expect(n.data.completed_at).not.toBeNull();
    const [d] = await dbAdmin.select().from(deals).where(eq(deals.id, dealA));
    expect(d!.last_activity_at).not.toBeNull();
    expect(d!.next_activity_at).toEqual(before[0]!.next_activity_at);
  });

  it('tasks/calls/meetings require a due time; invalid outcome is rejected', async () => {
    await expect(service.create(tenantA, userId, { type: 'task', subject: 'No due' })).rejects.toThrow(/due time/i);
    await expect(service.create(tenantA, userId, { type: 'call', subject: 'X', due_at: new Date().toISOString(), outcome: 'ghosted' })).rejects.toThrow(/outcome/i);
  });

  it('buckets My Activities into overdue / today / upcoming', async () => {
    const past = new Date(Date.now() - 3600_000).toISOString();
    const future = new Date(Date.now() + 72 * 3600_000).toISOString();
    await service.create(tenantA, userId, { type: 'task', subject: 'Overdue thing', deal_id: dealA, due_at: past });
    await service.create(tenantA, userId, { type: 'task', subject: 'Future thing', deal_id: dealA, due_at: future });
    const mine = await service.mine(tenantA, userId);
    expect(mine.data.overdue.some((r) => r.subject === 'Overdue thing')).toBe(true);
    expect(mine.data.upcoming.some((r) => r.subject === 'Future thing')).toBe(true);
    expect(mine.data.completed.some((r) => r.subject === 'Intro call')).toBe(true);
    // Deal titles ride along for the C8 rows.
    expect(mine.data.overdue.find((r) => r.subject === 'Overdue thing')!.deal_title).toBeTruthy();
  });

  it('refuses another tenant’s deal and never leaks activities across tenants', async () => {
    await expect(
      service.create(tenantB, userId, { type: 'task', subject: 'Cross', deal_id: dealA, due_at: new Date().toISOString() }),
    ).rejects.toThrow(/does not belong/i);
    const listB = await service.listForDeal(tenantB, dealA);
    expect(listB.data).toHaveLength(0);
    const mineB = await service.mine(tenantB, userId);
    expect([...mineB.data.overdue, ...mineB.data.today, ...mineB.data.upcoming].some((r) => r.deal_id === dealA)).toBe(false);
    void activities;
  });
});
