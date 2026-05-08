import { Injectable, Logger, Inject } from '@nestjs/common';
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
