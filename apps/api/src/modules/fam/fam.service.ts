import { Injectable, Logger, Inject } from '@nestjs/common';
import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import {
  tenants,
  subscriptions,
  tenantHealthSnapshots,
  memberships,
  users,
  employees,
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
   * its subscription row to surface plan, MRR, and user count in one
   * round trip; the latest health snapshot is loaded in a second batched
   * query and merged in JS so we don't need a fragile DISTINCT ON subquery.
   */
  async listTenants(query: TenantListQueryDto) {
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, 100);
    const offset = (page - 1) * limit;

    // Build the WHERE clause. The status enum is narrowed before passing
    // to `eq` so Drizzle generates a parameterized comparison; search is
    // a case-insensitive LIKE over name + slug.
    const conditions = [isNull(tenants.deleted_at)] as Array<ReturnType<typeof isNull>>;
    if (query.status) {
      conditions.push(
        eq(
          tenants.status,
          query.status as 'trialing' | 'active' | 'past_due' | 'canceled' | 'suspended',
        ) as never,
      );
    }
    if (query.search?.trim()) {
      const needle = `%${query.search.trim().toLowerCase()}%`;
      conditions.push(
        sql`(lower(${tenants.name}) like ${needle} or lower(${tenants.slug}) like ${needle})` as never,
      );
    }
    const where = and(...conditions);

    const baseRows = await this.dbAdmin
      .select({
        id: tenants.id,
        name: tenants.name,
        slug: tenants.slug,
        status: tenants.status,
        createdAt: tenants.created_at,
        trialEndsAt: tenants.trial_ends_at,
        planCode: subscriptions.plan_code,
        subStatus: subscriptions.status,
        mrrAmount: subscriptions.mrr_amount,
        userCount: subscriptions.user_count,
      })
      .from(tenants)
      .leftJoin(subscriptions, eq(subscriptions.tenant_id, tenants.id))
      .where(where)
      .orderBy(desc(tenants.created_at))
      .limit(limit)
      .offset(offset);

    const tenantIds = baseRows.map((r) => r.id);

    // Latest health snapshot per tenant in one round trip.
    const healthRows = tenantIds.length
      ? await this.dbAdmin.execute<{
          tenant_id: string;
          signal: string;
          health_score: number | null;
        }>(sql`
          SELECT DISTINCT ON (tenant_id) tenant_id, signal, health_score
          FROM tenant_health_snapshots
          WHERE tenant_id IN (${sql.join(
            tenantIds.map((id) => sql`${id}`),
            sql`, `,
          )})
          ORDER BY tenant_id, snapshot_date DESC
        `)
      : [];
    const healthByTenant = new Map<string, { signal: string; healthScore: number | null }>();
    for (const r of (healthRows as unknown as Array<{ tenant_id: string; signal: string; health_score: number | null }>) ?? []) {
      healthByTenant.set(r.tenant_id, {
        signal: r.signal,
        healthScore: r.health_score != null ? Number(r.health_score) : null,
      });
    }

    // Member counts per tenant — one aggregate query.
    const memberCountRows = tenantIds.length
      ? await this.dbAdmin.execute<{ tenant_id: string; n: number }>(sql`
          SELECT tenant_id, COUNT(*)::int AS n
          FROM memberships
          WHERE tenant_id IN (${sql.join(
            tenantIds.map((id) => sql`${id}`),
            sql`, `,
          )})
          GROUP BY tenant_id
        `)
      : [];
    const memberCountByTenant = new Map<string, number>();
    for (const r of (memberCountRows as unknown as Array<{ tenant_id: string; n: number }>) ?? []) {
      memberCountByTenant.set(r.tenant_id, Number(r.n));
    }

    // Total count for pagination — uses the same WHERE.
    const totalRowResult = await this.dbAdmin
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(tenants)
      .where(where);
    const total = Number(totalRowResult[0]?.n ?? 0);

    // Build the shaped response. If a signal filter was requested, drop
    // tenants whose latest snapshot doesn't match — cheaper than a
    // second SQL pass for the small page sizes the UI uses.
    const data = baseRows
      .map((r) => {
        const h = healthByTenant.get(r.id);
        return {
          id: r.id,
          name: r.name,
          slug: r.slug,
          status: r.status,
          createdAt: r.createdAt.toISOString(),
          trialEndsAt: r.trialEndsAt?.toISOString() ?? null,
          plan: r.planCode ?? null,
          subStatus: r.subStatus ?? null,
          mrr: r.mrrAmount != null ? Number(r.mrrAmount) : 0,
          userCount: r.userCount ?? 0,
          memberCount: memberCountByTenant.get(r.id) ?? 0,
          signal: h?.signal ?? null,
          healthScore: h?.healthScore ?? null,
        };
      })
      .filter((t) => (query.signal ? t.signal === query.signal : true));

    return {
      data,
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

    // Member + employee counts via two cheap aggregates. The employees
    // table has no soft-delete column; "active workforce" is anyone who
    // hasn't been moved to 'separated' or 'absconded'.
    const [memberRow] = await this.dbAdmin
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(memberships)
      .where(eq(memberships.tenant_id, tenantId));
    const [employeeRow] = await this.dbAdmin
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(employees)
      .where(
        and(
          eq(employees.tenant_id, tenantId),
          sql`${employees.status} NOT IN ('separated', 'absconded')`,
        ),
      );
    const c = {
      member_count: Number(memberRow?.n ?? 0),
      employee_count: Number(employeeRow?.n ?? 0),
    };

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
    // ORDER BY role-precedence is expressed inline; everything else is
    // pure Drizzle so the placeholders bind correctly.
    const rolePrecedence = sql`
      CASE ${memberships.role}
        WHEN 'fam'         THEN 0
        WHEN 'super_admin' THEN 0
        WHEN 'owner'       THEN 1
        WHEN 'admin'       THEN 2
        WHEN 'manager'     THEN 3
        WHEN 'finance'     THEN 4
        WHEN 'employee'    THEN 5
        ELSE 9
      END
    `;

    const rows = await this.dbAdmin
      .select({
        membershipId: memberships.id,
        role: memberships.role,
        status: memberships.status,
        invitedAt: memberships.invited_at,
        acceptedAt: memberships.accepted_at,
        userId: users.id,
        email: users.email,
        fullName: users.full_name,
      })
      .from(memberships)
      .leftJoin(users, eq(users.id, memberships.user_id))
      .where(eq(memberships.tenant_id, tenantId))
      .orderBy(rolePrecedence, users.full_name);

    return {
      data: rows.map((r) => ({
        membershipId: r.membershipId,
        userId: r.userId ?? '',
        email: r.email ?? null,
        fullName: r.fullName ?? null,
        role: r.role,
        status: r.status,
        invitedAt: r.invitedAt?.toISOString() ?? null,
        acceptedAt: r.acceptedAt?.toISOString() ?? null,
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
