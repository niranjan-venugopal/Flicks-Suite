import 'dotenv/config';
import * as crypto from 'crypto';
import { eq, like } from 'drizzle-orm';
import { db, dbAdmin } from '@flicks/db';
import {
  couponCodes,
  memberships,
  subscriptions,
  tenants,
  users,
} from '@flicks/db/schema';
import { DatabaseService } from '../core/database/database.service';
import { AnalyticsService } from '../core/analytics/analytics.service';
import { AuditService } from '../modules/audit/audit.service';
import { BillingStateService } from '../core/billing/billing-state.service';
import { BillingService } from '../modules/billing/billing.service';
import { FamBillingService } from '../modules/billing/fam-billing.service';
import { FamBillingController } from '../modules/billing/fam-billing.controller';
import { RazorpayPlatformService } from '../modules/billing/razorpay-platform.service';

/**
 * PRD v4 D21/D22 (Sprint 22) — FAM coupon console + billing overview.
 * Real-Postgres integration on the mint/deactivate/inspect side; redemption
 * itself is BillingService (tested in billing.spec.ts) — here we prove the
 * two sides agree (deactivation blocks redemption, drawer sees the redeemer).
 */

const rid = () => crypto.randomBytes(4).toString('hex');
const dbSvc = new DatabaseService();
const config = { get: (_: string, fb?: unknown) => fb } as never;
const analytics = new AnalyticsService(config, dbAdmin as never);
const audit = new AuditService(db as never, dbAdmin as never, dbSvc);
const famBilling = new FamBillingService(dbAdmin as never, audit);
const billing = new BillingService(
  dbAdmin as never,
  new RazorpayPlatformService(config),
  new BillingStateService(dbAdmin as never),
  audit,
  analytics,
  { sendEmail: async () => true } as never,
);

let famUserId: string;
const PREFIX = `T${rid().toUpperCase().slice(0, 6)}`;
// Campaign names are unique per run — the CSV assertion counts rows by
// campaign, and leftovers from an aborted previous run must never bleed in.
const CAMP_SEQ = `ts-${PREFIX.toLowerCase()}`;
const CAMP_RAND = `tr-${PREFIX.toLowerCase()}`;
const cleanupTenants: string[] = [];

beforeAll(async () => {
  const [u] = await dbAdmin
    .insert(users)
    .values({ email: `fam-${rid()}@test.test`, full_name: 'FAM Op', status: 'active' })
    .returning();
  famUserId = u!.id;
});

afterAll(async () => {
  // Tenants first: their cascade removes coupon_redemptions, which otherwise
  // FK-block the coupon and user deletions below.
  for (const id of cleanupTenants) await dbAdmin.delete(tenants).where(eq(tenants.id, id));
  await dbAdmin.delete(couponCodes).where(like(couponCodes.code, `${PREFIX}-%`));
  await dbAdmin.delete(users).where(eq(users.id, famUserId));
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
});

let seqCode = '';

describe('FAM coupons + billing overview (PRD v4 D21/D22)', () => {
  it('sequential minting is REJECTED (round 9 — guessable sequences); random batches are unique', async () => {
    // The FOUNDER-002..050 retirement made the policy explicit: numbered
    // sequences let anyone holding one code enumerate the rest.
    await expect(
      famBilling.batchCreate(famUserId, {
        prefix: PREFIX,
        mode: 'sequential',
        count: 5,
        months: 3,
        campaign: CAMP_SEQ,
      }),
    ).rejects.toThrow(/Sequential codes are retired/);

    // Seed a couple of CAMP_SEQ rows the later CSV/list cases rely on —
    // random now, since that is the only mint mode.
    const seeded = await famBilling.batchCreate(famUserId, {
      prefix: PREFIX,
      mode: 'random',
      count: 5,
      months: 3,
      campaign: CAMP_SEQ,
    });
    expect(seeded.data.minted).toBe(5);
    seqCode = seeded.data.codes[0]!;

    // §8B.3 checkpoint size: a full batch of 50.
    const r = await famBilling.batchCreate(famUserId, {
      prefix: PREFIX,
      mode: 'random',
      count: 50,
      months: 2,
      campaign: CAMP_RAND,
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    });
    expect(r.data.minted).toBe(50);
    expect(new Set(r.data.codes).size).toBe(50);
    for (const code of r.data.codes) {
      expect(code).toMatch(new RegExp(`^${PREFIX}-[A-HJ-NP-Z]{5}$`)); // letters only
    }
  });

  it('CSV export carries every column and is campaign-filterable', async () => {
    const csv = await famBilling.exportCsv(CAMP_SEQ);
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe(
      'code,campaign,months,max_redemptions,redemption_count,expires_at,active',
    );
    expect(lines.length).toBe(1 + 5); // the 5 CAMP_SEQ codes
    expect(lines[1]).toContain(`"${PREFIX}-`);
    expect(lines[1]).toContain(`"${CAMP_SEQ}"`);
  });

  it('deactivation blocks redemption; the drawer shows who redeemed', async () => {
    const [t] = await dbAdmin
      .insert(tenants)
      .values({
        name: `CpnCo${rid()}`,
        slug: `cpn-${rid()}-${Date.now()}`,
        status: 'trialing',
        trial_ends_at: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
      })
      .returning();
    cleanupTenants.push(t!.id);
    const [owner] = await dbAdmin
      .insert(users)
      .values({ email: `cpn-${rid()}@test.test`, full_name: 'Cpn Owner', status: 'active' })
      .returning();
    await dbAdmin.insert(memberships).values({
      tenant_id: t!.id,
      user_id: owner!.id,
      role: 'owner' as never,
      status: 'active',
    });
    await billing.ensureRow(t!.id);

    const [coupon] = await dbAdmin
      .select()
      .from(couponCodes)
      .where(eq(couponCodes.code, seqCode))
      .limit(1);

    // Deactivated → redemption refused.
    await famBilling.update(famUserId, coupon!.id, { active: false });
    await expect(billing.redeemCoupon(t!.id, owner!.id, coupon!.code)).rejects.toThrow(/isn/);

    // Reactivated → redeems, and the drawer shows the redeemer.
    await famBilling.update(famUserId, coupon!.id, { active: true });
    await billing.redeemCoupon(t!.id, owner!.id, coupon!.code);
    const drawer = await famBilling.redemptions(coupon!.id);
    expect(drawer.data.length).toBe(1);
    expect(drawer.data[0]!.tenant_name).toContain('CpnCo');
    expect(drawer.data[0]!.redeemed_by_name).toBe('Cpn Owner');
    expect(drawer.meta.code).toBe(coupon!.code);

    await dbAdmin.delete(users).where(eq(users.id, owner!.id));
  });

  it('billing overview: MRR counts only ACTIVE subs; trial→paid = active/total', async () => {
    // Two throwaway tenants: one active (₹998 MRR), one trialing.
    const mk = async (status: 'active' | 'trialing', mrr: number) => {
      const [t] = await dbAdmin
        .insert(tenants)
        .values({ name: `Ovw${rid()}`, slug: `ovw-${rid()}-${Date.now()}`, status: 'trialing' })
        .returning();
      cleanupTenants.push(t!.id);
      await dbAdmin.insert(subscriptions).values({
        tenant_id: t!.id,
        plan_code: 'beta',
        status,
        per_user_price: 499,
        user_count: 2,
        mrr_amount: mrr,
        billing_cycle: 'monthly',
      });
      return t!.id;
    };
    await mk('active', 998);
    await mk('trialing', 0);

    // Lower-bound assertions by design: the dev DB is shared across suites,
    // so exact-sum equality would flake; the known inserts prove inclusion.
    const before = await famBilling.overview();
    expect(before.data.platform_mrr).toBeGreaterThanOrEqual(998);
    expect(before.data.active_subscriptions).toBeGreaterThanOrEqual(1);
    expect(before.data.trialing).toBeGreaterThanOrEqual(1);
    expect(before.data.trial_to_paid_pct).toBeGreaterThanOrEqual(1);
    expect(before.data.trial_to_paid_pct).toBeLessThanOrEqual(100);
  });

  it('tenant-track and platform webhook endpoints coexist on distinct routes', async () => {
    const { PlatformWebhookController } = await import(
      '../modules/billing/platform-webhook.controller'
    );
    const { RazorpayWebhookController } = await import(
      '../modules/invoicing/razorpay-webhook.controller'
    );
    // Same 'webhooks' prefix, different method paths — both registered.
    expect(Reflect.getMetadata('path', PlatformWebhookController)).toBe('webhooks');
    expect(Reflect.getMetadata('path', RazorpayWebhookController)).toBe('webhooks');
    expect(Reflect.getMetadata('path', PlatformWebhookController.prototype.handle)).toBe(
      'razorpay-platform',
    );
    const tenantHandler = Object.getOwnPropertyNames(RazorpayWebhookController.prototype).find(
      (m) => Reflect.getMetadata('path', (RazorpayWebhookController.prototype as never)[m]) === 'razorpay',
    );
    expect(tenantHandler).toBeDefined();
  });

  it('FAM console routes are class-gated to the fam role', () => {
    const roles = Reflect.getMetadata('roles', FamBillingController);
    expect(roles).toEqual(['fam']);
  });
});
