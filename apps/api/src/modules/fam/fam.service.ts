import {
  Injectable,
  Logger,
  Inject,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  Optional,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { and, desc, eq, gte, gt, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { EventEmitter2 } from '@nestjs/event-emitter';

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
  invoicingDebugConsents,
  razorpayWebhookEvents,
  auditLog,
  notifications,
  famTenantNotes,
} from '@flicks/db/schema';
import { DB_SERVICE_ROLE } from '../../core/database/database.module';
import type { DbAdmin } from '@flicks/db';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { MediaService } from '../media/media.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  AnalyticsService,
  SERVER_EVENTS,
} from '../../core/analytics/analytics.service';
import type { UserRole } from '@flicks/shared/types';
import { BillingService } from '../billing/public';
import { EmployeesPublicService } from '../employees/public';
import { BillingStateService } from '../../core/billing/billing-state.service';
import type {
  SuspendTenantDto,
  ExtendTrialDto,
  StartImpersonationDto,
  UpsertFeatureFlagDto,
  UpsertCohortDto,
  TenantListQueryDto,
  FamAuditQueryDto,
  TenantActivityQueryDto,
} from './fam.dto';

/** Who did it, from where — stamped on every platform audit row (Round R R2). */
export interface FamActor {
  userId: string;
  ip?: string;
  userAgent?: string;
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(columns: string[], rows: Array<Record<string, unknown>>): string {
  return [columns.join(','), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(','))].join('\n') + '\n';
}

function parseDate(v?: string): Date | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

@Injectable()
export class FamService {
  private readonly logger = new Logger(FamService.name);

  constructor(
    @Inject(DB_SERVICE_ROLE) private readonly dbAdmin: DbAdmin,
    private readonly auditService: AuditService,
    private readonly authService: AuthService,
    private readonly notificationsService: NotificationsService,
    private readonly analytics: AnalyticsService,
    private readonly mediaService: MediaService,
    // Round R R2 — optional so the hand-built service in older specs keeps
    // its 6-arg form.
    @Optional() private readonly billingService?: BillingService,
    @Optional() private readonly employeesPublic?: EmployeesPublicService,
    @Optional() private readonly billingState?: BillingStateService,
    @Optional() private readonly eventEmitter?: EventEmitter2,
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
        verifiedAt: tenants.verified_at,
        logoKey: tenants.logo_key,
        logoUrlLegacy: tenants.logo_url,
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
    const data = (
      await Promise.all(
        baseRows.map(async (r) => {
          const h = healthByTenant.get(r.id);
          return {
            id: r.id,
            name: r.name,
            slug: r.slug,
            status: r.status,
            createdAt: r.createdAt.toISOString(),
            trialEndsAt: r.trialEndsAt?.toISOString() ?? null,
            verifiedAt: r.verifiedAt?.toISOString() ?? null,
            // Signed URL from the uploaded logo_key, else the legacy URL —
            // same serving rule as the customer app (settings/auth).
            logoUrl: await this.mediaService.servedUrl(r.logoKey, r.logoUrlLegacy, 64),
            plan: r.planCode ?? null,
            subStatus: r.subStatus ?? null,
            mrr: r.mrrAmount != null ? Number(r.mrrAmount) : 0,
            userCount: r.userCount ?? 0,
            memberCount: memberCountByTenant.get(r.id) ?? 0,
            signal: h?.signal ?? null,
            healthScore: h?.healthScore ?? null,
          };
        }),
      )
    ).filter((t) => (query.signal ? t.signal === query.signal : true));

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
          isNull(employees.deleted_at), // round 21 — removed staff are not a seat
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
      // logo_key is the live column (R2 upload); logo_url is legacy-only.
      logoUrl: await this.mediaService.servedUrl(tenant.logo_key, tenant.logo_url, 256),
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
        // Round R R2: the support tab's "Resend invite" needs the employee id.
        employeeId: memberships.employee_id,
        lastLoginAt: users.last_login_at,
        email: users.email,
        fullName: users.full_name,
        // Round N: the member list shows faces. The photo upload writes
        // users.avatar_key only, so sign it here; avatarKey never leaves.
        avatarKey: users.avatar_key,
        avatarUrlLegacy: users.avatar_url,
      })
      .from(memberships)
      .leftJoin(users, eq(users.id, memberships.user_id))
      .where(eq(memberships.tenant_id, tenantId))
      .orderBy(rolePrecedence, users.full_name);

    return {
      data: await Promise.all(
        rows.map(async (r) => ({
          membershipId: r.membershipId,
          userId: r.userId,
          employeeId: r.employeeId ?? null,
          email: r.email ?? null,
          fullName: r.fullName ?? null,
          avatarUrl: await this.mediaService.servedUrl(r.avatarKey, r.avatarUrlLegacy, 64),
          role: r.role,
          status: r.status,
          invitedAt: r.invitedAt?.toISOString() ?? null,
          acceptedAt: r.acceptedAt?.toISOString() ?? null,
          lastLoginAt: r.lastLoginAt?.toISOString() ?? null,
        })),
      ),
    };
  }

  /**
   * Round R R2 — suspend that really blocks. Saves what the suspension
   * interrupted (Reactivate puts it back), flips the status, retires every
   * live session of every member (login / refresh / switch / every tenant
   * route refuse a suspended company), tells the Owners, and audits with the
   * admin's IP / user agent. The Specflicks tenant can never be suspended.
   */
  async suspendTenant(tenantId: string, actor: FamActor, dto: SuspendTenantDto) {
    if (tenantId === SPECFLICKS_TENANT_ID) {
      throw new BadRequestException('The Specflicks platform tenant cannot be suspended');
    }
    const [current] = await this.dbAdmin
      .select({ id: tenants.id, name: tenants.name, status: tenants.status })
      .from(tenants)
      .where(and(eq(tenants.id, tenantId), isNull(tenants.deleted_at)))
      .limit(1);
    if (!current) throw new NotFoundException('Tenant not found');
    if (current.status === 'suspended') {
      throw new ConflictException('This workspace is already suspended');
    }
    const now = new Date();
    const [updated] = await this.dbAdmin
      .update(tenants)
      .set({ status: 'suspended', status_before_suspend: current.status, updated_at: now })
      .where(eq(tenants.id, tenantId))
      .returning({ id: tenants.id, status: tenants.status });

    let sessionsRevoked = 0;
    try {
      sessionsRevoked = await this.authService.revokeTenantSessions(tenantId);
    } catch (err) {
      this.logger.warn(`suspend ${tenantId}: session revoke failed: ${(err as Error).message}`);
    }

    await this.auditService.logPlatform({
      actorUserId: actor.userId,
      action: 'tenant.suspended',
      targetTenantId: tenantId,
      metadata: { reason: dto.reason, previousStatus: current.status, sessionsRevoked },
      ipAddress: actor.ip,
      userAgent: actor.userAgent,
    });
    this.billingState?.invalidate(tenantId);

    // Owners hear about it — best-effort, after the write (house rules 6/7).
    void this.notifyOwners(tenantId, 'workspace-suspended', (name) => ({
      recipientName: name,
      tenantName: current.name,
      reason: dto.reason,
    }));

    return { id: updated!.id, status: updated!.status, previousStatus: current.status, sessionsRevoked };
  }

  /**
   * Lifts a suspension: the status goes back to what it was before (a trial
   * stays a trial), not blindly to 'active'.
   */
  async reactivateTenant(tenantId: string, actor: FamActor) {
    const [current] = await this.dbAdmin
      .select({ id: tenants.id, name: tenants.name, status: tenants.status, before: tenants.status_before_suspend })
      .from(tenants)
      .where(and(eq(tenants.id, tenantId), isNull(tenants.deleted_at)))
      .limit(1);
    if (!current) throw new NotFoundException('Tenant not found');
    if (current.status !== 'suspended') {
      throw new ConflictException('This workspace is not suspended');
    }
    const restored = current.before ?? 'active';
    const now = new Date();
    const [updated] = await this.dbAdmin
      .update(tenants)
      .set({ status: restored, status_before_suspend: null, updated_at: now })
      .where(eq(tenants.id, tenantId))
      .returning({ id: tenants.id, status: tenants.status });

    await this.auditService.logPlatform({
      actorUserId: actor.userId,
      action: 'tenant.reactivated',
      targetTenantId: tenantId,
      metadata: { restoredStatus: restored },
      ipAddress: actor.ip,
      userAgent: actor.userAgent,
    });
    this.billingState?.invalidate(tenantId);
    void this.notifyOwners(tenantId, 'workspace-reactivated', (name) => ({
      recipientName: name,
      tenantName: current.name,
    }));

    return { id: updated!.id, status: updated!.status };
  }

  /**
   * Extends a tenant's trial by N days — from today or the current trial end,
   * whichever is later (an expired trial used to get days added to a date in
   * the past and stayed locked). One expression on both rows the paywall and
   * the fallbacks read, a plan-history event, and the billing cache dropped so
   * the 402 wall lifts on the next request.
   */
  async extendTrial(tenantId: string, actor: FamActor, dto: ExtendTrialDto) {
    const [tenantRow] = await this.dbAdmin
      .select({ id: tenants.id })
      .from(tenants)
      .where(and(eq(tenants.id, tenantId), isNull(tenants.deleted_at)))
      .limit(1);
    if (!tenantRow) throw new NotFoundException('Tenant not found');

    const [current] = await this.dbAdmin
      .select({ status: subscriptions.status, razorpayId: subscriptions.razorpay_subscription_id })
      .from(subscriptions)
      .where(eq(subscriptions.tenant_id, tenantId))
      .limit(1);
    // A live Razorpay subscription decides its own dates — an "extension"
    // would change nothing about what is charged or when, so say so instead
    // of reporting a success that is not one. A canceled one is dead at
    // Razorpay: more time is a real lever there.
    if (current?.razorpayId && current.status !== 'canceled') {
      throw new BadRequestException(
        'This workspace pays through Razorpay — a trial extension would not change what it is charged or when. Adjust the subscription in Razorpay instead.',
      );
    }
    // A company with no subscription row yet gets the standard trialing one
    // (the paywall reads it), exactly as the Billing tab promises.
    if (!current) await this.billingService?.ensureRow(tenantId);

    const days = Math.floor(dto.days);
    const extension = sql`GREATEST(coalesce(trial_ends_at, now()), now()) + (${days} || ' days')::interval`;
    // A canceled subscription's lock reads current_period_end — slide it too
    // (when set), as the console always did.
    const periodExtension = sql`CASE WHEN current_period_end IS NULL THEN NULL ELSE GREATEST(current_period_end, now()) + (${days} || ' days')::interval END`;
    const now = new Date();
    await this.dbAdmin
      .update(tenants)
      .set({ trial_ends_at: extension, updated_at: now })
      .where(eq(tenants.id, tenantId));
    const [sub] = await this.dbAdmin
      .update(subscriptions)
      .set({ trial_ends_at: extension, current_period_end: periodExtension, updated_at: now })
      .where(eq(subscriptions.tenant_id, tenantId))
      .returning({ id: subscriptions.id, trialEndsAt: subscriptions.trial_ends_at });
    const [after] = await this.dbAdmin
      .select({ trialEndsAt: tenants.trial_ends_at })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    // The paywall reads the subscription row when there is one.
    const newTrialEndsAt = sub?.trialEndsAt ?? after?.trialEndsAt ?? null;

    if (sub) {
      await this.dbAdmin.insert(subscriptionEvents).values({
        tenant_id: tenantId,
        subscription_id: sub.id,
        event_type: 'trial.extended',
        // The plan history is the customer's; the reason and the staff id
        // stay on the platform audit log below.
        metadata: { days },
      });
    }
    await this.auditService.logPlatform({
      actorUserId: actor.userId,
      action: 'tenant.trial.extended',
      targetTenantId: tenantId,
      metadata: { days, reason: dto.reason, newTrialEndsAt: newTrialEndsAt?.toISOString() ?? null },
      ipAddress: actor.ip,
      userAgent: actor.userAgent,
    });
    this.billingState?.invalidate(tenantId);

    return {
      id: tenantId,
      trialEndsAt: newTrialEndsAt?.toISOString() ?? null,
      extendedByDays: days,
    };
  }

  /** Round R R2 — "Give free months": a private coupon applied on the company's behalf. */
  async grantFreeMonths(tenantId: string, actor: FamActor, input: { months: number; reason: string }) {
    if (!this.billingService) throw new ServiceUnavailableException('Billing is not available');
    const [t] = await this.dbAdmin
      .select({ id: tenants.id })
      .from(tenants)
      .where(and(eq(tenants.id, tenantId), isNull(tenants.deleted_at), ne(tenants.id, SPECFLICKS_TENANT_ID)))
      .limit(1);
    if (!t) throw new NotFoundException('Tenant not found');
    return this.billingService.grantFreeMonths(tenantId, actor.userId, {
      months: input.months,
      reason: input.reason,
      ip: actor.ip,
      userAgent: actor.userAgent,
    });
  }

  /** Every active Owner of a company, emailed best-effort. */
  private async notifyOwners(
    tenantId: string,
    template: 'workspace-suspended' | 'workspace-reactivated',
    props: (recipientName: string) => Record<string, unknown>,
  ): Promise<void> {
    try {
      const owners = await this.dbAdmin
        .select({ email: users.email, name: users.full_name })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.user_id))
        .where(
          and(
            eq(memberships.tenant_id, tenantId),
            eq(memberships.status, 'active'),
            eq(memberships.role, 'owner'),
          ),
        );
      for (const o of owners) {
        await this.notificationsService
          .sendEmail(template, o.email, props(o.name ?? o.email))
          .catch((err: unknown) => this.logger.warn(`${template} email to ${o.email} failed: ${String(err)}`));
      }
    } catch (err) {
      this.logger.warn(`${template}: owner lookup failed: ${(err as Error).message}`);
    }
  }

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
          isNull(employees.deleted_at), // round 21 — removed staff are not a seat
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

    // Round R R2: the applied coupon, the grace window and a LIVE seat count
    // (the stored one is recounted lazily) so the support panel explains
    // "₹0 MRR on a trial" instead of looking broken.
    const [coupon, seats] = await Promise.all([
      this.billingService?.couponForTenant(tenantId) ?? Promise.resolve(null),
      this.billingService?.billableSeats(tenantId) ?? Promise.resolve(Number(sub.user_count ?? 0)),
    ]);

    return {
      subscription: {
        id: sub.id,
        planCode: sub.plan_code,
        status: sub.status,
        perUserPrice: Number(sub.per_user_price ?? 0),
        userCount: Number(sub.user_count ?? 0),
        seats,
        monthlyEstimate: seats * Number(sub.per_user_price ?? 0),
        mrr: Number(sub.mrr_amount ?? 0),
        billingCycle: sub.billing_cycle,
        trialEndsAt: sub.trial_ends_at?.toISOString() ?? null,
        graceEndsAt: sub.grace_ends_at?.toISOString() ?? null,
        currentPeriodStart: sub.current_period_start?.toISOString() ?? null,
        currentPeriodEnd: sub.current_period_end?.toISOString() ?? null,
        cancelAtPeriodEnd: sub.cancel_at_period_end,
        canceledAt: sub.canceled_at?.toISOString() ?? null,
        razorpaySubscriptionId: sub.razorpay_subscription_id,
        createdAt: sub.created_at.toISOString(),
        coupon,
      },
      events: events.map((e) => ({
        id: e.id,
        eventType: e.eventType,
        metadata: e.metadata as Record<string, unknown> | null,
        createdAt: e.createdAt.toISOString(),
      })),
    };
  }

  /** WHERE clause shared by the platform audit log and its per-company view. */
  private platformAuditWhere(q: FamAuditQueryDto, tenantId?: string) {
    const conditions: Array<ReturnType<typeof eq>> = [];
    if (tenantId) conditions.push(eq(auditLogPlatform.target_tenant_id, tenantId));
    else if (q.tenantId) conditions.push(eq(auditLogPlatform.target_tenant_id, q.tenantId));
    if (q.action?.trim()) {
      // Comma-separated alternatives; a leading ^ anchors a term to the start
      // of the action ("^tenant." = the company lifecycle only, which a plain
      // substring would confuse with fam.tenant.note_*).
      const alts = q.action
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
        .map((t) =>
          t.startsWith('^')
            ? sql`${auditLogPlatform.action} ILIKE ${`${t.slice(1)}%`}`
            : sql`${auditLogPlatform.action} ILIKE ${`%${t}%`}`,
        );
      if (alts.length) conditions.push((alts.length === 1 ? alts[0] : or(...alts)) as never);
    }
    if (q.actor?.trim()) {
      const needle = `%${q.actor.trim().toLowerCase()}%`;
      conditions.push(
        sql`EXISTS (SELECT 1 FROM users au WHERE au.id = ${auditLogPlatform.actor_user_id} AND (lower(au.email) LIKE ${needle} OR lower(au.full_name) LIKE ${needle}))` as never,
      );
    }
    const from = parseDate(q.from);
    const to = parseDate(q.to);
    if (from) conditions.push(gte(auditLogPlatform.created_at, from) as never);
    if (to) conditions.push(lte(auditLogPlatform.created_at, to) as never);
    return conditions.length ? and(...conditions) : undefined;
  }

  private async platformAuditRows(where: ReturnType<typeof and> | undefined, limit: number, offset: number) {
    return this.dbAdmin
      .select({
        id: auditLogPlatform.id,
        action: auditLogPlatform.action,
        actorUserId: auditLogPlatform.actor_user_id,
        targetTenantId: auditLogPlatform.target_tenant_id,
        targetUserId: auditLogPlatform.target_user_id,
        metadata: auditLogPlatform.metadata,
        ipAddress: auditLogPlatform.ip_address,
        userAgent: auditLogPlatform.user_agent,
        createdAt: auditLogPlatform.created_at,
        actorEmail: users.email,
        actorName: users.full_name,
        tenantName: tenants.name,
      })
      .from(auditLogPlatform)
      .leftJoin(users, eq(users.id, auditLogPlatform.actor_user_id))
      .leftJoin(tenants, eq(tenants.id, auditLogPlatform.target_tenant_id))
      .where(where)
      .orderBy(desc(auditLogPlatform.created_at))
      .limit(limit)
      .offset(offset);
  }

  /**
   * Platform audit log entries scoped to a single tenant for the Audit tab —
   * Round R R2: filters (action, actor, dates) like the platform-wide log.
   */
  async getTenantAudit(tenantId: string, q: FamAuditQueryDto = {}) {
    const page = Math.max(1, q.page ?? 1);
    const limit = Math.max(1, Math.min(q.limit ?? 50, 100));
    const where = this.platformAuditWhere(q, tenantId);
    const [rows, [{ n }]] = await Promise.all([
      this.platformAuditRows(where, limit, (page - 1) * limit),
      this.dbAdmin.select({ n: sql<number>`COUNT(*)::int` }).from(auditLogPlatform).where(where),
    ]);
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
        userAgent: r.userAgent,
        createdAt: r.createdAt.toISOString(),
      })),
      pagination: { page, limit, total: Number(n ?? 0) },
    };
  }

  /** Platform-wide audit log with filters (Round R R2 wires the page's controls). */
  async getPlatformAudit(q: FamAuditQueryDto = {}) {
    const page = Math.max(1, q.page ?? 1);
    const limit = Math.max(1, Math.min(q.limit ?? 50, 200));
    const where = this.platformAuditWhere(q);
    const [rows, [{ n }]] = await Promise.all([
      this.platformAuditRows(where, limit, (page - 1) * limit),
      this.dbAdmin.select({ n: sql<number>`COUNT(*)::int` }).from(auditLogPlatform).where(where),
    ]);
    return {
      data: rows.map((r) => ({
        id: r.id,
        action: r.action,
        actor: r.actorName ?? r.actorEmail ?? 'system',
        actorEmail: r.actorEmail,
        actorUserId: r.actorUserId,
        targetTenantId: r.targetTenantId,
        targetTenantName: r.tenantName,
        targetUserId: r.targetUserId,
        metadata: r.metadata as Record<string, unknown> | null,
        ipAddress: r.ipAddress,
        userAgent: r.userAgent,
        createdAt: r.createdAt.toISOString(),
      })),
      pagination: { page, limit, total: Number(n ?? 0) },
    };
  }

  /** CSV of the platform audit log (whole platform or one company), newest first, up to 5 000 rows. */
  async exportPlatformAuditCsv(q: FamAuditQueryDto = {}, tenantId?: string): Promise<string> {
    const rows = await this.platformAuditRows(this.platformAuditWhere(q, tenantId), 5000, 0);
    return toCsv(
      ['when', 'action', 'actor', 'actor_email', 'company', 'target_tenant_id', 'target_user_id', 'ip', 'user_agent', 'metadata'],
      rows.map((r) => ({
        when: r.createdAt.toISOString(),
        action: r.action,
        actor: r.actorName ?? '',
        actor_email: r.actorEmail ?? '',
        company: r.tenantName ?? '',
        target_tenant_id: r.targetTenantId ?? '',
        target_user_id: r.targetUserId ?? '',
        ip: r.ipAddress ?? '',
        user_agent: r.userAgent ?? '',
        metadata: r.metadata ?? '',
      })),
    );
  }

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
      // Round R R2: nobody signs in to a suspended company — staff included.
      ne(tenants.status, 'suspended'),
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
      .innerJoin(tenants, eq(tenants.id, memberships.tenant_id))
      .where(and(...filters))
      .orderBy(memberships.created_at)
      .limit(1);

    if (!target) {
      throw new NotFoundException('Target user has no active tenant membership (or the company is suspended)');
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
      undefined,
      undefined,
      undefined,
      undefined,
      // The admin cleared the FAM second factor to start impersonating.
      { mfa: true },
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
        logoKey: tenants.logo_key,
        logoUrlLegacy: tenants.logo_url,
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
      // Round R: the console's Top tenants showed initials only — the logo
      // the company uploaded in Settings → Organization now rides along.
      topPaying: await Promise.all(
        topPaying.map(async (r) => ({
          tenantId: r.tenantId,
          tenantName: r.tenantName,
          slug: r.slug,
          planCode: r.planCode,
          mrr: Number(r.mrr ?? 0),
          userCount: Number(r.userCount ?? 0),
          status: r.status,
          logoUrl: await this.mediaService.servedUrl(r.logoKey, r.logoUrlLegacy, 64),
        })),
      ),
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
   * PRD v4 §6 / D13 — the SECOND funnel block: Invoicing activation F1–F5.
   * Computed from business tables (authoritative even before product_events
   * accumulates history): signed_up → org_configured → first invoice created
   * → first invoice sent → first payment received. The existing signup funnel
   * block above is untouched.
   */
  async getInvoicingFunnel() {
    const totals = await this.dbAdmin.execute<{ stage: string; n: number }>(sql`
      WITH t AS (
        SELECT id FROM tenants
        WHERE deleted_at IS NULL AND id <> ${SPECFLICKS_TENANT_ID}::uuid
      )
      SELECT 'signed_up'::text AS stage, COUNT(*)::int AS n FROM t
      UNION ALL
      SELECT 'org_configured', COUNT(*)::int FROM t
        WHERE EXISTS (SELECT 1 FROM locations   l WHERE l.tenant_id = t.id)
          AND EXISTS (SELECT 1 FROM departments d WHERE d.tenant_id = t.id)
      UNION ALL
      SELECT 'first_invoice_created', COUNT(*)::int FROM t
        WHERE EXISTS (SELECT 1 FROM invoices i WHERE i.tenant_id = t.id)
      UNION ALL
      SELECT 'first_invoice_sent', COUNT(*)::int FROM t
        WHERE EXISTS (SELECT 1 FROM invoices i
                       WHERE i.tenant_id = t.id AND i.status <> 'DRAFT')
      UNION ALL
      SELECT 'first_payment_received', COUNT(*)::int FROM t
        WHERE EXISTS (SELECT 1 FROM invoice_payments p WHERE p.tenant_id = t.id)
    `);
    const map = new Map<string, number>();
    for (const r of (totals as unknown as Array<{ stage: string; n: number }>) ?? []) {
      map.set(r.stage, Number(r.n));
    }
    const total = map.get('signed_up') ?? 0;
    const stages = [
      { id: 'signed_up', label: 'signed_up' },
      { id: 'org_configured', label: 'org_configured' },
      { id: 'first_invoice_created', label: 'first_invoice_created' },
      { id: 'first_invoice_sent', label: 'first_invoice_sent' },
      { id: 'first_payment_received', label: 'first_payment_received' },
    ];
    return {
      total,
      stages: stages.map((s2) => {
        const count = map.get(s2.id) ?? 0;
        return {
          id: s2.id,
          label: s2.label,
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
      logo_key: string | null;
      logo_url: string | null;
      attendance_users: number;
      leave_users: number;
      timesheet_users: number;
      employee_count: number;
    }>(sql`
      SELECT
        t.id           AS tenant_id,
        t.name         AS tenant_name,
        t.slug,
        t.logo_key,
        t.logo_url,
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
      tenants: await Promise.all(
        ((rows as unknown as Array<{
          tenant_id: string;
          tenant_name: string;
          slug: string;
          logo_key: string | null;
          logo_url: string | null;
          attendance_users: number;
          leave_users: number;
          timesheet_users: number;
          employee_count: number;
        }>) ?? []).map(async (r) => {
          const empl = Number(r.employee_count ?? 0) || 1;
          return {
            tenantId: r.tenant_id,
            tenantName: r.tenant_name,
            slug: r.slug,
            logoUrl: await this.mediaService.servedUrl(r.logo_key, r.logo_url, 64),
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
      ),
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
      logo_key: string | null;
      logo_url: string | null;
      signal: string;
      health_score: number | null;
      support_tickets_open: number;
    }>(sql`
      SELECT t.id AS tenant_id, t.name AS tenant_name, t.slug, t.logo_key, t.logo_url,
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
      atRiskTenants: await Promise.all(
        ((atRisk as unknown as Array<{
          tenant_id: string;
          tenant_name: string;
          slug: string;
          logo_key: string | null;
          logo_url: string | null;
          signal: string;
          health_score: number | null;
          support_tickets_open: number;
        }>) ?? []).map(async (r) => ({
          tenantId: r.tenant_id,
          tenantName: r.tenant_name,
          slug: r.slug,
          logoUrl: await this.mediaService.servedUrl(r.logo_key, r.logo_url, 64),
          signal: r.signal,
          healthScore: r.health_score != null ? Number(r.health_score) : null,
          supportTicketsOpen: Number(r.support_tickets_open ?? 0),
        })),
      ),
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
        logoKey: tenants.logo_key,
        logoUrlLegacy: tenants.logo_url,
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
      data: await Promise.all(
        rows.map(async (r) => ({
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
          logoUrl: await this.mediaService.servedUrl(r.logoKey, r.logoUrlLegacy, 64),
        })),
      ),
      total: rows.length,
    };
  }

  /**
   * Marks a tenant as verified (sets tenants.verified_at = now()). This is
   * the ONLY writer of verified_at in the application — the badge can never
   * appear without a FAM admin taking this action.
   */
  async verifyTenant(tenantId: string, actorUserId: string, notes?: string) {
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
      metadata: notes?.trim() ? { notes: notes.trim() } : undefined,
    });

    return {
      id: row.id,
      verifiedAt: row.verifiedAt?.toISOString() ?? null,
    };
  }


  // ─── Invoicing v3 (§10): module toggles, auditor registry, seats, metrics ──
  //
  // Service-role only. FAM never reads invoice CONTENT here — only enablement,
  // membership/seat metadata, and anonymized aggregates.

  // Round P R3: 'policies' (company policies) is a FAM-toggleable module like
  // invoicing/crm — the PoliciesGrantGuard reads the same tenant_module_toggles
  // row, so a platform kill-switch bites on the next request.
  private static readonly MANAGED_MODULES = ['invoicing', 'crm', 'payroll', 'expenses', 'policies'];
  /** ON when no toggle row exists (PRD v5 §13: crm ships default-enabled). */
  private static readonly DEFAULT_ENABLED = new Set(['invoicing', 'crm', 'policies']);

  /** Per-module enablement for one tenant. Invoicing + CRM default ENABLED. */
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
          // Invoicing/CRM on by default; payroll/expenses are reserved (off).
          enabled: row ? row.enabled : FamService.DEFAULT_ENABLED.has(module),
          live: FamService.DEFAULT_ENABLED.has(module),
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
        // Round N: the registry renders a person chip per auditor — signed
        // below, one signature per auditor (not per auditor↔company link).
        avatarKey: users.avatar_key,
        avatarUrlLegacy: users.avatar_url,
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
        avatarKey: string | null;
        avatarUrlLegacy: string | null;
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
        avatarKey: r.avatarKey,
        avatarUrlLegacy: r.avatarUrlLegacy,
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

    // Round N: strip the raw key and hand back a signed 64px url instead.
    return {
      data: await Promise.all(
        Array.from(byUser.values()).map(async ({ avatarKey, avatarUrlLegacy, ...a }) => ({
          ...a,
          avatarUrl: await this.mediaService.servedUrl(avatarKey, avatarUrlLegacy, 64),
        })),
      ),
    };
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
        billable: sql<number>`count(*) filter (where ${memberships.role} not in ('auditor', 'guest') and ${memberships.status} = 'active')::int`,
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

  /**
   * Consented debug (PRD §10.5). Requires an ACTIVE consent row from the
   * tenant's Owner; returns invoice count/status distribution + webhook/email/
   * audit LOG METADATA only (never amounts/customers/descriptions). Every
   * access is written to the platform audit log.
   */
  async getInvoicingDebug(tenantId: string, actorUserId: string) {
    const [consent] = await this.dbAdmin
      .select()
      .from(invoicingDebugConsents)
      .where(
        and(
          eq(invoicingDebugConsents.tenant_id, tenantId),
          isNull(invoicingDebugConsents.revoked_at),
          or(
            isNull(invoicingDebugConsents.expires_at),
            gt(invoicingDebugConsents.expires_at, new Date()),
          ),
        ),
      )
      .orderBy(desc(invoicingDebugConsents.created_at))
      .limit(1);

    if (!consent) {
      throw new ForbiddenException(
        'No active debug consent from this tenant. Ask the Owner to grant access under Invoicing → Settings.',
      );
    }

    // Invoice status distribution (counts only).
    const statusRows = await this.dbAdmin
      .select({ status: invoices.status, n: sql<number>`count(*)::int` })
      .from(invoices)
      .where(and(eq(invoices.tenant_id, tenantId), eq(invoices.document_type, 'INVOICE')))
      .groupBy(invoices.status);

    // Razorpay webhook log (metadata only).
    const recentWebhooks = await this.dbAdmin
      .select({
        eventType: razorpayWebhookEvents.event_type,
        verified: razorpayWebhookEvents.signature_verified,
        processed: razorpayWebhookEvents.processed,
        createdAt: razorpayWebhookEvents.created_at,
      })
      .from(razorpayWebhookEvents)
      .where(eq(razorpayWebhookEvents.tenant_id, tenantId))
      .orderBy(desc(razorpayWebhookEvents.created_at))
      .limit(10);

    // Recent audit entries (action/resource only — no before/after content).
    const recentAudit = await this.dbAdmin
      .select({
        action: auditLog.action,
        resourceType: auditLog.resource_type,
        createdAt: auditLog.created_at,
      })
      .from(auditLog)
      .where(eq(auditLog.tenant_id, tenantId))
      .orderBy(desc(auditLog.created_at))
      .limit(15);

    // Email/notification delivery (type + count only — never the message body).
    const emailRows = await this.dbAdmin
      .select({ type: notifications.type, n: sql<number>`count(*)::int` })
      .from(notifications)
      .where(eq(notifications.tenant_id, tenantId))
      .groupBy(notifications.type);

    // Audit the access itself (logged + revocable, PRD §10.5).
    await this.auditService.logPlatform({
      actorUserId,
      action: 'fam.invoicing_debug_viewed',
      targetTenantId: tenantId,
      metadata: { consentId: consent.id, scope: consent.scope },
    });

    return {
      data: {
        consent: {
          id: consent.id,
          scope: consent.scope,
          expiresAt: consent.expires_at ? consent.expires_at.toISOString() : null,
          grantedAt: consent.created_at.toISOString(),
        },
        invoiceStatusDistribution: statusRows.map((r) => ({
          status: r.status,
          count: Number(r.n),
        })),
        webhookEvents: recentWebhooks.map((w) => ({
          eventType: w.eventType,
          verified: w.verified,
          processed: w.processed,
          createdAt: w.createdAt.toISOString(),
        })),
        auditEntries: recentAudit.map((a) => ({
          action: a.action,
          resourceType: a.resourceType,
          createdAt: a.createdAt.toISOString(),
        })),
        notificationsByType: emailRows.map((e) => ({ type: e.type, count: Number(e.n) })),
      },
    };
  }
  // ─── Round R R2 — find anyone ──────────────────────────────────────────────

  /** Users by email / name, companies by name / slug / GSTIN. Never the Specflicks tenant. */
  async search(q: string) {
    const needle = `%${q.trim().toLowerCase()}%`;
    if (q.trim().length < 2) return { users: [], tenants: [] };
    const [userRows, tenantRows] = await Promise.all([
      this.dbAdmin
        .select({
          id: users.id,
          email: users.email,
          fullName: users.full_name,
          status: users.status,
          isPlatformAdmin: users.is_platform_admin,
          lastLoginAt: users.last_login_at,
          avatarKey: users.avatar_key,
          avatarUrl: users.avatar_url,
          // Drizzle renders an interpolated column UNQUALIFIED inside a select list
          // ("id", which the correlated subquery would resolve to m.id) — spell
          // the outer reference out.
          companies: sql<number>`(SELECT COUNT(*)::int FROM memberships m WHERE m.user_id = "users"."id" AND m.tenant_id <> ${SPECFLICKS_TENANT_ID}::uuid)`,
        })
        .from(users)
        .where(sql`(lower(${users.email}) LIKE ${needle} OR lower(coalesce(${users.full_name}, '')) LIKE ${needle})`)
        .orderBy(desc(users.last_login_at))
        .limit(8),
      this.dbAdmin
        .select({
          id: tenants.id,
          name: tenants.name,
          slug: tenants.slug,
          gstin: tenants.gstin,
          status: tenants.status,
          logoKey: tenants.logo_key,
          logoUrl: tenants.logo_url,
          members: sql<number>`(SELECT COUNT(*)::int FROM memberships m WHERE m.tenant_id = "tenants"."id" AND m.status = 'active')`,
        })
        .from(tenants)
        .where(
          and(
            isNull(tenants.deleted_at),
            ne(tenants.id, SPECFLICKS_TENANT_ID),
            sql`(lower(${tenants.name}) LIKE ${needle} OR lower(${tenants.slug}) LIKE ${needle} OR lower(coalesce(${tenants.gstin}, '')) LIKE ${needle})`,
          ),
        )
        .orderBy(tenants.name)
        .limit(8),
    ]);
    return {
      users: await Promise.all(
        userRows.map(async (u) => ({
          id: u.id,
          email: u.email,
          fullName: u.fullName,
          status: u.status,
          isPlatformAdmin: u.isPlatformAdmin,
          lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
          companies: Number(u.companies ?? 0),
          avatarUrl: await this.mediaService.servedUrl(u.avatarKey, u.avatarUrl, 64),
        })),
      ),
      tenants: await Promise.all(
        tenantRows.map(async (t) => ({
          id: t.id,
          name: t.name,
          slug: t.slug,
          gstin: t.gstin,
          status: t.status,
          members: Number(t.members ?? 0),
          logoUrl: await this.mediaService.servedUrl(t.logoKey, t.logoUrl, 64),
        })),
      ),
    };
  }

  // ─── Round R R2 — a person, across companies ────────────────────────────────

  private async loadUser(userId: string) {
    const [u] = await this.dbAdmin.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!u) throw new NotFoundException('User not found');
    return u;
  }

  async getUser(userId: string) {
    const u = await this.loadUser(userId);
    const [companies, sessions, devices, lockout] = await Promise.all([
      this.dbAdmin
        .select({
          membershipId: memberships.id,
          tenantId: memberships.tenant_id,
          tenantName: tenants.name,
          tenantSlug: tenants.slug,
          tenantStatus: tenants.status,
          tenantLogoKey: tenants.logo_key,
          tenantLogoUrl: tenants.logo_url,
          role: memberships.role,
          status: memberships.status,
          employeeId: memberships.employee_id,
          accessExpiresAt: memberships.access_expires_at,
          invitedAt: memberships.invited_at,
          acceptedAt: memberships.accepted_at,
        })
        .from(memberships)
        .innerJoin(tenants, eq(tenants.id, memberships.tenant_id))
        .where(and(eq(memberships.user_id, userId), ne(memberships.tenant_id, SPECFLICKS_TENANT_ID)))
        .orderBy(memberships.created_at),
      this.authService.listSessionsDetailed(userId),
      this.authService.listTrustedDevices(userId),
      this.authService.lockoutState(u.email, userId),
    ]);
    return {
      id: u.id,
      email: u.email,
      fullName: u.full_name,
      phone: u.phone,
      avatarUrl: await this.mediaService.servedUrl(u.avatar_key, u.avatar_url, 256),
      status: u.status,
      isPlatformAdmin: u.is_platform_admin,
      totpEnrolledAt: u.totp_enrolled_at?.toISOString() ?? null,
      lastLoginAt: u.last_login_at?.toISOString() ?? null,
      createdAt: u.created_at.toISOString(),
      lockout,
      companies: await Promise.all(
        companies.map(async (c) => ({
          membershipId: c.membershipId,
          tenantId: c.tenantId,
          tenantName: c.tenantName,
          tenantSlug: c.tenantSlug,
          tenantStatus: c.tenantStatus,
          tenantLogoUrl: await this.mediaService.servedUrl(c.tenantLogoKey, c.tenantLogoUrl, 64),
          role: c.role,
          status: c.status,
          employeeId: c.employeeId,
          accessExpiresAt: c.accessExpiresAt?.toISOString() ?? null,
          invitedAt: c.invitedAt?.toISOString() ?? null,
          acceptedAt: c.acceptedAt?.toISOString() ?? null,
        })),
      ),
      sessions,
      devices,
    };
  }

  async getUserAuthEvents(userId: string, opts: { page?: number; limit?: number }) {
    const u = await this.loadUser(userId);
    return this.authService.listAuthEvents(userId, u.email, opts);
  }

  async clearUserLockout(userId: string, actor: FamActor) {
    const u = await this.loadUser(userId);
    const result = await this.authService.clearSignInLockout(u.email, userId, {
      actorUserId: actor.userId,
      ip: actor.ip,
      userAgent: actor.userAgent,
    });
    await this.auditService.logPlatform({
      actorUserId: actor.userId,
      action: 'fam.user.lockout_cleared',
      targetUserId: userId,
      metadata: { email: u.email, ...result },
      ipAddress: actor.ip,
      userAgent: actor.userAgent,
    });
    return { ok: true, ...result };
  }

  async sendUserSignInLink(userId: string, actor: FamActor) {
    const u = await this.loadUser(userId);
    if (u.status !== 'active') throw new ConflictException('This account is not active');
    const result = await this.authService.sendSignInLink(
      { id: u.id, email: u.email },
      { actorUserId: actor.userId, ip: actor.ip, userAgent: actor.userAgent },
    );
    await this.auditService.logPlatform({
      actorUserId: actor.userId,
      action: 'fam.user.sign_in_link_sent',
      targetUserId: userId,
      metadata: { email: u.email, sent: result.sent, expiresAt: result.expiresAt },
      ipAddress: actor.ip,
      userAgent: actor.userAgent,
    });
    if (!result.sent) throw new ServiceUnavailableException('The sign-in email could not be sent — try again in a minute');
    return { ok: true, expiresAt: result.expiresAt };
  }

  async signOutUserEverywhere(userId: string, actor: FamActor) {
    const u = await this.loadUser(userId);
    const result = await this.authService.revokeAllSessions(userId, {
      reason: 'fam_sign_out_everywhere',
      actorUserId: actor.userId,
      ip: actor.ip,
      userAgent: actor.userAgent,
    });
    await this.auditService.logPlatform({
      actorUserId: actor.userId,
      action: 'fam.user.signed_out_everywhere',
      targetUserId: userId,
      metadata: { email: u.email, ...result },
      ipAddress: actor.ip,
      userAgent: actor.userAgent,
    });
    return { ok: true, ...result };
  }

  // ─── Round R R2 — company support tab ──────────────────────────────────────

  private tenantActivityFilters(q: TenantActivityQueryDto) {
    return {
      action: q.action?.trim() || undefined,
      resourceType: q.resourceType?.trim() || undefined,
      actorUserId: q.actorUserId,
      from: parseDate(q.from),
      to: parseDate(q.to),
    };
  }

  /** The company's OWN audit log — exactly what its Owner sees under Reports → Audit log. */
  async getTenantActivity(tenantId: string, q: TenantActivityQueryDto = {}) {
    await this.assertTenant(tenantId);
    return this.auditService.search(tenantId, {
      ...this.tenantActivityFilters(q),
      page: Math.max(1, q.page ?? 1),
      limit: Math.max(1, Math.min(q.limit ?? 50, 200)),
    });
  }

  async exportTenantActivityCsv(tenantId: string, q: TenantActivityQueryDto = {}): Promise<string> {
    await this.assertTenant(tenantId);
    const rows: Array<Record<string, unknown>> = [];
    const filters = this.tenantActivityFilters(q);
    for (let page = 1; page <= 25; page++) {
      const { data } = await this.auditService.search(tenantId, { ...filters, page, limit: 200 });
      for (const r of data) {
        rows.push({
          when: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
          action: r.action,
          resource_type: r.resourceType,
          resource_id: r.resourceId ?? '',
          actor: r.actorName ?? '',
          actor_email: r.actorEmail ?? '',
          ip: r.ipAddress ?? '',
          user_agent: r.userAgent ?? '',
          before: r.beforeState ?? '',
          after: r.afterState ?? '',
        });
      }
      if (data.length < 200) break;
    }
    return toCsv(['when', 'action', 'resource_type', 'resource_id', 'actor', 'actor_email', 'ip', 'user_agent', 'before', 'after'], rows);
  }

  private async assertTenant(tenantId: string) {
    const [t] = await this.dbAdmin
      .select({ id: tenants.id })
      .from(tenants)
      .where(and(eq(tenants.id, tenantId), isNull(tenants.deleted_at), ne(tenants.id, SPECFLICKS_TENANT_ID)))
      .limit(1);
    if (!t) throw new NotFoundException('Tenant not found');
    return t;
  }

  private async loadMember(tenantId: string, membershipId: string) {
    const [m] = await this.dbAdmin
      .select({
        id: memberships.id,
        userId: memberships.user_id,
        employeeId: memberships.employee_id,
        status: memberships.status,
        role: memberships.role,
        email: users.email,
      })
      .from(memberships)
      .leftJoin(users, eq(users.id, memberships.user_id))
      .where(and(eq(memberships.id, membershipId), eq(memberships.tenant_id, tenantId)))
      .limit(1);
    if (!m) throw new NotFoundException('Member not found');
    return m;
  }

  async resendMemberInvite(tenantId: string, membershipId: string, actor: FamActor) {
    if (!this.employeesPublic) throw new ServiceUnavailableException('Invites are not available');
    await this.assertTenant(tenantId);
    const m = await this.loadMember(tenantId, membershipId);
    if (!m.employeeId) {
      throw new ConflictException('This seat has no employee record — invites go through People → Onboarding');
    }
    const result = await this.employeesPublic.resendInvite(m.employeeId, tenantId, actor.userId);
    await this.auditService.logPlatform({
      actorUserId: actor.userId,
      action: 'fam.member.invite_resent',
      targetTenantId: tenantId,
      targetUserId: m.userId,
      metadata: { email: m.email, emailSent: result.data.emailSent, resentCount: result.data.resentCount },
      ipAddress: actor.ip,
      userAgent: actor.userAgent,
    });
    return result;
  }

  async signOutMember(tenantId: string, membershipId: string, actor: FamActor) {
    await this.assertTenant(tenantId);
    const m = await this.loadMember(tenantId, membershipId);
    const sessionsRevoked = await this.authService.revokeTenantSessionsForUser(m.userId, tenantId);
    await this.auditService.logPlatform({
      actorUserId: actor.userId,
      action: 'fam.member.signed_out',
      targetTenantId: tenantId,
      targetUserId: m.userId,
      metadata: { email: m.email, sessionsRevoked },
      ipAddress: actor.ip,
      userAgent: actor.userAgent,
    });
    return { ok: true, sessionsRevoked };
  }

  async listTenantNotes(tenantId: string) {
    await this.assertTenant(tenantId);
    const rows = await this.dbAdmin
      .select({
        id: famTenantNotes.id,
        body: famTenantNotes.body,
        pinned: famTenantNotes.pinned,
        createdAt: famTenantNotes.created_at,
        updatedAt: famTenantNotes.updated_at,
        authorUserId: famTenantNotes.author_user_id,
        authorName: users.full_name,
        authorEmail: users.email,
      })
      .from(famTenantNotes)
      .leftJoin(users, eq(users.id, famTenantNotes.author_user_id))
      .where(and(eq(famTenantNotes.tenant_id, tenantId), isNull(famTenantNotes.deleted_at)))
      .orderBy(desc(famTenantNotes.pinned), desc(famTenantNotes.created_at));
    return {
      data: rows.map((r) => ({
        id: r.id,
        body: r.body,
        pinned: r.pinned,
        author: r.authorName ?? r.authorEmail ?? 'Specflicks',
        authorUserId: r.authorUserId,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      })),
    };
  }

  async addTenantNote(tenantId: string, actor: FamActor, body: string) {
    await this.assertTenant(tenantId);
    const [row] = await this.dbAdmin
      .insert(famTenantNotes)
      .values({ tenant_id: tenantId, author_user_id: actor.userId, body: body.trim() })
      .returning({ id: famTenantNotes.id });
    await this.auditService.logPlatform({
      actorUserId: actor.userId,
      action: 'fam.tenant.note_added',
      targetTenantId: tenantId,
      metadata: { noteId: row!.id, length: body.trim().length },
      ipAddress: actor.ip,
      userAgent: actor.userAgent,
    });
    return { id: row!.id };
  }

  async updateTenantNote(
    tenantId: string,
    noteId: string,
    actor: FamActor,
    patch: { body?: string; pinned?: boolean },
  ) {
    await this.assertTenant(tenantId);
    const set: Partial<typeof famTenantNotes.$inferInsert> = { updated_at: new Date() };
    if (patch.body !== undefined) set.body = patch.body.trim();
    if (patch.pinned !== undefined) set.pinned = patch.pinned;
    const [row] = await this.dbAdmin
      .update(famTenantNotes)
      .set(set)
      .where(and(eq(famTenantNotes.id, noteId), eq(famTenantNotes.tenant_id, tenantId), isNull(famTenantNotes.deleted_at)))
      .returning({ id: famTenantNotes.id, pinned: famTenantNotes.pinned });
    if (!row) throw new NotFoundException('Note not found');
    await this.auditService.logPlatform({
      actorUserId: actor.userId,
      action: 'fam.tenant.note_updated',
      targetTenantId: tenantId,
      metadata: { noteId, pinned: row.pinned, edited: patch.body !== undefined },
      ipAddress: actor.ip,
      userAgent: actor.userAgent,
    });
    return { id: row.id, pinned: row.pinned };
  }

  async deleteTenantNote(tenantId: string, noteId: string, actor: FamActor) {
    await this.assertTenant(tenantId);
    const [row] = await this.dbAdmin
      .update(famTenantNotes)
      .set({ deleted_at: new Date() })
      .where(and(eq(famTenantNotes.id, noteId), eq(famTenantNotes.tenant_id, tenantId), isNull(famTenantNotes.deleted_at)))
      .returning({ id: famTenantNotes.id });
    if (!row) throw new NotFoundException('Note not found');
    await this.auditService.logPlatform({
      actorUserId: actor.userId,
      action: 'fam.tenant.note_deleted',
      targetTenantId: tenantId,
      metadata: { noteId },
      ipAddress: actor.ip,
      userAgent: actor.userAgent,
    });
    return { ok: true };
  }
}
