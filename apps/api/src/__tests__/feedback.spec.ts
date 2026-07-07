import 'dotenv/config';
import * as crypto from 'crypto';
import { eq, sql } from 'drizzle-orm';
import { dbAdmin } from '@flicks/db';
import {
  tenants,
  users,
  invoices,
  customers as customersTable,
  employees,
  npsResponses,
} from '@flicks/db/schema';
import { DatabaseService } from '../core/database/database.service';
import { AnalyticsService } from '../core/analytics/analytics.service';
import { FeedbackService } from '../modules/feedback/feedback.service';
import { FeedbackController } from '../modules/feedback/feedback.controller';

/**
 * PRD v4 §7 — feedback + NPS (Sprint 20). Real-Postgres integration.
 */

const rid = () => crypto.randomBytes(4).toString('hex');
const dbSvc = new DatabaseService();
const config = { get: (_: string, fb?: unknown) => fb } as never;
const analytics = new AnalyticsService(config, dbAdmin as never);
const logPlatformSpy = jest.fn(async () => {});
const audit = { log: async () => {}, logPlatform: logPlatformSpy } as never;
const feedback = new FeedbackService(dbAdmin as never, dbSvc, analytics, audit);

describe('Feedback + NPS (PRD v4 §7)', () => {
  let tenantId: string;
  let userId: string;

  beforeAll(async () => {
    const [t] = await dbAdmin
      .insert(tenants)
      .values({
        name: `FbCo${rid()}`,
        slug: `fb-${rid()}-${Date.now()}`,
        status: 'trialing',
        // 30-day-old TENANT → passes the ≥21d NPS age gate (§7.2 gates on
        // workspace age, not the individual user's account age)
        created_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      })
      .returning();
    tenantId = t!.id;
    const [u] = await dbAdmin
      .insert(users)
      .values({
        email: `fb-${rid()}@test.test`,
        full_name: 'Fb User',
        status: 'active',
      })
      .returning();
    userId = u!.id;
  });

  afterAll(async () => {
    await dbAdmin.delete(tenants).where(eq(tenants.id, tenantId));
    await dbAdmin.delete(users).where(eq(users.id, userId));
    await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  });

  it('feedback submits, reaches the FAM inbox, and contact-ok gates the email', async () => {
    await feedback.submit(tenantId, userId, {
      category: 'idea',
      message: 'Bulk GSTR-1 downloads please',
      contact_ok: true,
      page_path: '/invoicing/reports',
    });
    await feedback.submit(tenantId, userId, {
      category: 'bug',
      message: 'No contact for this one',
      contact_ok: false,
    });
    const inbox = await feedback.famList({ tenantId });
    expect(inbox.data.length).toBe(2);
    const withContact = inbox.data.find((r) => r.category === 'idea')!;
    const withoutContact = inbox.data.find((r) => r.category === 'bug')!;
    expect(withContact.user_email).toContain('@'); // exposed when contact_ok
    expect(withoutContact.user_email).toBeNull(); // hidden otherwise
  });

  it('feedback throttle: the 11th submission in 24h is rejected with 429', async () => {
    // 2 rows exist from the previous test; add 8 more to reach the cap of 10.
    for (let i = 0; i < 8; i++) {
      await feedback.submit(tenantId, userId, { category: 'other', message: `filler ${i}` });
    }
    await expect(
      feedback.submit(tenantId, userId, { category: 'other', message: 'one too many' }),
    ).rejects.toThrow(/limit reached/i);
  });

  it('FAM status change + internal note round-trips and is platform-audited; reopening clears the resolution stamp', async () => {
    const inbox = await feedback.famList({ tenantId });
    const row = inbox.data[0]!;
    logPlatformSpy.mockClear();
    const updated = await feedback.famUpdate(row.id, userId, {
      status: 'resolved',
      internal_note: 'Repro confirmed',
    });
    expect(updated.data!.status).toBe('resolved');
    expect(updated.data!.internal_note).toBe('Repro confirmed');
    expect(updated.data!.resolved_by).toBe(userId);
    expect(updated.data!.resolved_at).not.toBeNull();
    // D12: every status change is audit-logged (platform track).
    expect(logPlatformSpy).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'fam.feedback_updated', actorUserId: userId }),
    );
    // Reopen → the stale resolution stamp must not survive.
    const reopened = await feedback.famUpdate(row.id, userId, { status: 'triaged' });
    expect(reopened.data!.status).toBe('triaged');
    expect(reopened.data!.resolved_by).toBeNull();
    expect(reopened.data!.resolved_at).toBeNull();
    // Empty PATCH body is a 400, not a drizzle crash.
    await expect(feedback.famUpdate(row.id, userId, {})).rejects.toThrow('Nothing to update');
  });

  it('FAM endpoints carry the @Roles(fam) guard metadata', () => {
    for (const method of ['famList', 'famUpdate', 'npsSummary'] as const) {
      const roles = Reflect.getMetadata('roles', FeedbackController.prototype[method]);
      expect(roles).toEqual(['fam']);
    }
  });

  it('NPS gates: ineligible without activity; eligible with active days + a sent invoice; answer is once-only; snooze re-prompts', async () => {
    // Not eligible yet (no first_login_day rows → 0 distinct active days).
    let e = await feedback.eligibility(tenantId, userId);
    expect(e.data.eligible).toBe(false);

    // 3 distinct active days (backdated product events) + one sent invoice.
    for (const daysAgo of [1, 2, 3]) {
      await dbAdmin.execute(
        // raw insert with explicit occurred_at (track() always stamps now())
        (await import('drizzle-orm')).sql`
          INSERT INTO product_events (tenant_id, user_id, event_name, occurred_at)
          VALUES (${tenantId}::uuid, ${userId}::uuid, 'first_login_day', now() - (${daysAgo}::int || ' days')::interval)`,
      );
    }
    const [cust] = await dbAdmin
      .insert(customersTable)
      .values({ tenant_id: tenantId, customer_code: `C-${rid()}`, display_name: 'NPS Co' })
      .returning();
    await dbAdmin.insert(invoices).values({
      tenant_id: tenantId,
      customer_id: cust!.id,
      invoice_number: `INV-${rid()}`,
      invoice_date: '2026-07-01',
      due_date: '2026-07-31',
      fy_label: '26-27',
      currency: 'INR',
      status: 'SENT',
    });
    e = await feedback.eligibility(tenantId, userId);
    expect(e.data.eligible).toBe(true);

    // Snooze → ineligible now (snoozed_until in the future).
    await feedback.respond(tenantId, userId, { action: 'snooze' });
    e = await feedback.eligibility(tenantId, userId);
    expect(e.data.eligible).toBe(false);

    // Elapsed snooze → prompts again (the 14-day "Later" re-entry branch).
    await dbAdmin
      .update(npsResponses)
      .set({ snoozed_until: new Date(Date.now() - 60 * 1000) })
      .where(eq(npsResponses.user_id, userId));
    e = await feedback.eligibility(tenantId, userId);
    expect(e.data.eligible).toBe(true);

    // Answer → permanently done; summary reflects the promoter.
    await feedback.respond(tenantId, userId, { action: 'answer', score: 10, comment: 'Love it' });
    e = await feedback.eligibility(tenantId, userId);
    expect(e.data.eligible).toBe(false);
    const summary = await feedback.npsSummary();
    expect(summary.data.total).toBeGreaterThanOrEqual(1);
    expect(summary.data.promoters).toBeGreaterThanOrEqual(1);

    // Answered is TERMINAL: a stray dismiss/answer afterwards must not touch
    // the stored score (the upsert would otherwise wipe it to null).
    const afterDismiss = await feedback.respond(tenantId, userId, { action: 'dismiss' });
    expect(afterDismiss.data.status).toBe('answered');
    const afterReanswer = await feedback.respond(tenantId, userId, { action: 'answer', score: 0 });
    expect(afterReanswer.data.status).toBe('answered');
    const summary2 = await feedback.npsSummary();
    expect(summary2.data.promoters).toBe(summary.data.promoters); // score untouched
    expect(summary2.data.detractors).toBe(summary.data.detractors);
  });

  it('NPS gates on TENANT age (young workspace blocks even an active user) and the HRMS-onboarding OR-branch', async () => {
    // Young tenant (5 days) + active user → still ineligible.
    const [youngT] = await dbAdmin
      .insert(tenants)
      .values({
        name: `FbYoung${rid()}`,
        slug: `fby-${rid()}-${Date.now()}`,
        status: 'trialing',
        created_at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
      })
      .returning();
    const [u2] = await dbAdmin
      .insert(users)
      .values({ email: `fb2-${rid()}@test.test`, full_name: 'Fb Two', status: 'active' })
      .returning();
    for (const daysAgo of [1, 2, 3]) {
      await dbAdmin.execute(sql`
        INSERT INTO product_events (tenant_id, user_id, event_name, occurred_at)
        VALUES (${youngT!.id}::uuid, ${u2!.id}::uuid, 'first_login_day', now() - (${daysAgo}::int || ' days')::interval)`);
    }
    let e = await feedback.eligibility(youngT!.id, u2!.id);
    expect(e.data.eligible).toBe(false); // tenant only 5 days old

    // Mature tenant + NO invoice, but HRMS onboarding done → eligible.
    const [hrT] = await dbAdmin
      .insert(tenants)
      .values({
        name: `FbHr${rid()}`,
        slug: `fbh-${rid()}-${Date.now()}`,
        status: 'trialing',
        created_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      })
      .returning();
    for (const daysAgo of [1, 2, 3]) {
      await dbAdmin.execute(sql`
        INSERT INTO product_events (tenant_id, user_id, event_name, occurred_at)
        VALUES (${hrT!.id}::uuid, ${u2!.id}::uuid, 'first_login_day', now() - (${daysAgo}::int || ' days')::interval)`);
    }
    e = await feedback.eligibility(hrT!.id, u2!.id);
    expect(e.data.eligible).toBe(false); // no invoice, no onboarding yet

    // A quote must NOT satisfy the "sent ≥1 invoice" gate.
    const [qCust] = await dbAdmin
      .insert(customersTable)
      .values({ tenant_id: hrT!.id, customer_code: `C-${rid()}`, display_name: 'Quote Co' })
      .returning();
    await dbAdmin.insert(invoices).values({
      tenant_id: hrT!.id,
      customer_id: qCust!.id,
      invoice_number: `QUO-${rid()}`,
      invoice_date: '2026-07-01',
      due_date: '2026-07-31',
      fy_label: '26-27',
      currency: 'INR',
      status: 'SENT',
      document_type: 'QUOTE',
    });
    e = await feedback.eligibility(hrT!.id, u2!.id);
    expect(e.data.eligible).toBe(false); // quotes don't count

    await dbAdmin.insert(employees).values({
      tenant_id: hrT!.id,
      employee_code: `E-${rid()}`,
      first_name: 'On',
      last_name: 'Boarded',
      work_email: `onb-${rid()}@test.test`,
      date_of_joining: '2026-06-01',
      custom_fields: { onboarding_submitted_for_review: true },
    } as never);
    e = await feedback.eligibility(hrT!.id, u2!.id);
    expect(e.data.eligible).toBe(true);

    await dbAdmin.delete(tenants).where(eq(tenants.id, youngT!.id));
    await dbAdmin.delete(tenants).where(eq(tenants.id, hrT!.id));
    await dbAdmin.delete(users).where(eq(users.id, u2!.id));
  });
});
