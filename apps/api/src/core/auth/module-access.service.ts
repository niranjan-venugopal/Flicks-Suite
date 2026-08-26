import { Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import {
  membershipGrants,
  memberships,
  tenantModuleToggles,
  tenantRoleModuleDefaults,
} from '@flicks/db/schema';
import type { UserRole } from '@flicks/shared/types';
import { DatabaseService } from '../database/database.service';
import type { GrantModule } from './decorators/require-grant.decorator';

export type AccessLevel = 'none' | 'view' | 'edit';

export const LEVEL_RANK: Record<string, number> = { none: 0, view: 1, edit: 2 };

/** Modules an Owner administers from Settings → Module access. */
export const MANAGED_ACCESS_MODULES = ['crm', 'invoicing', 'pm'] as const;

/**
 * Roles that hold a module outright, by role. These short-circuit BEFORE any
 * row is read, so no grant row and no tenant default can take the module away
 * — that is deliberate: an Owner must never be able to lock every Owner out,
 * and Finance's invoicing access carries capability routes that a plain level
 * cannot express. Changing what these roles can reach means changing the
 * person's role.
 */
export const FULL_ACCESS_ROLES: Record<GrantModule, ReadonlySet<UserRole>> = {
  invoicing: new Set<UserRole>(['owner', 'admin', 'finance', 'super_admin', 'fam']),
  reports: new Set<UserRole>(['owner', 'admin', 'finance', 'super_admin', 'fam']),
  org_financial: new Set<UserRole>(['owner', 'admin', 'finance', 'super_admin', 'fam']),
  payroll: new Set<UserRole>(['owner', 'admin', 'finance', 'super_admin', 'fam']),
  expenses: new Set<UserRole>(['owner', 'admin', 'finance', 'super_admin', 'fam']),
  crm: new Set<UserRole>(['owner', 'admin', 'super_admin', 'fam']),
  pm: new Set<UserRole>(['owner', 'admin', 'super_admin', 'fam']),
};

/**
 * Access a role holds with NO rows anywhere — the shipped default. CRM and PM
 * are org-open for standard members (the SMB default); everything else is
 * opt-in via a grant row.
 */
export function builtInDefault(module: GrantModule, role: UserRole): AccessLevel {
  if ((module === 'crm' || module === 'pm') &&
      (role === 'manager' || role === 'employee' || role === 'finance')) {
    return 'edit';
  }
  return 'none';
}

export interface ResolvedAccess {
  level: AccessLevel;
  capabilities: Record<string, boolean>;
  /** Where the level came from — drives the Settings UI labels. */
  source: 'role' | 'member' | 'tenant_default' | 'built_in';
  moduleEnabled: boolean;
  membershipActive: boolean;
}

const DEFAULTS_TTL_MS = 30_000;

/**
 * The one place that answers "what access does this membership have to this
 * module?". Used by ModuleGrantGuard, by /auth/me (so the sidebar can hide
 * modules the caller cannot open) and by Settings → Module access.
 *
 * Resolution order, most specific first:
 *   1. full-access role                       → edit, unrevokable
 *   2. explicit membership_grants row         → exactly that level (this is
 *                                               how revocation is expressed)
 *   3. tenant_role_module_defaults row        → the workspace's role policy
 *   4. built-in role default                  → shipped behaviour
 *
 * Capabilities are ALWAYS member-level: a role default can grant the level but
 * never the capability switches.
 */
@Injectable()
export class ModuleAccessService {
  private readonly logger = new Logger(ModuleAccessService.name);
  /** tenantId → role|module → level. Role policy changes rarely; member rows
   *  are never cached (two specs assert revocation flips synchronously). */
  private defaultsCache = new Map<
    string,
    { map: Map<string, AccessLevel>; at: number }
  >();

  constructor(private readonly db: DatabaseService) {}

  /** Drop the cached role policy for a tenant (call after a policy write). */
  invalidateTenant(tenantId: string): void {
    this.defaultsCache.delete(tenantId);
  }

  private async roleDefaults(
    tenantId: string,
    userId?: string,
  ): Promise<Map<string, AccessLevel>> {
    const hit = this.defaultsCache.get(tenantId);
    if (hit && Date.now() - hit.at < DEFAULTS_TTL_MS) return hit.map;

    const rows = await this.db.withTenant(
      tenantId,
      (tx) =>
        tx
          .select({
            role: tenantRoleModuleDefaults.role,
            module: tenantRoleModuleDefaults.module,
            level: tenantRoleModuleDefaults.access_level,
          })
          .from(tenantRoleModuleDefaults)
          .where(eq(tenantRoleModuleDefaults.tenant_id, tenantId)),
      userId,
    );
    const map = new Map<string, AccessLevel>();
    for (const r of rows) map.set(`${r.role}|${r.module}`, r.level as AccessLevel);
    this.defaultsCache.set(tenantId, { map, at: Date.now() });
    return map;
  }

  /**
   * Everything the guard needs, in ONE tenant transaction: FAM module toggle,
   * membership liveness, the LIVE role (not the possibly-stale JWT one) and
   * the member's grant row.
   */
  async loadContext(
    tenantId: string,
    membershipId: string | undefined,
    module: GrantModule,
    userId?: string,
    /**
     * The module whose GRANT ROW to read, when it differs from the module
     * whose FAM toggle governs the controller. They diverge on purpose:
     * /invoicing/reports and /org-financial/* sit under InvoicingGrantGuard
     * (so the invoicing kill-switch closes them too) while requiring their own
     * grants. Reading the guard's module here instead of the requirement's
     * would let an invoicing:edit row unlock org_financial.
     */
    grantModule: GrantModule = module,
  ): Promise<{
    moduleEnabled: boolean;
    membershipActive: boolean;
    liveRole: UserRole | null;
    grant: { level: AccessLevel; capabilities: Record<string, boolean> } | null;
  }> {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const [toggleRows, memberRows, grantRows] = await Promise.all([
          tx
            .select({ enabled: tenantModuleToggles.enabled })
            .from(tenantModuleToggles)
            .where(
              and(
                eq(tenantModuleToggles.tenant_id, tenantId),
                eq(tenantModuleToggles.module, module),
              ),
            )
            .limit(1),
          membershipId
            ? tx
                .select({
                  status: memberships.status,
                  expires: memberships.access_expires_at,
                  role: memberships.role,
                })
                .from(memberships)
                .where(
                  and(
                    eq(memberships.id, membershipId),
                    eq(memberships.tenant_id, tenantId),
                  ),
                )
                .limit(1)
            : Promise.resolve(
                [] as Array<{
                  status: string;
                  expires: Date | null;
                  role: string;
                }>,
              ),
          membershipId
            ? tx
                .select({
                  level: membershipGrants.access_level,
                  capabilities: membershipGrants.capabilities,
                })
                .from(membershipGrants)
                .where(
                  and(
                    eq(membershipGrants.membership_id, membershipId),
                    eq(membershipGrants.module, grantModule),
                  ),
                )
                .limit(1)
            : Promise.resolve(
                [] as Array<{ level: string; capabilities: unknown }>,
              ),
        ]);

        const m = memberRows[0];
        const g = grantRows[0];
        return {
          // Toggle default = ENABLED when no row exists (§3.5).
          moduleEnabled: toggleRows.length === 0 ? true : toggleRows[0]!.enabled,
          membershipActive:
            !!m &&
            m.status === 'active' &&
            (!m.expires || new Date(m.expires).getTime() > Date.now()),
          liveRole: (m?.role as UserRole | undefined) ?? null,
          grant: g
            ? {
                level: g.level as AccessLevel,
                capabilities: (g.capabilities ?? {}) as Record<string, boolean>,
              }
            : null,
        };
      },
      userId,
    );
  }

  /** Does this role hold the module outright, regardless of any row? */
  isFullAccess(module: GrantModule, role: UserRole): boolean {
    return FULL_ACCESS_ROLES[module].has(role);
  }

  /**
   * Level for a role with NO member grant row: the workspace's role policy if
   * it has one, else the shipped default.
   */
  async defaultLevel(
    tenantId: string,
    role: UserRole,
    module: GrantModule,
    userId?: string,
  ): Promise<AccessLevel> {
    const defaults = await this.roleDefaults(tenantId, userId);
    return defaults.get(`${role}|${module}`) ?? builtInDefault(module, role);
  }

  /** Effective access for one membership + module. */
  async resolve(
    tenantId: string,
    membershipId: string | undefined,
    role: UserRole,
    module: GrantModule,
    userId?: string,
  ): Promise<ResolvedAccess> {
    const ctx = await this.loadContext(tenantId, membershipId, module, userId);
    const effectiveRole = ctx.liveRole ?? role;

    if (FULL_ACCESS_ROLES[module].has(effectiveRole)) {
      return {
        level: 'edit',
        capabilities: {},
        source: 'role',
        moduleEnabled: ctx.moduleEnabled,
        membershipActive: ctx.membershipActive,
      };
    }
    if (ctx.grant) {
      return {
        level: ctx.grant.level,
        capabilities: ctx.grant.capabilities,
        source: 'member',
        moduleEnabled: ctx.moduleEnabled,
        membershipActive: ctx.membershipActive,
      };
    }
    const defaults = await this.roleDefaults(tenantId, userId);
    const tenantLevel = defaults.get(`${effectiveRole}|${module}`);
    if (tenantLevel) {
      return {
        level: tenantLevel,
        capabilities: {},
        source: 'tenant_default',
        moduleEnabled: ctx.moduleEnabled,
        membershipActive: ctx.membershipActive,
      };
    }
    return {
      level: builtInDefault(module, effectiveRole),
      capabilities: {},
      source: 'built_in',
      moduleEnabled: ctx.moduleEnabled,
      membershipActive: ctx.membershipActive,
    };
  }

  /**
   * The effective level for each managed module — shipped on /auth/me so the
   * sidebar hides what the caller cannot open (a granted manager finally sees
   * CRM; a revoked employee stops seeing Projects). A disabled module reads as
   * 'none' here: the guard would reject every request anyway.
   */
  async moduleAccessMap(
    tenantId: string,
    membershipId: string | undefined,
    role: UserRole,
    userId?: string,
  ): Promise<Record<(typeof MANAGED_ACCESS_MODULES)[number], AccessLevel>> {
    const entries = await Promise.all(
      MANAGED_ACCESS_MODULES.map(async (module) => {
        try {
          const res = await this.resolve(
            tenantId,
            membershipId,
            role,
            module,
            userId,
          );
          return [
            module,
            res.moduleEnabled && res.membershipActive ? res.level : 'none',
          ] as const;
        } catch (err) {
          // /me must never fail because one module lookup did.
          this.logger.warn(
            `moduleAccess resolve failed for ${module}: ${
              err instanceof Error ? err.message : err
            }`,
          );
          return [module, 'none'] as const;
        }
      }),
    );
    return Object.fromEntries(entries) as Record<
      (typeof MANAGED_ACCESS_MODULES)[number],
      AccessLevel
    >;
  }
}
