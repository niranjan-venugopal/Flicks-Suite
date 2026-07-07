import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Razorpay OAuth token-exchange response (subset we persist). */
export interface RazorpayTokenResponse {
  access_token: string;
  refresh_token: string;
  public_token?: string;
  razorpay_account_id?: string;
  expires_in: number; // seconds
  token_type?: string;
}

export interface RazorpayOrder {
  id: string;
  amount: number; // paise
  currency: string;
  status: string;
}

const AUTH_BASE = 'https://auth.razorpay.com';
const API_BASE = 'https://api.razorpay.com';

/**
 * Razorpay OAuth + Orders client (Sprint 15). Talks to Razorpay's REST API with
 * native fetch (no SDK dependency — mirrors the lightweight Resend/PDF service
 * idiom). Reads partner credentials from config and degrades to a clear error
 * when unconfigured, so local/CI run without live keys.
 *
 * Token encryption/persistence is the caller's job (InvSettingsService); this
 * service only speaks the protocol.
 */
@Injectable()
export class RazorpayService {
  private readonly logger = new Logger(RazorpayService.name);
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string;

  constructor(private readonly config: ConfigService) {
    this.clientId = this.config.get<string>('RAZORPAY_OAUTH_CLIENT_ID') ?? '';
    this.clientSecret =
      this.config.get<string>('RAZORPAY_OAUTH_CLIENT_SECRET') ?? '';
    const apiUrl = this.config.get<string>('API_URL') ?? 'http://localhost:4000';
    this.redirectUri =
      this.config.get<string>('RAZORPAY_OAUTH_REDIRECT_URI') ??
      `${apiUrl}/api/v1/invoicing/razorpay/callback`;
  }

  /** Whether the partner app is provisioned (client id + secret present). */
  isConfigured(): boolean {
    return !!this.clientId && !!this.clientSecret;
  }

  private assertConfigured() {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException(
        'Razorpay is not configured on this server (RAZORPAY_OAUTH_CLIENT_ID/SECRET missing).',
      );
    }
  }

  /** Authorize URL the seller is redirected to (read_write scope). */
  buildAuthorizeUrl(state: string): string {
    this.assertConfigured();
    const params = new URLSearchParams({
      client_id: this.clientId,
      response_type: 'code',
      redirect_uri: this.redirectUri,
      scope: 'read_write',
      state,
    });
    return `${AUTH_BASE}/authorize?${params.toString()}`;
  }

  /** Exchange the authorization code for access/refresh tokens. */
  async exchangeCode(code: string): Promise<RazorpayTokenResponse> {
    this.assertConfigured();
    return this.tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri,
    });
  }

  /** Mint a new access token from a refresh token. */
  async refresh(refreshToken: string): Promise<RazorpayTokenResponse> {
    this.assertConfigured();
    return this.tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
  }

  /** Revoke a token on disconnect (best-effort; logs but never throws). */
  async revoke(token: string): Promise<void> {
    if (!this.isConfigured() || !token) return;
    try {
      await this.postJson(`${AUTH_BASE}/token/revoke`, {
        client_id: this.clientId,
        client_secret: this.clientSecret,
        token_type_hint: 'access_token',
        token,
      });
    } catch (err) {
      this.logger.warn(
        `Razorpay token revoke failed (continuing): ${
          err instanceof Error ? err.message : 'unknown'
        }`,
      );
    }
  }

  /** Create an order on the connected sub-merchant account (Bearer auth). */
  async createOrder(input: {
    accessToken: string;
    amountPaise: number;
    currency: string;
    receipt: string;
    notes: Record<string, string>;
  }): Promise<RazorpayOrder> {
    this.assertConfigured();
    const res = await fetch(`${API_BASE}/v1/orders`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: input.amountPaise,
        currency: input.currency,
        receipt: input.receipt,
        notes: input.notes,
        payment_capture: 1,
      }),
    });
    return this.parse<RazorpayOrder>(res, 'create order');
  }

  // ─── Auto-debit mandates (PRD v4 §8A, Sprint 23) — sub-merchant Bearer ─────

  /** Razorpay customer on the SELLER's connected account. */
  async createCustomer(input: {
    accessToken: string;
    name: string;
    email?: string | null;
    tenantId: string;
    customerId: string;
  }): Promise<{ id: string }> {
    this.assertConfigured();
    const res = await fetch(`${API_BASE}/v1/customers`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: input.name.slice(0, 100),
        ...(input.email ? { email: input.email } : {}),
        fail_existing: '0',
        notes: { tenant_id: input.tenantId, customer_id: input.customerId },
      }),
    });
    return this.parse<{ id: string }>(res, 'create customer');
  }

  /** Per-subscription plan (fixed cycle amount; INR only for e-mandates). */
  async createPlan(input: {
    accessToken: string;
    name: string;
    amountPaise: number;
    period: 'monthly' | 'quarterly' | 'yearly';
  }): Promise<{ id: string }> {
    this.assertConfigured();
    const res = await fetch(`${API_BASE}/v1/plans`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        period: input.period,
        interval: 1,
        item: {
          name: input.name.slice(0, 120),
          amount: input.amountPaise,
          currency: 'INR',
        },
      }),
    });
    return this.parse<{ id: string }>(res, 'create plan');
  }

  /**
   * The subscription whose hosted short_url the customer authorizes.
   * customer_notify: 0 — OUR emails handle comms (D15), not Razorpay's.
   */
  async createSubscription(input: {
    accessToken: string;
    planId: string;
    customerId: string;
    totalCount: number;
    startAt?: Date | null;
    notes: Record<string, string>;
  }): Promise<{ id: string; status: string; short_url?: string }> {
    this.assertConfigured();
    const res = await fetch(`${API_BASE}/v1/subscriptions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        plan_id: input.planId,
        customer_id: input.customerId,
        total_count: Math.max(1, Math.min(input.totalCount, 100)),
        customer_notify: 0,
        ...(input.startAt
          ? { start_at: Math.floor(input.startAt.getTime() / 1000) }
          : {}),
        notes: input.notes,
      }),
    });
    return this.parse<{ id: string; status: string; short_url?: string }>(
      res,
      'create subscription',
    );
  }

  /** Cancel a mandate/subscription on the sub-merchant (best-effort callers). */
  async cancelSubscription(
    accessToken: string,
    subscriptionId: string,
    atCycleEnd = false,
  ): Promise<{ id: string; status: string }> {
    this.assertConfigured();
    const res = await fetch(
      `${API_BASE}/v1/subscriptions/${subscriptionId}/cancel`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ cancel_at_cycle_end: atCycleEnd ? 1 : 0 }),
      },
    );
    return this.parse<{ id: string; status: string }>(res, 'cancel subscription');
  }

  // ─── internals ──────────────────────────────────────────────────────────────

  private async tokenRequest(
    extra: Record<string, string>,
  ): Promise<RazorpayTokenResponse> {
    const res = await this.postJson(`${API_BASE}/v1/oauth/token`, {
      client_id: this.clientId,
      client_secret: this.clientSecret,
      ...extra,
    });
    return res as RazorpayTokenResponse;
  }

  private async postJson(
    url: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return this.parse(res, url);
  }

  private async parse<T>(res: Response, context: string): Promise<T> {
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }
    if (!res.ok) {
      const message =
        (json as { error?: { description?: string } })?.error?.description ??
        `Razorpay ${context} failed (${res.status})`;
      this.logger.error(`Razorpay ${context} → ${res.status}: ${message}`);
      throw new BadRequestException(`Razorpay: ${message}`);
    }
    return json as T;
  }
}
