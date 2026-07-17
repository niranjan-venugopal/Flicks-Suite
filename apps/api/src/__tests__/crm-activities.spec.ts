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
const notifyStub = { createInAppNotification: jest.fn(async () => undefined) };
const presenceStub = { statusOf: jest.fn(async () => 'available') };
const service = new ActivitiesService(dbSvc, audit, eventsStub as never, notifyStub as never, presenceStub as never);

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

  it('mine() is assignee-scoped: completing a teammate’s deal task lands in THEIR queue, not the completer’s (bug-report repro)', async () => {
    const { memberships } = await import('@flicks/db/schema');
    const [mate] = await dbAdmin.insert(users).values({ email: `mate-${rid()}@test.test`, full_name: 'Mate M', status: 'active' }).returning();
    await dbAdmin.insert(memberships).values({ tenant_id: tenantA, user_id: mate!.id, role: 'employee', status: 'active' });
    const due = new Date(Date.now() + 3600_000).toISOString();

    // The reported flow: a task on the deal assigned to a teammate, completed
    // by the CREATOR from the deal timeline.
    const a = await service.create(tenantA, userId, { type: 'task', subject: 'Teammate follow-up', deal_id: dealA, due_at: due, assignee_user_id: mate!.id });
    await service.complete(tenantA, userId, a.data.id);

    // Completed on the deal timeline…
    const dealList = await service.listForDeal(tenantA, dealA);
    expect(dealList.data.some((r) => r.id === a.data.id && r.completed_at)).toBe(true);
    // …in the ASSIGNEE's recently-completed bucket…
    const theirs = await service.mine(tenantA, mate!.id);
    expect(theirs.data.completed.some((r) => r.id === a.data.id)).toBe(true);
    // …and nowhere in the completer's queue: My Activities is assignee-scoped.
    const mine = await service.mine(tenantA, userId);
    expect(
      [...mine.data.overdue, ...mine.data.today, ...mine.data.upcoming, ...mine.data.completed].some((r) => r.id === a.data.id),
    ).toBe(false);

    // Control: a self-assigned completed task DOES land in the creator's bucket.
    const b = await service.create(tenantA, userId, { type: 'task', subject: 'My own follow-up', deal_id: dealA, due_at: due });
    await service.complete(tenantA, userId, b.data.id);
    const mine2 = await service.mine(tenantA, userId);
    expect(mine2.data.completed.some((r) => r.id === b.data.id)).toBe(true);

    await dbAdmin.delete(activities).where(eq(activities.assignee_user_id, mate!.id));
    await dbAdmin.delete(users).where(eq(users.id, mate!.id));
  });

  it('pings the assignee when someone ELSE schedules for them — and DND swallows the ping (§6.3)', async () => {
    const [other] = await dbAdmin.insert(users).values({ email: `assignee-${rid()}@test.test`, full_name: 'Assignee A', status: 'active' }).returning();
    await dbAdmin.insert((await import('@flicks/db/schema')).memberships).values({ tenant_id: tenantA, user_id: other!.id, role: 'employee', status: 'active' });
    const due = new Date(Date.now() + 3600_000).toISOString();

    // Available assignee → ping delivered with the deal link.
    notifyStub.createInAppNotification.mockClear();
    await service.create(tenantA, userId, { type: 'task', subject: 'For you', deal_id: dealA, due_at: due, assignee_user_id: other!.id });
    expect(notifyStub.createInAppNotification).toHaveBeenCalledWith(
      other!.id, 'crm.activity.assigned', expect.stringContaining('For you'), `/crm/deals/${dealA}`, tenantA,
    );

    // Self-assigned → no ping.
    notifyStub.createInAppNotification.mockClear();
    await service.create(tenantA, userId, { type: 'task', subject: 'For me', deal_id: dealA, due_at: due });
    expect(notifyStub.createInAppNotification).not.toHaveBeenCalled();

    // DND assignee → ping suppressed (queue + digest still carry it).
    presenceStub.statusOf.mockImplementationOnce(async () => 'dnd');
    await service.create(tenantA, userId, { type: 'call', subject: 'Quiet hours', deal_id: dealA, due_at: due, assignee_user_id: other!.id });
    expect(notifyStub.createInAppNotification).not.toHaveBeenCalled();
    // FK order: the assignee's activities reference them — clear those first.
    await dbAdmin.delete(activities).where(eq(activities.assignee_user_id, other!.id));
    await dbAdmin.delete(users).where(eq(users.id, other!.id));
  });

  it('morning digest fires at the user’s local 08:00, once per day (§6.4)', async () => {
    const { CrmJobs } = await import('../jobs/crm.jobs');
    const digestNotify = { createInAppNotification: jest.fn(async () => undefined) };
    const jobs = new CrmJobs(dbAdmin as never, digestNotify as never, { tick: async () => 0 } as never);
    // An overdue task exists for userId (created in earlier tests). Pick a
    // `now` that is 08:xx in the user's timezone (users.timezone default IST).
    const now = new Date();
    const istHour = parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false }).format(now), 10);
    const at8 = new Date(now.getTime() + (8 - istHour) * 3600_000);
    const sent = await jobs.runDigestSweep(at8);
    expect(sent).toBeGreaterThanOrEqual(1);
    expect(digestNotify.createInAppNotification).toHaveBeenCalledWith(
      userId, 'crm.digest', expect.stringContaining('Good morning'), '/crm/activities', tenantA,
    );
    // Second sweep the same morning → idempotent, nothing re-sent to that user…
    // (the ledger row was written by the real notifications table? No — stub!)
    // The idempotency check reads the notifications TABLE, so simulate the real
    // write and re-run.
    const { notifications } = await import('@flicks/db/schema');
    await dbAdmin.insert(notifications).values({ user_id: userId, type: 'crm.digest', message: 'x', tenant_id: tenantA });
    digestNotify.createInAppNotification.mockClear();
    await jobs.runDigestSweep(at8);
    expect(digestNotify.createInAppNotification).not.toHaveBeenCalledWith(
      userId, 'crm.digest', expect.anything(), expect.anything(), expect.anything(),
    );
    await dbAdmin.delete(notifications).where(eq(notifications.user_id, userId));
    // Not 08:00 locally → nothing fires.
    const at11 = new Date(at8.getTime() + 3 * 3600_000);
    digestNotify.createInAppNotification.mockClear();
    await jobs.runDigestSweep(at11);
    expect(digestNotify.createInAppNotification).not.toHaveBeenCalled();
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
