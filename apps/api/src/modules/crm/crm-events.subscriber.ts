import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DealsService } from './deals.service';
import type { DomainEventEnvelope } from '../../core/events/domain-events.service';

/**
 * CRM in-process reactions to domain events published by other modules (PRD v5
 * §2.2). Kept thin: it translates an event into a CRM service call and never
 * throws back into the emitting flow. Durable reactions belong on the queue
 * lane; this lane is best-effort and tolerates pre-commit rollbacks.
 */
@Injectable()
export class CrmEventsSubscriber {
  private readonly logger = new Logger(CrmEventsSubscriber.name);

  constructor(private readonly deals: DealsService) {}

  /**
   * A hosted-page quote acceptance (§19.3): advance the linked deal to the
   * pipeline's configured stage, if any.
   */
  @OnEvent('domain.invoice.quote_accepted')
  async onQuoteAccepted(env: DomainEventEnvelope): Promise<void> {
    const dealId = env.payload?.deal_id as string | undefined;
    if (!dealId || !env.tenantId) return;
    try {
      await this.deals.applyQuoteAccepted(env.tenantId, dealId);
    } catch (err) {
      this.logger.warn(
        `quote-accepted auto-move failed for deal ${dealId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}
