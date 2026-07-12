import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID } from 'crypto';
import { domainEvents } from '@flicks/db/schema';
import type { Db, DbAdmin } from '@flicks/db';
import { DOMAIN_EVENTS, type DomainEventName } from '@flicks/shared/constants';
import { DB_SERVICE_ROLE } from '../database/database.module';

/**
 * Domain-event bus (PRD v5 §2.2) — the ONE way modules tell the platform that
 * something happened.
 *
 * publish() writes the transactional-outbox row. Pass the caller's `tx` so the
 * event commits or rolls back WITH the state change (that is the whole point);
 * without a tx it writes via the service role (platform events, jobs).
 *
 * Fan-out is two-lane:
 *  • in-process: EventEmitter2 `domain.<name>` fires immediately after the
 *    outbox insert — cheap same-process reactions (notifications, cache pokes).
 *    Emitted pre-commit, so in-process subscribers must tolerate rollbacks;
 *    anything that must be durable listens on the queue lane instead.
 *  • durable: the worker-side dispatcher drains undispatched rows to the
 *    BullMQ 'domain-events' queue → webhooks, timeline, workflows, future AI.
 */
export interface DomainEventEnvelope {
  id: string;
  name: DomainEventName;
  tenantId: string | null;
  actorUserId: string | null;
  occurredAt: string;
  payload: Record<string, unknown>;
}

export interface PublishInput {
  name: DomainEventName;
  tenantId?: string | null;
  actorUserId?: string | null;
  /** ids/enums/amounts ONLY — never PII, names, emails, or message bodies. */
  payload?: Record<string, unknown>;
}

const KNOWN = new Set<string>(DOMAIN_EVENTS);

@Injectable()
export class DomainEventsService {
  private readonly logger = new Logger(DomainEventsService.name);

  constructor(
    @Inject(DB_SERVICE_ROLE) private readonly dbAdmin: DbAdmin,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Publish a domain event. Never throws into the caller's business flow for
   * emitter errors — but an outbox INSERT failure inside a caller's tx must
   * propagate (the state change and its event live or die together).
   */
  async publish(input: PublishInput, tx?: Db | DbAdmin): Promise<string | null> {
    if (!KNOWN.has(input.name)) {
      // Fail fast in dev/test; refuse quietly in prod rather than break flows.
      const msg = `domain event '${input.name}' is not in the DOMAIN_EVENTS catalog`;
      if (process.env.NODE_ENV !== 'production') throw new Error(msg);
      this.logger.error(msg);
      return null;
    }
    // Generate id + timestamp client-side: the app role is INSERT-ONLY on the
    // outbox (no SELECT), so `INSERT ... RETURNING` — which needs SELECT on the
    // returned columns — would be denied. Explicit values keep the write inside
    // the caller's app-role transaction.
    const id = randomUUID();
    const occurredAt = new Date();
    const executor = tx ?? this.dbAdmin;
    await executor.insert(domainEvents).values({
      id,
      tenant_id: input.tenantId ?? null,
      event_name: input.name,
      actor_user_id: input.actorUserId ?? null,
      payload: input.payload ?? {},
      occurred_at: occurredAt,
    });

    const envelope: DomainEventEnvelope = {
      id,
      name: input.name,
      tenantId: input.tenantId ?? null,
      actorUserId: input.actorUserId ?? null,
      occurredAt: occurredAt.toISOString(),
      payload: input.payload ?? {},
    };
    try {
      // In-process lane. Namespaced 'domain.' so wildcard subscribers can
      // listen to 'domain.crm.**' etc. without colliding with legacy events.
      this.eventEmitter.emit(`domain.${input.name}`, envelope);
    } catch (err) {
      this.logger.warn(
        `in-process fan-out failed for ${input.name}: ${err instanceof Error ? err.message : err}`,
      );
    }
    return id;
  }
}
