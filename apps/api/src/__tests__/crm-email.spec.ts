import 'dotenv/config';
import * as crypto from 'crypto';
import { and, eq } from 'drizzle-orm';
import { db, dbAdmin } from '@flicks/db';
import {
  deals,
  directoryPeople,
  emailEvents,
  emailLinks,
  emailMessages,
  pipelines,
  pipelineStages,
  sequenceEnrollments,
  sequences,
  tenantInboundAddresses,
  tenants,
  users,
} from '@flicks/db/schema';
import { DatabaseService } from '../core/database/database.service';
import { AuditService } from '../modules/audit/audit.service';
import { CrmEmailService } from '../modules/crm/email.service';

/**
 * PRD v5 §7.1 Email Phase A — compose (variables/signature/DNC), tracking
 * (open pixel, wrapped links, unsubscribe), Resend webhook effects
 * (idempotency, auto-DNC on bounce), BCC dropbox routing + reply-exits.
 */

const rid = () => crypto.randomBytes(4).toString('hex');
const dbSvc = new DatabaseService();
const audit = new AuditService(db as never, dbAdmin as never, dbSvc);
const eventsStub = { publish: jest.fn(async () => 'evt') };
const sendRaw: jest.Mock = jest.fn(async () => `prov-${rid()}`);
const notifyStub = { sendRawEmail: sendRaw };
const configStub = { get: (k: string) => (k === 'APP_URL' ? 'http://localhost:3000' : undefined) };
const service = new CrmEmailService(dbSvc, dbAdmin as never, audit, eventsStub as never, notifyStub as never, configStub as never);

let tenantA: string;
let tenantB: string;
let userId: string;
let personA: string;
let dealA: string;

beforeAll(async () => {
  const [u] = await dbAdmin
    .insert(users)
    .values({ email: `mail-${rid()}@test.test`, full_name: 'Sara Khan', status: 'active', email_signature_html: '<p>— Sara @ Flicks</p>' })
    .returning();
  userId = u!.id;
  const mk = async () => {
    const [t] = await dbAdmin.insert(tenants).values({ name: `Mail${rid()}`, slug: `mail-${rid()}`, status: 'active', currency: 'INR' }).returning();
    const [pl] = await dbAdmin.insert(pipelines).values({ tenant_id: t!.id, name: 'Sales', is_default: true }).returning();
    const [st] = await dbAdmin.insert(pipelineStages).values({ tenant_id: t!.id, pipeline_id: pl!.id, name: 'Qualified', display_order: 0, win_probability: 10, stage_type: 'open' }).returning();
    return { tenant: t!.id, pipeline: pl!.id, stage: st!.id };
  };
  const A = await mk();
  const B = await mk();
  tenantA = A.tenant; tenantB = B.tenant;
  // users rows are RLS-visible only to tenants they belong to — the sender
  // lookup (name/email/signature) needs a membership.
  const { memberships } = await import('@flicks/db/schema');
  await dbAdmin.insert(memberships).values({ tenant_id: tenantA, user_id: userId, role: 'owner', status: 'active' });
  const [p] = await dbAdmin
    .insert(directoryPeople)
    .values({ tenant_id: tenantA, first_name: 'Wei Lin', last_name: 'Tan', email: `weilin-${rid()}@bluewave.example` })
    .returning();
  personA = p!.id;
  const [d] = await dbAdmin
    .insert(deals)
    .values({ tenant_id: tenantA, pipeline_id: A.pipeline, stage_id: A.stage, title: 'Bluewave upgrade', primary_person_id: personA, owner_user_id: userId, currency: 'INR', value_amount: '1000', value_base_amount: '1000' })
    .returning();
  dealA = d!.id;
});

afterAll(async () => {
  await dbAdmin.delete(tenants).where(eq(tenants.id, tenantA));
  await dbAdmin.delete(tenants).where(eq(tenants.id, tenantB));
  await dbAdmin.delete(users).where(eq(users.id, userId));
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
});

describe('Compose + send (§7.1, §19.4, §19.5)', () => {
  it('renders variables, appends the signature, instruments tracking, files on the deal', async () => {
    sendRaw.mockClear();
    const res = await service.send(tenantA, userId, {
      deal_id: dealA,
      subject: 'Hello {{first_name}} — about {{deal_title}}',
      body_html: '<p>Hi {{first_name}} at {{company}},</p><p><a href="https://flicks.example/pricing">Pricing</a></p><p><a href="{{unsubscribe_link}}">unsubscribe</a></p>',
    });
    expect(res.data.status).toBe('sent');

    const [msg] = await dbAdmin.select().from(emailMessages).where(eq(emailMessages.id, res.data.id));
    expect(msg!.subject).toBe('Hello Wei Lin — about Bluewave upgrade');
    expect(msg!.body_html).toContain('Hi Wei Lin at ,'); // no company linked → blank
    expect(msg!.body_html).toContain('— Sara @ Flicks'); // §19.4 signature
    expect(msg!.provider_id).toMatch(/^prov-/);
    expect(msg!.deal_id).toBe(dealA);

    // The instrumented HTML that actually went out: wrapped links + pixel.
    const sentHtml = (sendRaw.mock.calls[0]![0] as unknown as { html: string }).html;
    expect(sentHtml).toContain('/api/v1/t/c/'); // click-wrapped
    expect(sentHtml).toContain('/api/v1/t/o/'); // open pixel
    expect(sentHtml).not.toContain('https://flicks.example/pricing"'); // raw href replaced
    const links = await dbAdmin.select().from(emailLinks).where(eq(emailLinks.message_id, msg!.id));
    expect(links.length).toBeGreaterThanOrEqual(2); // pricing + unsubscribe target

    // Timeline stamps bumped.
    const [d] = await dbAdmin.select().from(deals).where(eq(deals.id, dealA));
    expect(d!.last_activity_at).not.toBeNull();
  });

  it('§19.5 do-not-contact HARD-blocks compose', async () => {
    await dbAdmin.update(directoryPeople).set({ email_do_not_contact: true, email_do_not_contact_reason: 'manual' }).where(eq(directoryPeople.id, personA));
    await expect(
      service.send(tenantA, userId, { deal_id: dealA, subject: 'x', body_html: '<p>y</p>' }),
    ).rejects.toThrow(/do-not-contact/i);
    await dbAdmin.update(directoryPeople).set({ email_do_not_contact: false, email_do_not_contact_reason: null }).where(eq(directoryPeople.id, personA));
  });
});

describe('Tracking + unsubscribe (C11)', () => {
  it('open pixel increments counts; clicks resolve + count; unsubscribe sets DNC and exits sequences', async () => {
    const res = await service.send(tenantA, userId, {
      deal_id: dealA, subject: 'Track me', body_html: '<p><a href="https://flicks.example/docs">Docs</a></p>',
    });
    const [msg] = await dbAdmin.select().from(emailMessages).where(eq(emailMessages.id, res.data.id));

    await service.trackOpen(msg!.open_token!);
    await service.trackOpen(msg!.open_token!);
    let [after] = await dbAdmin.select().from(emailMessages).where(eq(emailMessages.id, msg!.id));
    expect(after!.open_count).toBe(2);

    const [link] = await dbAdmin.select().from(emailLinks).where(eq(emailLinks.message_id, msg!.id));
    const url = await service.trackClick(link!.token);
    expect(url).toBe('https://flicks.example/docs');
    ;[after] = await dbAdmin.select().from(emailMessages).where(eq(emailMessages.id, msg!.id));
    expect(after!.click_count).toBe(1);
    expect(await service.trackClick('nope')).toBeNull();

    // Active enrollment + unsubscribe → DNC + exited.
    const [seq] = await dbAdmin.insert(sequences).values({ tenant_id: tenantA, name: `Seq ${rid()}` }).returning();
    await dbAdmin.insert(sequenceEnrollments).values({ tenant_id: tenantA, sequence_id: seq!.id, person_id: personA, status: 'active' });
    expect(await service.unsubscribe(msg!.open_token!)).toBe(true);
    const [p] = await dbAdmin.select().from(directoryPeople).where(eq(directoryPeople.id, personA));
    expect(p!.email_do_not_contact).toBe(true);
    expect(p!.email_do_not_contact_reason).toBe('unsubscribed');
    const [enr] = await dbAdmin.select().from(sequenceEnrollments).where(eq(sequenceEnrollments.person_id, personA));
    expect(enr!.status).toBe('exited');
    expect(enr!.exit_reason).toBe('dnc');
    const evts = await dbAdmin.select().from(emailEvents).where(eq(emailEvents.message_id, msg!.id));
    expect(evts.map((e) => e.type)).toEqual(expect.arrayContaining(['opened', 'clicked', 'unsubscribed']));
    // reset for later tests
    await dbAdmin.update(directoryPeople).set({ email_do_not_contact: false, email_do_not_contact_reason: null }).where(eq(directoryPeople.id, personA));
  });
});

describe('Resend webhook effects', () => {
  it('is idempotent by svix id; a bounce flips status AND auto-DNCs the person (§19.5)', async () => {
    const id = `svix-${rid()}`;
    expect(await service.markWebhookSeen(id)).toBe(true);
    expect(await service.markWebhookSeen(id)).toBe(false);

    const res = await service.send(tenantA, userId, { deal_id: dealA, subject: 'Bounce me', body_html: '<p>x</p>' });
    const [msg] = await dbAdmin.select().from(emailMessages).where(eq(emailMessages.id, res.data.id));
    await service.handleDeliveryEvent('bounced', msg!.provider_id!);
    const [after] = await dbAdmin.select().from(emailMessages).where(eq(emailMessages.id, msg!.id));
    expect(after!.status).toBe('bounced');
    const [p] = await dbAdmin.select().from(directoryPeople).where(eq(directoryPeople.id, personA));
    expect(p!.email_do_not_contact).toBe(true);
    expect(p!.email_do_not_contact_reason).toBe('bounced');
    await dbAdmin.update(directoryPeople).set({ email_do_not_contact: false, email_do_not_contact_reason: null }).where(eq(directoryPeople.id, personA));
  });

  it('BCC dropbox files an inbound email onto the contact + latest open deal and exits sequences on reply', async () => {
    const addr = await service.inboundAddress(tenantA);
    expect(addr.data.address).toMatch(/@in\./);
    const [p] = await dbAdmin.select().from(directoryPeople).where(eq(directoryPeople.id, personA));
    const [seq] = await dbAdmin.insert(sequences).values({ tenant_id: tenantA, name: `Seq ${rid()}` }).returning();
    await dbAdmin.insert(sequenceEnrollments).values({ tenant_id: tenantA, sequence_id: seq!.id, person_id: personA, status: 'active' });

    const result = await service.handleInbound({
      from: `Wei Lin <${p!.email}>`,
      to: [addr.data.address],
      subject: 'Re: Bluewave upgrade',
      html: '<p>Sounds good, send the contract.</p>',
    });
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.person_id).toBe(personA);
      expect(result.deal_id).toBe(dealA);
      const [msg] = await dbAdmin.select().from(emailMessages).where(eq(emailMessages.id, result.message_id));
      expect(msg!.direction).toBe('in');
      expect(msg!.status).toBe('received');
    }
    const enr = await dbAdmin
      .select()
      .from(sequenceEnrollments)
      .where(and(eq(sequenceEnrollments.sequence_id, seq!.id), eq(sequenceEnrollments.person_id, personA)));
    expect(enr[0]!.status).toBe('exited');
    expect(enr[0]!.exit_reason).toBe('replied');

    // Unknown dropbox token → unmatched, nothing filed.
    const miss = await service.handleInbound({ from: 'x@y.z', to: ['acme-doesnotexist@in.flickssuite.com'], subject: 'x' });
    expect(miss.matched).toBe(false);
  });

  it('never leaks messages across tenants', async () => {
    const list = await service.listForDeal(tenantB, dealA);
    expect(list.data).toHaveLength(0);
    void tenantInboundAddresses;
  });
});
