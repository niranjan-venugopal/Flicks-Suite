import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { and, count, desc, eq, gt, notInArray, sql } from 'drizzle-orm';
import {
  auditLogPlatform,
  couponCodes,
  couponRedemptions,
  memberships,
  subscriptionEvents,
  subscriptions,
  tenants,
  users,
} from '@flicks/db/schema';
import type { DbAdmin } from '@flicks/db';
import { BILLING_GRACE_DAYS, PLATFORM_PLAN, TRIAL_DAYS } from '@flicks/shared/constants';
import { DB_SERVICE_ROLE } from '../../core/database/database.module';
import { BillingStateService } from '../../core/billing/billing-state.service';
import { AuditService } from '../audit/audit.service';
import { AnalyticsService } from '../../core/analytics/analytics.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RazorpayPlatformService } from './razorpay-platform.service';

const SPECFLICKS_TENANT_ID = '00000000-0000-0000-0000-000000000001';
/** Roles that occupy a paid seat (§8B.2): auditors and platform staff don't. */
const NON_BILLABLE_ROLES = ['auditor', 'fam', 'super_admin'];
const COUPON_ATTEMPTS_PER_DAY = 10;

/**
 * Platform billing core (PRD v4 §8B, Sprint 21). One plan (PLATFORM_PLAN,
 * ₹499/seat/mo), 7-day trial, Razorpay-hosted subscribe (authorization_url),
 * FAM coupons (months of free trial), cancel-at-period-end + resume.
 *
 * Seat counting is LAZY: recounted on every billing read/subscribe and by the
 * daily pre-debit job (which pushes quantity changes to Razorpay at the next
 * cycle boundary) — no hooks scattered across membership mutations.
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    @Inject(DB_SERVICE_ROLE) private readonly dbAdmin: DbAdmin,
    private readonly rzp: RazorpayPlatformService,
    private readonly billingState: BillingStateService,
    private readonly audit: AuditService,
    private readonly analytics: AnalyticsService,
    private readonly notifications: NotificationsService,
  ) {}

  // ─── Row lifecycle ──────────────────────────────────────────────────────────

  /** Idempotent: the trialing row every tenant gets at creation (§8B.1). */
  async ensureRow(tenantId: string): Promise<void> {
    if (tenantId === SPECFLICKS_TENANT_ID) return;
    const [tenant] = await this.dbAdmin
      .select({ trial_ends_at: tenants.trial_ends_at })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    const trialEndsAt =
      tenant?.trial_ends_at ?? new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
    await this.dbAdmin
      .insert(subscriptions)
      .values({
        tenant_id: tenantId,
        plan_code: PLATFORM_PLAN.code,
        status: 'trialing',
        per_user_price: PLATFORM_PLAN.priceRupees,
        user_count: 1,
        billing_cycle: 'monthly',
        trial_ends_at: trialEndsAt,
      })
      .onConflictDoNothing({ target: subscriptions.tenant_id });
  }

  /** Billable seats = active memberships minus auditors/platform staff. */
  async recountSeats(tenantId: string): Promise<number> {
    const [{ n }] = await this.dbAdmin
      .select({ n: count() })
      .from(memberships)
      .where(
        and(
          eq(memberships.tenant_id, tenantId),
          eq(memberships.status, 'active'),
          notInArray(memberships.role, NON_BILLABLE_ROLES as never),
        ),
      );
    const seats = Math.max(1, Number(n));
    await this.dbAdmin
      .update(subscriptions)
      .set({
        user_count: seats,
        mrr_amount: sql`CASE WHEN status = 'active' THEN ${seats * PLATFORM_PLAN.priceRupees} ELSE mrr_amount END`,
        updated_at: new Date(),
      })
      .where(eq(subscriptions.tenant_id, tenantId));
    return seats;
  }

  // ─── GET /billing ───────────────────────────────────────────────────────────

  async state(tenantId: string) {
    await this.ensureRow(tenantId);
    const seats = await this.recountSeats(tenantId);
    const [sub] = await this.dbAdmin
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.tenant_id, tenantId))
      .limit(1);
    this.billingState.invalidate(tenantId);
    const lock = await this.billingState.state(tenantId);

    const [redemption] = await this.dbAdmin
      .select({
        code: couponCodes.code,
        months: couponRedemptions.months,
        redeemed_at: couponRedemptions.redeemed_at,
      })
      .from(couponRedemptions)
      .innerJoin(couponCodes, eq(couponCodes.id, couponRedemptions.coupon_id))
      .where(eq(couponRedemptions.tenant_id, tenantId))
      .limit(1);

    const history = sub
      ? await this.dbAdmin
          .select({
            id: subscriptionEvents.id,
            event_type: subscriptionEvents.event_type,
            metadata: subscriptionEvents.metadata,
            created_at: subscriptionEvents.created_at,
          })
          .from(subscriptionEvents)
          .where(eq(subscriptionEvents.subscription_id, sub.id))
          .orderBy(desc(subscriptionEvents.created_at))
          .limit(20)
      : [];

    return {
      data: {
        plan: {
          code: PLATFORM_PLAN.code,
          price_rupees: PLATFORM_PLAN.priceRupees,
          display_usd: PLATFORM_PLAN.displayUsd,
          currency: PLATFORM_PLAN.currency,
          interval: PLATFORM_PLAN.interval,
        },
        status: sub?.status ?? 'trialing',
        seats,
        monthly_total_rupees: seats * PLATFORM_PLAN.priceRupees,
        trial_ends_at: sub?.trial_ends_at ?? null,
        grace_ends_at: sub?.grace_ends_at ?? null,
        current_period_start: sub?.current_period_start ?? null,
        current_period_end: sub?.current_period_end ?? null,
        cancel_at_period_end: sub?.cancel_at_period_end ?? false,
        // Only meaningful while checkout is pending (subscribe clicked, not
        // yet activated) — the web polls GET /billing for the flip.
        authorization_url:
          sub && sub.razorpay_subscription_id && sub.status !== 'active'
            ? sub.authorization_url
            : null,
        has_razorpay_subscription: !!sub?.razorpay_subscription_id,
        coupon: redemption ?? null,
        locked: lock.locked,
        locked_reason: lock.reason,
        payments_configured: this.rzp.isConfigured(),
        history,
      },
    };
  }

  // ─── POST /billing/subscribe ────────────────────────────────────────────────

  async subscribe(tenantId: string, userId: string) {
    // State guards run BEFORE the config gate: "already active" is the honest
    // answer even on a server without Razorpay keys.
    await this.ensureRow(tenantId);
    const seats = await this.recountSeats(tenantId);
    const [sub] = await this.dbAdmin
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.tenant_id, tenantId))
      .limit(1);
    if (!sub) throw new BadRequestException('No subscription row for this workspace');
    // A LIVE Razorpay subscription (active or in dunning) must never be
    // shadowed by a second one — that is double billing. Cancel-scheduled
    // subscriptions are reverted with Resume, not re-subscribed.
    if (sub.razorpay_subscription_id) {
      if (sub.status === 'active') {
        throw new BadRequestException(
          sub.cancel_at_period_end
            ? 'A cancellation is scheduled — use "Keep my subscription" to continue instead.'
            : 'This workspace already has an active subscription',
        );
      }
      if (sub.status === 'past_due') {
        throw new BadRequestException(
          'Your last charge is being retried by Razorpay — no new checkout is needed. Contact support to change the payment method.',
        );
      }
      // Pending checkout (mandate never completed) → reuse the same link.
      if (sub.authorization_url) {
        return { data: { authorization_url: sub.authorization_url } };
      }
      // canceled/unpaid → the old subscription is terminal at Razorpay;
      // fall through and create a fresh one.
    }
    this.rzp.assertConfigured();

    const [tenant] = await this.dbAdmin
      .select({ name: tenants.name })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    const [owner] = await this.dbAdmin
      .select({ email: users.email, name: users.full_name })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.user_id))
      .where(and(eq(memberships.tenant_id, tenantId), eq(memberships.user_id, userId)))
      .limit(1);

    let customerId = sub.razorpay_customer_id;
    if (!customerId) {
      customerId = (
        await this.rzp.createCustomer({
          name: tenant?.name ?? 'Flicks Suite workspace',
          email: owner?.email ?? 'billing@unknown.invalid',
          tenantId,
        })
      ).id;
    }
    let planId = sub.razorpay_plan_id;
    if (!planId) planId = (await this.rzp.createPlan()).id;

    // Paid period starts when the trial runway ends (never bill trial days).
    const trialEnd = sub.trial_ends_at ? new Date(sub.trial_ends_at) : null;
    const startAt = trialEnd && trialEnd.getTime() > Date.now() + 10 * 60 * 1000 ? trialEnd : null;

    const rzpSub = await this.rzp.createSubscription({
      planId,
      customerId,
      quantity: seats,
      tenantId,
      startAt,
    });

    await this.dbAdmin
      .update(subscriptions)
      .set({
        razorpay_customer_id: customerId,
        razorpay_plan_id: planId,
        razorpay_subscription_id: rzpSub.id,
        authorization_url: rzpSub.short_url ?? null,
        cancel_at_period_end: false,
        canceled_at: null,
        updated_at: new Date(),
      })
      .where(eq(subscriptions.id, sub.id));
    await this.event(tenantId, sub.id, 'checkout.opened', {
      seats,
      razorpay_subscription_id: rzpSub.id,
    });
    await this.audit.logPlatform({
      actorUserId: userId,
      action: 'billing.subscribe_started',
      targetTenantId: tenantId,
      metadata: { seats, razorpay_subscription_id: rzpSub.id },
    });
    this.billingState.invalidate(tenantId);
    return { data: { authorization_url: rzpSub.short_url ?? null } };
  }

  // ─── POST /billing/coupon/redeem ────────────────────────────────────────────

  async redeemCoupon(tenantId: string, userId: string, rawCode: string) {
    const code = rawCode.trim().toUpperCase();
    if (!code) throw new BadRequestException('Enter a coupon code');

    // Log the attempt FIRST, then count (including this one) — a pure
    // check-then-log would let concurrent requests all pass at 9 attempts.
    // The audit trail itself is the counter (restart-proof, no new table).
    await this.audit.logPlatform({
      actorUserId: userId,
      action: 'billing.coupon_attempt',
      targetTenantId: tenantId,
      metadata: { code },
    });
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [{ n: attempts }] = await this.dbAdmin
      .select({ n: count() })
      .from(auditLogPlatform)
      .where(
        and(
          eq(auditLogPlatform.action, 'billing.coupon_attempt'),
          eq(auditLogPlatform.target_tenant_id, tenantId),
          gt(auditLogPlatform.created_at, dayAgo),
        ),
      );
    if (Number(attempts) > COUPON_ATTEMPTS_PER_DAY) {
      throw new HttpException(
        'Too many coupon attempts today — try again tomorrow.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const [sub] = await this.dbAdmin
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.tenant_id, tenantId))
      .limit(1);
    // Coupon months are TRIAL runway — once a Razorpay subscription exists,
    // extending a trial date changes nothing about what Razorpay charges.
    // Refuse loudly rather than swallow the free months.
    if (sub?.razorpay_subscription_id) {
      throw new BadRequestException(
        'Coupons apply before subscribing — this workspace already has a payment subscription.',
      );
    }
    // One coupon EVER per tenant — friendly pre-check (the UNIQUE constraint
    // inside the transaction is the real enforcement).
    const [already] = await this.dbAdmin
      .select({ id: couponRedemptions.id })
      .from(couponRedemptions)
      .where(eq(couponRedemptions.tenant_id, tenantId))
      .limit(1);
    if (already) {
      throw new ConflictException('This workspace has already redeemed a coupon');
    }

    // Claim + redemption + trial extension are ONE transaction: a crash can't
    // burn a redemption without granting the months, and a same-tenant race
    // rolls the claim back automatically via the UNIQUE(tenant_id) violation.
    let claimed;
    try {
      claimed = await this.dbAdmin.transaction(async (tx) => {
        // Atomic claim: the guarded UPDATE is the only way the count
        // increments, so two racing redeems of a last-use code can't both win.
        const [c] = await tx
          .update(couponCodes)
          .set({ redemption_count: sql`${couponCodes.redemption_count} + 1` })
          .where(
            and(
              eq(couponCodes.code, code),
              eq(couponCodes.active, true),
              sql`(${couponCodes.expires_at} IS NULL OR ${couponCodes.expires_at} > now())`,
              sql`${couponCodes.redemption_count} < ${couponCodes.max_redemptions}`,
            ),
          )
          .returning();
        if (!c) {
          throw new BadRequestException('That code isn’t valid — check it and try again');
        }
        await tx.insert(couponRedemptions).values({
          coupon_id: c.id,
          tenant_id: tenantId,
          redeemed_by: userId,
          months: c.months,
        });
        // Free months extend the trial runway on the sub row (the lock reads
        // it) and the tenant row (legacy fallbacks) — CALENDAR months, not
        // months*30 days.
        await tx
          .update(subscriptions)
          .set({
            applied_coupon_id: c.id,
            trial_ends_at: sql`GREATEST(coalesce(trial_ends_at, now()), now()) + (${c.months} || ' months')::interval`,
            updated_at: new Date(),
          })
          .where(eq(subscriptions.tenant_id, tenantId));
        await tx
          .update(tenants)
          .set({
            trial_ends_at: sql`GREATEST(coalesce(trial_ends_at, now()), now()) + (${c.months} || ' months')::interval`,
          })
          .where(eq(tenants.id, tenantId));
        return c;
      });
    } catch (err) {
      if (err instanceof HttpException) throw err;
      const pgCode = (err as { code?: string })?.code;
      if (pgCode === '23505') {
        // UNIQUE(tenant_id) — raced another redeem from the same tenant.
        throw new ConflictException('This workspace has already redeemed a coupon');
      }
      throw err;
    }

    const [subAfter] = await this.dbAdmin
      .select({ id: subscriptions.id, trial_ends_at: subscriptions.trial_ends_at })
      .from(subscriptions)
      .where(eq(subscriptions.tenant_id, tenantId))
      .limit(1);
    if (subAfter) {
      await this.event(tenantId, subAfter.id, 'coupon.redeemed', {
        code: claimed.code,
        campaign: claimed.campaign,
        months: claimed.months,
      });
    }
    await this.audit.logPlatform({
      actorUserId: userId,
      action: 'billing.coupon_redeemed',
      targetTenantId: tenantId,
      metadata: { code: claimed.code, campaign: claimed.campaign, months: claimed.months },
    });
    void this.analytics.track({
      event: 'coupon_redeemed',
      tenantId,
      userId,
      properties: {
        coupon_id: claimed.id,
        code: claimed.code,
        campaign: claimed.campaign,
        months: claimed.months,
      },
    });
    this.billingState.invalidate(tenantId);
    return {
      data: {
        months: claimed.months,
        trial_ends_at: subAfter?.trial_ends_at ?? null,
      },
    };
  }

  // ─── Cancel / resume ────────────────────────────────────────────────────────

  /**
   * Schedules cancellation at the period end. The flag is LOCAL until ~24h
   * before the boundary, when the hourly billing job pushes
   * `cancel_at_cycle_end` to Razorpay (before the boundary charge can fire —
   * pushing on the lapse side never works because each charge rolls
   * current_period_end forward). Keeping it local until then makes Resume
   * trivially safe: Razorpay has no reliable un-cancel, so Resume is simply
   * refused once the push window has begun.
   */
  async cancel(tenantId: string, userId: string) {
    const [sub] = await this.dbAdmin
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.tenant_id, tenantId))
      .limit(1);
    if (!sub?.razorpay_subscription_id || sub.status !== 'active') {
      throw new BadRequestException('There is no active subscription to cancel');
    }
    await this.dbAdmin
      .update(subscriptions)
      .set({ cancel_at_period_end: true, updated_at: new Date() })
      .where(eq(subscriptions.id, sub.id));
    await this.event(tenantId, sub.id, 'cancellation.scheduled', {
      effective: sub.current_period_end,
    });
    await this.audit.logPlatform({
      actorUserId: userId,
      action: 'billing.cancel_scheduled',
      targetTenantId: tenantId,
      metadata: { effective: sub.current_period_end },
    });
    this.billingState.invalidate(tenantId);
    return { data: { cancel_at_period_end: true, effective: sub.current_period_end } };
  }

  async resume(tenantId: string, userId: string) {
    const [sub] = await this.dbAdmin
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.tenant_id, tenantId))
      .limit(1);
    if (!sub?.cancel_at_period_end || sub.status !== 'active') {
      throw new BadRequestException('There is no scheduled cancellation to resume from');
    }
    // Once inside the push window the cancel may already be at Razorpay
    // (which cannot be reverted) — refuse rather than pretend.
    if (
      sub.current_period_end &&
      new Date(sub.current_period_end).getTime() - Date.now() < 26 * 60 * 60 * 1000
    ) {
      throw new BadRequestException(
        'The cancellation is already being processed for this period — subscribe again after it completes.',
      );
    }
    await this.dbAdmin
      .update(subscriptions)
      .set({ cancel_at_period_end: false, updated_at: new Date() })
      .where(eq(subscriptions.id, sub.id));
    await this.event(tenantId, sub.id, 'cancellation.reverted', {});
    await this.audit.logPlatform({
      actorUserId: userId,
      action: 'billing.cancel_reverted',
      targetTenantId: tenantId,
    });
    this.billingState.invalidate(tenantId);
    return { data: { cancel_at_period_end: false } };
  }

  // ─── Webhook effects (called by the platform webhook controller) ────────────

  async applyWebhook(eventType: string, payload: Record<string, unknown>): Promise<void> {
    const entity = this.subscriptionEntity(payload);
    const rzpSubId = entity?.id;
    if (!rzpSubId) return;
    const [sub] = await this.dbAdmin
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.razorpay_subscription_id, rzpSubId))
      .limit(1);
    if (!sub) {
      this.logger.warn(`platform webhook for unknown subscription ${rzpSubId} (${eventType})`);
      return;
    }
    const tenantId = sub.tenant_id;
    const periodStart = entity.current_start ? new Date(entity.current_start * 1000) : null;
    const periodEnd = entity.current_end ? new Date(entity.current_end * 1000) : null;

    switch (eventType) {
      case 'subscription.authenticated': {
        await this.event(tenantId, sub.id, 'mandate.authenticated', {});
        break;
      }
      case 'subscription.activated': {
        const seats = await this.recountSeats(tenantId);
        await this.dbAdmin
          .update(subscriptions)
          .set({
            status: 'active',
            grace_ends_at: null,
            authorization_url: null,
            mrr_amount: seats * PLATFORM_PLAN.priceRupees,
            ...(periodStart ? { current_period_start: periodStart } : {}),
            ...(periodEnd ? { current_period_end: periodEnd } : {}),
            updated_at: new Date(),
          })
          .where(eq(subscriptions.id, sub.id));
        await this.dbAdmin
          .update(tenants)
          .set({ status: 'active' })
          .where(eq(tenants.id, tenantId));
        await this.event(tenantId, sub.id, 'subscription.activated', { seats });
        void this.analytics.track({
          event: 'plan_subscribed',
          tenantId,
          properties: { seats, plan: PLATFORM_PLAN.code },
        });
        break;
      }
      case 'subscription.charged': {
        const amountPaise = this.paymentAmount(payload);
        await this.dbAdmin
          .update(subscriptions)
          .set({
            status: 'active',
            grace_ends_at: null,
            ...(periodStart ? { current_period_start: periodStart } : {}),
            ...(periodEnd ? { current_period_end: periodEnd } : {}),
            updated_at: new Date(),
          })
          .where(eq(subscriptions.id, sub.id));
        await this.event(tenantId, sub.id, 'charge.succeeded', {
          amount_paise: amountPaise,
          period_end: periodEnd,
        });
        await this.notifyOwners(tenantId, 'subscription-payment-success', {
          amount: amountPaise ? `₹${(amountPaise / 100).toLocaleString('en-IN')}` : '—',
          periodEnd: periodEnd?.toDateString(),
        });
        break;
      }
      case 'subscription.pending':
      case 'payment.failed': {
        const grace = new Date(Date.now() + BILLING_GRACE_DAYS * 24 * 60 * 60 * 1000);
        await this.dbAdmin
          .update(subscriptions)
          .set({
            status: 'past_due',
            // Never SHORTEN an existing grace window on repeat failures.
            grace_ends_at: sql`GREATEST(coalesce(grace_ends_at, to_timestamp(0)), ${grace.toISOString()}::timestamptz)`,
            updated_at: new Date(),
          })
          .where(eq(subscriptions.id, sub.id));
        await this.event(tenantId, sub.id, 'charge.failed', {});
        await this.notifyOwners(tenantId, 'subscription-payment-failed', {
          amount: `₹${(sub.user_count * PLATFORM_PLAN.priceRupees).toLocaleString('en-IN')}`,
        });
        break;
      }
      case 'subscription.halted': {
        await this.dbAdmin
          .update(subscriptions)
          .set({ status: 'unpaid', updated_at: new Date() })
          .where(eq(subscriptions.id, sub.id));
        await this.event(tenantId, sub.id, 'subscription.halted', {});
        break;
      }
      case 'subscription.cancelled': {
        await this.dbAdmin
          .update(subscriptions)
          .set({
            status: 'canceled',
            canceled_at: new Date(),
            // The old checkout link and the schedule flag die with the
            // subscription — otherwise re-subscribe reuses a dead short_url
            // and resume() "succeeds" with no billing effect.
            authorization_url: null,
            cancel_at_period_end: false,
            updated_at: new Date(),
          })
          .where(eq(subscriptions.id, sub.id));
        await this.event(tenantId, sub.id, 'subscription.cancelled', {});
        break;
      }
      default:
        this.logger.log(`platform webhook ${eventType} acknowledged (no-op)`);
    }
    this.billingState.invalidate(tenantId);
  }

  // ─── internals ──────────────────────────────────────────────────────────────

  private subscriptionEntity(
    payload: Record<string, unknown>,
  ): { id?: string; current_start?: number; current_end?: number } | null {
    const p = payload as {
      payload?: {
        subscription?: { entity?: Record<string, never> };
        payment?: { entity?: { subscription_id?: string } };
      };
    };
    const direct = p.payload?.subscription?.entity as
      | { id?: string; current_start?: number; current_end?: number }
      | undefined;
    if (direct?.id) return direct;
    // payment.failed carries only payload.payment.entity with a
    // subscription_id — without this fallback that event never matches a row.
    const viaPayment = p.payload?.payment?.entity?.subscription_id;
    return viaPayment ? { id: viaPayment } : null;
  }

  private paymentAmount(payload: Record<string, unknown>): number | null {
    const p = payload as { payload?: { payment?: { entity?: { amount?: number } } } };
    return p.payload?.payment?.entity?.amount ?? null;
  }

  private async event(
    tenantId: string,
    subscriptionId: string,
    eventType: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.dbAdmin.insert(subscriptionEvents).values({
      tenant_id: tenantId,
      subscription_id: subscriptionId,
      event_type: eventType,
      metadata,
    });
  }

  /** Owner+Admin emails for billing notices. */
  async ownerEmails(tenantId: string): Promise<Array<{ email: string; name: string | null }>> {
    return this.dbAdmin
      .select({ email: users.email, name: users.full_name })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.user_id))
      .where(
        and(
          eq(memberships.tenant_id, tenantId),
          eq(memberships.status, 'active'),
          sql`${memberships.role} IN ('owner','admin')`,
        ),
      );
  }

  private async notifyOwners(
    tenantId: string,
    template: 'subscription-payment-success' | 'subscription-payment-failed',
    extra: Record<string, unknown>,
  ): Promise<void> {
    try {
      const [tenant] = await this.dbAdmin
        .select({ name: tenants.name })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      const owners = await this.ownerEmails(tenantId);
      for (const o of owners) {
        await this.notifications.sendEmail(template, o.email, {
          tenantName: tenant?.name ?? 'your workspace',
          retryUrl: `${process.env.APP_URL ?? 'http://localhost:3000'}/settings/billing`,
          ...extra,
        });
      }
    } catch (err) {
      this.logger.warn(
        `billing email ${template} failed (continuing): ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}
