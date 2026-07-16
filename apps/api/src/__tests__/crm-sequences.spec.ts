import 'dotenv/config';
import * as crypto from 'crypto';
import { and, eq } from 'drizzle-orm';
import { db, dbAdmin, withTenant } from '@flicks/db';
import {
  connectedEmailAccounts,
  deals,
  directoryPeople,
  emailMessages,
  memberships,
  pipelines,
  pipelineStages,
  sequenceEnrollments,
  tenants,
  users,
} from '@flicks/db/schema';
import { DatabaseService } from '../core/database/database.service';
import { AuditService } from '../modules/audit/audit.service';
import { CrmEmailService } from '../modules/crm/email.service';
import { SequencesService } from '../modules/crm/sequences.service';

/**
 * PRD v5 §7.1 / C10 — the sequences engine: enroll guards, windowed sending,
 * step advancement, exits (DNC/won), completion, daily throttle. Plus the C21
 * scaffold's security posture: connected-account tokens are self-visible only.
 */

const rid = () => crypto.randomBytes(4).toString('hex');
const dbSvc = new DatabaseService();
const audit = new AuditService(db as never, dbAdmin as never, dbSvc);
const eventsStub = { publish: jest.fn(async () => 'evt') };
const sendRaw: jest.Mock = jest.fn(async () => `prov-${rid()}`);
const notifyStub = { sendRawEmail: sendRaw };
const configStub = { get: () => undefined };
const email = new CrmEmailService(dbSvc, dbAdmin as never, audit, eventsStub as never, notifyStub as never, configStub as never);
const service = new SequencesService(dbSvc, dbAdmin as never, audit, eventsStub as never, email);

// A `now` guaranteed inside the default 09:00–18:00 IST window: today 12:00 IST.
function nowInWindow(): Date {
  const now = new Date();
  const istHour = parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false }).format(now), 10);
  return new Date(now.getTime() + (12 - istHour) * 3600_000);
}

let tenantA: string;
let userId: string;
let personA: string;
let dealA: string;
let seqId: string;

beforeAll(async () => {
  const [u] = await dbAdmin.insert(users).values({ email: `seq-${rid()}@test.test`, full_name: 'Seq Sender', status: 'active' }).returning();
  userId = u!.id;
  const [t] = await dbAdmin.insert(tenants).values({ name: `Seq${rid()}`, slug: `seq-${rid()}`, status: 'active', currency: 'INR' }).returning();
  tenantA = t!.id;
  await dbAdmin.insert(memberships).values({ tenant_id: tenantA, user_id: userId, role: 'owner', status: 'active' });
  const [pl] = await dbAdmin.insert(pipelines).values({ tenant_id: tenantA, name: 'Sales', is_default: true }).returning();
  const [st] = await dbAdmin.insert(pipelineStages).values({ tenant_id: tenantA, pipeline_id: pl!.id, name: 'Qualified', display_order: 0, win_probability: 10, stage_type: 'open' }).returning();
  const [p] = await dbAdmin.insert(directoryPeople).values({ tenant_id: tenantA, first_name: 'Rohit', last_name: 'Menon', email: `rohit-${rid()}@m.example` }).returning();
  personA = p!.id;
  const [d] = await dbAdmin.insert(deals).values({ tenant_id: tenantA, pipeline_id: pl!.id, stage_id: st!.id, title: 'Meridian renewal', primary_person_id: personA, owner_user_id: userId, currency: 'INR', value_amount: '100', value_base_amount: '100' }).returning();
  dealA = d!.id;
  const seq = await service.create(tenantA, userId, {
    name: 'Renewal nudge',
    steps: [
      { subject: 'Hi {{first_name}} — step 1', body_html: '<p>one</p>', wait_days: 0 },
      { subject: 'Following up — step 2', body_html: '<p>two</p>', wait_days: 3 },
    ],
  });
  seqId = seq.data.id;
});

afterAll(async () => {
  await dbAdmin.delete(tenants).where(eq(tenants.id, tenantA));
  await dbAdmin.delete(users).where(eq(users.id, userId));
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
});

describe('Sequence engine (§7.1 / C10)', () => {
  it('enrolls once (dup → 409), refuses DNC contacts, sends step 1 inside the window, schedules step 2', async () => {
    const enr = await service.enroll(tenantA, userId, { sequence_id: seqId, person_id: personA, deal_id: dealA });
    await expect(service.enroll(tenantA, userId, { sequence_id: seqId, person_id: personA })).rejects.toThrow(/already/i);

    const now = nowInWindow();
    // Force due now (enroll clamps into the window relative to real now).
    await dbAdmin.update(sequenceEnrollments).set({ next_send_at: now }).where(eq(sequenceEnrollments.id, enr.data.id));
    sendRaw.mockClear();
    const sent = await service.tick(now);
    expect(sent).toBe(1);
    const call = sendRaw.mock.calls[0]![0] as unknown as { subject: string };
    expect(call.subject).toBe('Hi Rohit — step 1'); // variables rendered

    const [after] = await dbAdmin.select().from(sequenceEnrollments).where(eq(sequenceEnrollments.id, enr.data.id));
    expect(after!.current_step).toBe(1);
    expect(after!.status).toBe('active');
    // step 2 waits 3 days.
    const diffDays = (new Date(after!.next_send_at!).getTime() - now.getTime()) / 86_400_000;
    expect(diffDays).toBeGreaterThan(2.5);
    expect(diffDays).toBeLessThan(3.6);

    // The sent message links back to the enrollment.
    const msgs = await dbAdmin.select().from(emailMessages).where(eq(emailMessages.sequence_enrollment_id, enr.data.id));
    expect(msgs).toHaveLength(1);
    expect(eventsStub.publish).toHaveBeenCalledWith(expect.objectContaining({ name: 'crm.sequence.step_sent' }));

    // Last step → completed.
    await dbAdmin.update(sequenceEnrollments).set({ next_send_at: now }).where(eq(sequenceEnrollments.id, enr.data.id));
    await service.tick(now);
    const [done] = await dbAdmin.select().from(sequenceEnrollments).where(eq(sequenceEnrollments.id, enr.data.id));
    expect(done!.status).toBe('completed');
    expect(eventsStub.publish).toHaveBeenCalledWith(expect.objectContaining({ name: 'crm.sequence.completed' }));
  });

  it('outside the send window nothing sends — next_send_at clamps to the window opening', async () => {
    const [p2] = await dbAdmin.insert(directoryPeople).values({ tenant_id: tenantA, first_name: 'Nite', email: `nite-${rid()}@m.example` }).returning();
    const enr = await service.enroll(tenantA, userId, { sequence_id: seqId, person_id: p2!.id });
    const now = nowInWindow();
    const midnightIsh = new Date(now.getTime() + 12 * 3600_000); // 00:00 IST → outside
    await dbAdmin.update(sequenceEnrollments).set({ next_send_at: midnightIsh, current_step: 0 }).where(eq(sequenceEnrollments.id, enr.data.id));
    sendRaw.mockClear();
    const sent = await service.tick(midnightIsh);
    expect(sent).toBe(0);
    expect(sendRaw).not.toHaveBeenCalled();
    const [after] = await dbAdmin.select().from(sequenceEnrollments).where(eq(sequenceEnrollments.id, enr.data.id));
    expect(after!.status).toBe('active');
    expect(new Date(after!.next_send_at!).getTime()).toBeGreaterThan(midnightIsh.getTime());
    await service.exit(tenantA, userId, enr.data.id);
  });

  it('DNC set mid-sequence exits on the next tick without sending (§19.5)', async () => {
    const [p3] = await dbAdmin.insert(directoryPeople).values({ tenant_id: tenantA, first_name: 'Dnc', email: `dnc-${rid()}@m.example` }).returning();
    const enr = await service.enroll(tenantA, userId, { sequence_id: seqId, person_id: p3!.id });
    await dbAdmin.update(directoryPeople).set({ email_do_not_contact: true, email_do_not_contact_reason: 'manual' }).where(eq(directoryPeople.id, p3!.id));
    const now = nowInWindow();
    await dbAdmin.update(sequenceEnrollments).set({ next_send_at: now }).where(eq(sequenceEnrollments.id, enr.data.id));
    sendRaw.mockClear();
    await service.tick(now);
    expect(sendRaw).not.toHaveBeenCalled();
    const [after] = await dbAdmin.select().from(sequenceEnrollments).where(eq(sequenceEnrollments.id, enr.data.id));
    expect(after!.status).toBe('exited');
    expect(after!.exit_reason).toBe('dnc');
  });

  it('a decided deal exits its enrollments (won/lost hook)', async () => {
    const [p4] = await dbAdmin.insert(directoryPeople).values({ tenant_id: tenantA, first_name: 'Won', email: `won-${rid()}@m.example` }).returning();
    const enr = await service.enroll(tenantA, userId, { sequence_id: seqId, person_id: p4!.id, deal_id: dealA });
    await service.exitByDeal(tenantA, dealA, 'won');
    const [after] = await dbAdmin.select().from(sequenceEnrollments).where(eq(sequenceEnrollments.id, enr.data.id));
    expect(after!.status).toBe('exited');
    expect(after!.exit_reason).toBe('won');
  });

  it('defers (not burns) the step at the 200/user/day throttle', async () => {
    const [p5] = await dbAdmin.insert(directoryPeople).values({ tenant_id: tenantA, first_name: 'Cap', email: `cap-${rid()}@m.example` }).returning();
    const enr = await service.enroll(tenantA, userId, { sequence_id: seqId, person_id: p5!.id });
    // Seed 200 outbound messages for the enrolling user, stamped to the tick's
    // own day (the throttle counts created_at >= UTC-midnight-of-now, and
    // nowInWindow can land on a later UTC day than wall-clock `now()`).
    const now = nowInWindow();
    await dbAdmin.insert(emailMessages).values(
      Array.from({ length: 200 }, (_, i) => ({
        tenant_id: tenantA, direction: 'out' as const, status: 'sent', to_email: `x${i}@y.z`, subject: 's', sender_user_id: userId, created_at: now,
      })),
    );
    await dbAdmin.update(sequenceEnrollments).set({ next_send_at: now, current_step: 0 }).where(eq(sequenceEnrollments.id, enr.data.id));
    sendRaw.mockClear();
    await service.tick(now);
    expect(sendRaw).not.toHaveBeenCalled();
    const [after] = await dbAdmin.select().from(sequenceEnrollments).where(eq(sequenceEnrollments.id, enr.data.id));
    expect(after!.status).toBe('active');
    expect(after!.current_step).toBe(0); // step NOT burned
    expect(new Date(after!.next_send_at!).getTime()).toBeGreaterThan(now.getTime());
    await dbAdmin.delete(emailMessages).where(and(eq(emailMessages.tenant_id, tenantA), eq(emailMessages.subject, 's')));
    await service.exit(tenantA, userId, enr.data.id);
  });
});

describe('C21 connected accounts — security posture', () => {
  it('rows are SELF-visible only: another member of the SAME tenant sees nothing', async () => {
    const [other] = await dbAdmin.insert(users).values({ email: `peek-${rid()}@test.test`, full_name: 'Peek', status: 'active' }).returning();
    await dbAdmin.insert(memberships).values({ tenant_id: tenantA, user_id: other!.id, role: 'admin', status: 'active' });
    await dbAdmin.insert(connectedEmailAccounts).values({
      tenant_id: tenantA, user_id: userId, provider: 'google', email: 'me@gmail.example',
      access_token_enc: 'CIPHERTEXT-A', refresh_token_enc: 'CIPHERTEXT-R',
    });
    // Owner sees their own row.
    const mine = await withTenant(tenantA, (tx) => tx.select().from(connectedEmailAccounts), userId);
    expect(mine).toHaveLength(1);
    // A DIFFERENT member of the same tenant sees ZERO rows (token privacy).
    const theirs = await withTenant(tenantA, (tx) => tx.select().from(connectedEmailAccounts), other!.id);
    expect(theirs).toHaveLength(0);
    await dbAdmin.delete(users).where(eq(users.id, other!.id));
  });
});
