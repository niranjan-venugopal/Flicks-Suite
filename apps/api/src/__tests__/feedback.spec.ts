import 'dotenv/config';
import * as crypto from 'crypto';
import { eq } from 'drizzle-orm';
import { dbAdmin } from '@flicks/db';
import { tenants, users, invoices, customers as customersTable } from '@flicks/db/schema';
import { DatabaseService } from '../core/database/database.service';
import { AnalyticsService } from '../core/analytics/analytics.service';
import { FeedbackService } from '../modules/feedback/feedback.service';

/**
 * PRD v4 §7 — feedback + NPS (Sprint 20). Real-Postgres integration.
 */

const rid = () => crypto.randomBytes(4).toString('hex');
const dbSvc = new DatabaseService();
const config = { get: (_: string, fb?: unknown) => fb } as never;
const analytics = new AnalyticsService(config, dbAdmin as never);
const audit = { log: async () => {}, logPlatform: async () => {} } as never;
const feedback = new FeedbackService(dbAdmin as never, dbSvc, analytics, audit);

describe('Feedback + NPS (PRD v4 §7)', () => {
  let tenantId: string;
  let userId: string;

  beforeAll(async () => {
    const [t] = await dbAdmin
      .insert(tenants)
      .values({ name: `FbCo${rid()}`, slug: `fb-${rid()}-${Date.now()}`, status: 'trialing' })
      .returning();
    tenantId = t!.id;
    const [u] = await dbAdmin
      .insert(users)
      .values({
        email: `fb-${rid()}@test.test`,
        full_name: 'Fb User',
        status: 'active',
        // 30-day-old account → passes the ≥21d NPS age gate
        created_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
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

  it('FAM status change + internal note round-trips (platform-audited path)', async () => {
    const inbox = await feedback.famList({ tenantId });
    const row = inbox.data[0]!;
    const updated = await feedback.famUpdate(row.id, userId, {
      status: 'triaged',
      internal_note: 'Repro confirmed',
    });
    expect(updated.data!.status).toBe('triaged');
    expect(updated.data!.internal_note).toBe('Repro confirmed');
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

    // Answer → permanently done; summary reflects the promoter.
    await feedback.respond(tenantId, userId, { action: 'answer', score: 10, comment: 'Love it' });
    e = await feedback.eligibility(tenantId, userId);
    expect(e.data.eligible).toBe(false);
    const summary = await feedback.npsSummary();
    expect(summary.data.total).toBeGreaterThanOrEqual(1);
    expect(summary.data.promoters).toBeGreaterThanOrEqual(1);
  });
});
