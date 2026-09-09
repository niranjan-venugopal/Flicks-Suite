import { Injectable } from '@nestjs/common';
import type { MeetingProvider } from '@flicks/shared/constants';

/**
 * Round J — the door for auto-generated meeting links.
 *
 * Today the organizer pastes a Teams / Google Meet link (or leaves it empty —
 * "link pending"). Once a user connects their Microsoft 365 / Google account
 * (Round K: `user_connected_accounts` with self-visibility RLS, encrypted
 * tokens via AppCryptoService, OAuth callback routes), a provider registers
 * here and `generate()` returns a real link. The calendar service calls
 * `generate()` BEFORE opening its tenant transaction, so the future network
 * call never runs inside the tx (house rule 7).
 */
export interface MeetingLinkProvider {
  readonly provider: Exclude<MeetingProvider, 'none' | 'other'>;
  isConnected(tenantId: string, userId: string): Promise<boolean>;
  createLink(
    tenantId: string,
    userId: string,
    event: { title: string; startAt: Date; endAt: Date; timezone: string },
  ): Promise<{ url: string; externalId?: string }>;
}

@Injectable()
export class MeetingLinksService {
  private readonly providers: MeetingLinkProvider[] = [];

  /** Providers the user has connected (none this round). */
  async connected(tenantId: string, userId: string): Promise<MeetingProvider[]> {
    const out: MeetingProvider[] = [];
    for (const p of this.providers) {
      if (await p.isConnected(tenantId, userId)) out.push(p.provider);
    }
    return out;
  }

  /** A generated link, or null when the provider is not connected / unknown. */
  async generate(
    provider: MeetingProvider,
    tenantId: string,
    userId: string,
    event: { title: string; startAt: Date; endAt: Date; timezone: string },
  ): Promise<string | null> {
    const p = this.providers.find((x) => x.provider === provider);
    if (!p) return null;
    try {
      if (!(await p.isConnected(tenantId, userId))) return null;
      const { url } = await p.createLink(tenantId, userId, event);
      return url;
    } catch {
      return null;
    }
  }
}
