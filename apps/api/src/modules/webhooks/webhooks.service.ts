import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { randomBytes } from 'crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { domainEvents, webhookDeliveries, webhookEndpoints } from '@flicks/db/schema';
import type { DbAdmin } from '@flicks/db';
import { DOMAIN_EVENTS } from '@flicks/shared/constants';
import { DB_SERVICE_ROLE } from '../../core/database/database.module';
import { WEBHOOK_DELIVERIES_QUEUE } from '../../core/events/events.constants';
import { AppCryptoService } from '../../core/crypto/app-crypto.service';
import { assertPublicHttpUrl, SsrfViolationError } from '../../core/security/ssrf.util';
import { AuditService } from '../audit/audit.service';

/**
 * Outbound webhook endpoints (PRD v5 §11). Service-role data access (the
 * tables are REVOKEd from the app role — secrets never touch it); tenant
 * scoping enforced here on every query. Secrets are shown ONCE at creation
 * and stored AES-256-GCM encrypted.
 */
const MAX_ENDPOINTS = 10;
const KNOWN_EVENTS = new Set<string>(DOMAIN_EVENTS);

@Injectable()
export class WebhooksService {
  constructor(
    @Inject(DB_SERVICE_ROLE) private readonly dbAdmin: DbAdmin,
    private readonly crypto: AppCryptoService,
    private readonly audit: AuditService,
    @InjectQueue(WEBHOOK_DELIVERIES_QUEUE) private readonly deliveryQueue: Queue,
  ) {}

  private sanitize(row: typeof webhookEndpoints.$inferSelect) {
    const { secret_encrypted: _secret, ...safe } = row;
    return safe;
  }

  async list(tenantId: string) {
    const rows = await this.dbAdmin
      .select()
      .from(webhookEndpoints)
      .where(and(eq(webhookEndpoints.tenant_id, tenantId), isNull(webhookEndpoints.deleted_at)))
      .orderBy(desc(webhookEndpoints.created_at));
    return { data: rows.map((r) => this.sanitize(r)) };
  }

  async create(
    tenantId: string,
    userId: string,
    dto: { url: string; events: string[] },
  ) {
    const events = [...new Set(dto.events ?? [])];
    if (events.length === 0) throw new BadRequestException('Subscribe to at least one event');
    const unknown = events.filter((e) => !KNOWN_EVENTS.has(e));
    if (unknown.length) throw new BadRequestException(`Unknown events: ${unknown.join(', ')}`);
    try {
      await assertPublicHttpUrl(dto.url);
    } catch (err) {
      if (err instanceof SsrfViolationError) throw new BadRequestException(err.message);
      throw err;
    }
    const existing = await this.dbAdmin
      .select({ id: webhookEndpoints.id })
      .from(webhookEndpoints)
      .where(and(eq(webhookEndpoints.tenant_id, tenantId), isNull(webhookEndpoints.deleted_at)));
    if (existing.length >= MAX_ENDPOINTS) {
      throw new BadRequestException(`Limit: ${MAX_ENDPOINTS} webhook endpoints per workspace`);
    }

    const secret = `whsec_${randomBytes(24).toString('base64url')}`;
    const [row] = await this.dbAdmin
      .insert(webhookEndpoints)
      .values({
        tenant_id: tenantId,
        url: dto.url,
        secret_encrypted: this.crypto.encrypt(secret, 'webhook'),
        events,
        created_by: userId,
      })
      .returning();
    await this.audit.log({
      tenantId,
      actorUserId: userId,
      action: 'webhooks.endpoint_created',
      resourceType: 'webhook_endpoint',
      resourceId: row!.id,
      metadata: { url: dto.url, events },
    });
    // The ONLY time the plaintext secret leaves the server.
    return { data: { ...this.sanitize(row!), secret } };
  }

  async update(
    tenantId: string,
    userId: string,
    id: string,
    dto: { url?: string; events?: string[]; active?: boolean },
  ) {
    const [existing] = await this.dbAdmin
      .select()
      .from(webhookEndpoints)
      .where(
        and(
          eq(webhookEndpoints.id, id),
          eq(webhookEndpoints.tenant_id, tenantId),
          isNull(webhookEndpoints.deleted_at),
        ),
      )
      .limit(1);
    if (!existing) throw new NotFoundException('Webhook endpoint not found');

    if (dto.url) {
      try {
        await assertPublicHttpUrl(dto.url);
      } catch (err) {
        if (err instanceof SsrfViolationError) throw new BadRequestException(err.message);
        throw err;
      }
    }
    if (dto.events) {
      const unknown = dto.events.filter((e) => !KNOWN_EVENTS.has(e));
      if (unknown.length) throw new BadRequestException(`Unknown events: ${unknown.join(', ')}`);
    }
    const [row] = await this.dbAdmin
      .update(webhookEndpoints)
      .set({
        ...(dto.url ? { url: dto.url } : {}),
        ...(dto.events ? { events: [...new Set(dto.events)] } : {}),
        ...(dto.active !== undefined
          ? {
              active: dto.active,
              // Re-enabling clears the strike counter and the disabled stamp.
              ...(dto.active
                ? { consecutive_failures: 0, disabled_at: null, disabled_reason: null }
                : {}),
            }
          : {}),
        updated_at: new Date(),
      })
      // tenant_id in the WHERE too (defense-in-depth — service role bypasses RLS).
      .where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.tenant_id, tenantId)))
      .returning();
    await this.audit.log({
      tenantId,
      actorUserId: userId,
      action: 'webhooks.endpoint_updated',
      resourceType: 'webhook_endpoint',
      resourceId: id,
      metadata: dto as Record<string, unknown>,
    });
    return { data: this.sanitize(row!) };
  }

  async remove(tenantId: string, userId: string, id: string) {
    const [row] = await this.dbAdmin
      .update(webhookEndpoints)
      .set({ deleted_at: new Date(), active: false })
      .where(
        and(
          eq(webhookEndpoints.id, id),
          eq(webhookEndpoints.tenant_id, tenantId),
          isNull(webhookEndpoints.deleted_at),
        ),
      )
      .returning({ id: webhookEndpoints.id });
    if (!row) throw new NotFoundException('Webhook endpoint not found');
    await this.audit.log({
      tenantId,
      actorUserId: userId,
      action: 'webhooks.endpoint_deleted',
      resourceType: 'webhook_endpoint',
      resourceId: id,
    });
    return { data: { deleted: true } };
  }

  /** Delivery log for the C19 UI (latest 50 per endpoint). */
  async deliveries(tenantId: string, endpointId: string) {
    const rows = await this.dbAdmin
      .select()
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.tenant_id, tenantId),
          eq(webhookDeliveries.endpoint_id, endpointId),
        ),
      )
      .orderBy(desc(webhookDeliveries.created_at))
      .limit(50);
    return { data: rows };
  }

  /**
   * Redrive (C19): re-enqueue one delivery. The envelope is rebuilt from the
   * outbox row, so the receiver gets the SAME event id/payload — their
   * idempotency keys keep working. Fresh jobId → fresh 5-attempt budget.
   */
  async redrive(tenantId: string, userId: string, endpointId: string, deliveryId: string) {
    const [row] = await this.dbAdmin
      .select({ delivery: webhookDeliveries, endpoint: webhookEndpoints })
      .from(webhookDeliveries)
      .innerJoin(webhookEndpoints, eq(webhookEndpoints.id, webhookDeliveries.endpoint_id))
      .where(
        and(
          eq(webhookDeliveries.id, deliveryId),
          eq(webhookDeliveries.tenant_id, tenantId),
          eq(webhookDeliveries.endpoint_id, endpointId),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException('Delivery not found');
    if (!row.endpoint.active || row.endpoint.deleted_at) {
      throw new BadRequestException('Endpoint is disabled — re-enable it first');
    }
    if (row.delivery.status === 'pending') {
      throw new BadRequestException('Delivery is still in flight');
    }
    if (!row.delivery.event_id) throw new BadRequestException('Original event no longer available');
    const [evt] = await this.dbAdmin
      .select()
      .from(domainEvents)
      .where(eq(domainEvents.id, row.delivery.event_id))
      .limit(1);
    if (!evt) throw new BadRequestException('Original event no longer available');

    await this.dbAdmin
      .update(webhookDeliveries)
      .set({ status: 'pending', last_error: null })
      .where(eq(webhookDeliveries.id, deliveryId));
    await this.deliveryQueue.add(
      'deliver',
      {
        deliveryId,
        event: {
          id: evt.id,
          name: evt.event_name,
          tenantId: evt.tenant_id,
          actorUserId: evt.actor_user_id,
          occurredAt: evt.occurred_at.toISOString(),
          payload: evt.payload as Record<string, unknown>,
        },
      },
      {
        jobId: `${deliveryId}:redrive:${Date.now()}`,
        attempts: 5,
        backoff: { type: 'exponential', delay: 60_000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    );
    await this.audit.log({
      tenantId, actorUserId: userId, action: 'webhooks.delivery.redrive',
      resourceType: 'webhook_delivery', resourceId: deliveryId,
    });
    return { data: { ok: true } };
  }
}
