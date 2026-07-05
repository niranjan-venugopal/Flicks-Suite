import 'dotenv/config';
import * as crypto from 'crypto';
import { and, eq } from 'drizzle-orm';
import { dbAdmin } from '@flicks/db';
import { tenants, users, productEvents } from '@flicks/db/schema';
import { AnalyticsService } from '../core/analytics/analytics.service';
import { AnalyticsListener } from '../core/analytics/analytics.listener';

/**
 * PRD v4 §6 — internal product analytics (Sprint 19). track() writes
 * product_events (PostHog dormant); the listener adds per-day dedupe,
 * once-per-tenant, and the first:true funnel stamp.
 */

const rid = () => crypto.randomBytes(4).toString('hex');
const config = { get: (_: string, fb?: unknown) => fb } as never; // no POSTHOG_KEY
const analytics = new AnalyticsService(config, dbAdmin as never);
const listener = new AnalyticsListener(analytics, dbAdmin as never);
const flush = () => new Promise((r) => setTimeout(r, 150)); // track() is fire-and-forget

describe('Internal product analytics (PRD v4 §6)', () => {
  let tenantId: string;
  let userId: string;

  beforeAll(async () => {
    const [t] = await dbAdmin
      .insert(tenants)
      .values({ name: `AnaCo${rid()}`, slug: `ana-${rid()}-${Date.now()}`, status: 'trialing' })
      .returning();
    tenantId = t!.id;
    const [u] = await dbAdmin
      .insert(users)
      .values({ email: `ana-${rid()}@test.test`, full_name: 'Ana User', status: 'active' })
      .returning();
    userId = u!.id;
  });

  afterAll(async () => {
    await dbAdmin.delete(tenants).where(eq(tenants.id, tenantId));
    await dbAdmin.delete(users).where(eq(users.id, userId));
    await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  });

  const rowsFor = (event: string) =>
    dbAdmin
      .select()
      .from(productEvents)
      .where(and(eq(productEvents.tenant_id, tenantId), eq(productEvents.event_name, event)));

  it('track() writes product_events with PII-free properties; unknown names are dropped', async () => {
    analytics.track({
      event: 'module_opened',
      tenantId,
      userId,
      source: 'web',
      properties: { module: 'invoicing' },
    });
    // @ts-expect-error — unknown event names must be rejected at runtime too
    analytics.track({ event: 'totally_bogus', tenantId, userId });
    await flush();
    const rows = await rowsFor('module_opened');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.properties).toEqual({ module: 'invoicing' });
    expect(JSON.stringify(rows[0]!.properties)).not.toMatch(/@/); // no emails in props
    const bogus = await rowsFor('totally_bogus');
    expect(bogus).toHaveLength(0);
  });

  it('listener: first_login_day dedupes per user per day', async () => {
    await listener.handle({ event: 'first_login_day', tenantId, userId, dedupePerDay: true });
    await listener.handle({ event: 'first_login_day', tenantId, userId, dedupePerDay: true });
    await flush();
    expect(await rowsFor('first_login_day')).toHaveLength(1);
  });

  it('listener: org_configured fires once per tenant', async () => {
    await listener.handle({ event: 'org_configured', tenantId, userId, oncePerTenant: true });
    await listener.handle({ event: 'org_configured', tenantId, userId, oncePerTenant: true });
    await flush();
    expect(await rowsFor('org_configured')).toHaveLength(1);
  });

  it('listener: markFirst stamps first:true on the first event only (F3–F5)', async () => {
    await listener.handle({ event: 'invoice_created', tenantId, userId, markFirst: true });
    await flush();
    await listener.handle({ event: 'invoice_created', tenantId, userId, markFirst: true });
    await flush();
    const rows = await rowsFor('invoice_created');
    expect(rows).toHaveLength(2);
    const flags = rows
      .map((r) => (r.properties as { first?: boolean }).first)
      .sort((a, b) => Number(b) - Number(a));
    expect(flags).toEqual([true, false]);
  });
});
