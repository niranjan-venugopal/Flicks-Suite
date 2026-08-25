import { ForbiddenException, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  pmTeams,
  pmTeamMemberships,
  pmProjects,
  pmProjectTeams,
  pmProjectMembers,
  pmIssues,
  memberships,
} from '@flicks/db/schema';
import type { Db } from '@flicks/db';
import { DatabaseService } from '../../../core/database/database.service';

/**
 * PM visibility (PRD v6 §16 + guest seats round 7) — THE single
 * implementation of "what can this user see". Public teams: every pm-granted
 * member. Private teams: members only. GUESTS (membership role 'guest') see
 * ONLY the projects they were invited to (pm_project_members rows): their
 * issues are `project_id ∈ projectIds` (issues without a project are
 * invisible), their teams are just the ones needed to render those issues'
 * states/labels, and rosters/cycles/initiatives are never exposed. Enforced
 * identically in bootstrap, delta, search and REST reads so rows can never
 * leak through one forgotten filter.
 *
 * ⚠ Doctrine for future work: every NEW PM read path must consult scopeTx /
 * issueVisible, and every NEW mutation must call assertNotGuestTx (or the
 * issue-level assert in PmIssuesService) — module-level pm:edit alone does
 * NOT scope a guest.
 */
export interface PmScope {
  guest: boolean;
  teamIds: string[];
  projectIds: string[];
}

@Injectable()
export class PmVisibilityService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Role-aware scope. Role is read from the DB (not the JWT) so a promotion
   * or revocation takes effect immediately, not after token expiry.
   */
  async scopeTx(
    tx: Db,
    tenantId: string,
    userId: string,
    opts: { withDeleted?: boolean } = {},
  ): Promise<PmScope> {
    const guestScope = await this.guestScopeTx(tx, tenantId, userId);
    if (guestScope) return guestScope;
    return {
      guest: false,
      teamIds: await this.memberTeamIdsTx(tx, tenantId, userId),
      projectIds: await this.memberProjectIdsTx(tx, tenantId, userId, opts),
    };
  }

  /**
   * Fast path for per-mutation checks: null for non-guests (one membership
   * select), the guest scope otherwise.
   */
  async guestScopeTx(
    tx: Db,
    tenantId: string,
    userId: string,
  ): Promise<PmScope | null> {
    const [membership] = await tx
      .select({ role: memberships.role })
      .from(memberships)
      .where(
        and(
          eq(memberships.tenant_id, tenantId),
          eq(memberships.user_id, userId),
          inArray(memberships.status, ['active', 'invited']),
        ),
      )
      .limit(1);

    if (membership?.role !== 'guest') return null;

    // Guest: projects = explicit pm_project_members rows only.
    const rows = await tx
      .select({ project_id: pmProjectMembers.project_id })
      .from(pmProjectMembers)
      .where(
        and(
          eq(pmProjectMembers.tenant_id, tenantId),
          eq(pmProjectMembers.user_id, userId),
        ),
      );
    const projectIds = rows.map((r) => r.project_id);

    // Teams are only what's needed to RENDER those projects' issues (state
    // chips, labels, board columns): linked teams ∪ teams of in-project
    // issues. Rosters are never implied by this set.
    const teamIds = new Set<string>();
    if (projectIds.length) {
      const links = await tx
        .select({ team_id: pmProjectTeams.team_id })
        .from(pmProjectTeams)
        .where(
          and(
            eq(pmProjectTeams.tenant_id, tenantId),
            inArray(pmProjectTeams.project_id, projectIds),
          ),
        );
      for (const l of links) teamIds.add(l.team_id);
      const issueTeams = await tx
        .selectDistinct({ team_id: pmIssues.team_id })
        .from(pmIssues)
        .where(
          and(
            eq(pmIssues.tenant_id, tenantId),
            inArray(pmIssues.project_id, projectIds),
          ),
        );
      for (const t of issueTeams) teamIds.add(t.team_id);
    }

    return { guest: true, teamIds: [...teamIds], projectIds };
  }

  /** Is this issue inside the caller's scope? (Central rule — use everywhere.) */
  issueVisible(
    scope: PmScope,
    issue: { team_id: string; project_id: string | null },
  ): boolean {
    if (scope.guest) {
      return issue.project_id != null && scope.projectIds.includes(issue.project_id);
    }
    return scope.teamIds.includes(issue.team_id);
  }

  /** Guard for mutations that guests may never perform. */
  async assertNotGuestTx(
    tx: Db,
    tenantId: string,
    userId: string,
    what: string,
  ): Promise<void> {
    const [membership] = await tx
      .select({ role: memberships.role })
      .from(memberships)
      .where(
        and(
          eq(memberships.tenant_id, tenantId),
          eq(memberships.user_id, userId),
          inArray(memberships.status, ['active', 'invited']),
        ),
      )
      .limit(1);
    if (membership?.role === 'guest') {
      throw new ForbiddenException(`Guest seats are project-scoped — ${what} is not available to guests`);
    }
  }

  // ─── Member (non-guest) logic — unchanged semantics ────────────────────────

  private async memberTeamIdsTx(tx: Db, tenantId: string, userId: string): Promise<string[]> {
    const teams = await tx
      .select({ id: pmTeams.id, is_private: pmTeams.is_private })
      .from(pmTeams)
      .where(and(eq(pmTeams.tenant_id, tenantId), isNull(pmTeams.deleted_at)));
    const mine = await tx
      .select({ team_id: pmTeamMemberships.team_id })
      .from(pmTeamMemberships)
      .where(and(eq(pmTeamMemberships.tenant_id, tenantId), eq(pmTeamMemberships.user_id, userId)));
    const mineIds = new Set(mine.map((m) => m.team_id));
    return teams.filter((t) => !t.is_private || mineIds.has(t.id)).map((t) => t.id);
  }

  private async memberProjectIdsTx(
    tx: Db,
    tenantId: string,
    userId: string,
    opts: { withDeleted?: boolean } = {},
  ): Promise<string[]> {
    const visibleTeams = new Set(await this.memberTeamIdsTx(tx, tenantId, userId));
    const projects = await tx
      .select({ id: pmProjects.id })
      .from(pmProjects)
      .where(
        opts.withDeleted
          ? eq(pmProjects.tenant_id, tenantId)
          : and(eq(pmProjects.tenant_id, tenantId), isNull(pmProjects.deleted_at)),
      );
    const links = await tx
      .select({ project_id: pmProjectTeams.project_id, team_id: pmProjectTeams.team_id })
      .from(pmProjectTeams)
      .where(eq(pmProjectTeams.tenant_id, tenantId));
    const linkedTeams = new Map<string, string[]>();
    for (const l of links) {
      if (!linkedTeams.has(l.project_id)) linkedTeams.set(l.project_id, []);
      linkedTeams.get(l.project_id)!.push(l.team_id);
    }
    return projects
      .filter((p) => {
        const teams = linkedTeams.get(p.id);
        return !teams || teams.length === 0 || teams.some((t) => visibleTeams.has(t));
      })
      .map((p) => p.id);
  }

  // ─── Back-compat wrappers — every existing caller becomes guest-aware ──────

  /** Visible team ids inside an existing tenant tx (guest-aware). */
  async visibleTeamIdsTx(tx: Db, tenantId: string, userId: string): Promise<string[]> {
    return (await this.scopeTx(tx, tenantId, userId)).teamIds;
  }

  async visibleTeamIds(tenantId: string, userId: string): Promise<string[]> {
    return this.db.withTenant(tenantId, (tx) => this.visibleTeamIdsTx(tx, tenantId, userId), userId);
  }

  /**
   * Visible project ids (§6/§16): for members, a project is visible when it
   * has NO team links (workspace-wide) or a linked team is visible; for
   * guests, only their invited projects. Implemented once, used by
   * bootstrap/delta/REST.
   */
  async visibleProjectIdsTx(
    tx: Db,
    tenantId: string,
    userId: string,
    opts: { withDeleted?: boolean } = {},
  ): Promise<string[]> {
    return (await this.scopeTx(tx, tenantId, userId, opts)).projectIds;
  }
}
