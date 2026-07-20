import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { eq } from 'drizzle-orm';
import { featureFlags } from '@flicks/db/schema';
import type { DbAdmin } from '@flicks/db';
import { DB_SERVICE_ROLE } from '../database/database.module';

/**
 * Runtime evaluator for the FAM `feature_flags` table (PRD v6 kill-switch,
 * locked decision #2). The FAM console has managed flag rows since v4; this
 * is the first request-time reader. Evaluation:
 *   enabled = is_enabled_globally
 *          || tenant ∈ enabled_tenant_ids
 *          || hash(flag:tenant) % 100 < rollout_percentage
 * An ABSENT row falls back to FLAG_DEFAULTS (pm_sync_engine defaults ON — the
 * flag exists to turn the engine OFF; flipping it in FAM is a zero-deploy
 * kill-switch). Results cached 30s so /me and the sync endpoints stay cheap.
 */
const FLAG_DEFAULTS: Record<string, boolean> = {
  pm_sync_engine: true,
};

const CACHE_TTL_MS = 30_000;

interface FlagRow {
  is_enabled_globally: boolean;
  enabled_tenant_ids: string[] | null;
  rollout_percentage: number | null;
}

@Injectable()
export class FlagEvalService {
  private readonly logger = new Logger(FlagEvalService.name);
  private cache = new Map<string, { row: FlagRow | null; at: number }>();

  constructor(@Inject(DB_SERVICE_ROLE) private readonly dbAdmin: DbAdmin) {}

  private async loadFlag(flagKey: string): Promise<FlagRow | null> {
    const hit = this.cache.get(flagKey);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.row;
    try {
      const [row] = await this.dbAdmin
        .select({
          is_enabled_globally: featureFlags.is_enabled_globally,
          enabled_tenant_ids: featureFlags.enabled_tenant_ids,
          rollout_percentage: featureFlags.rollout_percentage,
        })
        .from(featureFlags)
        .where(eq(featureFlags.flag_key, flagKey))
        .limit(1);
      this.cache.set(flagKey, { row: row ?? null, at: Date.now() });
      return row ?? null;
    } catch (err) {
      this.logger.warn(`flag load failed for ${flagKey}: ${err instanceof Error ? err.message : err}`);
      return null; // fail to defaults, never to a crash
    }
  }

  async isEnabled(flagKey: string, tenantId: string): Promise<boolean> {
    const row = await this.loadFlag(flagKey);
    if (!row) return FLAG_DEFAULTS[flagKey] ?? false;
    if (row.is_enabled_globally) return true;
    if (row.enabled_tenant_ids?.includes(tenantId)) return true;
    const pct = row.rollout_percentage ?? 0;
    if (pct > 0) {
      const h = createHash('sha256').update(`${flagKey}:${tenantId}`).digest();
      return h[0]! % 100 < pct;
    }
    return false;
  }

  /** Effective flags for /me — only keys the client cares about. */
  async effectiveFlags(tenantId: string): Promise<string[]> {
    const keys = Object.keys(FLAG_DEFAULTS);
    const out: string[] = [];
    for (const k of keys) {
      if (await this.isEnabled(k, tenantId)) out.push(k);
    }
    return out;
  }
}
