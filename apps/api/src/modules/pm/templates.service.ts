import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { pmIssueTemplates, pmTeams } from '@flicks/db/schema';
import { DatabaseService } from '../../core/database/database.service';
import { AuditService } from '../audit/audit.service';
import { DomainEventsService } from '../../core/events/domain-events.service';
import type { Db } from '@flicks/db';
import { PmVisibilityService } from './sync/visibility.service';

/**
 * Issue templates (PRD v6 §15.5, P15 Templates tab) — per-team, one may be
 * the team default; the C composer prefills from it. Tables shipped in 0044;
 * this instantiates them. Project templates + recurring schedules stay
 * reserved (v1.5 — the schema carries the columns).
 */
@Injectable()
export class PmTemplatesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly domainEvents: DomainEventsService,
    private readonly visibility: PmVisibilityService,
  ) {}

  /**
   * §16 — templates carry a team's working copy (title patterns, description
   * boilerplate), so reads follow team visibility and writes need the same
   * settings rights as the rest of the team's configuration.
   */
  private async assertTeamVisible(tx: Db, tenantId: string, userId: string, teamId: string) {
    // Templates are team configuration — not part of a guest's project scope.
    await this.visibility.assertNotGuestTx(tx, tenantId, userId, 'issue templates');
    const visible = await this.visibility.visibleTeamIdsTx(tx, tenantId, userId);
    if (!visible.includes(teamId)) throw new NotFoundException('team not found');
  }

  async list(tenantId: string, userId: string, teamId: string) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        await this.assertTeamVisible(tx, tenantId, userId, teamId);
        const rows = await tx
          .select()
          .from(pmIssueTemplates)
          .where(and(eq(pmIssueTemplates.tenant_id, tenantId), eq(pmIssueTemplates.team_id, teamId)))
          .orderBy(asc(pmIssueTemplates.created_at));
        return { data: rows };
      },
      userId,
    );
  }

  async save(
    tenantId: string,
    userId: string,
    teamId: string,
    input: {
      id?: string;
      name: string;
      title_pattern?: string | null;
      description_md?: string | null;
      default_priority?: number | null;
      default_estimate?: number | null;
      is_team_default?: boolean;
    },
  ) {
    if (!input.name?.trim()) throw new BadRequestException('Template name is required');
    if (input.default_priority != null && (input.default_priority < 0 || input.default_priority > 4)) {
      throw new BadRequestException('default_priority 0–4');
    }
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const [team] = await tx
          .select({ id: pmTeams.id })
          .from(pmTeams)
          .where(and(eq(pmTeams.id, teamId), eq(pmTeams.tenant_id, tenantId)))
          .limit(1);
        if (!team) throw new BadRequestException('team not found');
        await this.assertTeamVisible(tx, tenantId, userId, teamId);
        // Exactly one default per team — setting a new default clears the rest.
        if (input.is_team_default) {
          await tx
            .update(pmIssueTemplates)
            .set({ is_team_default: false })
            .where(and(eq(pmIssueTemplates.tenant_id, tenantId), eq(pmIssueTemplates.team_id, teamId)));
        }
        const values = {
          name: input.name.trim(),
          title_pattern: input.title_pattern ?? null,
          description_md: input.description_md ?? null,
          default_priority: input.default_priority ?? null,
          default_estimate: input.default_estimate != null ? String(input.default_estimate) : null,
          is_team_default: input.is_team_default ?? false,
        };
        const [row] = input.id
          ? await tx
              .update(pmIssueTemplates)
              .set(values)
              .where(and(eq(pmIssueTemplates.id, input.id), eq(pmIssueTemplates.tenant_id, tenantId), eq(pmIssueTemplates.team_id, teamId)))
              .returning()
          : await tx
              .insert(pmIssueTemplates)
              .values({ ...values, tenant_id: tenantId, team_id: teamId, created_by: userId })
              .returning();
        if (!row) throw new NotFoundException('Template not found');
        await this.domainEvents.publish(
          { name: 'pm.template.saved', tenantId, actorUserId: userId, payload: { template_id: row.id, team_id: teamId } },
          tx,
        );
        return { data: row };
      },
      userId,
    );
  }

  async remove(tenantId: string, userId: string, teamId: string, id: string) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        await this.assertTeamVisible(tx, tenantId, userId, teamId);
        const [row] = await tx
          .delete(pmIssueTemplates)
          .where(and(eq(pmIssueTemplates.id, id), eq(pmIssueTemplates.tenant_id, tenantId), eq(pmIssueTemplates.team_id, teamId)))
          .returning();
        if (!row) throw new NotFoundException('Template not found');
        await this.audit.log({
          tenantId,
          actorUserId: userId,
          action: 'pm.template.delete',
          resourceType: 'pm_issue_template',
          resourceId: id,
          metadata: { name: row.name },
        });
        return { data: { removed: true } };
      },
      userId,
    );
  }
}
