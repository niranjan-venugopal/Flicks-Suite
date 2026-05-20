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
   * Lists tenants across the platform (FAM view). Joins each tenant with
   * its subscription row and the latest tenant_health_snapshots row to
   * surface plan, MRR, and current health signal in one round trip.
   */
  async listTenants(query: TenantListQueryDto) {
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, 100);
    const offset = (page - 1) * limit;

    const filters = [isNull(tenants.deleted_at)] as Array<ReturnType<typeof isNull>>;
    if (query.status) {
      filters.push(
        eq(tenants.status, query.status as 'trialing' | 'active' | 'past_due' | 'canceled' | 'suspended'),
      );
    }
    if (query.search?.trim()) {
      const needle = `%${query.search.trim().toLowerCase()}%`;
      filters.push(
        sql`(lower(${tenants.name}) like ${needle} or lower(${tenants.slug}) like ${needle})` as never,
      );
    }

    // Latest health snapshot per tenant via DISTINCT ON.
    const latestHealthSql = sql`(
      SELECT DISTINCT ON (h.tenant_id)
        h.tenant_id, h.signal, h.health_score, h.snapshot_date
      FROM tenant_health_snapshots h
      ORDER BY h.tenant_id, h.snapshot_date DESC
    ) AS latest_health`;

    const rows = await this.dbAdmin.execute<{
      id: string;
      name: string;
      slug: string;
      status: string;
      created_at: Date;
      trial_ends_at: Date | null;
      plan_code: string | null;
      sub_status: string | null;
      mrr_amount: number | null;
      user_count: number | null;
      signal: string | null;
      health_score: number | null;
      member_count: number;
    }>(sql`
      SELECT
        t.id, t.name, t.slug, t.status, t.created_at, t.trial_ends_at,
        s.plan_code,
        s.status     AS sub_status,
        s.mrr_amount,
        s.user_count,
        lh.signal,
        lh.health_score,
        (SELECT COUNT(*)::int FROM memberships m
           WHERE m.tenant_id = t.id) AS member_count
      FROM tenants t
      LEFT JOIN subscriptions s ON s.tenant_id = t.id
      LEFT JOIN ${latestHealthSql} ON latest_health.tenant_id = t.id
      WHERE ${and(...filters)}
        ${query.signal ? sql`AND lh.signal = ${query.signal}` : sql``}
      ORDER BY t.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `);

    const totalRow = await this.dbAdmin.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n
      FROM tenants t
      ${query.signal
        ? sql`LEFT JOIN ${latestHealthSql} ON latest_health.tenant_id = t.id`
        : sql``}
      WHERE ${and(...filters)}
        ${query.signal ? sql`AND lh.signal = ${query.signal}` : sql``}
    `);
    const total = Number(
      (totalRow as unknown as Array<{ n: number }>)[0]?.n ?? 0,
    );

    return {
      data: ((rows as unknown as Array<typeof rows extends Array<infer R> ? R : never>) ?? []).map((r) => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        status: r.status,
        createdAt: r.created_at instanceof Date
          ? r.created_at.toISOString()
          : new Date(r.created_at as unknown as string).toISOString(),
        trialEndsAt: r.trial_ends_at
          ? (r.trial_ends_at instanceof Date
              ? r.trial_ends_at.toISOString()
              : new Date(r.trial_ends_at as unknown as string).toISOString())
          : null,
        plan: r.plan_code ?? null,
        subStatus: r.sub_status ?? null,
        mrr: r.mrr_amount != null ? Number(r.mrr_amount) : 0,
        userCount: r.user_count ?? 0,
        memberCount: Number(r.member_count ?? 0),
        signal: r.signal ?? null,
        healthScore: r.health_score != null ? Number(r.health_score) : null,
      })),
      pagination: { page, limit, total },
    };
  }

  /**
   * Detailed tenant view: core row + subscription + latest health snapshot
   * + member/employee counts. Used by /fam/tenants/[id] Overview tab.
   */
  async getTenant(tenantId: string) {
    const [tenant] = await this.dbAdmin
      .select()
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (!tenant) {
      this.logger.warn(`getTenant: ${tenantId} not found`);
      return null;
    }

    const [sub] = await this.dbAdmin
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.tenant_id, tenantId))
      .limit(1);

    const [latestHealth] = await this.dbAdmin
      .select()
      .from(tenantHealthSnapshots)
      .where(eq(tenantHealthSnapshots.tenant_id, tenantId))
      .orderBy(desc(tenantHealthSnapshots.snapshot_date))
      .limit(1);

    const counts = await this.dbAdmin.execute<{
      member_count: number;
      employee_count: number;
    }>(sql`
      SELECT
        (SELECT COUNT(*)::int FROM memberships m WHERE m.tenant_id = ${tenantId}) AS member_count,
        (SELECT COUNT(*)::int FROM employees e   WHERE e.tenant_id = ${tenantId} AND e.deleted_at IS NULL) AS employee_count
    `);
    const c =
      (counts as unknown as Array<{ member_count: number; employee_count: number }>)[0] ??
      { member_count: 0, employee_count: 0 };

    return {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      status: tenant.status,
      legalName: tenant.legal_name,
      industry: tenant.industry,
      sizeBand: tenant.size_band,
      city: tenant.city,
      stateCode: tenant.state_code,
      country: tenant.country_code,
      currency: tenant.currency,
      timezone: tenant.timezone,
      logoUrl: tenant.logo_url,
      trialEndsAt: tenant.trial_ends_at?.toISOString() ?? null,
      verifiedAt: tenant.verified_at?.toISOString() ?? null,
      createdAt: tenant.created_at.toISOString(),
      memberCount: Number(c.member_count ?? 0),
      employeeCount: Number(c.employee_count ?? 0),
      subscription: sub
        ? {
            planCode: sub.plan_code,
            status: sub.status,
            mrr: Number(sub.mrr_amount ?? 0),
            perUserPrice: Number(sub.per_user_price ?? 0),
            userCount: Number(sub.user_count ?? 0),
            billingCycle: sub.billing_cycle,
            currentPeriodStart: sub.current_period_start?.toISOString() ?? null,
            currentPeriodEnd: sub.current_period_end?.toISOString() ?? null,
            cancelAtPeriodEnd: sub.cancel_at_period_end,
          }
        : null,
      health: latestHealth
        ? {
            score: latestHealth.health_score,
            signal: latestHealth.signal,
            activeUsers7d: latestHealth.active_users_7d,
            activeUsers30d: latestHealth.active_users_30d,
            attendanceCompliance: latestHealth.attendance_compliance,
            featureAdoptionScore: latestHealth.feature_adoption_score,
            snapshotDate: latestHealth.snapshot_date,
          }
        : null,
    };
  }

  /**
   * Lists members (memberships) of a tenant for the FAM tenant detail
   * page. Joins with users to surface email + display name + status.
   */
  async listTenantMembers(tenantId: string) {
    const rows = await this.dbAdmin.execute<{
      membership_id: string;
      role: string;
      m_status: string;
      invited_at: Date | null;
      accepted_at: Date | null;
      user_id: string;
      email: string;
      full_name: string;
    }>(sql`
      SELECT
        m.id         AS membership_id,
        m.role,
        m.status     AS m_status,
        m.invited_at,
        m.accepted_at,
        u.id         AS user_id,
        u.email,
        u.full_name
      FROM memberships m
      LEFT JOIN users u ON u.id = m.user_id
      WHERE m.tenant_id = ${tenantId}
      ORDER BY
        CASE m.role
          WHEN 'fam' THEN 0
          WHEN 'super_admin' THEN 0
          WHEN 'owner' THEN 1
          WHEN 'admin' THEN 2
          WHEN 'manager' THEN 3
          WHEN 'finance' THEN 4
          WHEN 'employee' THEN 5
          ELSE 9
        END,
        u.full_name
    `);

    return {
      data: ((rows as unknown as Array<{
        membership_id: string;
        role: string;
        m_status: string;
        invited_at: Date | null;
        accepted_at: Date | null;
        user_id: string;
        email: string;
        full_name: string;
      }>) ?? []).map((r) => ({
        membershipId: r.membership_id,
        userId: r.user_id,
        email: r.email,
        fullName: r.full_name,
        role: r.role,
        status: r.m_status,
        invitedAt: r.invited_at
          ? (r.invited_at instanceof Date
              ? r.invited_at.toISOString()
              : new Date(r.invited_at as unknown as string).toISOString())
          : null,
        acceptedAt: r.accepted_at
          ? (r.accepted_at instanceof Date
              ? r.accepted_at.toISOString()
              : new Date(r.accepted_at as unknown as string).toISOString())
          : null,
      })),
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
