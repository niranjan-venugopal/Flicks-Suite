/**
 * Founder round 19 — the sidebar must never offer a door that is locked.
 *
 * The reported bug: the FAM (Specflicks platform) console showed a customer
 * **CRM** menu whose every item did nothing. Cause: the web sidebar filtered
 * the nav through `/auth/me`'s `moduleAccess`, and that helper also ADDED a
 * CRM section to any nav that lacked one. A platform admin resolves
 * `crm: 'edit'` — `FULL_ACCESS_ROLES` puts 'fam' in every module — so the
 * tenant CRM group was bolted onto the platform nav, where each child link
 * navigates into the customer shell and is bounced straight back to
 * /fam/overview. "Nothing happens."
 *
 * The second half of the founder's ask was "check the others". The finding
 * there: FINANCE was handed the Owner/Admin nav even though it ranks BELOW
 * manager in the role hierarchy, so People, Insights and workspace Settings
 * were advertised to a seat the API 403s.
 *
 * These specs pin the server-side truth the nav is built from, so a future
 * change to a guard or to FULL_ACCESS_ROLES fails here instead of silently
 * putting a dead link back in someone's sidebar. The map of who-sees-what
 * lives in apps/web/components/layout/Sidebar.tsx; keep the two in step.
 */
import 'dotenv/config';
import * as crypto from 'crypto';
import { eq } from 'drizzle-orm';
import { dbAdmin } from '@flicks/db';
import { tenants, users, memberships } from '@flicks/db/schema';
import type { ExecutionContext } from '@nestjs/common';
import type { JwtPayload, UserRole } from '@flicks/shared/types';
import { DatabaseService } from '../core/database/database.service';
import { RolesGuard } from '../core/auth/guards/roles.guard';
import {
  ModuleAccessService,
  FULL_ACCESS_ROLES,
} from '../core/auth/module-access.service';
import type { AuditService } from '../modules/audit/audit.service';

const rid = () => crypto.randomBytes(4).toString('hex');
const audit = { log: async () => undefined } as unknown as AuditService;
const dbSvc = new DatabaseService();
const moduleAccess = new ModuleAccessService(dbSvc);

/**
 * Run the REAL RolesGuard for a `@Roles(...)` requirement against a synthetic
 * JWT — same shape as role-matrix.spec.ts does for InvoicingGrantGuard.
 */
let required: UserRole[] = [];
const rolesGuard = new RolesGuard(
  { getAllAndOverride: () => required } as never,
  audit,
);
const allows = async (
  requiredRoles: UserRole[],
  user: Partial<JwtPayload>,
): Promise<boolean> => {
  required = requiredRoles;
  const ctx = {
    switchToHttp: () => ({
      getRequest: () => ({ user, method: 'GET', url: '/x', headers: {} }),
    }),
    getHandler: () => () => {},
    getClass: () => class {},
  } as unknown as ExecutionContext;
  try {
    return await rolesGuard.canActivate(ctx);
  } catch {
    return false;
  }
};

/**
 * The ranked gate behind each sidebar group, read off the controllers:
 *   People            → GET /employees              @Roles('manager')
 *   People→Onboarding → GET /employees/onboarding-queue @Roles('admin')
 *   Insights→Reports  → GET /reports/*              @Roles('manager')
 *   Insights→Audit    → GET /audit                  @Roles('admin')
 *   Settings          → /settings/*                 @Roles('admin')
 *   Time→team view    → GET /attendance/team        @Roles('finance')
 *   FAM console       → /fam/*                      @Roles('fam')
 */
const GATES = {
  employeesList: ['manager'] as UserRole[],
  onboardingQueue: ['admin'] as UserRole[],
  reports: ['manager'] as UserRole[],
  auditLog: ['admin'] as UserRole[],
  workspaceSettings: ['admin'] as UserRole[],
  teamAttendance: ['finance'] as UserRole[],
  famConsole: ['fam'] as UserRole[],
};

describe('Founder round 19 — the sidebar never offers a locked door', () => {
  let tenantId: string;
  const membershipIds: Partial<Record<UserRole, string>> = {};
  const userIds: Partial<Record<UserRole, string>> = {};

  const jwt = (role: UserRole, isPlatformAdmin = false): Partial<JwtPayload> => ({
    sub: userIds[role]!,
    tenantId,
    membershipId: membershipIds[role],
    role,
    isPlatformAdmin,
  });

  beforeAll(async () => {
    const [t] = await dbAdmin
      .insert(tenants)
      .values({
        name: `R19 ${rid()}`,
        slug: `r19-${rid()}-${Date.now()}`,
        status: 'active',
      })
      .returning();
    tenantId = t!.id;

    // One seat per role, all active, no grant rows anywhere: this is the
    // shipped default every workspace starts from.
    for (const role of [
      'owner',
      'admin',
      'manager',
      'finance',
      'employee',
      'auditor',
      'guest',
      'fam',
    ] as UserRole[]) {
      const [u] = await dbAdmin
        .insert(users)
        .values({
          email: `r19-${role}-${rid()}@t.test`,
          full_name: `R19 ${role}`,
          status: 'active',
          is_platform_admin: role === 'fam',
        })
        .returning();
      const [m] = await dbAdmin
        .insert(memberships)
        .values({ tenant_id: tenantId, user_id: u!.id, role, status: 'active' })
        .returning();
      userIds[role] = u!.id;
      membershipIds[role] = m!.id;
    }
  });

  afterAll(async () => {
    await dbAdmin.delete(tenants).where(eq(tenants.id, tenantId));
    for (const id of Object.values(userIds)) {
      await dbAdmin.delete(users).where(eq(users.id, id));
    }
  });

  // ─── The ranked gates the nav is built on ────────────────────────────────

  it('Finance ranks below Manager: People, Reports, Audit and Settings are all closed to it', async () => {
    const finance = jwt('finance');
    expect(await allows(GATES.employeesList, finance)).toBe(false);
    expect(await allows(GATES.onboardingQueue, finance)).toBe(false);
    expect(await allows(GATES.reports, finance)).toBe(false);
    expect(await allows(GATES.auditLog, finance)).toBe(false);
    expect(await allows(GATES.workspaceSettings, finance)).toBe(false);
  });

  it('Finance DOES hold the workspace attendance view and the whole of Invoicing', async () => {
    expect(await allows(GATES.teamAttendance, jwt('finance'))).toBe(true);
    expect(FULL_ACCESS_ROLES.invoicing.has('finance')).toBe(true);
    expect(FULL_ACCESS_ROLES.reports.has('finance')).toBe(true);
    const access = await moduleAccess.moduleAccessMap(
      tenantId,
      membershipIds.finance,
      'finance',
      userIds.finance,
    );
    // CRM + Projects are org-open for a standard member (builtInDefault).
    expect(access).toEqual({ crm: 'edit', invoicing: 'edit', pm: 'edit' });
  });

  it('Owner and Admin hold every ranked gate the full sidebar advertises', async () => {
    for (const role of ['owner', 'admin'] as UserRole[]) {
      const who = jwt(role);
      expect(await allows(GATES.employeesList, who)).toBe(true);
      expect(await allows(GATES.onboardingQueue, who)).toBe(true);
      expect(await allows(GATES.reports, who)).toBe(true);
      expect(await allows(GATES.auditLog, who)).toBe(true);
      expect(await allows(GATES.workspaceSettings, who)).toBe(true);
    }
  });

  it('Manager holds the team gates but not the admin ones', async () => {
    const mgr = jwt('manager');
    expect(await allows(GATES.employeesList, mgr)).toBe(true);
    expect(await allows(GATES.teamAttendance, mgr)).toBe(true);
    expect(await allows(GATES.onboardingQueue, mgr)).toBe(false);
    expect(await allows(GATES.workspaceSettings, mgr)).toBe(false);
    expect(await allows(GATES.auditLog, mgr)).toBe(false);
  });

  it('Employee holds none of them — their nav is self-service only', async () => {
    const emp = jwt('employee');
    for (const gate of Object.values(GATES)) {
      expect(await allows(gate, emp)).toBe(false);
    }
  });

  it('Auditor and Guest sit outside the hierarchy: every ranked gate is shut', async () => {
    for (const role of ['auditor', 'guest'] as UserRole[]) {
      for (const gate of Object.values(GATES)) {
        expect(await allows(gate, jwt(role))).toBe(false);
      }
    }
  });

  // ─── Why the FAM console must NOT derive its nav from moduleAccess ───────

  it('a platform admin resolves EVERY module to edit — which is exactly why the FAM nav is fixed, not access-filtered', async () => {
    // This is the bug the founder hit. It is correct behaviour for the API
    // (Specflicks staff can act inside a tenant during support), but it means
    // moduleAccess says "yes" to CRM/Invoicing/Projects for a session that is
    // sitting in the platform console. The web sidebar therefore takes its
    // console from the LAYOUT (variant='fam'), never from this map or from
    // the membership role.
    for (const module of ['crm', 'invoicing', 'pm'] as const) {
      expect(FULL_ACCESS_ROLES[module].has('fam')).toBe(true);
      expect(FULL_ACCESS_ROLES[module].has('super_admin')).toBe(true);
    }
    const access = await moduleAccess.moduleAccessMap(
      tenantId,
      membershipIds.fam,
      'fam',
      userIds.fam,
    );
    expect(access).toEqual({ crm: 'edit', invoicing: 'edit', pm: 'edit' });
  });

  it('only a platform admin passes the FAM console gate', async () => {
    expect(await allows(GATES.famConsole, jwt('fam'))).toBe(true);
    for (const role of [
      'owner',
      'admin',
      'manager',
      'finance',
      'employee',
      'auditor',
      'guest',
    ] as UserRole[]) {
      expect(await allows(GATES.famConsole, jwt(role))).toBe(false);
    }
  });

  it('the isPlatformAdmin flag bypasses every ranked gate regardless of the active membership role', async () => {
    // The founder is a platform admin whose ACTIVE workspace is their own
    // company, where they are 'owner'. That is why the /fam layout admits on
    // the user-level flag and not on the membership role — and why the role
    // was the wrong thing for the sidebar to read.
    const staffInsideATenant = jwt('owner', true);
    for (const gate of Object.values(GATES)) {
      expect(await allows(gate, staffInsideATenant)).toBe(true);
    }
  });

  // ─── The CRM re-add that leaked into the console ─────────────────────────

  it('Manager and Employee really do hold CRM by default — the re-add is right for them, wrong for the console', async () => {
    for (const role of ['manager', 'employee'] as UserRole[]) {
      const access = await moduleAccess.moduleAccessMap(
        tenantId,
        membershipIds[role],
        role,
        userIds[role],
      );
      expect(access.crm).toBe('edit');
      expect(access.pm).toBe('edit');
      // ...but NOT invoicing: that one is grant-only for these seats, which is
      // why the sidebar builds their Invoicing section from membership_grants.
      expect(access.invoicing).toBe('none');
    }
  });

  it('an Auditor holds no module by role — their nav is grant-driven end to end', async () => {
    const access = await moduleAccess.moduleAccessMap(
      tenantId,
      membershipIds.auditor,
      'auditor',
      userIds.auditor,
    );
    expect(access).toEqual({ crm: 'none', invoicing: 'none', pm: 'none' });
  });
});
