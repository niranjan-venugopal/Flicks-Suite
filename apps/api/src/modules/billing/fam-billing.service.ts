import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { and, count, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import {
  couponCodes,
  couponRedemptions,
  subscriptions,
  tenants,
  users,
} from '@flicks/db/schema';
import type { DbAdmin } from '@flicks/db';
import { DB_SERVICE_ROLE } from '../../core/database/database.module';
import { AuditService } from '../audit/audit.service';

const SPECFLICKS_TENANT_ID = '00000000-0000-0000-0000-000000000001';
// Unambiguous LETTERS-ONLY alphabet for random suffixes (no O/I/L). Digits
// are excluded so a random suffix can never be all-numeric and pollute the
// sequential-mode MAX(PREFIX-nnn) continuation scan.
const SUFFIX_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const MAX_BATCH = 500;

export interface BatchCreateInput {
  prefix: string;
  mode: 'random' | 'sequential';
  count: number;
  months: number;
  campaign: string;
  max_redemptions?: number;
  expires_at?: string | null;
}

/**
 * FAM coupon administration + platform billing overview (PRD v4 §8B.3 / D21,
 * D22 — Sprint 22). Service-role only; every route is @Roles('fam') and every
 * mutation is platform-audited. Coupon REDEMPTION lives in BillingService —
 * this is the mint/inspect/deactivate side.
 */
@Injectable()
export class FamBillingService {
  constructor(
    @Inject(DB_SERVICE_ROLE) private readonly dbAdmin: DbAdmin,
    private readonly audit: AuditService,
  ) {}

  // ─── D21 · batch mint ───────────────────────────────────────────────────────

  async batchCreate(actorUserId: string, input: BatchCreateInput) {
    const prefix = input.prefix
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9-]/g, '');
    if (!prefix) throw new BadRequestException('Prefix is required (A–Z, 0–9, dashes)');
    if (input.count < 1 || input.count > MAX_BATCH) {
      throw new BadRequestException(`Count must be 1–${MAX_BATCH}`);
    }
    const expiresAt = input.expires_at ? new Date(input.expires_at) : null;
    if (expiresAt && expiresAt.getTime() < Date.now()) {
      throw new BadRequestException('Expiry is in the past');
    }

    // The whole mint runs in one transaction holding a per-prefix advisory
    // lock: two concurrent sequential batches would otherwise read the same
    // MAX and silently drop the loser's rows via onConflictDoNothing.
    const inserted = await this.dbAdmin.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`coupon:${prefix}`}))`);

      // Sequential: PREFIX-001..NNN continues AFTER any existing numbered
      // codes with the same prefix (re-running never collides or renumbers).
      let startAt = 1;
      if (input.mode === 'sequential') {
        const [row] = await tx
          .select({
            max: sql<number>`COALESCE(MAX(NULLIF(regexp_replace(${couponCodes.code}, ${`^${prefix}-`}, ''), '')::int), 0)`,
          })
          .from(couponCodes)
          .where(sql`${couponCodes.code} ~ ${`^${prefix}-[0-9]+$`}`);
        startAt = Number(row?.max ?? 0) + 1;
      }

      const values: Array<typeof couponCodes.$inferInsert> = [];
      const seen = new Set<string>();
      for (let i = 0; i < input.count; i++) {
        let code: string;
        if (input.mode === 'sequential') {
          code = `${prefix}-${String(startAt + i).padStart(3, '0')}`;
        } else {
          do {
            code = `${prefix}-${this.randomSuffix(5)}`;
          } while (seen.has(code));
        }
        seen.add(code);
        values.push({
          code,
          campaign: input.campaign.trim() || 'general',
          months: input.months,
          max_redemptions: input.max_redemptions ?? 1,
          expires_at: expiresAt,
          active: true,
          created_by: actorUserId,
        });
      }

      // Random suffixes can (rarely) collide with EXISTING rows — skip those
      // and report what was actually minted rather than failing the batch.
      return tx
        .insert(couponCodes)
        .values(values)
        .onConflictDoNothing({ target: couponCodes.code })
        .returning({ code: couponCodes.code });
    });

    await this.audit.logPlatform({
      actorUserId,
      action: 'fam.coupons_minted',
      metadata: {
        prefix,
        mode: input.mode,
        campaign: input.campaign,
        months: input.months,
        requested: input.count,
        minted: inserted.length,
      },
    });
    return {
      data: {
        minted: inserted.length,
        requested: input.count,
        codes: inserted.map((r) => r.code),
      },
    };
  }

  private randomSuffix(len: number): string {
    const bytes = crypto.randomBytes(len);
    let out = '';
    for (let i = 0; i < len; i++) out += SUFFIX_ALPHABET[bytes[i]! % SUFFIX_ALPHABET.length];
    return out;
  }

  // ─── D21 · list / export / deactivate / redemptions ────────────────────────

  async list(filters: { campaign?: string; active?: string }) {
    const conds = [];
    if (filters.campaign) conds.push(eq(couponCodes.campaign, filters.campaign));
    if (filters.active === 'true') conds.push(eq(couponCodes.active, true));
    if (filters.active === 'false') conds.push(eq(couponCodes.active, false));
    const rows = await this.dbAdmin
      .select()
      .from(couponCodes)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(couponCodes.created_at))
      .limit(1000);
    const campaigns = await this.dbAdmin
      .select({ campaign: couponCodes.campaign, n: count() })
      .from(couponCodes)
      .groupBy(couponCodes.campaign);
    return { data: rows, meta: { campaigns } };
  }

  /** CSV of codes for a campaign (or everything) — D21 "CSV download". */
  async exportCsv(campaign?: string): Promise<string> {
    const rows = await this.dbAdmin
      .select()
      .from(couponCodes)
      .where(campaign ? eq(couponCodes.campaign, campaign) : undefined)
      .orderBy(couponCodes.code);
    // Quote-escape AND neutralize formula triggers (=+-@, tab, CR) — Excel
    // executes formulas in CSV cells, and campaign is free text (CWE-1236).
    const esc = (v: unknown) => {
      let str = String(v ?? '').replace(/"/g, '""');
      if (/^[=+\-@\t\r]/.test(str)) str = `'${str}`;
      return `"${str}"`;
    };
    const header = 'code,campaign,months,max_redemptions,redemption_count,expires_at,active';
    const lines = rows.map((r) =>
      [
        esc(r.code),
        esc(r.campaign),
        r.months,
        r.max_redemptions,
        r.redemption_count,
        esc(r.expires_at ? new Date(r.expires_at).toISOString().slice(0, 10) : ''),
        r.active,
      ].join(','),
    );
    return [header, ...lines].join('\n') + '\n';
  }

  async update(actorUserId: string, id: string, dto: { active?: boolean }) {
    if (dto.active === undefined) throw new BadRequestException('Nothing to update');
    const [existing] = await this.dbAdmin
      .select()
      .from(couponCodes)
      .where(eq(couponCodes.id, id))
      .limit(1);
    if (!existing) throw new NotFoundException('Coupon not found');
    const [updated] = await this.dbAdmin
      .update(couponCodes)
      .set({ active: dto.active })
      .where(eq(couponCodes.id, id))
      .returning();
    await this.audit.logPlatform({
      actorUserId,
      action: dto.active ? 'fam.coupon_reactivated' : 'fam.coupon_deactivated',
      metadata: { coupon_id: id, code: existing.code },
    });
    return { data: updated };
  }

  async redemptions(id: string) {
    const [coupon] = await this.dbAdmin
      .select()
      .from(couponCodes)
      .where(eq(couponCodes.id, id))
      .limit(1);
    if (!coupon) throw new NotFoundException('Coupon not found');
    const rows = await this.dbAdmin
      .select({
        id: couponRedemptions.id,
        tenant_id: couponRedemptions.tenant_id,
        tenant_name: tenants.name,
        tenant_slug: tenants.slug,
        redeemed_by_name: users.full_name,
        months: couponRedemptions.months,
        redeemed_at: couponRedemptions.redeemed_at,
      })
      .from(couponRedemptions)
      .innerJoin(tenants, eq(tenants.id, couponRedemptions.tenant_id))
      .leftJoin(users, eq(users.id, couponRedemptions.redeemed_by))
      .where(eq(couponRedemptions.coupon_id, id))
      .orderBy(desc(couponRedemptions.redeemed_at));
    return { data: rows, meta: { code: coupon.code, campaign: coupon.campaign } };
  }

  // ─── D22 · billing overview (revenue tiles) ─────────────────────────────────

  async overview() {
    const [tiles] = await this.dbAdmin
      .select({
        mrr: sql<number>`COALESCE(SUM(${subscriptions.mrr_amount}) FILTER (WHERE ${subscriptions.status} = 'active'), 0)::real`,
        active: sql<number>`COUNT(*) FILTER (WHERE ${subscriptions.status} = 'active')::int`,
        trialing: sql<number>`COUNT(*) FILTER (WHERE ${subscriptions.status} = 'trialing')::int`,
        past_due: sql<number>`COUNT(*) FILTER (WHERE ${subscriptions.status} = 'past_due')::int`,
        total: sql<number>`COUNT(*)::int`,
      })
      .from(subscriptions)
      .where(ne(subscriptions.tenant_id, SPECFLICKS_TENANT_ID));
    const [redeemed] = await this.dbAdmin
      .select({ n: count() })
      .from(couponRedemptions)
      .where(
        inArray(
          couponRedemptions.tenant_id,
          this.dbAdmin
            .select({ id: tenants.id })
            .from(tenants)
            .where(ne(tenants.id, SPECFLICKS_TENANT_ID)),
        ),
      );
    // Trial→paid measures DECIDED trials only: mid-trial workspaces are
    // neither converted nor failed yet, and a past_due/canceled customer DID
    // convert — counting them as failures made launch-day read near zero.
    const [conv] = await this.dbAdmin
      .select({
        converted: sql<number>`COUNT(*) FILTER (WHERE ${subscriptions.status} IN ('active','past_due','unpaid') OR (${subscriptions.status} = 'canceled' AND ${subscriptions.razorpay_subscription_id} IS NOT NULL))::int`,
        failed: sql<number>`COUNT(*) FILTER (WHERE ${subscriptions.status} = 'trialing' AND ${subscriptions.trial_ends_at} < now())::int`,
      })
      .from(subscriptions)
      .where(ne(subscriptions.tenant_id, SPECFLICKS_TENANT_ID));
    const converted = Number(conv?.converted ?? 0);
    const decided = converted + Number(conv?.failed ?? 0);
    return {
      data: {
        platform_mrr: Number(tiles?.mrr ?? 0),
        active_subscriptions: Number(tiles?.active ?? 0),
        trialing: Number(tiles?.trialing ?? 0),
        past_due: Number(tiles?.past_due ?? 0),
        trial_to_paid_pct: decided > 0 ? Math.round((converted / decided) * 100) : 0,
        coupons_redeemed: Number(redeemed?.n ?? 0),
      },
    };
  }
}
