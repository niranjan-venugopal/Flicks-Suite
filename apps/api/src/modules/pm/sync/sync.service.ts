import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import {
  domainEvents,
  pmTeams,
  pmTeamMemberships,
  pmWorkflowStates,
  pmLabels,
  pmIssues,
  pmIssueLabels,
  pmIssueRelations,
  pmIssueSubscribers,
  pmProjects,
  pmProjectTeams,
  pmProjectMembers,
  pmProjectMilestones,
  pmProjectUpdates,
  pmInitiatives,
  pmInitiativeProjects,
  pmCycles,
} from '@flicks/db/schema';
import type { Db, DbAdmin } from '@flicks/db';
import type { PmSyncTable } from '@flicks/shared/pm';
import { DB_SERVICE_ROLE } from '../../../core/database/database.module';
import { DatabaseService } from '../../../core/database/database.service';
import { PmVisibilityService } from './visibility.service';
import { PmTeamsService } from '../teams.service';

/**
 * FSE server core (PRD v6 §3.3/§3.4).
 *
 * BOOTSTRAP — instant models for the visible workspace, streamed as NDJSON
 * (issues ship WITHOUT description — the registry projection; description/
 * comments/history are lazy). latest_seq is read BEFORE the snapshot queries:
 * anything committed during the read is re-delivered by the first delta —
 * snapshot deltas are idempotent, so overlap is harmless (never a gap).
 *
 * DELTA — the outbox is read via the SERVICE ROLE (the app role is INSERT-only
 * on domain_events) but with explicit tenant + seq predicates (house rule),
 * collecting the `sync` refs each pm.* publisher embeds in its payload. Rows
 * are then RE-FETCHED under the normal RLS tenant transaction + visibility
 * filter — the client only ever receives what it could read directly. Touched
 * ids that the visible re-fetch does NOT return become tombstones (covers
 * deletes AND visibility loss with one rule).
 *
 * Join tables (pm_issue_labels/_subscribers/_relations) sync as issue-scoped
 * collections: the ref id is the ISSUE id and the delta ships the full current
 * set for that issue (client replaces).
 */

interface SyncRef {
  t: string;
  id: string;
}

const ISSUE_SCOPED: ReadonlySet<string> = new Set([
  'pm_issue_labels',
  'pm_issue_subscribers',
  'pm_issue_relations',
]);

// Project-scoped collections: ref id = PROJECT id, full set replaces (§3.4).
const PROJECT_SCOPED: ReadonlySet<string> = new Set(['pm_project_teams', 'pm_project_members']);

const PM_PROJECT_PROJECTION = {
  id: pmProjects.id,
  name: pmProjects.name,
  summary: pmProjects.summary,
  icon: pmProjects.icon,
  color: pmProjects.color,
  status: pmProjects.status,
  health: pmProjects.health,
  lead_user_id: pmProjects.lead_user_id,
  start_date: pmProjects.start_date,
  target_date: pmProjects.target_date,
  deal_id: pmProjects.deal_id,
  completed_at: pmProjects.completed_at,
  created_at: pmProjects.created_at,
  updated_at: pmProjects.updated_at,
  deleted_at: pmProjects.deleted_at,
};

@Injectable()
export class PmSyncService {
  constructor(
    private readonly db: DatabaseService,
    @Inject(DB_SERVICE_ROLE) private readonly dbAdmin: DbAdmin,
    private readonly visibility: PmVisibilityService,
    private readonly teams: PmTeamsService,
  ) {}

  /** Global cursor head (indexed max). */
  async latestSeq(): Promise<number> {
    const [row] = await this.dbAdmin
      .select({ max: sql<number>`coalesce(max(${domainEvents.sync_seq}), 0)` })
      .from(domainEvents);
    return Number(row?.max ?? 0);
  }

  /** Oldest retained seq (prune job advances this; 0 = full history present). */
  async minSeqHorizon(): Promise<number> {
    const [row] = await this.dbAdmin
      .select({ min: sql<number>`coalesce(min(${domainEvents.sync_seq}), 0)` })
      .from(domainEvents);
    return Math.max(0, Number(row?.min ?? 0) - 1);
  }

  /** Bootstrap payload as NDJSON lines (§3.3). */
  async bootstrap(tenantId: string, userId: string): Promise<string[]> {
    await this.teams.ensureWorkspace(tenantId, userId);
    const latestSeq = await this.latestSeq(); // BEFORE the snapshot reads
    const horizon = await this.minSeqHorizon();

    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const visible = await this.visibility.visibleTeamIdsTx(tx, tenantId, userId);
        const lines: string[] = [];
        const push = (model: string, rows: unknown[]) =>
          lines.push(JSON.stringify({ model, rows }));

        const teams = visible.length
          ? await tx
              .select({
                id: pmTeams.id, key: pmTeams.key, name: pmTeams.name, icon: pmTeams.icon,
                color: pmTeams.color, is_private: pmTeams.is_private, timezone: pmTeams.timezone,
                cycles_enabled: pmTeams.cycles_enabled, cycle_length_weeks: pmTeams.cycle_length_weeks,
                cooldown_days: pmTeams.cooldown_days, cycle_start_dow: pmTeams.cycle_start_dow,
                cycle_auto_add_started: pmTeams.cycle_auto_add_started,
                upcoming_cycles: pmTeams.upcoming_cycles, estimate_scale: pmTeams.estimate_scale,
                triage_enabled: pmTeams.triage_enabled, default_state_id: pmTeams.default_state_id,
                created_at: pmTeams.created_at, deleted_at: pmTeams.deleted_at,
              })
              .from(pmTeams)
              .where(and(eq(pmTeams.tenant_id, tenantId), inArray(pmTeams.id, visible)))
          : [];
        push('pm_teams', teams);

        const memberships_ = visible.length
          ? await tx
              .select({
                team_id: pmTeamMemberships.team_id, user_id: pmTeamMemberships.user_id,
                is_lead: pmTeamMemberships.is_lead, joined_at: pmTeamMemberships.joined_at,
              })
              .from(pmTeamMemberships)
              .where(and(eq(pmTeamMemberships.tenant_id, tenantId), inArray(pmTeamMemberships.team_id, visible)))
          : [];
        push('pm_team_memberships', memberships_);

        const states = visible.length
          ? await tx
              .select({
                id: pmWorkflowStates.id, team_id: pmWorkflowStates.team_id,
                name: pmWorkflowStates.name, color: pmWorkflowStates.color,
                category: pmWorkflowStates.category, position: pmWorkflowStates.position,
                is_default_for_category: pmWorkflowStates.is_default_for_category,
              })
              .from(pmWorkflowStates)
              .where(and(eq(pmWorkflowStates.tenant_id, tenantId), inArray(pmWorkflowStates.team_id, visible)))
              .orderBy(asc(pmWorkflowStates.position))
          : [];
        push('pm_workflow_states', states);

        const labels = await tx
          .select({
            id: pmLabels.id, team_id: pmLabels.team_id, name: pmLabels.name,
            color: pmLabels.color, description: pmLabels.description,
          })
          .from(pmLabels)
          .where(eq(pmLabels.tenant_id, tenantId));
        push('pm_labels', labels.filter((l) => !l.team_id || visible.includes(l.team_id)));

        push('pm_users_lite', await this.teams.usersLite(tenantId, userId));

        // Issues: registry projection (NO description), most-recent 2000/team.
        for (const teamId of visible) {
          const rows = await tx
            .select({
              id: pmIssues.id, team_id: pmIssues.team_id, number: pmIssues.number,
              title: pmIssues.title, state_id: pmIssues.state_id, priority: pmIssues.priority,
              estimate: pmIssues.estimate, assignee_user_id: pmIssues.assignee_user_id,
              creator_user_id: pmIssues.creator_user_id, parent_issue_id: pmIssues.parent_issue_id,
              project_id: pmIssues.project_id, milestone_id: pmIssues.milestone_id,
              cycle_id: pmIssues.cycle_id, due_date: pmIssues.due_date,
              board_rank: pmIssues.board_rank, backlog_rank: pmIssues.backlog_rank,
              source: pmIssues.source, triaged_at: pmIssues.triaged_at,
              snoozed_until: pmIssues.snoozed_until,
              started_at: pmIssues.started_at, completed_at: pmIssues.completed_at,
              canceled_at: pmIssues.canceled_at, created_at: pmIssues.created_at,
              updated_at: pmIssues.updated_at, deleted_at: pmIssues.deleted_at,
            })
            .from(pmIssues)
            .where(and(eq(pmIssues.tenant_id, tenantId), eq(pmIssues.team_id, teamId), isNull(pmIssues.deleted_at)))
            .orderBy(desc(pmIssues.updated_at))
            .limit(2000);
          if (rows.length) push('pm_issues', rows);

          const issueIds = rows.map((r) => r.id);
          if (issueIds.length) {
            push(
              'pm_issue_labels',
              await tx
                .select({ issue_id: pmIssueLabels.issue_id, label_id: pmIssueLabels.label_id })
                .from(pmIssueLabels)
                .where(and(eq(pmIssueLabels.tenant_id, tenantId), inArray(pmIssueLabels.issue_id, issueIds))),
            );
            push(
              'pm_issue_subscribers',
              await tx
                .select({ issue_id: pmIssueSubscribers.issue_id, user_id: pmIssueSubscribers.user_id })
                .from(pmIssueSubscribers)
                .where(and(eq(pmIssueSubscribers.tenant_id, tenantId), inArray(pmIssueSubscribers.issue_id, issueIds))),
            );
            push(
              'pm_issue_relations',
              await tx
                .select({
                  id: pmIssueRelations.id, issue_id: pmIssueRelations.issue_id,
                  related_issue_id: pmIssueRelations.related_issue_id, type: pmIssueRelations.type,
                })
                .from(pmIssueRelations)
                .where(and(eq(pmIssueRelations.tenant_id, tenantId), inArray(pmIssueRelations.issue_id, issueIds))),
            );
          }
        }

        // Projects layer (§6): projects/milestones/initiatives are instant
        // models; project-update BODIES ride along (small text, latest 10/project).
        const visibleProjects = await this.visibility.visibleProjectIdsTx(tx, tenantId, userId);
        if (visibleProjects.length) {
          push(
            'pm_projects',
            await tx
              .select(PM_PROJECT_PROJECTION)
              .from(pmProjects)
              .where(and(eq(pmProjects.tenant_id, tenantId), inArray(pmProjects.id, visibleProjects), isNull(pmProjects.deleted_at))),
          );
          push(
            'pm_project_teams',
            await tx
              .select({ project_id: pmProjectTeams.project_id, team_id: pmProjectTeams.team_id })
              .from(pmProjectTeams)
              .where(and(eq(pmProjectTeams.tenant_id, tenantId), inArray(pmProjectTeams.project_id, visibleProjects))),
          );
          push(
            'pm_project_members',
            await tx
              .select({ project_id: pmProjectMembers.project_id, user_id: pmProjectMembers.user_id })
              .from(pmProjectMembers)
              .where(and(eq(pmProjectMembers.tenant_id, tenantId), inArray(pmProjectMembers.project_id, visibleProjects))),
          );
          push(
            'pm_project_milestones',
            await tx
              .select({
                id: pmProjectMilestones.id, project_id: pmProjectMilestones.project_id,
                name: pmProjectMilestones.name, target_date: pmProjectMilestones.target_date,
                position: pmProjectMilestones.position, created_at: pmProjectMilestones.created_at,
              })
              .from(pmProjectMilestones)
              .where(and(eq(pmProjectMilestones.tenant_id, tenantId), inArray(pmProjectMilestones.project_id, visibleProjects))),
          );
          const updates = await tx.execute(sql`
            SELECT id, project_id, health, body_md, author_user_id, created_at FROM (
              SELECT id, project_id, health, body_md, author_user_id, created_at,
                     row_number() OVER (PARTITION BY project_id ORDER BY created_at DESC) AS rn
              FROM pm_project_updates
              WHERE tenant_id = ${tenantId}
                AND project_id IN (${sql.join(visibleProjects.map((p) => sql`${p}`), sql`, `)})
            ) ranked WHERE rn <= 10
          `);
          push('pm_project_updates', updates as unknown as unknown[]);
        }
        const initiatives = await tx
          .select()
          .from(pmInitiatives)
          .where(and(eq(pmInitiatives.tenant_id, tenantId), isNull(pmInitiatives.deleted_at)));
        push(
          'pm_initiatives',
          initiatives.map((i) => ({
            id: i.id, name: i.name, description: i.description, status: i.status,
            owner_user_id: i.owner_user_id, target_quarter: i.target_quarter,
            created_at: i.created_at, updated_at: i.updated_at, deleted_at: i.deleted_at,
          })),
        );
        push(
          'pm_initiative_projects',
          await tx
            .select({
              initiative_id: pmInitiativeProjects.initiative_id,
              project_id: pmInitiativeProjects.project_id,
              position: pmInitiativeProjects.position,
            })
            .from(pmInitiativeProjects)
            .where(eq(pmInitiativeProjects.tenant_id, tenantId)),
        );

        // Cycles (§7): current + upcoming + recent history for visible teams.
        if (visible.length) {
          const cutoff = new Date(Date.now() - 60 * 86_400_000);
          const cycles = await tx
            .select({
              id: pmCycles.id, team_id: pmCycles.team_id, number: pmCycles.number,
              starts_at: pmCycles.starts_at, ends_at: pmCycles.ends_at,
              cooldown_ends_at: pmCycles.cooldown_ends_at, status: pmCycles.status,
              created_at: pmCycles.created_at,
            })
            .from(pmCycles)
            .where(and(eq(pmCycles.tenant_id, tenantId), inArray(pmCycles.team_id, visible)));
          push('pm_cycles', cycles.filter((c) => c.status !== 'completed' || c.ends_at > cutoff));
        }

        lines.push(JSON.stringify({ latest_seq: latestSeq, min_seq_horizon: horizon }));
        return lines;
      },
      userId,
    );
  }

  /** Delta since a cursor (§3.4). Returns 410-shaped flag when past horizon. */
  async delta(tenantId: string, userId: string, since: number) {
    const horizon = await this.minSeqHorizon();
    if (since < horizon) {
      return { reBootstrap: true as const, latest_seq: await this.latestSeq() };
    }

    // 1. Collect touched refs from pm.* events past the cursor (service role;
    //    explicit tenant + seq predicates — house rule).
    const events = await this.dbAdmin
      .select({ payload: domainEvents.payload, seq: domainEvents.sync_seq })
      .from(domainEvents)
      .where(
        and(
          eq(domainEvents.tenant_id, tenantId),
          gt(domainEvents.sync_seq, since),
          sql`${domainEvents.event_name} LIKE 'pm.%'`,
        ),
      )
      .orderBy(asc(domainEvents.sync_seq))
      .limit(5000);

    const latestSeq = await this.latestSeq();
    const touched = new Map<string, Set<string>>(); // table → ids
    for (const ev of events) {
      const refs = (ev.payload as { sync?: SyncRef[] })?.sync ?? [];
      for (const ref of refs) {
        if (!touched.has(ref.t)) touched.set(ref.t, new Set());
        touched.get(ref.t)!.add(ref.id);
      }
    }

    if (touched.size === 0) {
      return { upserts: {}, tombstones: {}, latest_seq: latestSeq, min_seq_horizon: horizon };
    }

    // 2. Re-fetch current rows under RLS + visibility. Missing ⇒ tombstone.
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const visible = await this.visibility.visibleTeamIdsTx(tx, tenantId, userId);
        const upserts: Partial<Record<PmSyncTable, unknown[]>> = {};
        const tombstones: Partial<Record<PmSyncTable, string[]>> = {};

        const record = (table: PmSyncTable, wanted: Set<string>, rows: Array<{ id?: string; issue_id?: string }>) => {
          if (rows.length) upserts[table] = rows;
          const returned = new Set(rows.map((r) => (r.id ?? r.issue_id)!));
          const missing = [...wanted].filter((id) => !returned.has(id));
          if (missing.length) tombstones[table] = missing;
        };

        for (const [table, idSet] of touched) {
          const ids = [...idSet];
          switch (table as PmSyncTable) {
            case 'pm_teams': {
              const rows = visible.length
                ? await tx.select().from(pmTeams).where(and(eq(pmTeams.tenant_id, tenantId), inArray(pmTeams.id, ids.filter((i) => visible.includes(i))), isNull(pmTeams.deleted_at)))
                : [];
              record('pm_teams', idSet, rows);
              break;
            }
            case 'pm_team_memberships': {
              // ref id = team id; ship the full roster for that team.
              const teamIds = ids.filter((i) => visible.includes(i));
              const rows = teamIds.length
                ? await tx.select().from(pmTeamMemberships).where(and(eq(pmTeamMemberships.tenant_id, tenantId), inArray(pmTeamMemberships.team_id, teamIds)))
                : [];
              if (rows.length) upserts.pm_team_memberships = rows;
              break;
            }
            case 'pm_workflow_states': {
              const rows = await tx.select().from(pmWorkflowStates).where(and(eq(pmWorkflowStates.tenant_id, tenantId), inArray(pmWorkflowStates.id, ids)));
              record('pm_workflow_states', idSet, rows.filter((r) => visible.includes(r.team_id)));
              break;
            }
            case 'pm_labels': {
              const rows = await tx.select().from(pmLabels).where(and(eq(pmLabels.tenant_id, tenantId), inArray(pmLabels.id, ids)));
              record('pm_labels', idSet, rows.filter((r) => !r.team_id || visible.includes(r.team_id)));
              break;
            }
            case 'pm_issues': {
              const rows = await tx
                .select({
                  id: pmIssues.id, team_id: pmIssues.team_id, number: pmIssues.number,
                  title: pmIssues.title, state_id: pmIssues.state_id, priority: pmIssues.priority,
                  estimate: pmIssues.estimate, assignee_user_id: pmIssues.assignee_user_id,
                  creator_user_id: pmIssues.creator_user_id, parent_issue_id: pmIssues.parent_issue_id,
                  project_id: pmIssues.project_id, milestone_id: pmIssues.milestone_id,
                  cycle_id: pmIssues.cycle_id, due_date: pmIssues.due_date,
                  board_rank: pmIssues.board_rank, backlog_rank: pmIssues.backlog_rank,
                  source: pmIssues.source, triaged_at: pmIssues.triaged_at,
                  snoozed_until: pmIssues.snoozed_until,
                  started_at: pmIssues.started_at, completed_at: pmIssues.completed_at,
                  canceled_at: pmIssues.canceled_at, created_at: pmIssues.created_at,
                  updated_at: pmIssues.updated_at, deleted_at: pmIssues.deleted_at,
                  })
                .from(pmIssues)
                .where(and(eq(pmIssues.tenant_id, tenantId), inArray(pmIssues.id, ids), isNull(pmIssues.deleted_at)));
              record('pm_issues', idSet, rows.filter((r) => visible.includes(r.team_id)));
              break;
            }
            case 'pm_cycles': {
              const rows = await tx
                .select({
                  id: pmCycles.id, team_id: pmCycles.team_id, number: pmCycles.number,
                  starts_at: pmCycles.starts_at, ends_at: pmCycles.ends_at,
                  cooldown_ends_at: pmCycles.cooldown_ends_at, status: pmCycles.status,
                  created_at: pmCycles.created_at,
                })
                .from(pmCycles)
                .where(and(eq(pmCycles.tenant_id, tenantId), inArray(pmCycles.id, ids)));
              record('pm_cycles', idSet, rows.filter((r) => visible.includes(r.team_id)));
              break;
            }
            case 'pm_projects': {
              const visibleProjects = await this.visibility.visibleProjectIdsTx(tx, tenantId, userId);
              const rows = await tx
                .select(PM_PROJECT_PROJECTION)
                .from(pmProjects)
                .where(and(eq(pmProjects.tenant_id, tenantId), inArray(pmProjects.id, ids), isNull(pmProjects.deleted_at)));
              record('pm_projects', idSet, rows.filter((r) => visibleProjects.includes(r.id)));
              break;
            }
            case 'pm_project_milestones': {
              const visibleProjects = await this.visibility.visibleProjectIdsTx(tx, tenantId, userId);
              const rows = await tx
                .select({
                  id: pmProjectMilestones.id, project_id: pmProjectMilestones.project_id,
                  name: pmProjectMilestones.name, target_date: pmProjectMilestones.target_date,
                  position: pmProjectMilestones.position, created_at: pmProjectMilestones.created_at,
                })
                .from(pmProjectMilestones)
                .where(and(eq(pmProjectMilestones.tenant_id, tenantId), inArray(pmProjectMilestones.id, ids)));
              record('pm_project_milestones', idSet, rows.filter((r) => visibleProjects.includes(r.project_id)));
              break;
            }
            case 'pm_project_updates': {
              const visibleProjects = await this.visibility.visibleProjectIdsTx(tx, tenantId, userId);
              const rows = await tx
                .select({
                  id: pmProjectUpdates.id, project_id: pmProjectUpdates.project_id,
                  health: pmProjectUpdates.health, body_md: pmProjectUpdates.body_md,
                  author_user_id: pmProjectUpdates.author_user_id, created_at: pmProjectUpdates.created_at,
                })
                .from(pmProjectUpdates)
                .where(and(eq(pmProjectUpdates.tenant_id, tenantId), inArray(pmProjectUpdates.id, ids)));
              record('pm_project_updates', idSet, rows.filter((r) => visibleProjects.includes(r.project_id)));
              break;
            }
            case 'pm_initiatives': {
              const rows = await tx
                .select({
                  id: pmInitiatives.id, name: pmInitiatives.name, description: pmInitiatives.description,
                  status: pmInitiatives.status, owner_user_id: pmInitiatives.owner_user_id,
                  target_quarter: pmInitiatives.target_quarter, created_at: pmInitiatives.created_at,
                  updated_at: pmInitiatives.updated_at, deleted_at: pmInitiatives.deleted_at,
                })
                .from(pmInitiatives)
                .where(and(eq(pmInitiatives.tenant_id, tenantId), inArray(pmInitiatives.id, ids), isNull(pmInitiatives.deleted_at)));
              record('pm_initiatives', idSet, rows);
              break;
            }
            case 'pm_initiative_projects': {
              // ref id = INITIATIVE id; ship the full ordered set + scope.
              const rows = await tx
                .select({
                  initiative_id: pmInitiativeProjects.initiative_id,
                  project_id: pmInitiativeProjects.project_id,
                  position: pmInitiativeProjects.position,
                })
                .from(pmInitiativeProjects)
                .where(and(eq(pmInitiativeProjects.tenant_id, tenantId), inArray(pmInitiativeProjects.initiative_id, ids)));
              upserts.pm_initiative_projects = rows;
              (upserts as Record<string, unknown>)['pm_initiative_projects__scope'] = ids;
              break;
            }
            default: {
              if (PROJECT_SCOPED.has(table)) {
                // ref id = PROJECT id; full current set for visible projects.
                const visibleProjects = await this.visibility.visibleProjectIdsTx(tx, tenantId, userId);
                const scopeIds = ids.filter((i) => visibleProjects.includes(i));
                if (!scopeIds.length) break;
                if (table === 'pm_project_teams') {
                  upserts.pm_project_teams = await tx
                    .select({ project_id: pmProjectTeams.project_id, team_id: pmProjectTeams.team_id })
                    .from(pmProjectTeams)
                    .where(and(eq(pmProjectTeams.tenant_id, tenantId), inArray(pmProjectTeams.project_id, scopeIds)));
                } else if (table === 'pm_project_members') {
                  upserts.pm_project_members = await tx
                    .select({ project_id: pmProjectMembers.project_id, user_id: pmProjectMembers.user_id })
                    .from(pmProjectMembers)
                    .where(and(eq(pmProjectMembers.tenant_id, tenantId), inArray(pmProjectMembers.project_id, scopeIds)));
                }
                (upserts as Record<string, unknown>)[`${table}__scope`] = scopeIds;
                break;
              }
              if (ISSUE_SCOPED.has(table)) {
                // ref id = issue id; ship the issue's full current set (only
                // for issues in visible teams).
                const issueRows = await tx
                  .select({ id: pmIssues.id, team_id: pmIssues.team_id })
                  .from(pmIssues)
                  .where(and(eq(pmIssues.tenant_id, tenantId), inArray(pmIssues.id, ids)));
                const visibleIssueIds = issueRows.filter((r) => visible.includes(r.team_id)).map((r) => r.id);
                if (!visibleIssueIds.length) break;
                if (table === 'pm_issue_labels') {
                  upserts.pm_issue_labels = await tx
                    .select({ issue_id: pmIssueLabels.issue_id, label_id: pmIssueLabels.label_id })
                    .from(pmIssueLabels)
                    .where(and(eq(pmIssueLabels.tenant_id, tenantId), inArray(pmIssueLabels.issue_id, visibleIssueIds)));
                } else if (table === 'pm_issue_subscribers') {
                  upserts.pm_issue_subscribers = await tx
                    .select({ issue_id: pmIssueSubscribers.issue_id, user_id: pmIssueSubscribers.user_id })
                    .from(pmIssueSubscribers)
                    .where(and(eq(pmIssueSubscribers.tenant_id, tenantId), inArray(pmIssueSubscribers.issue_id, visibleIssueIds)));
                } else if (table === 'pm_issue_relations') {
                  upserts.pm_issue_relations = await tx
                    .select({
                      id: pmIssueRelations.id, issue_id: pmIssueRelations.issue_id,
                      related_issue_id: pmIssueRelations.related_issue_id, type: pmIssueRelations.type,
                    })
                    .from(pmIssueRelations)
                    .where(and(eq(pmIssueRelations.tenant_id, tenantId), inArray(pmIssueRelations.issue_id, visibleIssueIds)));
                }
                // Attach the scope ids so the client knows which issues' sets
                // these collections replace (empty set ⇒ clear).
                (upserts as Record<string, unknown>)[`${table}__scope`] = visibleIssueIds;
              }
              break;
            }
          }
        }

        return { upserts, tombstones, latest_seq: latestSeq, min_seq_horizon: horizon };
      },
      userId,
    );
  }
}
