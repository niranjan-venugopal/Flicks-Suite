import { Inject, Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { and, eq, gte, sql } from 'drizzle-orm';
import { productEvents } from '@flicks/db/schema';
import type { DbAdmin } from '@flicks/db';
import { DB_SERVICE_ROLE } from '../database/database.module';
import {
  AnalyticsService,
  type ProductEventName,
  type TrackInput,
} from './analytics.service';

export interface AnalyticsTrackEvent extends TrackInput {
  /** Skip when a row already exists today for (user, event) — e.g. first_login_day. */
  dedupePerDay?: boolean;
  /** Skip when ANY row exists for (tenant, event) — e.g. org_configured. */
  oncePerTenant?: boolean;
  /** Stamp properties.first = "no prior row for (tenant, event)" — F3–F5. */
  markFirst?: boolean;
}

/**
 * `analytics.track` event sink (PRD v4 §6). Services/controllers emit through
 * EventEmitter2 instead of injecting AnalyticsService everywhere (keeps ~10
 * constructor signatures — and their test fixtures — untouched). The listener
 * adds the dedupe/first semantics the taxonomy needs, then delegates to
 * AnalyticsService.track().
 */
@Injectable()
export class AnalyticsListener {
  private readonly logger = new Logger(AnalyticsListener.name);

  constructor(
    private readonly analytics: AnalyticsService,
    @Inject(DB_SERVICE_ROLE) private readonly dbAdmin: DbAdmin,
  ) {}

  private async hasAny(
    tenantId: string,
    event: ProductEventName,
  ): Promise<boolean> {
    const [row] = await this.dbAdmin
      .select({ one: sql<number>`1` })
      .from(productEvents)
      .where(
        and(
          eq(productEvents.tenant_id, tenantId),
          eq(productEvents.event_name, event),
        ),
      )
      .limit(1);
    return !!row;
  }

  @OnEvent('analytics.track')
  async handle(payload: AnalyticsTrackEvent): Promise<void> {
    try {
      if (payload.dedupePerDay && payload.userId) {
        const dayStart = new Date();
        dayStart.setHours(0, 0, 0, 0);
        const [existing] = await this.dbAdmin
          .select({ one: sql<number>`1` })
          .from(productEvents)
          .where(
            and(
              eq(productEvents.user_id, payload.userId),
              eq(productEvents.event_name, payload.event),
              gte(productEvents.occurred_at, dayStart),
            ),
          )
          .limit(1);
        if (existing) return;
      }
      if (payload.oncePerTenant && payload.tenantId) {
        if (await this.hasAny(payload.tenantId, payload.event)) return;
      }
      let properties = payload.properties;
      if (payload.markFirst && payload.tenantId) {
        const first = !(await this.hasAny(payload.tenantId, payload.event));
        properties = { ...properties, first };
      }
      // Await so the dedupe/first checks of a subsequent event see this row.
      await this.analytics.track({ ...payload, properties });
    } catch (err) {
      this.logger.warn(
        `analytics.track handling failed (${payload.event}): ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}
