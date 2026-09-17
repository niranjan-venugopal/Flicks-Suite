import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import {
  pmIssues,
  pmIssueLabels,
  pmLabels,
  pmProjects,
  pmProjectMilestones,
  pmWorkflowStates,
} from '@flicks/db/schema';
import {
  PM_INSIGHT_MEASURES,
  PM_INSIGHT_SEGMENTS,
  PM_INSIGHT_SLICES,
  buildProgressSeries,
  predictCompletion,
  type PmInsightIssue,
  type PmInsightState,
  type PmInsightsConfig,
} from '@flicks/shared/pm';
import { DatabaseService } from '../../core/database/database.service';
import { DomainEventsService } from '../../core/events/domain-events.service';
import { PmProjectsService } from './projects.service';
import { PmTeamsService } from './teams.service';
import { PmVisibilityService } from './sync/visibility.service';

/**
 * Round M — the project page's right rail: the Insights card (Measure ×
 * Slice × Segment) and the Progress graph (weekly scope / started / done +
 * a predicted completion). Computed on the fly from issue timestamps — no
 * snapshot table this round — with the pivot itself left to the client, so
 * changing Measure/Slice/Segment never re-fetches. Sync-mode clients run
 * the identical `@flicks/shared/pm` math over their local graph; this
 * endpoint is the REST (kill-switch) twin and the source of the label rows
 * the store may lack.
 *
 * Read gate = `detail()`'s, through PmProjectsService.assertReadableTx, so
 * a caller gets the same status here as on the page that embeds the card.
 */

const iso = (d: Date | string | null | undefined): string | null =>
  d == null ? null : d instanceof Date ? d.toISOString() : new Date(d).toISOString();

/**
 * Security review — hard cap on the issue rows one call ships (most recent
 * first). There was no LIMIT: a project holding tens of thousands of issues
 * turned every project open in REST mode into a multi-MB response, on a
 * 60 s staleTime and with no per-route throttle. When the cap bites the
 * payload says so (`truncated: true`) so the card can label the numbers
 * "most recent N" instead of presenting a partial count as the whole.
 */
export const PM_INSIGHTS_ISSUE_CAP = 5000;

@Injectable()
export class InsightsService {
  /** Overridable in specs (a subclass) so the cap is exercised without seeding 5 001 rows. */
  protected readonly issueCap: number = PM_INSIGHTS_ISSUE_CAP;

  constructor(
    private readonly db: DatabaseService,
    private readonly visibility: PmVisibilityService,
    private readonly projects: PmProjectsService,
    private readonly teams: PmTeamsService,
    private readonly domainEvents: DomainEventsService,
  ) {}

  async get(tenantId: string, userId: string, projectId: string) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const project = await this.projects.assertReadableTx(tx, tenantId, userId, projectId);

        // ONE issues ⋈ states query — the category rides along so canceled
        // rows without a lifecycle stamp (imports) are still recognised.
        // Newest first, one row past the cap so truncation is detected
        // without a COUNT; flipped back to oldest-first below for the wire.
        const cap = this.issueCap;
        const fetched = await tx
          .select({
            id: pmIssues.id,
            state_id: pmIssues.state_id,
            category: pmWorkflowStates.category,
            priority: pmIssues.priority,
            estimate: pmIssues.estimate,
            assignee_user_id: pmIssues.assignee_user_id,
            milestone_id: pmIssues.milestone_id,
            created_at: pmIssues.created_at,
            started_at: pmIssues.started_at,
            completed_at: pmIssues.completed_at,
            canceled_at: pmIssues.canceled_at,
          })
          .from(pmIssues)
          .innerJoin(
            pmWorkflowStates,
            and(eq(pmWorkflowStates.id, pmIssues.state_id), eq(pmWorkflowStates.tenant_id, tenantId)),
          )
          .where(
            and(
              eq(pmIssues.tenant_id, tenantId),
              eq(pmIssues.project_id, projectId),
              isNull(pmIssues.deleted_at),
            ),
          )
          .orderBy(desc(pmIssues.created_at), desc(pmIssues.id))
          .limit(cap + 1);
        const truncated = fetched.length > cap;
        const rows = (truncated ? fetched.slice(0, cap) : fetched).reverse();
        const issueIds = rows.map((r) => r.id);
        // Lookups are keyed to what the returned issues actually reference —
        // never "every state of every linked team" or "the whole roster":
        //  · states: a public project linked to a private team would otherwise
        //    ship that team's custom state names to members who cannot see the
        //    team (the bootstrap never does);
        //  · users: the assignee slice needs assignees only. Names come from
        //    the same guest-aware helper the sync bootstrap uses, so a guest
        //    still cannot learn a name outside their invited projects, and a
        //    member no longer receives the full staff list on every open.
        const stateIds = [...new Set(rows.map((r) => r.state_id))];
        const assigneeIds = new Set<string>();
        for (const r of rows) if (r.assignee_user_id) assigneeIds.add(r.assignee_user_id);

        const [labelLinks, milestoneRows, people] = await Promise.all([
          issueIds.length
            ? tx
                .select({ issue_id: pmIssueLabels.issue_id, label_id: pmIssueLabels.label_id })
                .from(pmIssueLabels)
                .where(and(eq(pmIssueLabels.tenant_id, tenantId), inArray(pmIssueLabels.issue_id, issueIds)))
            : Promise.resolve([] as Array<{ issue_id: string; label_id: string }>),
          tx
            .select({ id: pmProjectMilestones.id, name: pmProjectMilestones.name })
            .from(pmProjectMilestones)
            .where(and(eq(pmProjectMilestones.tenant_id, tenantId), eq(pmProjectMilestones.project_id, projectId))),
          // Guest-aware roster (names only — avatars are the members card's job).
          assigneeIds.size
            ? this.teams.usersLiteTx(tx, tenantId, userId)
            : Promise.resolve([] as Array<{ id: string; name: string | null }>),
        ]);

        const labelIdsByIssue = new Map<string, string[]>();
        for (const l of labelLinks) {
          const list = labelIdsByIssue.get(l.issue_id) ?? [];
          list.push(l.label_id);
          labelIdsByIssue.set(l.issue_id, list);
        }
        const labelIds = [...new Set(labelLinks.map((l) => l.label_id))];

        const [stateRows, labelRows] = await Promise.all([
          stateIds.length
            ? tx
                .select({
                  id: pmWorkflowStates.id,
                  name: pmWorkflowStates.name,
                  category: pmWorkflowStates.category,
                  color: pmWorkflowStates.color,
                })
                .from(pmWorkflowStates)
                .where(and(eq(pmWorkflowStates.tenant_id, tenantId), inArray(pmWorkflowStates.id, stateIds)))
                .orderBy(asc(pmWorkflowStates.position))
            : Promise.resolve([] as PmInsightState[]),
          labelIds.length
            ? tx
                .select({ id: pmLabels.id, name: pmLabels.name, color: pmLabels.color })
                .from(pmLabels)
                .where(and(eq(pmLabels.tenant_id, tenantId), inArray(pmLabels.id, labelIds)))
            : Promise.resolve([] as Array<{ id: string; name: string; color: string }>),
        ]);

        const issues: PmInsightIssue[] = rows.map((r) => ({
          id: r.id,
          state_id: r.state_id,
          priority: r.priority,
          estimate: r.estimate == null ? null : Number(r.estimate),
          assignee_user_id: r.assignee_user_id,
          milestone_id: r.milestone_id,
          label_ids: labelIdsByIssue.get(r.id) ?? [],
          created_at: iso(r.created_at)!,
          started_at: iso(r.started_at),
          completed_at: iso(r.completed_at),
          canceled_at: iso(r.canceled_at),
        }));
        const states: PmInsightState[] = stateRows.map((s) => ({ id: s.id, name: s.name, category: s.category, color: s.color }));
        const now = new Date();
        const series = buildProgressSeries(issues, { to: now.toISOString(), states });
        const prediction = predictCompletion(series, now.toISOString());

        return {
          data: {
            issues,
            states,
            labels: Object.fromEntries(labelRows.map((l) => [l.id, { name: l.name, color: l.color }])),
            milestones: Object.fromEntries(milestoneRows.map((m) => [m.id, m.name])),
            users: Object.fromEntries(people.filter((p) => assigneeIds.has(p.id)).map((p) => [p.id, p.name ?? ''])),
            series,
            prediction,
            target_date: project.target_date ?? null,
            insights_default: (project.insights_default as PmInsightsConfig | null) ?? null,
            generated_at: now.toISOString(),
            /** True when the project holds more live issues than `issue_cap`; only the most recent ones are here. */
            truncated,
            issue_cap: cap,
          },
        };
      },
      userId,
    );
  }

  /**
   * "Set default for everyone" — saved on the project row, shipped to sync
   * clients through the same `pm.project.updated` + `pm_projects` ref that
   * update() publishes. Authority is the delete path's bar (manager and
   * above, plus the project's own lead), enforced here rather than with
   * @Roles because the same question is per-project, not per-route.
   */
  async setDefault(tenantId: string, userId: string, role: string | undefined, projectId: string, cfg: PmInsightsConfig) {
    if (
      !PM_INSIGHT_MEASURES.includes(cfg?.measure as never) ||
      !PM_INSIGHT_SLICES.includes(cfg?.slice as never) ||
      !PM_INSIGHT_SEGMENTS.includes(cfg?.segment as never)
    ) {
      throw new BadRequestException('invalid insights config');
    }
    const clean: PmInsightsConfig = { measure: cfg.measure, slice: cfg.slice, segment: cfg.segment };
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        await this.visibility.assertNotGuestTx(tx, tenantId, userId, 'project management');
        const project = await this.projects.assertReadableTx(tx, tenantId, userId, projectId);
        const elevated = !!role && !['employee', 'auditor', 'guest'].includes(role);
        const isLead = !!project.lead_user_id && project.lead_user_id === userId;
        if (!elevated && !isLead) {
          throw new ForbiddenException('Only the project lead, or a manager and above, can set the default Insights view.');
        }
        const [row] = await tx
          .update(pmProjects)
          .set({ insights_default: clean, updated_at: new Date() })
          .where(and(eq(pmProjects.id, projectId), eq(pmProjects.tenant_id, tenantId)))
          .returning({ id: pmProjects.id, insights_default: pmProjects.insights_default });
        await this.domainEvents.publish(
          {
            name: 'pm.project.updated',
            tenantId,
            actorUserId: userId,
            payload: { project_id: projectId, insights_default: clean, sync: [{ t: 'pm_projects', id: projectId }] },
          },
          tx,
        );
        return { data: { project_id: projectId, insights_default: (row!.insights_default as PmInsightsConfig | null) ?? clean } };
      },
      userId,
    );
  }
}
