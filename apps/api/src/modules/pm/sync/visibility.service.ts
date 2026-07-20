import { Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { pmTeams, pmTeamMemberships } from '@flicks/db/schema';
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
}
