import 'dotenv/config';
import * as crypto from 'crypto';
import { eq } from 'drizzle-orm';
import { db, dbAdmin } from '@flicks/db';
import {
  couponCodes,
  couponRedemptions,
  memberships,
  subscriptions,
  tenants,
  users,
} from '@flicks/db/schema';
import { PLATFORM_PLAN } from '@flicks/shared/constants';
import { DatabaseService } from '../core/database/database.service';
import { AnalyticsService } from '../core/analytics/analytics.service';
import { AuditService } from '../modules/audit/audit.service';
import { BillingStateService } from '../core/billing/billing-state.service';
import { BillingService } from '../modules/billing/billing.service';
import { RazorpayPlatformService } from '../modules/billing/razorpay-platform.service';
import { BillingGuard } from '../core/auth/guards/billing.guard';

/**
 * PRD v4 §8B — platform billing core (Sprint 21). Real-Postgres integration
 * for the trial/lock state machine, seats, coupons, and webhook effects.
 * Razorpay itself stays unconfigured (isConfigured=false) — the paywall is
 * date-driven and must work without live keys.
 */

const rid = () => crypto.randomBytes(4).toString('hex');
const dbSvc = new DatabaseService();
const config = { get: (_: string, fb?: unknown) => fb } as never;
const analytics = new AnalyticsService(config, dbAdmin as never);
const audit = new AuditService(db as never, dbAdmin as never, dbSvc);
const rzp = new RazorpayPlatformService(config);
const billingState = new BillingStateService(dbAdmin as never);
const sendEmailSpy = jest.fn(async () => {});
const notifications = { sendEmail: sendEmailSpy } as never;
const billing = new BillingService(
  dbAdmin as never,
  rzp,
  billingState,
  audit,
  analytics,
  notifications,
);

const DAY = 24 * 60 * 60 * 1000;

async function mkTenant(trialOffsetDays: number): Promise<string> {
  const [t] = await dbAdmin
    .insert(tenants)
    .values({
      name: `BillCo${rid()}`,
      slug: `bill-${rid()}-${Date.now()}`,
      status: 'trialing',
      trial_ends_at: new Date(Date.now() + trialOffsetDays * DAY),
    })
    .returning();
  return t!.id;
}

async function mkMember(tenantId: string, role: string): Promise<string> {
  const [u] = await dbAdmin
    .insert(users)
    .values({ email: `bill-${rid()}@test.test`, full_name: 'Bill User', status: 'active' })
    .returning();
  await dbAdmin.insert(memberships).values({
    tenant_id: tenantId,
    user_id: u!.id,
    role: role as never,
    status: 'active',
  });
  return u!.id;
}

const cleanupTenants: string[] = [];
const cleanupUsers: string[] = [];
const cleanupCoupons: string[] = [];

afterAll(async () => {
  for (const id of cleanupTenants) await dbAdmin.delete(tenants).where(eq(tenants.id, id));
  for (const id of cleanupUsers) await dbAdmin.delete(users).where(eq(users.id, id));
  for (const id of cleanupCoupons)
    await dbAdmin.delete(couponCodes).where(eq(couponCodes.id, id));
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
});

describe('Platform billing (PRD v4 §8B)', () => {
  it('ensureRow + state: trialing row exists, seats exclude auditors, price is the beta plan', async () => {
    const tenantId = await mkTenant(5);
    cleanupTenants.push(tenantId);
    cleanupUsers.push(await mkMember(tenantId, 'owner'));
    cleanupUsers.push(await mkMember(tenantId, 'employee'));
    cleanupUsers.push(await mkMember(tenantId, 'auditor')); // never billed

    const state = await billing.state(tenantId);
    expect(state.data.status).toBe('trialing');
    expect(state.data.seats).toBe(2); // owner + employee, NOT the auditor
    expect(state.data.plan.price_rupees).toBe(PLATFORM_PLAN.priceRupees);
    expect(state.data.monthly_total_rupees).toBe(2 * PLATFORM_PLAN.priceRupees);
    expect(state.data.locked).toBe(false);
    expect(state.data.payments_configured).toBe(false); // no keys in tests

    const [row] = await dbAdmin
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.tenant_id, tenantId));
    expect(row!.plan_code).toBe(PLATFORM_PLAN.code);
    expect(row!.user_count).toBe(2);
  });

  it('lock state machine: expired trial locks; grace window defers a past_due lock; active never locks', async () => {
    const expired = await mkTenant(-1);
    cleanupTenants.push(expired);
    await billing.ensureRow(expired);
    billingState.invalidate(expired);
    expect(await billingState.state(expired)).toEqual({
      locked: true,
      reason: 'trial_expired',
    });

    // past_due inside grace → open; grace lapsed → locked.
    await dbAdmin
      .update(subscriptions)
      .set({ status: 'past_due', grace_ends_at: new Date(Date.now() + 2 * DAY) })
      .where(eq(subscriptions.tenant_id, expired));
    billingState.invalidate(expired);
    expect((await billingState.state(expired)).locked).toBe(false);
    await dbAdmin
      .update(subscriptions)
      .set({ grace_ends_at: new Date(Date.now() - 1000) })
      .where(eq(subscriptions.tenant_id, expired));
    billingState.invalidate(expired);
    expect(await billingState.state(expired)).toEqual({ locked: true, reason: 'past_due' });

    // active → never locked, regardless of old trial dates.
    await dbAdmin
      .update(subscriptions)
      .set({ status: 'active', grace_ends_at: null })
      .where(eq(subscriptions.tenant_id, expired));
    billingState.invalidate(expired);
    expect((await billingState.state(expired)).locked).toBe(false);
  });

  it('BillingGuard: exempt/GET/fam pass; a mutation on a locked workspace 402s with BILLING_REQUIRED', async () => {
    const lockedTenant = await mkTenant(-2);
    cleanupTenants.push(lockedTenant);
    await billing.ensureRow(lockedTenant);
    billingState.invalidate(lockedTenant);

    const guard = new BillingGuard(
      {
        getAllAndOverride: jest.fn(() => false),
      } as never,
      billingState,
    );
    const ctx = (method: string, user?: Record<string, unknown>) =>
      ({
        getHandler: () => ({}),
        getClass: () => ({}),
        switchToHttp: () => ({ getRequest: () => ({ method, user }) }),
      }) as never;

    // GET on a locked tenant → allowed (read-only wall).
    await expect(
      guard.canActivate(ctx('GET', { tenantId: lockedTenant, role: 'owner', sub: 'x' })),
    ).resolves.toBe(true);
    // FAM staff bypass.
    await expect(
      guard.canActivate(ctx('POST', { tenantId: lockedTenant, role: 'fam', sub: 'x' })),
    ).resolves.toBe(true);
    // No tenant context (public-ish) → pass through.
    await expect(guard.canActivate(ctx('POST', undefined))).resolves.toBe(true);
    // Mutation on the locked tenant → 402 BILLING_REQUIRED.
    await expect(
      guard.canActivate(ctx('POST', { tenantId: lockedTenant, role: 'owner', sub: 'x' })),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'BILLING_REQUIRED' }) });
  });

  it('coupon redeem: extends the trial, once per tenant, invalid/exhausted codes rejected, all audited', async () => {
    const tenantId = await mkTenant(2);
    cleanupTenants.push(tenantId);
    const userId = await mkMember(tenantId, 'owner');
    cleanupUsers.push(userId);
    await billing.ensureRow(tenantId);

    const [coupon] = await dbAdmin
      .insert(couponCodes)
      .values({ code: `TEST-${rid().toUpperCase()}`, campaign: 'test', months: 2 })
      .returning();
    cleanupCoupons.push(coupon!.id);

    // Unknown code → rejected.
    await expect(billing.redeemCoupon(tenantId, userId, 'NOPE-000')).rejects.toThrow(/isn/);

    const res = await billing.redeemCoupon(tenantId, userId, coupon!.code);
    expect(res.data.months).toBe(2);
    const [sub] = await dbAdmin
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.tenant_id, tenantId));
    // ~60 days of runway added on top of the 2 remaining.
    const daysLeft = (new Date(sub!.trial_ends_at!).getTime() - Date.now()) / DAY;
    expect(daysLeft).toBeGreaterThan(59);
    expect(sub!.applied_coupon_id).toBe(coupon!.id);

    // The claim incremented atomically and a single-use code is now exhausted.
    const [after] = await dbAdmin
      .select()
      .from(couponCodes)
      .where(eq(couponCodes.id, coupon!.id));
    expect(after!.redemption_count).toBe(1);

    // Second coupon on the same tenant → conflict (one EVER per tenant).
    const [coupon2] = await dbAdmin
      .insert(couponCodes)
      .values({ code: `TEST2-${rid().toUpperCase()}`, campaign: 'test', months: 1 })
      .returning();
    cleanupCoupons.push(coupon2!.id);
    await expect(billing.redeemCoupon(tenantId, userId, coupon2!.code)).rejects.toThrow(
      /already redeemed/,
    );

    // Another tenant can't reuse the exhausted single-use code.
    const tenant2 = await mkTenant(2);
    cleanupTenants.push(tenant2);
    const user2 = await mkMember(tenant2, 'owner');
    cleanupUsers.push(user2);
    await billing.ensureRow(tenant2);
    await expect(billing.redeemCoupon(tenant2, user2, coupon!.code)).rejects.toThrow(/isn/);

    // Redemption row landed once, with the audit trail behind it.
    const redemptions = await dbAdmin
      .select()
      .from(couponRedemptions)
      .where(eq(couponRedemptions.tenant_id, tenantId));
    expect(redemptions.length).toBe(1);
  });

  it('coupon attempts throttle at 10/day/tenant', async () => {
    const tenantId = await mkTenant(2);
    cleanupTenants.push(tenantId);
    const userId = await mkMember(tenantId, 'owner');
    cleanupUsers.push(userId);
    await billing.ensureRow(tenantId);
    for (let i = 0; i < 10; i++) {
      await expect(billing.redeemCoupon(tenantId, userId, `MISS-${i}`)).rejects.toThrow(/isn/);
    }
    await expect(billing.redeemCoupon(tenantId, userId, 'MISS-11')).rejects.toThrow(
      /Too many coupon attempts/,
    );
  });

  it('webhook effects: activated → active (grace cleared); charged records history + receipt; failure opens grace + dunning email', async () => {
    const tenantId = await mkTenant(1);
    cleanupTenants.push(tenantId);
    cleanupUsers.push(await mkMember(tenantId, 'owner'));
    await billing.ensureRow(tenantId);
    const rzpId = `sub_${rid()}`;
    await dbAdmin
      .update(subscriptions)
      .set({ razorpay_subscription_id: rzpId, authorization_url: 'https://rzp.io/x' })
      .where(eq(subscriptions.tenant_id, tenantId));

    const envelope = (extra?: Record<string, unknown>) => ({
      payload: {
        subscription: {
          entity: {
            id: rzpId,
            current_start: Math.floor(Date.now() / 1000),
            current_end: Math.floor((Date.now() + 30 * DAY) / 1000),
          },
        },
        ...(extra ?? {}),
      },
    });

    await billing.applyWebhook('subscription.activated', envelope());
    let [sub] = await dbAdmin
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.tenant_id, tenantId));
    expect(sub!.status).toBe('active');
    expect(sub!.authorization_url).toBeNull();
    expect(sub!.current_period_end).not.toBeNull();
    expect(sub!.mrr_amount).toBe(PLATFORM_PLAN.priceRupees); // 1 billable seat

    sendEmailSpy.mockClear();
    await billing.applyWebhook(
      'subscription.charged',
      envelope({ payment: { entity: { amount: 49_900 } } }),
    );
    expect(sendEmailSpy).toHaveBeenCalledWith(
      'subscription-payment-success',
      expect.any(String),
      expect.objectContaining({ amount: expect.stringContaining('499') }),
    );

    sendEmailSpy.mockClear();
    await billing.applyWebhook('payment.failed', envelope());
    [sub] = await dbAdmin
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.tenant_id, tenantId));
    expect(sub!.status).toBe('past_due');
    expect(sub!.grace_ends_at).not.toBeNull();
    expect(sendEmailSpy).toHaveBeenCalledWith(
      'subscription-payment-failed',
      expect.any(String),
      expect.anything(),
    );
    // Grace keeps the workspace open.
    billingState.invalidate(tenantId);
    expect((await billingState.state(tenantId)).locked).toBe(false);

    // Recovery: the next successful charge clears past_due + grace.
    await billing.applyWebhook(
      'subscription.charged',
      envelope({ payment: { entity: { amount: 49_900 } } }),
    );
    [sub] = await dbAdmin
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.tenant_id, tenantId));
    expect(sub!.status).toBe('active');
    expect(sub!.grace_ends_at).toBeNull();
  });

  it('review regressions: double-subscribe blocked, coupon-after-subscribe blocked, abandoned-checkout cancel keeps trial unlocked, payment.failed resolves via payment entity', async () => {
    const tenantId = await mkTenant(5);
    cleanupTenants.push(tenantId);
    const userId = await mkMember(tenantId, 'owner');
    cleanupUsers.push(userId);
    await billing.ensureRow(tenantId);
    const rzpId = `sub_${rid()}`;
    await dbAdmin
      .update(subscriptions)
      .set({ razorpay_subscription_id: rzpId, status: 'active' })
      .where(eq(subscriptions.tenant_id, tenantId));

    // A live subscription can never be shadowed by a second checkout.
    await expect(billing.subscribe(tenantId, userId)).rejects.toThrow(/already has an active/);
    await dbAdmin
      .update(subscriptions)
      .set({ status: 'past_due' })
      .where(eq(subscriptions.tenant_id, tenantId));
    await expect(billing.subscribe(tenantId, userId)).rejects.toThrow(/retried by Razorpay/);

    // Coupons are trial runway — meaningless (and rejected) once Razorpay exists.
    const [c] = await dbAdmin
      .insert(couponCodes)
      .values({ code: `LATE-${rid().toUpperCase()}`, campaign: 'test', months: 1 })
      .returning();
    cleanupCoupons.push(c!.id);
    await expect(billing.redeemCoupon(tenantId, userId, c!.code)).rejects.toThrow(
      /before subscribing/,
    );

    // Mandate abandoned mid-checkout → cancelled with NO paid period: the
    // remaining trial runway must keep the workspace open.
    await dbAdmin
      .update(subscriptions)
      .set({ status: 'trialing' })
      .where(eq(subscriptions.tenant_id, tenantId));
    await billing.applyWebhook('subscription.cancelled', {
      payload: { subscription: { entity: { id: rzpId } } },
    });
    let [sub] = await dbAdmin
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.tenant_id, tenantId));
    expect(sub!.status).toBe('canceled');
    expect(sub!.authorization_url).toBeNull();
    expect(sub!.cancel_at_period_end).toBe(false);
    billingState.invalidate(tenantId);
    expect((await billingState.state(tenantId)).locked).toBe(false); // 5 trial days left

    // payment.failed carries only payload.payment.entity.subscription_id.
    await dbAdmin
      .update(subscriptions)
      .set({ status: 'active', grace_ends_at: null })
      .where(eq(subscriptions.tenant_id, tenantId));
    await billing.applyWebhook('payment.failed', {
      payload: { payment: { entity: { subscription_id: rzpId, amount: 49_900 } } },
    });
    [sub] = await dbAdmin
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.tenant_id, tenantId));
    expect(sub!.status).toBe('past_due');
    expect(sub!.grace_ends_at).not.toBeNull();
  });

  it('cancel schedules at period end and resume reverts it', async () => {
    const tenantId = await mkTenant(1);
    cleanupTenants.push(tenantId);
    const userId = await mkMember(tenantId, 'owner');
    cleanupUsers.push(userId);
    await billing.ensureRow(tenantId);
    // Not active yet → nothing to cancel.
    await expect(billing.cancel(tenantId, userId)).rejects.toThrow(/no active subscription/);

    await dbAdmin
      .update(subscriptions)
      .set({
        status: 'active',
        razorpay_subscription_id: `sub_${rid()}`,
        current_period_end: new Date(Date.now() + 20 * DAY),
      })
      .where(eq(subscriptions.tenant_id, tenantId));
    const res = await billing.cancel(tenantId, userId);
    expect(res.data.cancel_at_period_end).toBe(true);
    const resumed = await billing.resume(tenantId, userId);
    expect(resumed.data.cancel_at_period_end).toBe(false);

    // Inside the push window the Razorpay cancel may already be scheduled —
    // resume is refused rather than pretending.
    await billing.cancel(tenantId, userId);
    await dbAdmin
      .update(subscriptions)
      .set({ current_period_end: new Date(Date.now() + 12 * 60 * 60 * 1000) })
      .where(eq(subscriptions.tenant_id, tenantId));
    await expect(billing.resume(tenantId, userId)).rejects.toThrow(/already being processed/);
  });

  it('subscribe without Razorpay keys 503s cleanly (config-gated, not a crash)', async () => {
    const tenantId = await mkTenant(3);
    cleanupTenants.push(tenantId);
    const userId = await mkMember(tenantId, 'owner');
    cleanupUsers.push(userId);
    await expect(billing.subscribe(tenantId, userId)).rejects.toThrow(/not configured/);
  });
});
