import { Inject, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { createHmac } from 'crypto';
import { eq, sql } from 'drizzle-orm';
import { memberships, webhookDeliveries, webhookEndpoints } from '@flicks/db/schema';
import type { DbAdmin } from '@flicks/db';
import { DB_SERVICE_ROLE } from '../../core/database/database.module';
import { WEBHOOK_DELIVERIES_QUEUE } from '../../core/events/events.constants';
import { AppCryptoService } from '../../core/crypto/app-crypto.service';
import { assertPublicHttpUrl } from '../../core/security/ssrf.util';
import { NotificationsService } from '../notifications/notifications.service';
import type { DomainEventEnvelope } from '../../core/events/domain-events.service';

/**
 * Outbound webhook delivery (PRD v5 §11, worker process).
 *  • Signature: X-Flicks-Signature: t=<unix>,v1=HMAC_SHA256(secret, `${t}.${body}`)
 *  • Retries: 5 attempts, exponential backoff (BullMQ job opts set by fan-out)
 *  • SSRF: URL re-validated immediately before EVERY send (DNS may change)
 *  • Auto-disable: 20 consecutive failures across deliveries → endpoint off +
 *    in-app notice to tenant owners; any success resets the counter.
 */
const DISABLE_AFTER = 20;
const TIMEOUT_MS = 5_000;

interface DeliveryJob {
  deliveryId: string;
  event: DomainEventEnvelope;
}

@Processor(WEBHOOK_DELIVERIES_QUEUE)
export class WebhookDeliveryProcessor extends WorkerHost {
  private readonly logger = new Logger(WebhookDeliveryProcessor.name);

  constructor(
    @Inject(DB_SERVICE_ROLE) private readonly dbAdmin: DbAdmin,
    private readonly crypto: AppCryptoService,
    private readonly notifications: NotificationsService,
  ) {
    super();
  }

  async process(job: Job<DeliveryJob>): Promise<void> {
    const { deliveryId, event } = job.data;
    const [row] = await this.dbAdmin
      .select({
        delivery: webhookDeliveries,
        endpoint: webhookEndpoints,
      })
      .from(webhookDeliveries)
      .innerJoin(webhookEndpoints, eq(webhookEndpoints.id, webhookDeliveries.endpoint_id))
      .where(eq(webhookDeliveries.id, deliveryId))
      .limit(1);
    if (!row) return;
    const { delivery, endpoint } = row;
    if (!endpoint.active || endpoint.deleted_at) {
      await this.mark(deliveryId, { status: 'exhausted', last_error: 'endpoint disabled' });
      return;
    }

    const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 5);
    try {
      await assertPublicHttpUrl(endpoint.url);
      const body = JSON.stringify({
        id: event.id,
        name: event.name,
        occurredAt: event.occurredAt,
        payload: event.payload,
      });
      const t = Math.floor(Date.now() / 1000);
      const secret = this.crypto.decrypt(endpoint.secret_encrypted, 'webhook');
      const v1 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      let status: number;
      try {
        const res = await fetch(endpoint.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Flicks-Signature': `t=${t},v1=${v1}`,
            'X-Flicks-Event': event.name,
            'User-Agent': 'FlicksSuite-Webhooks/1.0',
          },
          body,
          signal: controller.signal,
          redirect: 'error', // a redirect could re-target into private space
        });
        status = res.status;
      } finally {
        clearTimeout(timer);
      }

      if (status >= 200 && status < 300) {
        await this.mark(deliveryId, {
          status: 'success',
          last_status_code: status,
          delivered_at: new Date(),
        });
        await this.dbAdmin
          .update(webhookEndpoints)
          .set({ consecutive_failures: 0 })
          .where(eq(webhookEndpoints.id, endpoint.id));
        return;
      }
      throw new Error(`HTTP ${status}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const statusCode = /^HTTP (\d+)$/.exec(message)?.[1];
      await this.mark(deliveryId, {
        status: isFinalAttempt ? 'exhausted' : 'failed',
        last_error: message.slice(0, 500),
        ...(statusCode ? { last_status_code: Number(statusCode) } : {}),
      });
      if (isFinalAttempt) {
        await this.recordEndpointFailure(endpoint.id, endpoint.tenant_id);
      }
      throw err; // let BullMQ schedule the backoff retry (or finalize)
    }
  }

  private async mark(
    deliveryId: string,
    patch: Partial<typeof webhookDeliveries.$inferInsert>,
  ): Promise<void> {
    await this.dbAdmin
      .update(webhookDeliveries)
      .set({ ...patch, attempts: sql`${webhookDeliveries.attempts} + 1` })
      .where(eq(webhookDeliveries.id, deliveryId));
  }

  /** Exhausted delivery → bump the strike counter; at 20, turn it off + notify. */
  private async recordEndpointFailure(endpointId: string, tenantId: string): Promise<void> {
    const [ep] = await this.dbAdmin
      .update(webhookEndpoints)
      .set({ consecutive_failures: sql`${webhookEndpoints.consecutive_failures} + 1` })
      .where(eq(webhookEndpoints.id, endpointId))
      .returning({ failures: webhookEndpoints.consecutive_failures, url: webhookEndpoints.url });
    if (!ep || ep.failures < DISABLE_AFTER) return;
    await this.dbAdmin
      .update(webhookEndpoints)
      .set({
        active: false,
        disabled_at: new Date(),
        disabled_reason: `${DISABLE_AFTER} consecutive delivery failures`,
      })
      .where(eq(webhookEndpoints.id, endpointId));
    try {
      const owners = await this.dbAdmin
        .select({ user_id: memberships.user_id })
        .from(memberships)
        .where(
          sql`${memberships.tenant_id} = ${tenantId} AND ${memberships.status} = 'active' AND ${memberships.role} IN ('owner','admin')`,
        );
      const host = (() => {
        try {
          return new URL(ep.url).host;
        } catch {
          return 'endpoint';
        }
      })();
      for (const o of owners) {
        await this.notifications.createInAppNotification(
          o.user_id,
          'webhooks.endpoint_disabled',
          `Webhook to ${host} was disabled after ${DISABLE_AFTER} consecutive failures.`,
          '/crm/settings/api',
          tenantId,
        );
      }
    } catch (err) {
      this.logger.warn(
        `endpoint-disabled notify failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}
