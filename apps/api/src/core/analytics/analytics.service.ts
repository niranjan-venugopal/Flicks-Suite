import { Inject, Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PostHog } from 'posthog-node';
import { productEvents } from '@flicks/db/schema';
import type { DbAdmin } from '@flicks/db';
import { DB_SERVICE_ROLE } from '../database/database.module';

// Server-side critical-path events. Captured here (not on the client) for
// the funnel/security-sensitive actions that must not be droppable by an
// ad-blocker: tenant signup and FAM impersonation. Names mirror the
// client taxonomy in apps/web/lib/analytics/posthog.ts.
export const SERVER_EVENTS = {
  TENANT_SIGNUP_COMPLETED: 'tenant_signup_completed',
  IMPERSONATION_STARTED: 'impersonation_started',
} as const;

export type ServerAnalyticsEvent =
  (typeof SERVER_EVENTS)[keyof typeof SERVER_EVENTS];

/**
 * PRD v4 §6 taxonomy — first-party events written to product_events.
 * Properties must be ids/enums/numbers only; NEVER emails, names or free text.
 */
export const PRODUCT_EVENTS = [
  'signed_up',
  'org_configured',
  'member_invited',
  'member_accepted',
  'first_login_day',
  'invoice_created',
  'invoice_sent',
  'payment_received',
  'subscription_created',
  'mandate_authorized',
  'subscription_charged',
  'plan_subscribed',
  'coupon_redeemed',
  'platform_charge_succeeded',
  'platform_charge_failed',
  'trial_expired',
  'feedback_submitted',
  'nps_submitted',
  'data_export_requested',
  'module_opened',
] as const;
export type ProductEventName = (typeof PRODUCT_EVENTS)[number];

export interface TrackInput {
  event: ProductEventName;
  tenantId?: string | null;
  userId?: string | null;
  properties?: Record<string, string | number | boolean | null>;
  source?: 'web' | 'api' | 'job';
}

@Injectable()
export class AnalyticsService implements OnModuleDestroy {
  private readonly logger = new Logger(AnalyticsService.name);
  private readonly client: PostHog | null;

  constructor(
    private readonly config: ConfigService,
    // Optional so pre-v4 unit constructions (new AnalyticsService(config))
    // keep working; track() no-ops without a DB handle.
    @Optional() @Inject(DB_SERVICE_ROLE) private readonly dbAdmin?: DbAdmin,
  ) {
    const key = this.config.get<string>('POSTHOG_KEY');
    this.client = key
      ? new PostHog(key, {
          host: this.config.get<string>(
            'POSTHOG_HOST',
            'https://app.posthog.com',
          ),
          flushAt: 1,
          flushInterval: 0,
        })
      : null;
  }

  /**
   * PRD v4 §6 — the single analytics abstraction. Writes product_events in our
   * own Postgres (never gated); ALSO double-writes to PostHog when a key is
   * configured (the documented exit ramp — no code hunt to re-enable).
   * Fire-and-forget: analytics must never break a request path.
   */
  track(input: TrackInput): Promise<void> {
    if (!PRODUCT_EVENTS.includes(input.event)) return Promise.resolve();
    const row = {
      tenant_id: input.tenantId ?? null,
      user_id: input.userId ?? null,
      event_name: input.event,
      properties: input.properties ?? {},
      source: input.source ?? 'api',
    };
    let write: Promise<void> = Promise.resolve();
    if (this.dbAdmin) {
      // Returned (awaitable by the listener's dedupe paths) but safe to drop —
      // failures only log; analytics never breaks a request path.
      write = this.dbAdmin
        .insert(productEvents)
        .values(row)
        .then(() => undefined)
        .catch((e: unknown) =>
          this.logger.warn(
            `product_events insert failed (${input.event}): ${e instanceof Error ? e.message : e}`,
          ),
        );
    }
    if (this.client && input.userId) {
      try {
        this.client.capture({
          distinctId: input.userId,
          event: input.event,
          properties: input.properties,
          groups: input.tenantId ? { tenant: input.tenantId } : undefined,
        });
      } catch (e) {
        this.logger.warn(`PostHog double-write failed: ${(e as Error).message}`);
      }
    }
    return write;
  }

  /** Fire a server-originated event. No-op without POSTHOG_KEY. */
  capture(
    distinctId: string,
    event: ServerAnalyticsEvent,
    properties?: Record<string, unknown>,
    groups?: { tenant?: string },
  ): void {
    if (!this.client) return;
    try {
      this.client.capture({
        distinctId,
        event,
        properties,
        groups: groups?.tenant ? { tenant: groups.tenant } : undefined,
      });
    } catch (e) {
      this.logger.warn(`PostHog capture failed: ${(e as Error).message}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.shutdown();
  }
}
