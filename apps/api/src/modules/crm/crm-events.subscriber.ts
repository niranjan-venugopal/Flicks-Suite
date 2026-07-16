import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DealsService } from './deals.service';
import { SequencesService } from './sequences.service';
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

  constructor(
    private readonly deals: DealsService,
    private readonly sequences: SequencesService,
  ) {}

  /**
   * A hosted-page quote acceptance (§19.3): advance the linked deal to the
   * pipeline's configured stage, if any.
   */
  /** §7.1 — a decided deal exits its active sequence enrollments. */
  @OnEvent('domain.crm.deal.won')
  async onDealWon(env: DomainEventEnvelope): Promise<void> {
    const dealId = env.payload?.deal_id as string | undefined;
    if (dealId && env.tenantId) await this.sequences.exitByDeal(env.tenantId, dealId, 'won').catch(() => undefined);
  }

  @OnEvent('domain.crm.deal.lost')
  async onDealLost(env: DomainEventEnvelope): Promise<void> {
    const dealId = env.payload?.deal_id as string | undefined;
    if (dealId && env.tenantId) await this.sequences.exitByDeal(env.tenantId, dealId, 'lost').catch(() => undefined);
  }

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
