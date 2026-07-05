import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { consentRecords, users } from '@flicks/db/schema';
import type { DbAdmin } from '@flicks/db';
import { DB_SERVICE_ROLE } from '../../core/database/database.module';
import {
  TERMS_VERSION,
  PRIVACY_VERSION,
  CONSENT_VERSION,
  CONSENT_TYPES,
  type ConsentType,
} from '@flicks/shared/constants';

export interface ConsentInput {
  type: ConsentType;
  granted: boolean;
}

export interface ConsentContext {
  tenantId?: string | null;
  source: 'signup' | 'banner' | 'settings' | 'unsubscribe' | 'import';
  regionCode?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Consent ledger (PRD v4 §3). Append-only: every decision is a new row;
 * current state = the latest row per (user, type). Writes/reads run on the
 * service-role connection keyed strictly to the caller's user id (the
 * self-visibility RLS policy remains defence-in-depth for the app role) —
 * signup consents happen before any tenant context exists.
 */
@Injectable()
export class ConsentService {
  private readonly logger = new Logger(ConsentService.name);

  constructor(
    @Inject(DB_SERVICE_ROLE) private readonly dbAdmin: DbAdmin,
    private readonly config: ConfigService,
  ) {}

  /** SHA-256(ip + server salt) — never the raw IP (§3.2). */
  ipHash(ip?: string | null): string | null {
    if (!ip) return null;
    const salt = this.config.get<string>('JWT_SECRET') ?? 'flicks-consent';
    return createHash('sha256').update(`${ip}${salt}`).digest('hex');
  }

  private versionFor(type: ConsentType): string {
    return type === 'terms_privacy' ? TERMS_VERSION : CONSENT_VERSION;
  }

  /** Append ledger rows for the given decisions. */
  async record(
    userId: string,
    consents: ConsentInput[],
    ctx: ConsentContext,
  ): Promise<void> {
    const valid = consents.filter((c) => CONSENT_TYPES.includes(c.type));
    if (!valid.length) return;
    await this.dbAdmin.insert(consentRecords).values(
      valid.map((c) => ({
        user_id: userId,
        tenant_id: ctx.tenantId ?? null,
        consent_type: c.type,
        granted: c.granted,
        policy_version: this.versionFor(c.type),
        source: ctx.source,
        region_code: ctx.regionCode?.slice(0, 2).toUpperCase() ?? null,
        ip_hash: this.ipHash(ctx.ip),
        user_agent: ctx.userAgent?.slice(0, 500) ?? null,
      })),
    );
  }

  /** Latest row per consent type for a user. */
  async latest(
    userId: string,
  ): Promise<
    Partial<
      Record<
        ConsentType,
        { granted: boolean; policy_version: string; occurred_at: Date }
      >
    >
  > {
    const rows = await this.dbAdmin
      .select({
        consent_type: consentRecords.consent_type,
        granted: consentRecords.granted,
        policy_version: consentRecords.policy_version,
        occurred_at: consentRecords.occurred_at,
      })
      .from(consentRecords)
      .where(
        and(
          eq(consentRecords.user_id, userId),
          inArray(consentRecords.consent_type, CONSENT_TYPES),
        ),
      )
      .orderBy(desc(consentRecords.occurred_at));
    const out: Partial<
      Record<
        ConsentType,
        { granted: boolean; policy_version: string; occurred_at: Date }
      >
    > = {};
    for (const r of rows) {
      const t = r.consent_type as ConsentType;
      if (!(t in out)) {
        out[t] = {
          granted: r.granted,
          policy_version: r.policy_version,
          occurred_at: r.occurred_at,
        };
      }
    }
    return out;
  }

  /** Latest analytics consent — the gate for client behavioral capture (§6). */
  async analyticsGranted(userId: string): Promise<boolean> {
    const latest = await this.latest(userId);
    return latest.analytics?.granted === true;
  }

  /**
   * Policy-bump re-acceptance (§3.2): true when the user's latest
   * terms_privacy acceptance predates the current TERMS_VERSION (or none
   * exists — e.g. users created before the ledger / invited via magic link).
   */
  async requiresReacceptance(userId: string): Promise<boolean> {
    const latest = await this.latest(userId);
    const tp = latest.terms_privacy;
    return !tp || !tp.granted || tp.policy_version !== TERMS_VERSION;
  }

  /**
   * First-authenticated-session banner sync (§3.3): ledger the pre-login
   * cookie choice — or the region default when the visitor never touched the
   * banner (US/rest default = granted). Writes ONLY when the state differs
   * from the latest ledger row, so repeat logins add nothing.
   */
  async syncBannerChoice(
    userId: string,
    analytics: boolean,
    ctx: Omit<ConsentContext, 'source'>,
  ): Promise<{ written: boolean }> {
    const latest = await this.latest(userId);
    const current = latest.analytics;
    if (current && current.granted === analytics) return { written: false };
    await this.record(userId, [{ type: 'analytics', granted: analytics }], {
      ...ctx,
      source: 'banner',
    });
    return { written: true };
  }

  // ─── One-click unsubscribe (§3.1 marketing) ────────────────────────────────

  /** HMAC token binding userId + expiry; survives signed-out clicks. */
  mintUnsubscribeToken(userId: string, ttlDays = 90): string {
    const exp = Date.now() + ttlDays * 24 * 60 * 60 * 1000;
    const payload = `${userId}.${exp}`;
    const sig = createHmac(
      'sha256',
      this.config.get<string>('JWT_SECRET') ?? 'flicks-unsub',
    )
      .update(payload)
      .digest('base64url');
    return Buffer.from(`${payload}.${sig}`).toString('base64url');
  }

  verifyUnsubscribeToken(token: string): string {
    let decoded: string;
    try {
      decoded = Buffer.from(token, 'base64url').toString('utf8');
    } catch {
      throw new BadRequestException('Invalid unsubscribe link');
    }
    const [userId, expStr, sig] = decoded.split('.');
    if (!userId || !expStr || !sig) {
      throw new BadRequestException('Invalid unsubscribe link');
    }
    const expected = createHmac(
      'sha256',
      this.config.get<string>('JWT_SECRET') ?? 'flicks-unsub',
    )
      .update(`${userId}.${expStr}`)
      .digest('base64url');
    if (
      expected.length !== sig.length ||
      !timingSafeEqual(Buffer.from(expected), Buffer.from(sig))
    ) {
      throw new BadRequestException('Invalid unsubscribe link');
    }
    if (Number(expStr) < Date.now()) {
      throw new BadRequestException('This unsubscribe link has expired');
    }
    return userId;
  }

  /** Signed-out one-click unsubscribe → withdrawal row. */
  async unsubscribe(token: string, ip?: string, userAgent?: string) {
    const userId = this.verifyUnsubscribeToken(token);
    const [user] = await this.dbAdmin
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user) throw new BadRequestException('Invalid unsubscribe link');
    await this.record(
      userId,
      [{ type: 'marketing_email', granted: false }],
      { source: 'unsubscribe', ip, userAgent },
    );
    this.logger.log(`Marketing unsubscribe recorded for user ${userId}`);
    return { email: user.email };
  }

  /** Marketing sends allowed only where the latest row grants it (§3.1). */
  async marketingAllowed(userId: string): Promise<boolean> {
    const latest = await this.latest(userId);
    return latest.marketing_email?.granted === true;
  }

  meta() {
    return {
      terms_version: TERMS_VERSION,
      privacy_version: PRIVACY_VERSION,
      consent_version: CONSENT_VERSION,
    };
  }
}
