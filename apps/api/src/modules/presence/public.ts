import { Injectable } from '@nestjs/common';
import { PresenceService, type PresenceStatus } from './presence.service';

/**
 * Presence public facade (PRD v5 §2.3) — the ONLY surface other feature
 * modules (CRM notifications DND check, later assignment skip-OOO) may consume
 * from Presence. Deliberately tiny: resolve one user's effective status.
 */
@Injectable()
export class PresencePublicService {
  constructor(private readonly presence: PresenceService) {}

  /** The user's effective presence (manual pin > leave > punch > activity). */
  async statusOf(tenantId: string, userId: string): Promise<PresenceStatus | null> {
    const [resolved] = await this.presence.resolve(tenantId, [userId], new Map());
    return resolved?.status ?? null;
  }
}
