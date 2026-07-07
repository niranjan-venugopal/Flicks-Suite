import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PLATFORM_PLAN } from '@flicks/shared/constants';

const API_BASE = 'https://api.razorpay.com';

export interface RzpCustomer {
  id: string;
}
export interface RzpPlan {
  id: string;
}
export interface RzpSubscription {
  id: string;
  status: string;
  short_url?: string;
  current_start?: number; // unix seconds
  current_end?: number;
  quantity?: number;
}

/**
 * Razorpay client for SPECFLICKS' OWN merchant account (PRD v4 §8B) — the
 * platform charges tenants for Flicks Suite seats. Distinct from the
 * partner-OAuth RazorpayService (tenant-track, sellers' own accounts): this
 * one uses plain Basic auth with RAZORPAY_PLATFORM_KEY_ID/SECRET (sandbox
 * keys first). Degrades to a clean 503 when unconfigured, so local/CI and
 * the pre-approval beta run without live keys.
 */
@Injectable()
export class RazorpayPlatformService {
  private readonly logger = new Logger(RazorpayPlatformService.name);
  private readonly keyId: string;
  private readonly keySecret: string;

  constructor(private readonly config: ConfigService) {
    this.keyId = this.config.get<string>('RAZORPAY_PLATFORM_KEY_ID') ?? '';
    this.keySecret = this.config.get<string>('RAZORPAY_PLATFORM_KEY_SECRET') ?? '';
  }

  isConfigured(): boolean {
    return !!this.keyId && !!this.keySecret;
  }

  assertConfigured(): void {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException(
        'Platform billing is not configured on this server (RAZORPAY_PLATFORM_KEY_ID/SECRET missing).',
      );
    }
  }

  async createCustomer(input: { name: string; email: string; tenantId: string }): Promise<RzpCustomer> {
    return this.post<RzpCustomer>('/v1/customers', {
      name: input.name.slice(0, 100),
      email: input.email,
      fail_existing: '0',
      notes: { tenant_id: input.tenantId },
    });
  }

  /** One monthly per-seat plan (quantity carries the seat count). */
  async createPlan(): Promise<RzpPlan> {
    return this.post<RzpPlan>('/v1/plans', {
      period: 'monthly',
      interval: 1,
      item: {
        name: `Flicks Suite · ${PLATFORM_PLAN.code} (per seat)`,
        amount: PLATFORM_PLAN.pricePaise,
        currency: PLATFORM_PLAN.currency,
      },
    });
  }

  async createSubscription(input: {
    planId: string;
    customerId: string;
    quantity: number;
    tenantId: string;
    startAt?: Date | null;
  }): Promise<RzpSubscription> {
    return this.post<RzpSubscription>('/v1/subscriptions', {
      plan_id: input.planId,
      customer_id: input.customerId,
      quantity: Math.max(1, input.quantity),
      total_count: 60, // 5 years of monthly cycles; renewable long before that
      customer_notify: 0, // our own emails handle comms (D23)
      ...(input.startAt ? { start_at: Math.floor(input.startAt.getTime() / 1000) } : {}),
      notes: { tenant_id: input.tenantId, source: 'flicks-platform' },
    });
  }

  /** Seat-count change applies from the next cycle boundary (§8B open item 5). */
  async updateQuantity(subscriptionId: string, quantity: number): Promise<RzpSubscription> {
    return this.patch<RzpSubscription>(`/v1/subscriptions/${subscriptionId}`, {
      quantity: Math.max(1, quantity),
      schedule_change_at: 'cycle_end',
    });
  }

  async cancel(subscriptionId: string, atCycleEnd = true): Promise<RzpSubscription> {
    return this.post<RzpSubscription>(`/v1/subscriptions/${subscriptionId}/cancel`, {
      cancel_at_cycle_end: atCycleEnd ? 1 : 0,
    });
  }

  async fetchSubscription(subscriptionId: string): Promise<RzpSubscription> {
    return this.request<RzpSubscription>('GET', `/v1/subscriptions/${subscriptionId}`);
  }

  // ─── HTTP plumbing ──────────────────────────────────────────────────────────

  private post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  private patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    this.assertConfigured();
    const auth = Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64');
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = (await res.json().catch(() => ({}))) as T & {
      error?: { description?: string; code?: string };
    };
    if (!res.ok) {
      const desc = json?.error?.description ?? `Razorpay ${method} ${path} failed (${res.status})`;
      this.logger.warn(`Razorpay platform API error: ${desc}`);
      throw new BadRequestException(desc);
    }
    return json;
  }
}
