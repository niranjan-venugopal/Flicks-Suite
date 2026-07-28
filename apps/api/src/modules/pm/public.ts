import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { pmProjects, pmProjectUpdates } from '@flicks/db/schema';
import { DatabaseService } from '../../core/database/database.service';
import { DomainEventsService } from '../../core/events/domain-events.service';
import { CrmPublicService } from '../crm/public';
import { PmIssuesService } from './issues.service';
import { PmProjectsService } from './projects.service';
import { PmTeamsService } from './teams.service';

/**
 * PmPublicService (PRD v6 §15.2/§19) — the ONLY PM surface other modules and
 * the public API may consume. Thin delegation (CRM facade shape) plus the one
 * cross-module flow PM owns: deal → project.
 */
@Injectable()
export class PmPublicService {
  constructor(
    private readonly db: DatabaseService,
    private readonly domainEvents: DomainEventsService,
    private readonly crm: CrmPublicService,
    private readonly issues: PmIssuesService,
    private readonly projects: PmProjectsService,
    private readonly teams: PmTeamsService,
  ) {}

  // ─── Public API (pm:read / pm:write) ───────────────────────────────────────

  listIssues(tenantId: string, actorUserId: string, query: { team_id?: string; project_id?: string; page?: number; limit?: number }) {
    return this.issues.list(tenantId, actorUserId, query);
  }

  createIssue(tenantId: string, actorUserId: string, dto: Parameters<PmIssuesService['create']>[2]) {
    return this.issues.create(tenantId, actorUserId, { ...dto, source: 'api' });
  }

  listProjects(tenantId: string, actorUserId: string) {
    return this.projects.list(tenantId, actorUserId);
  }

  listTeams(tenantId: string, actorUserId: string) {
    return this.teams.list(tenantId, actorUserId);
  }

  // ─── Deal → project (§15.2) ────────────────────────────────────────────────

  /** The project linked to a deal (deal-page pill + timeline echoes). */
  async projectForDeal(tenantId: string, userId: string, dealId: string) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const [project] = await tx
          .select()
          .from(pmProjects)
          .where(and(eq(pmProjects.tenant_id, tenantId), eq(pmProjects.deal_id, dealId), isNull(pmProjects.deleted_at)))
          .limit(1);
        if (!project) return { data: null };
        const [latestUpdate] = await tx
          .select()
          .from(pmProjectUpdates)
          .where(and(eq(pmProjectUpdates.tenant_id, tenantId), eq(pmProjectUpdates.project_id, project.id)))
          .orderBy(desc(pmProjectUpdates.created_at))
          .limit(1);
        return { data: { project, latest_update: latestUpdate ?? null } };
      },
      userId,
    );
  }

  /**
   * Create a project from a Won (or any open) deal — idempotent: a live
   * project already linked to the deal is returned instead of duplicating.
   * Mirrors the deal→invoice facade flow.
   */
  async createProjectFromDeal(tenantId: string, actorUserId: string, dealId: string) {
    const existing = await this.projectForDeal(tenantId, actorUserId, dealId);
    if (existing.data) return { data: existing.data.project, existed: true };

    const deal = await this.crm.getDeal(tenantId, dealId).catch(() => null);
    const dealRow = (deal as { data?: { title?: string; name?: string; owner_user_id?: string | null } } | null)?.data;
    if (!dealRow) throw new NotFoundException('Deal not found');
    const name = (dealRow.title ?? dealRow.name ?? '').trim();
    if (!name) throw new BadRequestException('Deal has no title to name the project after');

    const created = await this.projects.create(tenantId, actorUserId, {
      name,
      status: 'in_progress',
      lead_user_id: dealRow.owner_user_id ?? actorUserId,
      deal_id: dealId,
    });
    await this.domainEvents.publish({
      name: 'pm.project.created_from_deal',
      tenantId,
      actorUserId,
      payload: { project_id: created.data.id, deal_id: dealId, sync: [{ t: 'pm_projects', id: created.data.id }] },
    });
    return { data: created.data, existed: false };
  }
}
