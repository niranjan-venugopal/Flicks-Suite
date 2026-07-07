import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { subscriptions, tenants } from '@flicks/db/schema';
import type { DbAdmin } from '@flicks/db';
import { DB_SERVICE_ROLE } from '../database/database.module';

const SPECFLICKS_TENANT_ID = '00000000-0000-0000-0000-000000000001';
const CACHE_TTL_MS = 60_000;

export interface BillingLockState {
  locked: boolean;
  reason: 'trial_expired' | 'past_due' | 'canceled' | 'halted' | null;
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
  private readonly cache = new Map<string, { state: BillingLockState; at: number }>();

  constructor(@Inject(DB_SERVICE_ROLE) private readonly dbAdmin: DbAdmin) {}

  invalidate(tenantId: string): void {
    this.cache.delete(tenantId);
  }

  async isLocked(tenantId: string): Promise<boolean> {
    return (await this.state(tenantId)).locked;
  }

  async state(tenantId: string): Promise<BillingLockState> {
    if (tenantId === SPECFLICKS_TENANT_ID) return { locked: false, reason: null };
    const hit = this.cache.get(tenantId);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.state;

    const state = await this.compute(tenantId);
    this.cache.set(tenantId, { state, at: Date.now() });
    return state;
  }

  private async compute(tenantId: string): Promise<BillingLockState> {
    const now = Date.now();
    const [sub] = await this.dbAdmin
      .select({
        status: subscriptions.status,
        trial_ends_at: subscriptions.trial_ends_at,
        grace_ends_at: subscriptions.grace_ends_at,
        current_period_end: subscriptions.current_period_end,
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
      const ends = tenant?.trial_ends_at ? new Date(tenant.trial_ends_at).getTime() : null;
      return ends && ends < now
        ? { locked: true, reason: 'trial_expired' }
        : { locked: false, reason: null };
    }

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
