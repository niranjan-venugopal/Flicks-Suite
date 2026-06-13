import {
  Injectable,
  Logger,
  Inject,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, gte, inArray, isNull, ne, sql } from 'drizzle-orm';

// The Specflicks-internal "platform tenant" that exists only to give the
// FAM admin a JWT tenant_id without making them a member of any customer
// workspace. Hidden from /fam/tenants and the platform-wide aggregates;
// seeded by scripts/setup-demo.sh.
const SPECFLICKS_TENANT_ID = '00000000-0000-0000-0000-000000000001';
import {
  tenants,
  subscriptions,
  subscriptionEvents,
  tenantHealthSnapshots,
  auditLogPlatform,
  memberships,
  users,
  employees,
  featureFlags,
  tenantCohorts,
  impersonationSessions,
  tenantModuleToggles,
  membershipGrants,
  tenantBankAccounts,
  invoices,
} from '@flicks/db/schema';
import { DB_SERVICE_ROLE } from '../../core/database/database.module';
import type { DbAdmin } from '@flicks/db';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  AnalyticsService,
  SERVER_EVENTS,
} from '../../core/analytics/analytics.service';
import type { UserRole } from '@flicks/shared/types';
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
    private readonly authService: AuthService,
    private readonly notificationsService: NotificationsService,
    private readonly analytics: AnalyticsService,
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

    // Customer-tenant filter — everywhere we count or list workspaces,
    // we exclude the Specflicks platform tenant since it's not a real
    // customer; it exists only to host the FAM admin's membership.
    const customerOnly = and(
      isNull(tenants.deleted_at),
      ne(tenants.id, SPECFLICKS_TENANT_ID),
    );

    // 1. Tenants by status — single grouped aggregate.
    const statusRows = await this.dbAdmin
      .select({
        status: tenants.status,
        n: sql<number>`COUNT(*)::int`,
      })
      .from(tenants)
      .where(customerOnly)
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
    // The Specflicks platform tenant has no subscription, so no filter
    // is strictly needed here, but join-and-filter keeps things honest
    // in case someone accidentally seeds one.
    const planRows = await this.dbAdmin
      .select({
        plan: subscriptions.plan_code,
        n: sql<number>`COUNT(*)::int`,
      })
      .from(subscriptions)
      .where(ne(subscriptions.tenant_id, SPECFLICKS_TENANT_ID))
      .groupBy(subscriptions.plan_code);
    const tenantsByPlan: Record<string, number> = {};
    for (const r of planRows) tenantsByPlan[r.plan] = Number(r.n);

    // 3. Signups (tenants.created_at) — total this week + per-day series.
    const signupsThisWeekRow = await this.dbAdmin
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(tenants)
      .where(and(customerOnly, gte(tenants.created_at, sevenDaysAgo)));
    const signupsThisWeek = Number(signupsThisWeekRow[0]?.n ?? 0);

    const signupsTrendRaw = await this.dbAdmin
      .select({
        d: sql<string>`to_char(date_trunc('day', ${tenants.created_at}), 'YYYY-MM-DD')`,
        n: sql<number>`COUNT(*)::int`,
      })
      .from(tenants)
      .where(and(customerOnly, gte(tenants.created_at, sevenDaysAgo)))
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
        and(
          sql`${subscriptions.status} IN ('active', 'trialing')`,
          ne(subscriptions.tenant_id, SPECFLICKS_TENANT_ID),
        ),
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
        WHERE tenant_id <> ${SPECFLICKS_TENANT_ID}
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
      .where(customerOnly)
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
    const conditions = [
      isNull(tenants.deleted_at),
      ne(tenants.id, SPECFLICKS_TENANT_ID),
    ] as Array<ReturnType<typeof isNull>>;
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
    // Block direct access to the Specflicks platform tenant — it's not a
    // customer workspace and shouldn't appear in any FAM tenant view.
    if (tenantId === SPECFLICKS_TENANT_ID) {
      return null;
    }
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
      gstin: tenant.gstin,
      pan: tenant.pan,
      cin: tenant.cin,
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
        // memberships.user_id is the FK and is NOT NULL — always present.
        // Using users.id here was fragile: a leftJoin on a soft-broken
        // row would return null, which I was mapping to '' and breaking
        // the @IsUUID validation when the FAM admin tried to impersonate.
        userId: memberships.user_id,
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
        userId: r.userId,
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
    const now = new Date();
    const [updated] = await this.dbAdmin
      .update(tenants)
      .set({ status: 'suspended', updated_at: now })
      .where(eq(tenants.id, tenantId))
      .returning({ id: tenants.id, status: tenants.status });

    if (!updated) {
      throw new NotFoundException('Tenant not found');
    }

    await this.auditService.logPlatform({
      actorUserId,
      action: 'tenant.suspended',
      targetTenantId: tenantId,
      metadata: { reason: dto.reason },
    });

    return { id: updated.id, status: updated.status };
  }

  /**
   * Reverses a suspension by flipping the tenant back to 'active'.
   * Pairs with suspendTenant; same audit pattern.
   */
  async reactivateTenant(tenantId: string, actorUserId: string) {
    const now = new Date();
    const [updated] = await this.dbAdmin
      .update(tenants)
      .set({ status: 'active', updated_at: now })
      .where(eq(tenants.id, tenantId))
      .returning({ id: tenants.id, status: tenants.status });

    if (!updated) {
      throw new NotFoundException('Tenant not found');
    }

    await this.auditService.logPlatform({
      actorUserId,
      action: 'tenant.reactivated',
      targetTenantId: tenantId,
    });

    return { id: updated.id, status: updated.status };
  }

  /**
   * Extends a tenant's trial by N days. Updates tenants.trial_ends_at and,
   * if a subscription exists, slides subscriptions.current_period_end by
   * the same number of days so the billing surface stays consistent.
   */
  async extendTrial(
    tenantId: string,
    actorUserId: string,
    dto: ExtendTrialDto,
  ) {
    const now = new Date();
    const [tenantRow] = await this.dbAdmin
      .select({ trialEndsAt: tenants.trial_ends_at })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    if (!tenantRow) {
      throw new NotFoundException('Tenant not found');
    }

    const base = tenantRow.trialEndsAt ?? now;
    const newTrialEndsAt = new Date(
      base.getTime() + dto.days * 24 * 60 * 60 * 1000,
    );

    await this.dbAdmin
      .update(tenants)
      .set({ trial_ends_at: newTrialEndsAt, updated_at: now })
      .where(eq(tenants.id, tenantId));

    // Slide the subscription's current_period_end if there is one. We
    // don't touch billing cycle or MRR — the trial extension is a
    // free-of-charge runway grant, not a plan change.
    const [sub] = await this.dbAdmin
      .select({
        id: subscriptions.id,
        currentPeriodEnd: subscriptions.current_period_end,
      })
      .from(subscriptions)
      .where(eq(subscriptions.tenant_id, tenantId))
      .limit(1);
    if (sub?.currentPeriodEnd) {
      const slid = new Date(
        sub.currentPeriodEnd.getTime() + dto.days * 24 * 60 * 60 * 1000,
      );
      await this.dbAdmin
        .update(subscriptions)
        .set({ current_period_end: slid, updated_at: now })
        .where(eq(subscriptions.id, sub.id));
    }

    await this.auditService.logPlatform({
      actorUserId,
      action: 'tenant.trial.extended',
      targetTenantId: tenantId,
      metadata: { days: dto.days, reason: dto.reason, newTrialEndsAt: newTrialEndsAt.toISOString() },
    });

    return {
      id: tenantId,
      trialEndsAt: newTrialEndsAt.toISOString(),
      extendedByDays: dto.days,
    };
  }

  // ─── Usage / Billing / Audit (C4 tabs) ─────────────────────────────────────

  /**
   * Per-tenant activity rollups for the Usage tab. All counts are scoped
   * to the last 30 days unless noted otherwise.
   */
  async getTenantUsage(tenantId: string) {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [punches] = await this.dbAdmin.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n
      FROM attendance_punches
      WHERE tenant_id = ${tenantId} AND punched_at >= ${since.toISOString()}
    `) as unknown as Array<{ n: number }>;

    const [leaves] = await this.dbAdmin.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n
      FROM leave_requests
      WHERE tenant_id = ${tenantId} AND applied_at >= ${since.toISOString()}
    `) as unknown as Array<{ n: number }>;

    const [submittedTimesheets] = await this.dbAdmin.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n
      FROM timesheet_periods
      WHERE tenant_id = ${tenantId}
        AND submitted_at IS NOT NULL
        AND submitted_at >= ${since.toISOString()}
    `) as unknown as Array<{ n: number }>;

    const [activeEmployees] = await this.dbAdmin
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(employees)
      .where(
        and(
          eq(employees.tenant_id, tenantId),
          sql`${employees.status} NOT IN ('separated', 'absconded')`,
        ),
      );

    const [latestHealth] = await this.dbAdmin
      .select()
      .from(tenantHealthSnapshots)
      .where(eq(tenantHealthSnapshots.tenant_id, tenantId))
      .orderBy(desc(tenantHealthSnapshots.snapshot_date))
      .limit(1);

    return {
      windowDays: 30,
      attendancePunches: Number(punches?.n ?? 0),
      leaveRequests: Number(leaves?.n ?? 0),
      timesheetsSubmitted: Number(submittedTimesheets?.n ?? 0),
      activeEmployees: Number(activeEmployees?.n ?? 0),
      activeUsers7d: latestHealth?.active_users_7d ?? 0,
      activeUsers30d: latestHealth?.active_users_30d ?? 0,
      attendanceCompliance: latestHealth?.attendance_compliance ?? null,
      featureAdoptionScore: latestHealth?.feature_adoption_score ?? null,
      healthScore: latestHealth?.health_score ?? null,
    };
  }

  /**
   * Subscription + recent subscription_events for the Billing tab.
   */
  async getTenantBilling(tenantId: string) {
    const [sub] = await this.dbAdmin
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.tenant_id, tenantId))
      .limit(1);

    if (!sub) {
      return { subscription: null, events: [] };
    }

    const events = await this.dbAdmin
      .select({
        id: subscriptionEvents.id,
        eventType: subscriptionEvents.event_type,
        metadata: subscriptionEvents.metadata,
        createdAt: subscriptionEvents.created_at,
      })
      .from(subscriptionEvents)
      .where(eq(subscriptionEvents.subscription_id, sub.id))
      .orderBy(desc(subscriptionEvents.created_at))
      .limit(50);

    return {
      subscription: {
        id: sub.id,
        planCode: sub.plan_code,
        status: sub.status,
        perUserPrice: Number(sub.per_user_price ?? 0),
        userCount: Number(sub.user_count ?? 0),
        mrr: Number(sub.mrr_amount ?? 0),
        billingCycle: sub.billing_cycle,
        trialEndsAt: sub.trial_ends_at?.toISOString() ?? null,
        currentPeriodStart: sub.current_period_start?.toISOString() ?? null,
        currentPeriodEnd: sub.current_period_end?.toISOString() ?? null,
        cancelAtPeriodEnd: sub.cancel_at_period_end,
        canceledAt: sub.canceled_at?.toISOString() ?? null,
        razorpaySubscriptionId: sub.razorpay_subscription_id,
        createdAt: sub.created_at.toISOString(),
      },
      events: events.map((e) => ({
        id: e.id,
        eventType: e.eventType,
        metadata: e.metadata as Record<string, unknown> | null,
        createdAt: e.createdAt.toISOString(),
      })),
    };
  }

  /**
   * Platform audit log entries scoped to a single tenant for the Audit
   * tab. Joined with users to surface the actor's display name.
   */
  async getTenantAudit(
    tenantId: string,
    opts: { page?: number; limit?: number } = {},
  ) {
    const page = Math.max(1, opts.page ?? 1);
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 100));
    const offset = (page - 1) * limit;

    const rows = await this.dbAdmin
      .select({
        id: auditLogPlatform.id,
        action: auditLogPlatform.action,
        actorUserId: auditLogPlatform.actor_user_id,
        targetUserId: auditLogPlatform.target_user_id,
        metadata: auditLogPlatform.metadata,
        ipAddress: auditLogPlatform.ip_address,
        userAgent: auditLogPlatform.user_agent,
        createdAt: auditLogPlatform.created_at,
        actorEmail: users.email,
        actorName: users.full_name,
      })
      .from(auditLogPlatform)
      .leftJoin(users, eq(users.id, auditLogPlatform.actor_user_id))
      .where(eq(auditLogPlatform.target_tenant_id, tenantId))
      .orderBy(desc(auditLogPlatform.created_at))
      .limit(limit)
      .offset(offset);

    const [{ n }] = await this.dbAdmin
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(auditLogPlatform)
      .where(eq(auditLogPlatform.target_tenant_id, tenantId));

    return {
      data: rows.map((r) => ({
        id: r.id,
        action: r.action,
        actor: r.actorName ?? r.actorEmail ?? 'system',
        actorEmail: r.actorEmail,
        actorUserId: r.actorUserId,
        targetUserId: r.targetUserId,
        metadata: r.metadata as Record<string, unknown> | null,
        ipAddress: r.ipAddress,
        createdAt: r.createdAt.toISOString(),
      })),
      pagination: { page, limit, total: Number(n ?? 0) },
    };
  }

  // ─── Impersonation ─────────────────────────────────────────────────────────

  /**
   * Starts an impersonation session for a target user. Mints a fresh JWT
   * with `impersonatorUserId` set to the FAM admin's user id; the
   * controller swaps the response cookies to that pair so the next
   * request reads /me as the target user.
   *
   * Audits the action on BOTH the platform audit log (FAM-side) and the
   * tenant's audit log (so the customer can see who logged in as them).
   */
  async startImpersonation(
    actorUserId: string,
    dto: StartImpersonationDto,
  ) {
    if (!dto.membershipId && !dto.targetUserId) {
      throw new BadRequestException(
        'Either membershipId or targetUserId is required',
      );
    }

    // Resolve the target user + their primary tenant + role. Prefer
    // membershipId because it pins us to an exact row from the FAM
    // tenant detail page; fall back to targetUserId for backwards-compat.
    const filters = [
      eq(memberships.status, 'active'),
      ne(memberships.tenant_id, SPECFLICKS_TENANT_ID),
    ];
    if (dto.membershipId) {
      filters.push(eq(memberships.id, dto.membershipId));
    } else if (dto.targetUserId) {
      filters.push(eq(users.id, dto.targetUserId));
    }

    const [target] = await this.dbAdmin
      .select({
        userId: users.id,
        email: users.email,
        isPlatformAdmin: users.is_platform_admin,
        membershipId: memberships.id,
        tenantId: memberships.tenant_id,
        role: memberships.role,
      })
      .from(users)
      .innerJoin(memberships, eq(memberships.user_id, users.id))
      .where(and(...filters))
      .orderBy(memberships.created_at)
      .limit(1);

    if (!target) {
      throw new NotFoundException('Target user has no active tenant membership');
    }

    // Open the session row first — gives us a hard 15-minute cap that's
    // enforced server-side in the refresh handler. Without this, a leaked
    // refresh cookie could mint clean access tokens (no impersonator
    // marker) for the full 7-day refresh window.
    const now = new Date();
    const endsAt = new Date(now.getTime() + 15 * 60 * 1000);
    const [session] = await this.dbAdmin
      .insert(impersonationSessions)
      .values({
        impersonator_user_id: actorUserId,
        target_user_id: target.userId,
        target_tenant_id: target.tenantId,
        reason: dto.reason,
        support_ticket: null,
        started_at: now,
        ends_at: endsAt,
      })
      .returning({ id: impersonationSessions.id, endsAt: impersonationSessions.ends_at });

    // Mint the impersonation JWT (15 min). impersonatorUserId carries the
    // FAM admin's identity through every downstream request so /me can
    // surface the banner and the audit log can attribute writes.
    const { accessToken, refreshToken } = await this.authService.issueTokenPair(
      {
        id: target.userId,
        email: target.email,
        is_platform_admin: target.isPlatformAdmin,
      },
      target.tenantId,
      target.membershipId,
      target.role as UserRole,
      undefined,
      undefined,
      undefined,
      actorUserId,
    );

    // Platform audit (FAM-side) — visible in /fam/audit + tenant audit tab.
    await this.auditService.logPlatform({
      actorUserId,
      action: 'fam.tenant.impersonate.start',
      targetTenantId: target.tenantId,
      targetUserId: target.userId,
      metadata: { reason: dto.reason, targetEmail: target.email },
    });

    // Tenant audit (customer-side) so the workspace can see staff logins.
    await this.auditService.log({
      tenantId: target.tenantId,
      actorUserId,
      action: 'impersonation.session.started',
      resourceType: 'user',
      resourceId: target.userId,
      metadata: {
        impersonatorUserId: actorUserId,
        targetEmail: target.email,
        reason: dto.reason,
        sessionId: session.id,
        endsAt: endsAt.toISOString(),
      },
    });

    // In-app notification to the impersonated user so they can see this
    // immediately on next login. DPDP-flavoured: the customer knows.
    try {
      await this.notificationsService.createInAppNotification(
        target.userId,
        'impersonation.session.started',
        'Specflicks staff has signed in as you for support. The session expires in 15 minutes.',
        '/profile',
        target.tenantId,
      );
    } catch (e) {
      this.logger.warn(
        `Could not write impersonation in-app notification for ${target.userId}: ${(e as Error).message}`,
      );
    }

    // Email the impersonated user — best-effort, never blocks the flow.
    try {
      await this.notificationsService.sendEmail(
        'impersonation-started',
        target.email,
        {
          targetName: target.email.split('@')[0],
          reason: dto.reason,
          endsAt: endsAt.toUTCString(),
        },
      );
    } catch (e) {
      this.logger.warn(
        `Could not send impersonation-started email to ${target.email}: ${(e as Error).message}`,
      );
    }

    // Attribute to the FAM admin (impersonator), not the target — this is a
    // staff action. Captured server-side so an ad-blocker can't suppress an
    // audit-relevant event.
    this.analytics.capture(
      actorUserId,
      SERVER_EVENTS.IMPERSONATION_STARTED,
      { targetUserId: target.userId, tenantId: target.tenantId, sessionId: session.id },
      { tenant: target.tenantId },
    );

    return {
      accessToken,
      refreshToken,
      sessionId: session.id,
      targetUserId: target.userId,
      targetEmail: target.email,
      tenantId: target.tenantId,
      endsAt: endsAt.toISOString(),
      expiresIn: 15 * 60,
    };
  }

  /**
   * Ends the current impersonation session. Re-issues the original FAM
   * admin's token pair using their canonical Specflicks membership, and
   * writes matching audit rows on both sides.
   */
  async endImpersonation(
    impersonatedUserId: string,
    impersonatorUserId: string,
    currentTenantId: string,
  ) {
    // Restore the FAM admin's identity.
    const [impersonator] = await this.dbAdmin
      .select({
        userId: users.id,
        email: users.email,
        isPlatformAdmin: users.is_platform_admin,
        membershipId: memberships.id,
        tenantId: memberships.tenant_id,
        role: memberships.role,
      })
      .from(users)
      .innerJoin(memberships, eq(memberships.user_id, users.id))
      .where(
        and(
          eq(users.id, impersonatorUserId),
          eq(memberships.role, 'fam'),
        ),
      )
      .limit(1);

    if (!impersonator) {
      throw new NotFoundException('Impersonator user no longer has a FAM membership');
    }

    // Close the live session row so the refresh handler refuses any
    // outstanding refresh attempts. Idempotent: if there's no active
    // row this just updates zero rows.
    const now = new Date();
    await this.dbAdmin
      .update(impersonationSessions)
      .set({ ended_at: now })
      .where(
        and(
          eq(impersonationSessions.impersonator_user_id, impersonatorUserId),
          eq(impersonationSessions.target_user_id, impersonatedUserId),
          isNull(impersonationSessions.ended_at),
        ),
      );

    const { accessToken, refreshToken } = await this.authService.issueTokenPair(
      {
        id: impersonator.userId,
        email: impersonator.email,
        is_platform_admin: impersonator.isPlatformAdmin,
      },
      impersonator.tenantId,
      impersonator.membershipId,
      impersonator.role as UserRole,
    );

    await this.auditService.logPlatform({
      actorUserId: impersonatorUserId,
      action: 'fam.tenant.impersonate.end',
      targetTenantId: currentTenantId,
      targetUserId: impersonatedUserId,
    });

    await this.auditService.log({
      tenantId: currentTenantId,
      actorUserId: impersonatorUserId,
      action: 'impersonation.session.ended',
      resourceType: 'user',
      resourceId: impersonatedUserId,
      metadata: { impersonatorUserId },
    });

    return { accessToken, refreshToken };
  }

  // ─── Feature flags ─────────────────────────────────────────────────────────

  async listFeatureFlags() {
    const rows = await this.dbAdmin
      .select()
      .from(featureFlags)
      .orderBy(featureFlags.flag_key);
    return {
      data: rows.map((f) => ({
        id: f.id,
        flagKey: f.flag_key,
        description: f.description,
        isEnabledGlobally: f.is_enabled_globally,
        enabledTenantIds: f.enabled_tenant_ids ?? [],
        rolloutPercentage: f.rollout_percentage,
        updatedAt: f.updated_at.toISOString(),
      })),
      total: rows.length,
    };
  }

  async upsertFeatureFlag(
    actorUserId: string,
    dto: UpsertFeatureFlagDto,
  ) {
    const now = new Date();
    const [row] = await this.dbAdmin
      .insert(featureFlags)
      .values({
        flag_key: dto.flagKey,
        description: dto.description ?? null,
        is_enabled_globally: dto.isEnabledGlobally ?? false,
        enabled_tenant_ids: dto.enabledTenantIds ?? [],
        rollout_percentage: dto.rolloutPercentage ?? 0,
      })
      .onConflictDoUpdate({
        target: featureFlags.flag_key,
        set: {
          description: dto.description ?? null,
          is_enabled_globally: dto.isEnabledGlobally ?? false,
          enabled_tenant_ids: dto.enabledTenantIds ?? [],
          rollout_percentage: dto.rolloutPercentage ?? 0,
          updated_at: now,
        },
      })
      .returning();

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
      id: row.id,
      flagKey: row.flag_key,
      isEnabledGlobally: row.is_enabled_globally,
      enabledTenantIds: row.enabled_tenant_ids ?? [],
      rolloutPercentage: row.rollout_percentage,
    };
  }

  // ─── Cohorts ───────────────────────────────────────────────────────────────

  async listCohorts() {
    const rows = await this.dbAdmin
      .select()
      .from(tenantCohorts)
      .orderBy(tenantCohorts.name);
    return {
      data: rows.map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description,
        tenantIds: c.tenant_ids ?? [],
        tenantCount: (c.tenant_ids ?? []).length,
        createdAt: c.created_at.toISOString(),
      })),
      total: rows.length,
    };
  }

  async upsertCohort(actorUserId: string, dto: UpsertCohortDto) {
    const [row] = await this.dbAdmin
      .insert(tenantCohorts)
      .values({
        name: dto.name,
        description: dto.description ?? null,
        tenant_ids: dto.tenantIds,
      })
      .onConflictDoUpdate({
        target: tenantCohorts.name,
        set: {
          description: dto.description ?? null,
          tenant_ids: dto.tenantIds,
        },
      })
      .returning();

    await this.auditService.logPlatform({
      actorUserId,
      action: 'cohort.upserted',
      metadata: { name: dto.name, tenantCount: dto.tenantIds.length },
    });

    return {
      id: row.id,
      name: row.name,
      tenantIds: row.tenant_ids ?? [],
    };
  }

  // ─── Health ────────────────────────────────────────────────────────────────

  /**
   * Health snapshots for a single tenant — last N days, newest first.
   */
  async getTenantHealth(tenantId: string, days = 30) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const rows = await this.dbAdmin
      .select()
      .from(tenantHealthSnapshots)
      .where(
        and(
          eq(tenantHealthSnapshots.tenant_id, tenantId),
          gte(tenantHealthSnapshots.snapshot_date, since.toISOString().slice(0, 10)),
        ),
      )
      .orderBy(desc(tenantHealthSnapshots.snapshot_date));
    return {
      tenantId,
      windowDays: days,
      snapshots: rows.map((s) => ({
        snapshotDate: s.snapshot_date,
        healthScore: s.health_score,
        signal: s.signal,
        activeUsers7d: s.active_users_7d,
        activeUsers30d: s.active_users_30d,
        attendanceCompliance: s.attendance_compliance,
        featureAdoptionScore: s.feature_adoption_score,
      })),
    };
  }

  // ─── C5: Revenue / Funnel / Feature usage / System health ─────────────────

  /**
   * Platform-wide revenue snapshot. MRR + breakdown by plan and status,
   * plus the top tenants by MRR for the recent-payments feed.
   */
  async getRevenue() {
    const [{ mrr }] = await this.dbAdmin
      .select({
        mrr: sql<number>`COALESCE(SUM(${subscriptions.mrr_amount}), 0)::real`,
      })
      .from(subscriptions)
      .where(
        and(
          sql`${subscriptions.status} IN ('active', 'trialing')`,
          ne(subscriptions.tenant_id, SPECFLICKS_TENANT_ID),
        ),
      );

    const byPlan = await this.dbAdmin
      .select({
        plan: subscriptions.plan_code,
        n: sql<number>`COUNT(*)::int`,
        mrr: sql<number>`COALESCE(SUM(${subscriptions.mrr_amount}), 0)::real`,
      })
      .from(subscriptions)
      .where(ne(subscriptions.tenant_id, SPECFLICKS_TENANT_ID))
      .groupBy(subscriptions.plan_code);

    const byStatus = await this.dbAdmin
      .select({
        status: subscriptions.status,
        n: sql<number>`COUNT(*)::int`,
      })
      .from(subscriptions)
      .where(ne(subscriptions.tenant_id, SPECFLICKS_TENANT_ID))
      .groupBy(subscriptions.status);

    const topPaying = await this.dbAdmin
      .select({
        tenantId: tenants.id,
        tenantName: tenants.name,
        slug: tenants.slug,
        planCode: subscriptions.plan_code,
        mrr: subscriptions.mrr_amount,
        userCount: subscriptions.user_count,
        status: subscriptions.status,
      })
      .from(subscriptions)
      .innerJoin(tenants, eq(tenants.id, subscriptions.tenant_id))
      .where(
        and(
          ne(subscriptions.tenant_id, SPECFLICKS_TENANT_ID),
          sql`${subscriptions.status} IN ('active', 'trialing')`,
        ),
      )
      .orderBy(desc(subscriptions.mrr_amount))
      .limit(10);

    return {
      mrr: { amount: Number(mrr ?? 0), currency: 'INR' },
      arr: { amount: Number(mrr ?? 0) * 12, currency: 'INR' },
      byPlan: byPlan.map((r) => ({
        plan: r.plan,
        tenants: Number(r.n),
        mrr: Number(r.mrr ?? 0),
      })),
      byStatus: byStatus.map((r) => ({ status: r.status, n: Number(r.n) })),
      topPaying: topPaying.map((r) => ({
        tenantId: r.tenantId,
        tenantName: r.tenantName,
        slug: r.slug,
        planCode: r.planCode,
        mrr: Number(r.mrr ?? 0),
        userCount: Number(r.userCount ?? 0),
        status: r.status,
      })),
    };
  }

  /**
   * Signup funnel — 5 stages. Each stage is a strict subset of the one
   * before. Built off the demo schema:
   *   1. signedUp: tenant row exists (not deleted, not Specflicks)
   *   2. workspaceConfigured: tenant has ≥1 location AND ≥1 department
   *   3. firstInviteSent: tenant has ≥1 employee_invitation row
   *   4. firstEmployeeAccepted: tenant has ≥2 active memberships (Owner + 1)
   *   5. firstActivity: tenant has at least one attendance_punch, leave
   *      request, or timesheet entry.
   */
  async getFunnel() {
    const totals = await this.dbAdmin.execute<{ stage: string; n: number }>(sql`
      WITH t AS (
        SELECT id FROM tenants
        WHERE deleted_at IS NULL AND id <> ${SPECFLICKS_TENANT_ID}::uuid
      )
      SELECT 'signedUp'::text AS stage, COUNT(*)::int AS n FROM t
      UNION ALL
      SELECT 'workspaceConfigured', COUNT(*)::int FROM t
        WHERE EXISTS (SELECT 1 FROM locations   l WHERE l.tenant_id = t.id)
          AND EXISTS (SELECT 1 FROM departments d WHERE d.tenant_id = t.id)
      UNION ALL
      SELECT 'firstInviteSent', COUNT(*)::int FROM t
        WHERE EXISTS (SELECT 1 FROM employee_invitations i WHERE i.tenant_id = t.id)
           OR (SELECT COUNT(*) FROM memberships m WHERE m.tenant_id = t.id) > 1
      UNION ALL
      SELECT 'firstEmployeeAccepted', COUNT(*)::int FROM t
        WHERE (SELECT COUNT(*) FROM memberships m
                WHERE m.tenant_id = t.id AND m.status = 'active') >= 2
      UNION ALL
      SELECT 'firstActivity', COUNT(*)::int FROM t
        WHERE EXISTS (SELECT 1 FROM attendance_punches a WHERE a.tenant_id = t.id)
           OR EXISTS (SELECT 1 FROM leave_requests     l WHERE l.tenant_id = t.id)
           OR EXISTS (SELECT 1 FROM timesheet_entries  e
                       JOIN timesheet_periods p ON p.id = e.timesheet_period_id
                      WHERE p.tenant_id = t.id)
    `);

    const map = new Map<string, number>();
    for (const r of (totals as unknown as Array<{ stage: string; n: number }>) ?? []) {
      map.set(r.stage, Number(r.n));
    }

    const total = map.get('signedUp') ?? 0;
    const stages = [
      { id: 'signedUp',              label: 'Signed up' },
      { id: 'workspaceConfigured',   label: 'Workspace configured' },
      { id: 'firstInviteSent',       label: 'First invite sent' },
      { id: 'firstEmployeeAccepted', label: 'First employee accepted' },
      { id: 'firstActivity',         label: 'First activity' },
    ];
    return {
      total,
      stages: stages.map((s) => {
        const count = map.get(s.id) ?? 0;
        return {
          id: s.id,
          label: s.label,
          count,
          rate: total > 0 ? Math.round((count / total) * 1000) / 10 : 0,
        };
      }),
    };
  }

  /**
   * Per-tenant module adoption matrix. "Using" means at least one row in
   * the last 30 days for the relevant table.
   */
  async getFeatureUsage() {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const rows = await this.dbAdmin.execute<{
      tenant_id: string;
      tenant_name: string;
      slug: string;
      attendance_users: number;
      leave_users: number;
      timesheet_users: number;
      employee_count: number;
    }>(sql`
      SELECT
        t.id           AS tenant_id,
        t.name         AS tenant_name,
        t.slug,
        (SELECT COUNT(DISTINCT a.employee_id)::int
           FROM attendance_punches a
          WHERE a.tenant_id = t.id AND a.punched_at >= ${since.toISOString()}) AS attendance_users,
        (SELECT COUNT(DISTINCT l.employee_id)::int
           FROM leave_requests l
          WHERE l.tenant_id = t.id AND l.applied_at >= ${since.toISOString()}) AS leave_users,
        (SELECT COUNT(DISTINCT p.employee_id)::int
           FROM timesheet_periods p
          WHERE p.tenant_id = t.id
            AND p.submitted_at IS NOT NULL
            AND p.submitted_at >= ${since.toISOString()}) AS timesheet_users,
        (SELECT COUNT(*)::int
           FROM employees e
          WHERE e.tenant_id = t.id
            AND e.status NOT IN ('separated', 'absconded')) AS employee_count
      FROM tenants t
      WHERE t.deleted_at IS NULL
        AND t.id <> ${SPECFLICKS_TENANT_ID}::uuid
      ORDER BY t.name
    `);

    return {
      windowDays: 30,
      tenants:
        ((rows as unknown as Array<{
          tenant_id: string;
          tenant_name: string;
          slug: string;
          attendance_users: number;
          leave_users: number;
          timesheet_users: number;
          employee_count: number;
        }>) ?? []).map((r) => {
          const empl = Number(r.employee_count ?? 0) || 1;
          return {
            tenantId: r.tenant_id,
            tenantName: r.tenant_name,
            slug: r.slug,
            employeeCount: Number(r.employee_count ?? 0),
            attendance: {
              users: Number(r.attendance_users ?? 0),
              adoption: Math.min(1, Number(r.attendance_users ?? 0) / empl),
            },
            leave: {
              users: Number(r.leave_users ?? 0),
              adoption: Math.min(1, Number(r.leave_users ?? 0) / empl),
            },
            timesheet: {
              users: Number(r.timesheet_users ?? 0),
              adoption: Math.min(1, Number(r.timesheet_users ?? 0) / empl),
            },
          };
        }),
    };
  }

  /**
   * Cross-tenant health distribution + the top at-risk tenants.
   */
  async getSystemHealth() {
    const bucketRows = await this.dbAdmin.execute<{ signal: string; n: number }>(sql`
      SELECT signal, COUNT(*)::int AS n
      FROM (
        SELECT DISTINCT ON (tenant_id) tenant_id, signal
        FROM tenant_health_snapshots
        WHERE tenant_id <> ${SPECFLICKS_TENANT_ID}::uuid
        ORDER BY tenant_id, snapshot_date DESC
      ) AS latest
      GROUP BY signal
    `);

    const buckets = {
      healthy: 0,
      at_risk: 0,
      churning: 0,
      expanding: 0,
      new: 0,
    } as Record<string, number>;
    for (const r of (bucketRows as unknown as Array<{ signal: string; n: number }>) ?? []) {
      buckets[r.signal] = Number(r.n);
    }

    const atRisk = await this.dbAdmin.execute<{
      tenant_id: string;
      tenant_name: string;
      slug: string;
      signal: string;
      health_score: number | null;
      support_tickets_open: number;
    }>(sql`
      SELECT t.id AS tenant_id, t.name AS tenant_name, t.slug,
             h.signal, h.health_score, h.support_tickets_open
      FROM tenants t
      JOIN LATERAL (
        SELECT signal, health_score, support_tickets_open
        FROM tenant_health_snapshots
        WHERE tenant_id = t.id
        ORDER BY snapshot_date DESC
        LIMIT 1
      ) h ON true
      WHERE t.deleted_at IS NULL
        AND t.id <> ${SPECFLICKS_TENANT_ID}::uuid
        AND h.signal IN ('at_risk', 'churning')
      ORDER BY h.health_score ASC NULLS LAST
      LIMIT 10
    `);

    return {
      buckets,
      atRiskTenants:
        ((atRisk as unknown as Array<{
          tenant_id: string;
          tenant_name: string;
          slug: string;
          signal: string;
          health_score: number | null;
          support_tickets_open: number;
        }>) ?? []).map((r) => ({
          tenantId: r.tenant_id,
          tenantName: r.tenant_name,
          slug: r.slug,
          signal: r.signal,
          healthScore: r.health_score != null ? Number(r.health_score) : null,
          supportTicketsOpen: Number(r.support_tickets_open ?? 0),
        })),
    };
  }

  /**
   * Tenants that have not yet been GST + PAN verified.
   */
  async getVerificationQueue() {
    const rows = await this.dbAdmin
      .select({
        id: tenants.id,
        name: tenants.name,
        slug: tenants.slug,
        legalName: tenants.legal_name,
        gstin: tenants.gstin,
        pan: tenants.pan,
        cin: tenants.cin,
        industry: tenants.industry,
        sizeBand: tenants.size_band,
        createdAt: tenants.created_at,
      })
      .from(tenants)
      .where(
        and(
          isNull(tenants.deleted_at),
          isNull(tenants.verified_at),
          ne(tenants.id, SPECFLICKS_TENANT_ID),
        ),
      )
      .orderBy(desc(tenants.created_at));

    return {
      data: rows.map((r) => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        legalName: r.legalName,
        gstin: r.gstin,
        pan: r.pan,
        cin: r.cin,
        industry: r.industry,
        sizeBand: r.sizeBand,
        createdAt: r.createdAt.toISOString(),
      })),
      total: rows.length,
    };
  }

  /**
   * Marks a tenant as verified (sets tenants.verified_at = now()).
   */
  async verifyTenant(tenantId: string, actorUserId: string) {
    if (tenantId === SPECFLICKS_TENANT_ID) {
      throw new NotFoundException('Tenant not found');
    }
    const now = new Date();
    const [row] = await this.dbAdmin
      .update(tenants)
      .set({ verified_at: now, verified_by_user_id: actorUserId, updated_at: now })
      .where(eq(tenants.id, tenantId))
      .returning({ id: tenants.id, verifiedAt: tenants.verified_at });

    if (!row) {
      throw new NotFoundException('Tenant not found');
    }

    await this.auditService.logPlatform({
      actorUserId,
      action: 'tenant.verified',
      targetTenantId: tenantId,
    });

    return {
      id: row.id,
      verifiedAt: row.verifiedAt?.toISOString() ?? null,
    };
  }

  /**
   * Platform-wide audit log (not tenant-filtered). Powers /fam/audit.
   */
  async getPlatformAudit(opts: { page?: number; limit?: number } = {}) {
    const page = Math.max(1, opts.page ?? 1);
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
    const offset = (page - 1) * limit;

    const rows = await this.dbAdmin
      .select({
        id: auditLogPlatform.id,
        action: auditLogPlatform.action,
        targetTenantId: auditLogPlatform.target_tenant_id,
        targetUserId: auditLogPlatform.target_user_id,
        metadata: auditLogPlatform.metadata,
        createdAt: auditLogPlatform.created_at,
        actorEmail: users.email,
        actorName: users.full_name,
        tenantName: tenants.name,
      })
      .from(auditLogPlatform)
      .leftJoin(users, eq(users.id, auditLogPlatform.actor_user_id))
      .leftJoin(tenants, eq(tenants.id, auditLogPlatform.target_tenant_id))
      .orderBy(desc(auditLogPlatform.created_at))
      .limit(limit)
      .offset(offset);

    const [{ n }] = await this.dbAdmin
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(auditLogPlatform);

    return {
      data: rows.map((r) => ({
        id: r.id,
        action: r.action,
        actor: r.actorName ?? r.actorEmail ?? 'system',
        actorEmail: r.actorEmail,
        targetTenantId: r.targetTenantId,
        targetTenantName: r.tenantName,
        targetUserId: r.targetUserId,
        metadata: r.metadata as Record<string, unknown> | null,
        createdAt: r.createdAt.toISOString(),
      })),
      pagination: { page, limit, total: Number(n ?? 0) },
    };
  }

  // ─── Invoicing v3 (§10): module toggles, auditor registry, seats, metrics ──
  //
  // Service-role only. FAM never reads invoice CONTENT here — only enablement,
  // membership/seat metadata, and anonymized aggregates.

  private static readonly MANAGED_MODULES = ['invoicing', 'payroll', 'expenses'];

  /** Per-module enablement for one tenant. Invoicing defaults ENABLED. */
  async getTenantModules(tenantId: string) {
    const rows = await this.dbAdmin
      .select({
        module: tenantModuleToggles.module,
        enabled: tenantModuleToggles.enabled,
        updatedAt: tenantModuleToggles.updated_at,
      })
      .from(tenantModuleToggles)
      .where(eq(tenantModuleToggles.tenant_id, tenantId));

    const byModule = new Map(rows.map((r) => [r.module, r]));
    return {
      data: FamService.MANAGED_MODULES.map((module) => {
        const row = byModule.get(module);
        return {
          module,
          // Invoicing is on by default; payroll/expenses are reserved (off).
          enabled: row ? row.enabled : module === 'invoicing',
          live: module === 'invoicing',
          updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
        };
      }),
    };
  }

  /** Enable/disable a module for a tenant (the guard reads this; wins over grants). */
  async setTenantModule(
    tenantId: string,
    module: string,
    enabled: boolean,
    actorUserId: string,
  ) {
    if (!FamService.MANAGED_MODULES.includes(module)) {
      throw new BadRequestException(`Unknown module: ${module}`);
    }
    const [tenant] = await this.dbAdmin
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (!tenant) throw new NotFoundException('Tenant not found');

    const [row] = await this.dbAdmin
      .insert(tenantModuleToggles)
      .values({ tenant_id: tenantId, module, enabled, updated_by: actorUserId })
      .onConflictDoUpdate({
        target: [tenantModuleToggles.tenant_id, tenantModuleToggles.module],
        set: { enabled, updated_by: actorUserId, updated_at: new Date() },
      })
      .returning();

    await this.auditService.log({
      tenantId,
      actorUserId,
      action: 'fam.module_toggled',
      resourceType: 'tenant_module_toggle',
      resourceId: row.id,
      afterState: { module, enabled },
    });

    return { data: { module: row.module, enabled: row.enabled } };
  }

  /** Auditor-link registry: every auditor membership ↔ company ↔ status ↔ window. */
  async getAuditorRegistry() {
    const rows = await this.dbAdmin
      .select({
        userId: memberships.user_id,
        tenantId: memberships.tenant_id,
        status: memberships.status,
        isExternal: memberships.is_external,
        accessExpiresAt: memberships.access_expires_at,
        invitedAt: memberships.invited_at,
        email: users.email,
        fullName: users.full_name,
        tenantName: tenants.name,
      })
      .from(memberships)
      .innerJoin(users, eq(memberships.user_id, users.id))
      .innerJoin(tenants, eq(memberships.tenant_id, tenants.id))
      .where(eq(memberships.role, 'auditor'))
      .orderBy(users.email, tenants.name);

    // Group by auditor (email): one row per auditor, list of linked companies.
    const byUser = new Map<
      string,
      {
        userId: string;
        email: string | null;
        fullName: string | null;
        companies: Array<{
          tenantId: string;
          tenantName: string;
          status: string;
          isExternal: boolean;
          accessExpiresAt: string | null;
        }>;
      }
    >();
    for (const r of rows) {
      const entry = byUser.get(r.userId) ?? {
        userId: r.userId,
        email: r.email,
        fullName: r.fullName,
        companies: [],
      };
      entry.companies.push({
        tenantId: r.tenantId,
        tenantName: r.tenantName,
        status: r.status,
        isExternal: r.isExternal,
        accessExpiresAt: r.accessExpiresAt
          ? r.accessExpiresAt.toISOString()
          : null,
      });
      byUser.set(r.userId, entry);
    }

    return { data: Array.from(byUser.values()) };
  }

  /** Revoke a single auditor↔company link (deactivate the membership). */
  async revokeAuditorLink(
    userId: string,
    tenantId: string,
    actorUserId: string,
  ) {
    const [membership] = await this.dbAdmin
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.user_id, userId),
          eq(memberships.tenant_id, tenantId),
          eq(memberships.role, 'auditor'),
        ),
      )
      .limit(1);
    if (!membership) throw new NotFoundException('Auditor link not found');

    const [updated] = await this.dbAdmin
      .update(memberships)
      .set({ status: 'deactivated' })
      .where(eq(memberships.id, membership.id))
      .returning();

    await this.auditService.log({
      tenantId,
      actorUserId,
      action: 'fam.auditor_link_revoked',
      resourceType: 'membership',
      resourceId: membership.id,
      beforeState: { status: membership.status },
      afterState: { status: updated.status },
    });

    return { data: { userId, tenantId, status: updated.status } };
  }

  /** Member (billable) vs auditor (non-billable) seat split for one tenant. */
  async getTenantSeats(tenantId: string) {
    const [row] = await this.dbAdmin
      .select({
        billable: sql<number>`count(*) filter (where ${memberships.role} <> 'auditor' and ${memberships.status} = 'active')::int`,
        auditors: sql<number>`count(*) filter (where ${memberships.role} = 'auditor' and ${memberships.status} = 'active')::int`,
        pending: sql<number>`count(*) filter (where ${memberships.status} = 'invited')::int`,
      })
      .from(memberships)
      .where(eq(memberships.tenant_id, tenantId));

    return {
      data: {
        billable: Number(row?.billable ?? 0),
        auditors: Number(row?.auditors ?? 0),
        pending: Number(row?.pending ?? 0),
      },
    };
  }

  /**
   * Anonymized aggregate metrics (PRD §10.4). Counts and distributions only —
   * never customer/amount/description content.
   */
  async getInvoicingMetrics() {
    // Auditor reach.
    const auditorRows = await this.dbAdmin
      .select({
        tenantId: memberships.tenant_id,
        userId: memberships.user_id,
      })
      .from(memberships)
      .where(
        and(eq(memberships.role, 'auditor'), eq(memberships.status, 'active')),
      );
    const tenantsWithAuditor = new Set(auditorRows.map((r) => r.tenantId));
    const companiesByAuditor = new Map<string, number>();
    for (const r of auditorRows) {
      companiesByAuditor.set(
        r.userId,
        (companiesByAuditor.get(r.userId) ?? 0) + 1,
      );
    }
    const perAuditorCounts = Array.from(companiesByAuditor.values()).sort(
      (a, b) => a - b,
    );
    const multiCompanyAuditors = perAuditorCounts.filter((c) => c > 1).length;
    const median =
      perAuditorCounts.length === 0
        ? 0
        : perAuditorCounts[Math.floor((perAuditorCounts.length - 1) / 2)]!;

    // Bank-account adoption + SWIFT (foreign-currency) usage.
    const bankRows = await this.dbAdmin
      .select({ tenantId: tenantBankAccounts.tenant_id, swift: tenantBankAccounts.swift_bic })
      .from(tenantBankAccounts);
    const tenantsWithBank = new Set(bankRows.map((r) => r.tenantId));
    const tenantsWithSwift = new Set(
      bankRows.filter((r) => r.swift).map((r) => r.tenantId),
    );

    // Invoicing adoption (tenants that have created ≥1 invoice) — count only.
    const invoicedRows = await this.dbAdmin
      .selectDistinct({ tenantId: invoices.tenant_id })
      .from(invoices)
      .where(eq(invoices.document_type, 'INVOICE'));

    return {
      data: {
        tenantsWithAuditor: tenantsWithAuditor.size,
        multiCompanyAuditors,
        medianCompaniesPerAuditor: median,
        tenantsWithBankAccount: tenantsWithBank.size,
        tenantsUsingForeignCurrency: tenantsWithSwift.size,
        tenantsWithInvoices: invoicedRows.length,
      },
    };
  }
}
