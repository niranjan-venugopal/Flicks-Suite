import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { subscriptions, tenants } from '@flicks/db/schema';
import type { DbAdmin } from '@flicks/db';
import { PLATFORM_PLAN } from '@flicks/shared/constants';
import { DB_SERVICE_ROLE } from '../database/database.module';

const SPECFLICKS_TENANT_ID = '00000000-0000-0000-0000-000000000001';
const CACHE_TTL_MS = 60_000;

export interface BillingLockState {
  locked: boolean;
  reason: 'trial_expired' | 'past_due' | 'canceled' | 'halted' | null;
}

/**
 * Round R — what the workspace card under the company name says. Read by
 * /auth/me for every page load, so it is served from the same 60-second
 * cache as the lock verdict and never writes (unlike GET /billing).
 */
export interface BillingSummary {
  /** subscription status; 'platform' for the Specflicks tenant (no subscription). */
  status: 'trialing' | 'active' | 'past_due' | 'canceled' | 'unpaid' | 'paused' | 'platform';
  trialEndsAt: string | null;
  /**
   * IST calendar days left in the trial: 0 = ends later today, negative =
   * ended (always negative once the lock verdict says the trial is over);
   * null outside a trial.
   */
  trialDaysLeft: number | null;
  /** The plan's display name ("Pro") once paying; null otherwise. */
  planName: string | null;
  /** A promo code is applied (the trial was "given the code"). */
  hasCoupon: boolean;
}

interface CacheEntry {
  lock: BillingLockState;
  summary: BillingSummary;
  at: number;
}

const IST_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Whole IST calendar days from now to `d` — the same arithmetic as billing.service daysLeftIST. */
function daysLeftIST(d: Date | string, now = new Date()): number {
  const midnightUTC = (x: Date) => {
    const [y, m, day] = IST_DAY.format(x).split('-').map(Number);
    return Date.UTC(y!, m! - 1, day!);
  };
  return Math.round((midnightUTC(new Date(d)) - midnightUTC(now)) / 86_400_000);
}

/**
 * Days left for the workspace card. The lock compares instants, the card
 * counts IST days — a trial that ended an hour ago must never read "ends
 * today" while the workspace is already read-only.
 */
function trialDaysFor(endsAt: Date, now: number): number {
  const days = daysLeftIST(endsAt, new Date(now));
  return endsAt.getTime() < now ? Math.min(days, -1) : days;
}

/**
 * Per-tenant billing lock verdict (PRD v4 §8B.5), shared by the BillingGuard
 * (every mutating request) and the billing API. Lives in core/ so the guard
 * doesn't pull the whole billing module into the guard chain.
 *
 * Lock rules — a workspace is read-only when:
 *   • trialing and the trial has ended (subscription row's trial_ends_at,
 *     falling back to tenants.trial_ends_at when no row exists yet), or
 *   • past_due beyond grace_ends_at (7-day runway after a failed charge), or
 *   • canceled with the paid period over, or
 *   • unpaid/halted (Razorpay exhausted retries).
 *
 * Verdicts are cached 60s; billing mutations call invalidate(tenantId) so a
 * successful subscribe unlocks on the next request.
 *
 * NOTE: the cache (and its invalidation) is per-process — fine for the
 * single-instance beta (same assumption as the in-memory throttler and
 * presence maps); a multi-instance deploy needs a shared store or has to
 * accept up to 60s of stale lock verdicts on the other instances.
 */
@Injectable()
export class BillingStateService {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(@Inject(DB_SERVICE_ROLE) private readonly dbAdmin: DbAdmin) {}

  invalidate(tenantId: string): void {
    this.cache.delete(tenantId);
  }

  async isLocked(tenantId: string): Promise<boolean> {
    return (await this.state(tenantId)).locked;
  }

  async state(tenantId: string): Promise<BillingLockState> {
    return (await this.entry(tenantId)).lock;
  }

  /** Round R: the workspace-card label's source of truth (cached, read-only). */
  async summary(tenantId: string): Promise<BillingSummary> {
    return (await this.entry(tenantId)).summary;
  }

  private async entry(tenantId: string): Promise<CacheEntry> {
    if (tenantId === SPECFLICKS_TENANT_ID) {
      return {
        lock: { locked: false, reason: null },
        summary: { status: 'platform', trialEndsAt: null, trialDaysLeft: null, planName: null, hasCoupon: false },
        at: Date.now(),
      };
    }
    const hit = this.cache.get(tenantId);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit;

    const computed = await this.compute(tenantId);
    const entry = { ...computed, at: Date.now() };
    this.cache.set(tenantId, entry);
    return entry;
  }

  private async compute(tenantId: string): Promise<Omit<CacheEntry, 'at'>> {
    const now = Date.now();
    const [sub] = await this.dbAdmin
      .select({
        status: subscriptions.status,
        trial_ends_at: subscriptions.trial_ends_at,
        grace_ends_at: subscriptions.grace_ends_at,
        current_period_end: subscriptions.current_period_end,
        applied_coupon_id: subscriptions.applied_coupon_id,
      })
      .from(subscriptions)
      .where(eq(subscriptions.tenant_id, tenantId))
      .limit(1);

    if (!sub) {
      // Pre-0028 tenant without a row (shouldn't persist past the backfill,
      // but never lock on missing data alone) — fall back to the tenant trial.
      const [tenant] = await this.dbAdmin
        .select({ trial_ends_at: tenants.trial_ends_at })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      const endsAt = tenant?.trial_ends_at ? new Date(tenant.trial_ends_at) : null;
      const ends = endsAt?.getTime() ?? null;
      return {
        lock: ends && ends < now ? { locked: true, reason: 'trial_expired' } : { locked: false, reason: null },
        summary: {
          status: 'trialing',
          trialEndsAt: endsAt?.toISOString() ?? null,
          trialDaysLeft: endsAt ? trialDaysFor(endsAt, now) : null,
          planName: null,
          hasCoupon: false,
        },
      };
    }

    const trialEndsAt = sub.trial_ends_at ? new Date(sub.trial_ends_at) : null;
    const summary: BillingSummary = {
      status: sub.status as BillingSummary['status'],
      trialEndsAt: trialEndsAt?.toISOString() ?? null,
      trialDaysLeft: sub.status === 'trialing' && trialEndsAt ? trialDaysFor(trialEndsAt, now) : null,
      planName: sub.status === 'active' ? PLATFORM_PLAN.name : null,
      hasCoupon: !!sub.applied_coupon_id,
    };
    return { lock: this.lockFor(sub, now), summary };
  }

  private lockFor(
    sub: {
      status: string;
      trial_ends_at: Date | string | null;
      grace_ends_at: Date | string | null;
      current_period_end: Date | string | null;
    },
    now: number,
  ): BillingLockState {
    switch (sub.status) {
      case 'active':
        return { locked: false, reason: null };
      case 'trialing': {
        const ends = sub.trial_ends_at ? new Date(sub.trial_ends_at).getTime() : null;
        return ends && ends < now
          ? { locked: true, reason: 'trial_expired' }
          : { locked: false, reason: null };
      }
      case 'past_due': {
        const grace = sub.grace_ends_at ? new Date(sub.grace_ends_at).getTime() : null;
        return grace && grace > now
          ? { locked: false, reason: null }
          : { locked: true, reason: 'past_due' };
      }
      case 'canceled': {
        const periodEnd = sub.current_period_end
          ? new Date(sub.current_period_end).getTime()
          : null;
        if (periodEnd) {
          return periodEnd > now
            ? { locked: false, reason: null }
            : { locked: true, reason: 'canceled' };
        }
        // Cancelled before first activation (mandate abandoned mid-checkout):
        // no paid period ever existed — the trial runway still applies.
        const trialEnds = sub.trial_ends_at ? new Date(sub.trial_ends_at).getTime() : null;
        return trialEnds && trialEnds > now
          ? { locked: false, reason: null }
          : { locked: true, reason: 'trial_expired' };
      }
      case 'unpaid':
      case 'paused':
        return { locked: true, reason: 'halted' };
      default:
        return { locked: false, reason: null };
    }
  }
}
