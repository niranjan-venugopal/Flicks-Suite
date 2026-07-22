import { Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { pmTeams, pmTeamMemberships, pmProjects, pmProjectTeams } from '@flicks/db/schema';
import type { Db } from '@flicks/db';
import { DatabaseService } from '../../../core/database/database.service';

/**
 * PM visibility (PRD v6 §16) — THE single implementation of "which teams can
 * this user see". Public teams: every pm-granted member. Private teams:
 * members only — enforced identically in bootstrap, delta, search and REST
 * reads so private-team rows can never leak through one forgotten filter.
 */
@Injectable()
export class PmVisibilityService {
  constructor(private readonly db: DatabaseService) {}

  /** Visible team ids inside an existing tenant tx. */
  async visibleTeamIdsTx(tx: Db, tenantId: string, userId: string): Promise<string[]> {
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

  async visibleTeamIds(tenantId: string, userId: string): Promise<string[]> {
    return this.db.withTenant(tenantId, (tx) => this.visibleTeamIdsTx(tx, tenantId, userId), userId);
  }

  /**
   * Visible project ids (§6/§16): a project is visible when it has NO team
   * links (workspace-wide) or at least one linked team is visible. Same
   * doctrine as teams — implemented once, used by bootstrap/delta/REST.
   */
  async visibleProjectIdsTx(tx: Db, tenantId: string, userId: string): Promise<string[]> {
    const visibleTeams = new Set(await this.visibleTeamIdsTx(tx, tenantId, userId));
    const projects = await tx
      .select({ id: pmProjects.id })
      .from(pmProjects)
      .where(and(eq(pmProjects.tenant_id, tenantId), isNull(pmProjects.deleted_at)));
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
}
