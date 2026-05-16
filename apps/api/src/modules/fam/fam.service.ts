import { Injectable, Logger, Inject } from '@nestjs/common';
import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import {
  tenants,
  subscriptions,
  tenantHealthSnapshots,
} from '@flicks/db/schema';
import { DB_SERVICE_ROLE } from '../../core/database/database.module';
import type { DbAdmin } from '@flicks/db';
import { AuditService } from '../audit/audit.service';
import type {
  SuspendTenantDto,
  ExtendTrialDto,
  StartImpersonationDto,
  UpsertFeatureFlagDto,
  UpsertCohortDto,
  TenantListQueryDto,
} from './fam.dto';

@Injectable()
export class FamService {
  private readonly logger = new Logger(FamService.name);

  constructor(
    @Inject(DB_SERVICE_ROLE) private readonly dbAdmin: DbAdmin,
    private readonly auditService: AuditService,
  ) {}

  // ─── Overview (platform-wide stats) ────────────────────────────────────────

  /**
   * Aggregated KPIs and breakdowns for the FAM Overview landing page.
   * Returns:
   *   - totals by tenant status + plan
   *   - signups in the last 7 days + per-day trend
   *   - MRR sum (active + trialing subscriptions)
   *   - tenant health signal distribution from the latest snapshot per tenant
   *   - recent signups (last 5 tenants)
   */
  async getPlatformOverview() {
    const now = new Date();
    const startOfDay = (d: Date) => {
      const x = new Date(d);
      x.setUTCHours(0, 0, 0, 0);
      return x;
    };
    const sevenDaysAgo = startOfDay(new Date(now.getTime() - 7 * 86_400_000));

    // 1. Tenants by status — single grouped aggregate.
    const statusRows = await this.dbAdmin
      .select({
        status: tenants.status,
        n: sql<number>`COUNT(*)::int`,
      })
      .from(tenants)
      .where(isNull(tenants.deleted_at))
      .groupBy(tenants.status);

    const tenantsByStatus = {
      trialing: 0,
      active: 0,
      past_due: 0,
      canceled: 0,
      suspended: 0,
    } as Record<string, number>;
    let totalTenants = 0;
    for (const r of statusRows) {
      tenantsByStatus[r.status] = Number(r.n);
      totalTenants += Number(r.n);
    }
    const activeTenants =
      (tenantsByStatus.active ?? 0) + (tenantsByStatus.trialing ?? 0);

    // 2. Tenants by plan — from subscriptions (one row per tenant).
    const planRows = await this.dbAdmin
      .select({
        plan: subscriptions.plan_code,
        n: sql<number>`COUNT(*)::int`,
      })
      .from(subscriptions)
      .groupBy(subscriptions.plan_code);
    const tenantsByPlan: Record<string, number> = {};
    for (const r of planRows) tenantsByPlan[r.plan] = Number(r.n);

    // 3. Signups (tenants.created_at) — total this week + per-day series.
    const signupsThisWeekRow = await this.dbAdmin
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(tenants)
      .where(
        and(isNull(tenants.deleted_at), gte(tenants.created_at, sevenDaysAgo)),
      );
    const signupsThisWeek = Number(signupsThisWeekRow[0]?.n ?? 0);

    const signupsTrendRaw = await this.dbAdmin
      .select({
        d: sql<string>`to_char(date_trunc('day', ${tenants.created_at}), 'YYYY-MM-DD')`,
        n: sql<number>`COUNT(*)::int`,
      })
      .from(tenants)
      .where(
        and(isNull(tenants.deleted_at), gte(tenants.created_at, sevenDaysAgo)),
      )
      .groupBy(sql`date_trunc('day', ${tenants.created_at})`);

    const trendMap = new Map(signupsTrendRaw.map((r) => [r.d, Number(r.n)]));
    const signupsTrend7d: Array<{ date: string; count: number }> = [];
    for (let i = 6; i >= 0; i--) {
      const day = new Date(now.getTime() - i * 86_400_000);
      const key = startOfDay(day).toISOString().slice(0, 10);
      signupsTrend7d.push({ date: key, count: trendMap.get(key) ?? 0 });
    }

    // 4. MRR — sum of mrr_amount over active + trialing subscriptions.
    const mrrRow = await this.dbAdmin
      .select({
        mrr: sql<number>`COALESCE(SUM(${subscriptions.mrr_amount}), 0)::real`,
      })
      .from(subscriptions)
      .where(
        sql`${subscriptions.status} IN ('active', 'trialing')`,
      );
    const mrrAmount = Number(mrrRow[0]?.mrr ?? 0);

    // 5. Latest health snapshot per tenant → bucket by signal.
    const healthRows = await this.dbAdmin.execute<{
      signal: string;
      n: number;
    }>(sql`
      SELECT signal, COUNT(*)::int AS n
      FROM (
        SELECT DISTINCT ON (tenant_id) tenant_id, signal
        FROM tenant_health_snapshots
        ORDER BY tenant_id, snapshot_date DESC
      ) AS latest
      GROUP BY signal
    `);
    const healthByCount = {
      healthy: 0,
      at_risk: 0,
      churning: 0,
      expanding: 0,
      new: 0,
    } as Record<string, number>;
    for (const r of (healthRows as unknown as Array<{ signal: string; n: number }>) ?? []) {
      healthByCount[r.signal] = Number(r.n);
    }

    // 6. Recent signups — last 5 tenants.
    const recentSignups = await this.dbAdmin
      .select({
        id: tenants.id,
        name: tenants.name,
        slug: tenants.slug,
        status: tenants.status,
        createdAt: tenants.created_at,
      })
      .from(tenants)
      .where(isNull(tenants.deleted_at))
      .orderBy(desc(tenants.created_at))
      .limit(5);

    return {
      totalTenants,
      activeTenants,
      tenantsByStatus,
      tenantsByPlan,
      signupsThisWeek,
      signupsTrend7d,
      mrr: { amount: mrrAmount, currency: 'INR' },
      health: healthByCount,
      recentSignups: recentSignups.map((r) => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  }

  // ─── Tenants ───────────────────────────────────────────────────────────────

  /**
   * Lists tenants across the platform (admin view).
   * TODO: select from tenants joined with subscriptions + latest health snapshot.
   */
  async listTenants(query: TenantListQueryDto) {
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, 100);

    return {
      data: [] as Array<{
        id: string;
        name: string;
        slug: string;
        status: string;
        plan: string;
        userCount: number;
        mrr: number;
        signal: string;
        trialEndsAt: string | null;
      }>,
      pagination: { page, limit, total: 0 },
    };
  }

  /**
   * Detailed tenant view including subscription, recent health snapshots, audit summary.
   * TODO: hydrate tenant + subscriptions + tenantHealthSnapshots (last N).
   */
  async getTenant(tenantId: string) {
    return {
      id: tenantId,
      name: '',
      slug: '',
      status: 'trialing' as const,
      subscription: null as null | { plan: string; mrr: number },
      health: null as null | { score: number; signal: string },
    };
  }

  /**
   * Suspends a tenant (status = suspended) with a reason.
   * TODO: update tenants.status, write platform audit, optionally revoke active sessions.
   */
  async suspendTenant(
    tenantId: string,
    actorUserId: string,
    dto: SuspendTenantDto,
  ) {
    await this.auditService.logPlatform({
      actorUserId,
      action: 'tenant.suspended',
      targetTenantId: tenantId,
      metadata: { reason: dto.reason },
    });

    return { id: tenantId, status: 'suspended' as const };
  }

  /**
   * Extends a tenant's trial by N days. Admin action.
   * TODO: update tenants.trial_ends_at and subscriptions.current_period_end.
   */
  async extendTrial(
    tenantId: string,
    actorUserId: string,
    dto: ExtendTrialDto,
  ) {
    const newTrialEndsAt = new Date(
      Date.now() + dto.days * 24 * 60 * 60 * 1000,
    );

    await this.auditService.logPlatform({
      actorUserId,
      action: 'tenant.trial.extended',
      targetTenantId: tenantId,
      metadata: { days: dto.days, reason: dto.reason },
    });

    return {
      id: tenantId,
      trialEndsAt: newTrialEndsAt.toISOString(),
      extendedByDays: dto.days,
    };
  }

  // ─── Impersonation ─────────────────────────────────────────────────────────

  /**
   * Starts an impersonation session for a target user; returns a short-lived JWT.
   * TODO: validate target, mint JWT with impersonatorUserId set, log platform audit.
   */
  async startImpersonation(
    actorUserId: string,
    dto: StartImpersonationDto,
  ) {
    await this.auditService.logPlatform({
      actorUserId,
      action: 'impersonation.started',
      targetUserId: dto.targetUserId,
      metadata: { reason: dto.reason },
    });

    return {
      impersonationToken: '',
      targetUserId: dto.targetUserId,
      expiresIn: 15 * 60,
    };
  }

  // ─── Feature flags ─────────────────────────────────────────────────────────

  /**
   * Lists all feature flags.
   * TODO: select from feature_flags ordered by flag_key.
   */
  async listFeatureFlags() {
    return {
      data: [] as Array<{
        id: string;
        flagKey: string;
        isEnabledGlobally: boolean;
        rolloutPercentage: number;
      }>,
      total: 0,
    };
  }

  /**
   * Upserts a feature flag (create-or-update by flag_key).
   * TODO: ON CONFLICT (flag_key) DO UPDATE.
   */
  async upsertFeatureFlag(
    actorUserId: string,
    dto: UpsertFeatureFlagDto,
  ) {
    await this.auditService.logPlatform({
      actorUserId,
      action: 'feature_flag.upserted',
      metadata: {
        flagKey: dto.flagKey,
        isEnabledGlobally: dto.isEnabledGlobally,
        rolloutPercentage: dto.rolloutPercentage,
      },
    });

    return {
      id: '',
      flagKey: dto.flagKey,
      isEnabledGlobally: dto.isEnabledGlobally ?? false,
      enabledTenantIds: dto.enabledTenantIds ?? [],
      rolloutPercentage: dto.rolloutPercentage ?? 0,
    };
  }

  // ─── Cohorts ───────────────────────────────────────────────────────────────

  /**
   * Lists tenant cohorts.
   * TODO: select tenant_cohorts with tenant counts.
   */
  async listCohorts() {
    return {
      data: [] as Array<{
        id: string;
        name: string;
        tenantCount: number;
      }>,
      total: 0,
    };
  }

  /**
   * Upserts a cohort (create-or-update by name).
   * TODO: ON CONFLICT (name) DO UPDATE.
   */
  async upsertCohort(actorUserId: string, dto: UpsertCohortDto) {
    await this.auditService.logPlatform({
      actorUserId,
      action: 'cohort.upserted',
      metadata: { name: dto.name, tenantCount: dto.tenantIds.length },
    });

    return {
      id: '',
      name: dto.name,
      tenantIds: dto.tenantIds,
    };
  }

  // ─── Health ────────────────────────────────────────────────────────────────

  /**
   * Returns the tenant health snapshot stream (last 30 days by default).
   * TODO: select tenant_health_snapshots ordered by snapshot_date desc.
   */
  async getTenantHealth(tenantId: string, days = 30) {
    return {
      tenantId,
      windowDays: days,
      snapshots: [] as Array<{
        snapshotDate: string;
        healthScore: number | null;
        signal: string;
        activeUsers7d: number;
        activeUsers30d: number;
      }>,
    };
  }
}
