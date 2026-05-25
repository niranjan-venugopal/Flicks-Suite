import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PostHog } from 'posthog-node';

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

@Injectable()
export class AnalyticsService implements OnModuleDestroy {
  private readonly logger = new Logger(AnalyticsService.name);
  private readonly client: PostHog | null;

  constructor(private readonly config: ConfigService) {
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
