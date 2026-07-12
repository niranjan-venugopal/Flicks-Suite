import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, desc, eq, lte } from 'drizzle-orm';
import { fxRates } from '@flicks/db/schema';
import type { DbAdmin } from '@flicks/db';
import { DB_SERVICE_ROLE } from '../../core/database/database.module';

/**
 * FX rates (PRD v5 §12.1). Real openexchangerates daily fetch (USD base, free
 * tier covers all symbols) stored in fx_rates; the app computes any cross-rate
 * A→B = rate(USD→B) / rate(USD→A). Deals snapshot fx_rate_to_base at value-set
 * time so historical reporting is stable. Falls back to 1.0 (and logs) when a
 * symbol/date is missing, never blocking a deal save.
 */
@Injectable()
export class FxService {
  private readonly logger = new Logger(FxService.name);
  /** in-process cache: `${quote}` → { rate, as_of } (latest USD→quote). */
  private readonly cache = new Map<string, { rate: number; asOf: string }>();

  constructor(
    @Inject(DB_SERVICE_ROLE) private readonly dbAdmin: DbAdmin,
    private readonly config: ConfigService,
  ) {}

  private async latestUsdRate(quote: string): Promise<number | null> {
    const q = quote.toUpperCase();
    if (q === 'USD') return 1;
    const cached = this.cache.get(q);
    if (cached) return cached.rate;
    const [row] = await this.dbAdmin
      .select({ rate: fxRates.rate, as_of: fxRates.as_of })
      .from(fxRates)
      .where(and(eq(fxRates.base, 'USD'), eq(fxRates.quote, q)))
      .orderBy(desc(fxRates.as_of))
      .limit(1);
    if (!row) return null;
    const rate = parseFloat(row.rate);
    this.cache.set(q, { rate, asOf: row.as_of });
    return rate;
  }

  /**
   * Rate to convert `from` → `to` (1 unit of `from` = <rate> units of `to`).
   * Returns 1 with a warning if either symbol is unknown (deal save proceeds).
   */
  async rate(from: string, to: string): Promise<number> {
    const f = from.toUpperCase();
    const t = to.toUpperCase();
    if (f === t) return 1;
    const [rf, rt] = await Promise.all([this.latestUsdRate(f), this.latestUsdRate(t)]);
    if (rf == null || rt == null || rf === 0) {
      this.logger.warn(`FX rate unavailable for ${f}->${t}; defaulting to 1.0`);
      return 1;
    }
    // USD→t divided by USD→f gives f→t.
    return rt / rf;
  }

  /**
   * Snapshot a deal's value into the tenant base currency.
   * Returns { fxRate, baseAmount } — baseAmount rounded to 2dp.
   *
   * Financial-correctness rule: when the deal currency differs from the base and
   * no rate is available, we REJECT rather than silently snapshot at 1.0 — a
   * bogus 1:1 rate mis-values the pipeline/forecast in ways nobody notices. The
   * caller enters the value in the base currency, or an admin refreshes FX.
   */
  async toBase(amount: number, currency: string, baseCurrency: string) {
    const from = currency.toUpperCase();
    const to = baseCurrency.toUpperCase();
    if (from === to) return { fxRate: 1, baseAmount: Math.round(amount * 100) / 100 };
    const [rf, rt] = await Promise.all([this.latestUsdRate(from), this.latestUsdRate(to)]);
    if (rf == null || rt == null || rf === 0) {
      throw new BadRequestException(
        `No exchange rate available for ${from}→${to}. Refresh FX rates or enter the value in ${to}.`,
      );
    }
    const fxRate = rt / rf; // USD→to ÷ USD→from = from→to
    return { fxRate, baseAmount: Math.round(amount * fxRate * 100) / 100 };
  }

  /** Fetch + upsert today's USD-based rates (worker job). No-op without a key. */
  async refresh(): Promise<number> {
    const appId = this.config.get<string>('OPENEXCHANGERATES_APP_ID');
    if (!appId) {
      this.logger.debug('FX refresh skipped — OPENEXCHANGERATES_APP_ID unset');
      return 0;
    }
    let payload: { rates?: Record<string, number>; timestamp?: number };
    try {
      const res = await fetch(`https://openexchangerates.org/api/latest.json?app_id=${appId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      payload = (await res.json()) as typeof payload;
    } catch (err) {
      this.logger.error(`FX fetch failed: ${err instanceof Error ? err.message : err}`);
      return 0;
    }
    const rates = payload.rates ?? {};
    const asOf = new Date((payload.timestamp ?? Date.now() / 1000) * 1000)
      .toISOString()
      .slice(0, 10);
    const values = Object.entries(rates).map(([quote, rate]) => ({
      base: 'USD',
      quote,
      rate: String(rate),
      as_of: asOf,
    }));
    if (values.length === 0) return 0;
    // Upsert per (base, quote, as_of).
    for (let i = 0; i < values.length; i += 500) {
      await this.dbAdmin
        .insert(fxRates)
        .values(values.slice(i, i + 500))
        .onConflictDoUpdate({
          target: [fxRates.base, fxRates.quote, fxRates.as_of],
          set: { rate: fxRates.rate, fetched_at: new Date() },
        });
    }
    this.cache.clear();
    this.logger.log(`FX refresh: ${values.length} rates as of ${asOf}`);
    return values.length;
  }
}
