import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  pmIssues,
  pmTeams,
  pmTeamMemberships,
  pmTeamCounters,
  pmWorkflowStates,
  pmIssueHistory,
  pmIssueSubscribers,
  pmIssueLabels,
  pmIssueRelations,
  pmIssueComments,
  pmLabels,
  pmProjects,
  pmProjectMilestones,
  pmCycles,
  pmIssueGitLinks,
  memberships,
} from '@flicks/db/schema';
import type { Db } from '@flicks/db';
import { rankBetween } from '@flicks/shared/pm';
import { DatabaseService } from '../../core/database/database.service';
import { AuditService } from '../audit/audit.service';
import { DomainEventsService } from '../../core/events/domain-events.service';
import { NotificationsService } from '../notifications/notifications.service';

/**
 * PM issues (PRD v6 §5) — ONE service, TWO transports. The REST controller
 * (kill-switch path) and the sync mutation-executor both call these methods,
 * so validation, team access, history, timestamps and events exist once.
 * Every write publishes a pm.* event in the SAME transaction; payloads carry a
 * `sync` array of touched rows — the delta endpoint's collection contract.
 */

export interface CreateIssueInput {
  id?: string; // client-minted uuid (sync path); server mints when absent
  team_id: string;
  title: string;
  description?: string | null;
  state_id?: string; // defaults to the team's default (backlog) state
  priority?: number;
  estimate?: string | number | null;
  assignee_user_id?: string | null;
  parent_issue_id?: string | null;
  due_date?: string | null;
  source?: string;
}

export interface UpdateIssueInput {
  title?: string;
  description?: string | null;
  estimate?: string | number | null;
  due_date?: string | null;
}

const HISTORY_FIELDS: Array<keyof UpdateIssueInput> = ['title', 'estimate', 'due_date'];

@Injectable()
export class PmIssuesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly domainEvents: DomainEventsService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Inbox fan-out (§11): best-effort, never blocks or fails the mutation.
   * One group key per issue so repeat activity bumps a single inbox row.
   */
  private notifyInbox(
    tenantId: string,
    issueId: string,
    userIds: Array<string | null | undefined>,
    type: string,
    message: string,
  ) {
    const unique = [...new Set(userIds.filter((u): u is string => !!u))];
    for (const uid of unique) {
      void this.notifications
        .createInAppNotification(uid, type, message, `/pm/issues/${issueId}`, tenantId, {
          groupKey: `pm.issue:${issueId}`,
        })
        .catch(() => undefined);
    }
  }

  /** Subscriber ids for an issue (fan-out audience), inside the caller's tx. */
  private async subscriberIds(tx: Db, issueId: string): Promise<string[]> {
    const rows = await tx
      .select({ user_id: pmIssueSubscribers.user_id })
      .from(pmIssueSubscribers)
      .where(eq(pmIssueSubscribers.issue_id, issueId));
    return rows.map((r) => r.user_id);
  }

  // ─── helpers (run inside the caller's tenant tx) ──────────────────────────

  /** Team must exist, be visible to the user (public or member), not deleted. */
  private async assertTeamAccess(tx: Db, tenantId: string, userId: string, teamId: string) {
    const [team] = await tx
      .select()
      .from(pmTeams)
      .where(and(eq(pmTeams.id, teamId), eq(pmTeams.tenant_id, tenantId), isNull(pmTeams.deleted_at)))
      .limit(1);
    if (!team) throw new BadRequestException('team_id does not belong to this workspace');
    if (team.is_private) {
      const [m] = await tx
        .select({ user_id: pmTeamMemberships.user_id })
        .from(pmTeamMemberships)
        .where(and(eq(pmTeamMemberships.team_id, teamId), eq(pmTeamMemberships.user_id, userId)))
        .limit(1);
      if (!m) throw new ForbiddenException('Private team — members only');
    }
    return team;
  }

  private async loadIssue(tx: Db, tenantId: string, id: string) {
    const [issue] = await tx
      .select()
      .from(pmIssues)
      .where(and(eq(pmIssues.id, id), eq(pmIssues.tenant_id, tenantId), isNull(pmIssues.deleted_at)))
      .limit(1);
    if (!issue) throw new NotFoundException('Issue not found');
    return issue;
  }

  private async writeHistory(
    tx: Db,
    tenantId: string,
    issueId: string,
    actorUserId: string,
    entries: Array<{ field: string; from: unknown; to: unknown }>,
  ) {
    if (!entries.length) return;
    await tx.insert(pmIssueHistory).values(
      entries.map((e) => ({
        tenant_id: tenantId,
        issue_id: issueId,
        field: e.field,
        from_value: e.from == null ? null : String(e.from),
        to_value: e.to == null ? null : String(e.to),
        actor_user_id: actorUserId,
      })),
    );
  }

  /** Stamp lifecycle timestamps for a category transition (§5.2). */
  private lifecycleStamps(category: string, prevCategory: string | undefined) {
    const now = new Date();
    const patch: Record<string, Date | null> = {};
    if (category === 'started') patch.started_at = now;
    if (category === 'completed') patch.completed_at = now;
    if (category === 'canceled') patch.canceled_at = now;
    if (category === 'triage') {
      patch.started_at = null;
      patch.completed_at = null;
      patch.canceled_at = null;
      patch.triaged_at = null;
    }
    if (prevCategory === 'completed' && category !== 'completed') patch.completed_at = null;
    if (prevCategory === 'canceled' && category !== 'canceled') patch.canceled_at = null;
    return patch;
  }

  // ─── writes ───────────────────────────────────────────────────────────────

  async create(tenantId: string, userId: string, input: CreateIssueInput) {
    if (!input.title?.trim()) throw new BadRequestException('Title is required');
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const team = await this.assertTeamAccess(tx, tenantId, userId, input.team_id);

        // §8 triage entry rule: an issue created by a NON-member in a public
        // team (or API-intake sources) lands in Triage — the intake gate.
        let stateId = input.state_id ?? team.default_state_id;
        if (!input.state_id && team.triage_enabled) {
          const [member] = await tx
            .select({ user_id: pmTeamMemberships.user_id })
            .from(pmTeamMemberships)
            .where(and(eq(pmTeamMemberships.team_id, team.id), eq(pmTeamMemberships.user_id, userId)))
            .limit(1);
          const intakeSource = input.source === 'api' || input.source === 'intake';
          if (!member || intakeSource) {
            const [triageState] = await tx
              .select({ id: pmWorkflowStates.id })
              .from(pmWorkflowStates)
              .where(and(eq(pmWorkflowStates.team_id, team.id), eq(pmWorkflowStates.category, 'triage')))
              .limit(1);
            if (triageState) stateId = triageState.id;
          }
        }
        if (stateId) {
          const [st] = await tx
            .select()
            .from(pmWorkflowStates)
            .where(and(eq(pmWorkflowStates.id, stateId), eq(pmWorkflowStates.team_id, team.id)))
            .limit(1);
          if (!st) throw new BadRequestException('state_id does not belong to this team');
        } else {
          const [backlog] = await tx
            .select()
            .from(pmWorkflowStates)
            .where(and(eq(pmWorkflowStates.team_id, team.id), eq(pmWorkflowStates.category, 'backlog')))
            .limit(1);
          if (!backlog) throw new BadRequestException('Team has no backlog state');
          stateId = backlog.id;
        }

        if (input.parent_issue_id) await this.loadIssue(tx, tenantId, input.parent_issue_id);

        // Atomic per-team number (row-locked counter).
        const [counter] = await tx
          .update(pmTeamCounters)
          .set({ last_number: sql`${pmTeamCounters.last_number} + 1` })
          .where(eq(pmTeamCounters.team_id, team.id))
          .returning({ last_number: pmTeamCounters.last_number });
        const number = counter?.last_number;
        if (!number) throw new BadRequestException('Team counter missing');

        // Append to the bottom of both orderings.
        const [last] = await tx
          .select({ board: sql<string>`max(${pmIssues.board_rank})`, backlog: sql<string>`max(${pmIssues.backlog_rank})` })
          .from(pmIssues)
          .where(and(eq(pmIssues.tenant_id, tenantId), eq(pmIssues.team_id, team.id)));

        // Sub-issues inherit assignee + priority at creation (§5.2) — not status.
        let assignee = input.assignee_user_id ?? null;
        let priority = input.priority ?? 0;
        if (input.parent_issue_id && input.assignee_user_id === undefined && input.priority === undefined) {
          const parent = await this.loadIssue(tx, tenantId, input.parent_issue_id);
          assignee = parent.assignee_user_id;
          priority = parent.priority;
        }

        const [issue] = await tx
          .insert(pmIssues)
          .values({
            ...(input.id ? { id: input.id } : {}),
            tenant_id: tenantId,
            team_id: team.id,
            number,
            title: input.title.trim(),
            description: input.description ?? null,
            state_id: stateId,
            priority,
            estimate: input.estimate == null ? null : String(input.estimate),
            assignee_user_id: assignee,
            creator_user_id: userId,
            parent_issue_id: input.parent_issue_id ?? null,
            due_date: input.due_date ?? null,
            board_rank: rankBetween(last?.board ?? null, null),
            backlog_rank: rankBetween(last?.backlog ?? null, null),
            source: input.source ?? 'manual',
          })
          .returning();

        // Auto-subscribe creator + assignee (§5.1 companions).
        const subscriberIds = [userId, ...(assignee && assignee !== userId ? [assignee] : [])];
        await tx
          .insert(pmIssueSubscribers)
          .values(subscriberIds.map((u) => ({ tenant_id: tenantId, issue_id: issue!.id, user_id: u })))
          .onConflictDoNothing();

        await this.domainEvents.publish(
          {
            name: 'pm.issue.created',
            tenantId,
            actorUserId: userId,
            payload: {
              issue_id: issue!.id,
              team_id: team.id,
              number,
              sync: [
                { t: 'pm_issues', id: issue!.id },
                { t: 'pm_issue_subscribers', id: issue!.id },
              ],
            },
          },
          tx,
        );
        return { data: issue! };
      },
      userId,
    );
  }

  async update(tenantId: string, userId: string, id: string, input: UpdateIssueInput) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const issue = await this.loadIssue(tx, tenantId, id);
        await this.assertTeamAccess(tx, tenantId, userId, issue.team_id);

        const patch: Record<string, unknown> = { updated_at: new Date() };
        const history: Array<{ field: string; from: unknown; to: unknown }> = [];
        if (input.title !== undefined && input.title.trim() && input.title !== issue.title) {
          patch.title = input.title.trim();
        }
        if (input.description !== undefined) patch.description = input.description;
        if (input.estimate !== undefined) {
          patch.estimate = input.estimate == null ? null : String(input.estimate);
        }
        if (input.due_date !== undefined) patch.due_date = input.due_date;
        for (const f of HISTORY_FIELDS) {
          if (input[f] !== undefined && String(input[f] ?? '') !== String((issue as Record<string, unknown>)[f] ?? '')) {
            history.push({ field: f, from: (issue as Record<string, unknown>)[f], to: input[f] });
          }
        }

        const [updated] = await tx.update(pmIssues).set(patch).where(eq(pmIssues.id, id)).returning();
        await this.writeHistory(tx, tenantId, id, userId, history);
        await this.domainEvents.publish(
          {
            name: 'pm.issue.updated',
            tenantId,
            actorUserId: userId,
            payload: { issue_id: id, team_id: issue.team_id, sync: [{ t: 'pm_issues', id }] },
          },
          tx,
        );
        return { data: updated! };
      },
      userId,
    );
  }

  async moveState(tenantId: string, userId: string, id: string, stateId: string) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const issue = await this.loadIssue(tx, tenantId, id);
        const team = await this.assertTeamAccess(tx, tenantId, userId, issue.team_id);
        const [next] = await tx
          .select()
          .from(pmWorkflowStates)
          .where(and(eq(pmWorkflowStates.id, stateId), eq(pmWorkflowStates.team_id, issue.team_id)))
          .limit(1);
        if (!next) throw new BadRequestException('state_id does not belong to this team');
        if (next.id === issue.state_id) return { data: issue };

        const [prev] = await tx
          .select()
          .from(pmWorkflowStates)
          .where(eq(pmWorkflowStates.id, issue.state_id))
          .limit(1);

        // §7.1 auto-add-started: moving to a started state OUTSIDE any cycle
        // joins the team's active cycle automatically (when enabled).
        let autoCycleId: string | null = null;
        if (next.category === 'started' && !issue.cycle_id) {
          const [team] = await tx
            .select({ cycles_enabled: pmTeams.cycles_enabled, cycle_auto_add_started: pmTeams.cycle_auto_add_started })
            .from(pmTeams)
            .where(eq(pmTeams.id, issue.team_id))
            .limit(1);
          if (team?.cycles_enabled && team.cycle_auto_add_started) {
            const [active] = await tx
              .select({ id: pmCycles.id })
              .from(pmCycles)
              .where(and(eq(pmCycles.team_id, issue.team_id), eq(pmCycles.status, 'active')))
              .limit(1);
            autoCycleId = active?.id ?? null;
          }
        }

        const [updated] = await tx
          .update(pmIssues)
          .set({
            state_id: next.id,
            updated_at: new Date(),
            ...(autoCycleId ? { cycle_id: autoCycleId } : {}),
            ...this.lifecycleStamps(next.category, prev?.category),
          })
          .where(eq(pmIssues.id, id))
          .returning();
        await this.writeHistory(tx, tenantId, id, userId, [
          { field: 'state', from: prev?.name ?? issue.state_id, to: next.name },
        ]);
        await this.domainEvents.publish(
          {
            name: 'pm.issue.state_changed',
            tenantId,
            actorUserId: userId,
            payload: {
              issue_id: id,
              team_id: issue.team_id,
              state_id: next.id,
              category: next.category,
              sync: [{ t: 'pm_issues', id }],
            },
          },
          tx,
        );
        // §11: subscribers hear when a followed issue completes or cancels.
        if (next.category === 'completed' || next.category === 'canceled') {
          const subs = await this.subscriberIds(tx, id);
          this.notifyInbox(
            tenantId,
            id,
            subs.filter((u) => u !== userId),
            'pm.issue.status',
            `${team.key}-${issue.number} moved to ${next.name} — ${issue.title}`,
          );
        }
        return { data: updated! };
      },
      userId,
    );
  }

  async setPriority(tenantId: string, userId: string, id: string, priority: number) {
    if (!Number.isInteger(priority) || priority < 0 || priority > 4) {
      throw new BadRequestException('priority must be 0–4');
    }
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const issue = await this.loadIssue(tx, tenantId, id);
        await this.assertTeamAccess(tx, tenantId, userId, issue.team_id);
        if (issue.priority === priority) return { data: issue };
        const [updated] = await tx
          .update(pmIssues)
          .set({ priority, updated_at: new Date() })
          .where(eq(pmIssues.id, id))
          .returning();
        await this.writeHistory(tx, tenantId, id, userId, [
          { field: 'priority', from: issue.priority, to: priority },
        ]);
        await this.domainEvents.publish(
          {
            name: 'pm.issue.priority_changed',
            tenantId,
            actorUserId: userId,
            payload: { issue_id: id, team_id: issue.team_id, priority, sync: [{ t: 'pm_issues', id }] },
          },
          tx,
        );
        return { data: updated! };
      },
      userId,
    );
  }

  async assign(tenantId: string, userId: string, id: string, assigneeUserId: string | null) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const issue = await this.loadIssue(tx, tenantId, id);
        const team = await this.assertTeamAccess(tx, tenantId, userId, issue.team_id);
        if (assigneeUserId) {
          const [m] = await tx
            .select({ user_id: memberships.user_id })
            .from(memberships)
            .where(
              and(
                eq(memberships.tenant_id, tenantId),
                eq(memberships.user_id, assigneeUserId),
                eq(memberships.status, 'active'),
              ),
            )
            .limit(1);
          if (!m) throw new BadRequestException('assignee is not an active member of this workspace');
        }
        const [updated] = await tx
          .update(pmIssues)
          .set({ assignee_user_id: assigneeUserId, updated_at: new Date() })
          .where(eq(pmIssues.id, id))
          .returning();
        if (assigneeUserId) {
          await tx
            .insert(pmIssueSubscribers)
            .values({ tenant_id: tenantId, issue_id: id, user_id: assigneeUserId })
            .onConflictDoNothing();
        }
        await this.writeHistory(tx, tenantId, id, userId, [
          { field: 'assignee', from: issue.assignee_user_id, to: assigneeUserId },
        ]);
        await this.domainEvents.publish(
          {
            name: 'pm.issue.assigned',
            tenantId,
            actorUserId: userId,
            payload: {
              issue_id: id,
              team_id: issue.team_id,
              assignee_user_id: assigneeUserId,
              sync: [{ t: 'pm_issues', id }, { t: 'pm_issue_subscribers', id }],
            },
          },
          tx,
        );
        if (assigneeUserId && assigneeUserId !== userId) {
          this.notifyInbox(
            tenantId,
            id,
            [assigneeUserId],
            'pm.issue.assigned',
            `${team.key}-${issue.number} assigned to you — ${issue.title}`,
          );
        }
        return { data: updated! };
      },
      userId,
    );
  }

  async rank(
    tenantId: string,
    userId: string,
    id: string,
    input: { rank_field: 'board_rank' | 'backlog_rank'; rank: string },
  ) {
    if (!['board_rank', 'backlog_rank'].includes(input.rank_field) || !input.rank) {
      throw new BadRequestException('rank_field/rank required');
    }
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const issue = await this.loadIssue(tx, tenantId, id);
        await this.assertTeamAccess(tx, tenantId, userId, issue.team_id);
        const [updated] = await tx
          .update(pmIssues)
          .set({ [input.rank_field]: input.rank, updated_at: new Date() })
          .where(eq(pmIssues.id, id))
          .returning();
        await this.domainEvents.publish(
          {
            name: 'pm.issue.ranked',
            tenantId,
            actorUserId: userId,
            payload: { issue_id: id, team_id: issue.team_id, sync: [{ t: 'pm_issues', id }] },
          },
          tx,
        );
        return { data: updated! };
      },
      userId,
    );
  }

  /** §7 — attach/detach an issue to a cycle (bulk key C). */
  async setCycle(tenantId: string, userId: string, id: string, input: { cycle_id: string | null }) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const issue = await this.loadIssue(tx, tenantId, id);
        await this.assertTeamAccess(tx, tenantId, userId, issue.team_id);
        if (input.cycle_id) {
          const [cycle] = await tx
            .select({ id: pmCycles.id, status: pmCycles.status })
            .from(pmCycles)
            .where(and(eq(pmCycles.id, input.cycle_id), eq(pmCycles.tenant_id, tenantId), eq(pmCycles.team_id, issue.team_id)))
            .limit(1);
          if (!cycle) throw new BadRequestException('cycle_id does not belong to this team');
          if (cycle.status === 'completed') throw new BadRequestException('cycle already completed');
        }
        const [updated] = await tx
          .update(pmIssues)
          .set({ cycle_id: input.cycle_id, updated_at: new Date() })
          .where(eq(pmIssues.id, id))
          .returning();
        await this.writeHistory(tx, tenantId, id, userId, [{ field: 'cycle', from: issue.cycle_id, to: input.cycle_id }]);
        await this.domainEvents.publish(
          {
            name: 'pm.issue.updated',
            tenantId,
            actorUserId: userId,
            payload: { issue_id: id, team_id: issue.team_id, cycle_id: input.cycle_id, sync: [{ t: 'pm_issues', id }] },
          },
          tx,
        );
        return { data: updated! };
      },
      userId,
    );
  }

  // ─── triage (§8) ──────────────────────────────────────────────────────────

  /** Shift+T — send to the team's Triage state (clears lifecycle stamps). */
  async sendToTriage(tenantId: string, userId: string, id: string) {
    const issue = await this.db.withTenant(tenantId, (tx) => this.loadIssue(tx, tenantId, id), userId);
    const triageState = await this.db.withTenant(
      tenantId,
      async (tx) => {
        const [st] = await tx
          .select({ id: pmWorkflowStates.id })
          .from(pmWorkflowStates)
          .where(and(eq(pmWorkflowStates.team_id, issue.team_id), eq(pmWorkflowStates.category, 'triage')))
          .limit(1);
        if (!st) throw new BadRequestException('Team has no triage state');
        return st;
      },
      userId,
    );
    const res = await this.moveState(tenantId, userId, id, triageState.id);
    // AI/automation hook (§8) — separate from the in-tx state_changed event.
    await this.domainEvents
      .publish({ name: 'pm.issue.sent_to_triage', tenantId, actorUserId: userId, payload: { issue_id: id, team_id: issue.team_id } })
      .catch(() => undefined);
    return res;
  }

  /** Shift+Enter — Accept: team default (backlog) state + triaged_at stamp. */
  async triageAccept(
    tenantId: string,
    userId: string,
    id: string,
    opts: { priority?: number; assignee_user_id?: string | null } = {},
  ) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const issue = await this.loadIssue(tx, tenantId, id);
        const team = await this.assertTeamAccess(tx, tenantId, userId, issue.team_id);
        let targetStateId = team.default_state_id;
        if (!targetStateId) {
          const [backlog] = await tx
            .select({ id: pmWorkflowStates.id })
            .from(pmWorkflowStates)
            .where(and(eq(pmWorkflowStates.team_id, team.id), inArray(pmWorkflowStates.category, ['backlog', 'unstarted'])))
            .orderBy(asc(pmWorkflowStates.position))
            .limit(1);
          targetStateId = backlog?.id ?? issue.state_id;
        }
        const patch: Record<string, unknown> = {
          state_id: targetStateId,
          triaged_at: new Date(),
          snoozed_until: null,
          updated_at: new Date(),
        };
        if (opts.priority !== undefined) patch.priority = opts.priority;
        if (opts.assignee_user_id !== undefined) patch.assignee_user_id = opts.assignee_user_id;
        const [updated] = await tx.update(pmIssues).set(patch).where(eq(pmIssues.id, id)).returning();
        await this.writeHistory(tx, tenantId, id, userId, [{ field: 'triage', from: 'triage', to: 'accepted' }]);
        await this.domainEvents.publish(
          {
            name: 'pm.issue.triaged',
            tenantId,
            actorUserId: userId,
            payload: { issue_id: id, team_id: issue.team_id, action: 'accept', sync: [{ t: 'pm_issues', id }] },
          },
          tx,
        );
        return { data: updated! };
      },
      userId,
    );
  }

  /** Shift+Backspace — Decline: Canceled state, optional reason in history. */
  async triageDecline(tenantId: string, userId: string, id: string, reason?: string | null) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const issue = await this.loadIssue(tx, tenantId, id);
        await this.assertTeamAccess(tx, tenantId, userId, issue.team_id);
        const [canceled] = await tx
          .select({ id: pmWorkflowStates.id, name: pmWorkflowStates.name })
          .from(pmWorkflowStates)
          .where(and(eq(pmWorkflowStates.team_id, issue.team_id), eq(pmWorkflowStates.category, 'canceled')))
          .orderBy(asc(pmWorkflowStates.position))
          .limit(1);
        if (!canceled) throw new BadRequestException('Team has no canceled state');
        const [updated] = await tx
          .update(pmIssues)
          .set({ state_id: canceled.id, canceled_at: new Date(), snoozed_until: null, updated_at: new Date() })
          .where(eq(pmIssues.id, id))
          .returning();
        await this.writeHistory(tx, tenantId, id, userId, [
          { field: 'triage', from: 'triage', to: reason?.trim() ? `declined: ${reason.trim().slice(0, 200)}` : 'declined' },
        ]);
        await this.domainEvents.publish(
          {
            name: 'pm.issue.triaged',
            tenantId,
            actorUserId: userId,
            payload: { issue_id: id, team_id: issue.team_id, action: 'decline', sync: [{ t: 'pm_issues', id }] },
          },
          tx,
        );
        return { data: updated! };
      },
      userId,
    );
  }

  /** Z — snooze: hidden from the conveyor until `until` (1d/3d/1w). */
  async snooze(tenantId: string, userId: string, id: string, until: string | null) {
    if (until && Number.isNaN(Date.parse(until))) throw new BadRequestException('invalid snooze date');
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const issue = await this.loadIssue(tx, tenantId, id);
        await this.assertTeamAccess(tx, tenantId, userId, issue.team_id);
        const [updated] = await tx
          .update(pmIssues)
          .set({ snoozed_until: until ? new Date(until) : null, updated_at: new Date() })
          .where(eq(pmIssues.id, id))
          .returning();
        await this.domainEvents.publish(
          {
            name: 'pm.issue.snoozed',
            tenantId,
            actorUserId: userId,
            payload: { issue_id: id, team_id: issue.team_id, until, sync: [{ t: 'pm_issues', id }] },
          },
          tx,
        );
        return { data: updated! };
      },
      userId,
    );
  }

  /** §6 — attach/detach an issue to a project (+optional milestone). */
  async setProject(
    tenantId: string,
    userId: string,
    id: string,
    input: { project_id: string | null; milestone_id?: string | null },
  ) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const issue = await this.loadIssue(tx, tenantId, id);
        await this.assertTeamAccess(tx, tenantId, userId, issue.team_id);
        let milestoneId: string | null = input.milestone_id === undefined ? issue.milestone_id : input.milestone_id;
        if (input.project_id) {
          const [project] = await tx
            .select({ id: pmProjects.id })
            .from(pmProjects)
            .where(and(eq(pmProjects.id, input.project_id), eq(pmProjects.tenant_id, tenantId), isNull(pmProjects.deleted_at)))
            .limit(1);
          if (!project) throw new BadRequestException('project_id does not belong to this workspace');
          if (milestoneId) {
            const [ms] = await tx
              .select({ id: pmProjectMilestones.id })
              .from(pmProjectMilestones)
              .where(and(eq(pmProjectMilestones.id, milestoneId), eq(pmProjectMilestones.tenant_id, tenantId), eq(pmProjectMilestones.project_id, input.project_id)))
              .limit(1);
            if (!ms) throw new BadRequestException('milestone_id does not belong to this project');
          }
        } else {
          milestoneId = null; // no project ⇒ no milestone
        }
        const [updated] = await tx
          .update(pmIssues)
          .set({ project_id: input.project_id, milestone_id: milestoneId, updated_at: new Date() })
          .where(eq(pmIssues.id, id))
          .returning();
        await this.writeHistory(tx, tenantId, id, userId, [
          { field: 'project', from: issue.project_id, to: input.project_id },
        ]);
        await this.domainEvents.publish(
          {
            name: 'pm.issue.updated',
            tenantId,
            actorUserId: userId,
            payload: { issue_id: id, team_id: issue.team_id, project_id: input.project_id, sync: [{ t: 'pm_issues', id }] },
          },
          tx,
        );
        return { data: updated! };
      },
      userId,
    );
  }

  async setLabels(tenantId: string, userId: string, id: string, labelIds: string[]) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const issue = await this.loadIssue(tx, tenantId, id);
        await this.assertTeamAccess(tx, tenantId, userId, issue.team_id);
        // Validate labels: workspace labels or this team's.
        if (labelIds.length) {
          const rows = await tx
            .select({ id: pmLabels.id, team_id: pmLabels.team_id })
            .from(pmLabels)
            .where(and(eq(pmLabels.tenant_id, tenantId), inArray(pmLabels.id, labelIds)));
          const valid = new Set(rows.filter((l) => !l.team_id || l.team_id === issue.team_id).map((l) => l.id));
          const bad = labelIds.find((l) => !valid.has(l));
          if (bad) throw new BadRequestException('label does not belong to this workspace/team');
        }
        await tx.delete(pmIssueLabels).where(and(eq(pmIssueLabels.tenant_id, tenantId), eq(pmIssueLabels.issue_id, id)));
        if (labelIds.length) {
          await tx
            .insert(pmIssueLabels)
            .values(labelIds.map((l) => ({ tenant_id: tenantId, issue_id: id, label_id: l })))
            .onConflictDoNothing();
        }
        await tx.update(pmIssues).set({ updated_at: new Date() }).where(eq(pmIssues.id, id));
        await this.domainEvents.publish(
          {
            name: 'pm.issue.labeled',
            tenantId,
            actorUserId: userId,
            payload: {
              issue_id: id,
              team_id: issue.team_id,
              sync: [{ t: 'pm_issues', id }, { t: 'pm_issue_labels', id }],
            },
          },
          tx,
        );
        return { data: { issue_id: id, label_ids: labelIds } };
      },
      userId,
    );
  }

  async relate(
    tenantId: string,
    userId: string,
    id: string,
    input: { related_issue_id: string; type: 'blocks' | 'duplicate_of' | 'relates_to' },
  ) {
    if (!['blocks', 'duplicate_of', 'relates_to'].includes(input.type)) {
      throw new BadRequestException('invalid relation type');
    }
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const issue = await this.loadIssue(tx, tenantId, id);
        await this.assertTeamAccess(tx, tenantId, userId, issue.team_id);
        const related = await this.loadIssue(tx, tenantId, input.related_issue_id);
        await this.assertTeamAccess(tx, tenantId, userId, related.team_id);
        const [row] = await tx
          .insert(pmIssueRelations)
          .values({
            tenant_id: tenantId,
            issue_id: id,
            related_issue_id: input.related_issue_id,
            type: input.type,
            created_by: userId,
          })
          .onConflictDoNothing()
          .returning();

        // §5.1 duplicate-close: marking A duplicate_of B moves A to the team's
        // Duplicate (canceled) state and stamps canceled_at.
        if (input.type === 'duplicate_of') {
          const teamStates = await tx
            .select()
            .from(pmWorkflowStates)
            .where(and(eq(pmWorkflowStates.team_id, issue.team_id), eq(pmWorkflowStates.category, 'canceled')));
          const dupState = teamStates.find((s) => s.name === 'Duplicate') ?? teamStates[0];
          if (dupState && issue.state_id !== dupState.id) {
            await tx
              .update(pmIssues)
              .set({ state_id: dupState.id, canceled_at: new Date(), updated_at: new Date() })
              .where(eq(pmIssues.id, id));
            await this.writeHistory(tx, tenantId, id, userId, [
              { field: 'state', from: issue.state_id, to: dupState.name },
            ]);
          }
        }
        await this.domainEvents.publish(
          {
            name: 'pm.issue.related',
            tenantId,
            actorUserId: userId,
            payload: {
              issue_id: id,
              related_issue_id: input.related_issue_id,
              type: input.type,
              sync: [
                { t: 'pm_issue_relations', id },
                { t: 'pm_issue_relations', id: input.related_issue_id },
                { t: 'pm_issues', id }, // duplicate-close may have moved state
              ],
            },
          },
          tx,
        );
        return { data: row ?? { issue_id: id } };
      },
      userId,
    );
  }

  async unrelate(tenantId: string, userId: string, id: string, relatedIssueId: string, type: string) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const issue = await this.loadIssue(tx, tenantId, id);
        await this.assertTeamAccess(tx, tenantId, userId, issue.team_id);
        await tx
          .delete(pmIssueRelations)
          .where(
            and(
              eq(pmIssueRelations.tenant_id, tenantId),
              eq(pmIssueRelations.issue_id, id),
              eq(pmIssueRelations.related_issue_id, relatedIssueId),
              eq(pmIssueRelations.type, type),
            ),
          );
        await this.domainEvents.publish(
          {
            name: 'pm.issue.related',
            tenantId,
            actorUserId: userId,
            payload: {
              issue_id: id,
              related_issue_id: relatedIssueId,
              removed: true,
              sync: [{ t: 'pm_issue_relations', id }, { t: 'pm_issue_relations', id: relatedIssueId }],
            },
          },
          tx,
        );
        return { data: { issue_id: id } };
      },
      userId,
    );
  }

  async setSubscription(tenantId: string, userId: string, id: string, subscribed: boolean) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const issue = await this.loadIssue(tx, tenantId, id);
        await this.assertTeamAccess(tx, tenantId, userId, issue.team_id);
        if (subscribed) {
          await tx
            .insert(pmIssueSubscribers)
            .values({ tenant_id: tenantId, issue_id: id, user_id: userId })
            .onConflictDoNothing();
        } else {
          await tx
            .delete(pmIssueSubscribers)
            .where(
              and(
                eq(pmIssueSubscribers.tenant_id, tenantId),
                eq(pmIssueSubscribers.issue_id, id),
                eq(pmIssueSubscribers.user_id, userId),
              ),
            );
        }
        await this.domainEvents.publish(
          {
            name: 'pm.issue.subscribed',
            tenantId,
            actorUserId: userId,
            payload: { issue_id: id, subscribed, sync: [{ t: 'pm_issue_subscribers', id }] },
          },
          tx,
        );
        return { data: { issue_id: id, subscribed } };
      },
      userId,
    );
  }

  /** Lazy-loaded detail (§3.3): description + comments + history + children + relations. */
  async detail(tenantId: string, userId: string, id: string) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const issue = await this.loadIssue(tx, tenantId, id);
        await this.assertTeamAccess(tx, tenantId, userId, issue.team_id);
        const [comments, history, children, relations, subscribers, gitLinks] = await Promise.all([
          tx
            .select({
              id: pmIssueComments.id,
              body: pmIssueComments.body,
              author_user_id: pmIssueComments.author_user_id,
              parent_comment_id: pmIssueComments.parent_comment_id,
              edited_at: pmIssueComments.edited_at,
              created_at: pmIssueComments.created_at,
            })
            .from(pmIssueComments)
            .where(and(eq(pmIssueComments.tenant_id, tenantId), eq(pmIssueComments.issue_id, id), isNull(pmIssueComments.deleted_at)))
            .orderBy(asc(pmIssueComments.created_at)),
          tx
            .select()
            .from(pmIssueHistory)
            .where(and(eq(pmIssueHistory.tenant_id, tenantId), eq(pmIssueHistory.issue_id, id)))
            .orderBy(desc(pmIssueHistory.created_at))
            .limit(50),
          tx
            .select({
              id: pmIssues.id, number: pmIssues.number, title: pmIssues.title,
              state_id: pmIssues.state_id, priority: pmIssues.priority,
              assignee_user_id: pmIssues.assignee_user_id, completed_at: pmIssues.completed_at,
            })
            .from(pmIssues)
            .where(and(eq(pmIssues.tenant_id, tenantId), eq(pmIssues.parent_issue_id, id), isNull(pmIssues.deleted_at)))
            .orderBy(asc(pmIssues.number)),
          tx
            .select()
            .from(pmIssueRelations)
            .where(and(eq(pmIssueRelations.tenant_id, tenantId), sql`(${pmIssueRelations.issue_id} = ${id} OR ${pmIssueRelations.related_issue_id} = ${id})`)),
          tx
            .select({ user_id: pmIssueSubscribers.user_id })
            .from(pmIssueSubscribers)
            .where(and(eq(pmIssueSubscribers.tenant_id, tenantId), eq(pmIssueSubscribers.issue_id, id))),
          tx
            .select()
            .from(pmIssueGitLinks)
            .where(and(eq(pmIssueGitLinks.tenant_id, tenantId), eq(pmIssueGitLinks.issue_id, id)))
            .orderBy(asc(pmIssueGitLinks.created_at)),
        ]);
        return {
          data: {
            issue,
            comments,
            history,
            sub_issues: children,
            relations,
            subscriber_ids: subscribers.map((s) => s.user_id),
            git_links: gitLinks,
          },
        };
      },
      userId,
    );
  }

  async createComment(tenantId: string, userId: string, issueId: string, input: { id?: string; body: string; parent_comment_id?: string | null; mentioned_user_ids?: string[] }) {
    if (!input.body?.trim()) throw new BadRequestException('Comment body is required');
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const issue = await this.loadIssue(tx, tenantId, issueId);
        const team = await this.assertTeamAccess(tx, tenantId, userId, issue.team_id);
        // Fan-out audience = people ALREADY following, captured before this
        // comment's auto-subscribes (mentioned users get the mention notice).
        const preSubs = await this.subscriberIds(tx, issueId);
        if (input.parent_comment_id) {
          const [parent] = await tx
            .select({ id: pmIssueComments.id, parent: pmIssueComments.parent_comment_id })
            .from(pmIssueComments)
            .where(and(eq(pmIssueComments.id, input.parent_comment_id), eq(pmIssueComments.issue_id, issueId)))
            .limit(1);
          if (!parent) throw new BadRequestException('parent comment not found on this issue');
          if (parent.parent) throw new BadRequestException('threads are one level deep');
        }
        const [comment] = await tx
          .insert(pmIssueComments)
          .values({
            ...(input.id ? { id: input.id } : {}),
            tenant_id: tenantId,
            issue_id: issueId,
            author_user_id: userId,
            parent_comment_id: input.parent_comment_id ?? null,
            body: input.body,
          })
          .returning();
        // Commenting subscribes the author; @mentions subscribe the mentioned
        // members (§11 auto-subscribe — validated against active memberships).
        const subscriberIds = [userId];
        let mentionedIds: string[] = [];
        if (input.mentioned_user_ids?.length) {
          const valid = await tx
            .select({ user_id: memberships.user_id })
            .from(memberships)
            .where(
              and(
                eq(memberships.tenant_id, tenantId),
                inArray(memberships.user_id, input.mentioned_user_ids),
                eq(memberships.status, 'active'),
              ),
            );
          mentionedIds = valid.map((v) => v.user_id);
          subscriberIds.push(...mentionedIds);
        }
        await tx
          .insert(pmIssueSubscribers)
          .values([...new Set(subscriberIds)].map((u) => ({ tenant_id: tenantId, issue_id: issueId, user_id: u })))
          .onConflictDoNothing();
        await tx.update(pmIssues).set({ updated_at: new Date() }).where(eq(pmIssues.id, issueId));
        await this.domainEvents.publish(
          {
            name: 'pm.issue.commented',
            tenantId,
            actorUserId: userId,
            payload: {
              issue_id: issueId,
              comment_id: comment!.id,
              sync: [{ t: 'pm_issues', id: issueId }, { t: 'pm_issue_subscribers', id: issueId }],
            },
          },
          tx,
        );
        // §11 fan-out: mentions beat the ambient comment notice.
        const mentioned = mentionedIds.filter((u) => u !== userId);
        this.notifyInbox(
          tenantId,
          issueId,
          mentioned,
          'pm.issue.mention',
          `${team.key}-${issue.number} you were mentioned — ${issue.title}`,
        );
        this.notifyInbox(
          tenantId,
          issueId,
          preSubs.filter((u) => u !== userId && !mentioned.includes(u)),
          'pm.issue.comment',
          `${team.key}-${issue.number} new comment — ${issue.title}`,
        );
        return { data: comment! };
      },
      userId,
    );
  }

  async softDelete(tenantId: string, userId: string, id: string) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const issue = await this.loadIssue(tx, tenantId, id);
        await this.assertTeamAccess(tx, tenantId, userId, issue.team_id);
        const [updated] = await tx
          .update(pmIssues)
          .set({ deleted_at: new Date(), updated_at: new Date() })
          .where(eq(pmIssues.id, id))
          .returning();
        await this.audit.log({
          tenantId,
          actorUserId: userId,
          action: 'pm.issue.delete',
          resourceType: 'pm_issue',
          resourceId: id,
        });
        await this.domainEvents.publish(
          {
            name: 'pm.issue.deleted',
            tenantId,
            actorUserId: userId,
            payload: { issue_id: id, team_id: issue.team_id, sync: [{ t: 'pm_issues', id }] },
          },
          tx,
        );
        return { data: updated! };
      },
      userId,
    );
  }

  async restore(tenantId: string, userId: string, id: string) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const [issue] = await tx
          .select()
          .from(pmIssues)
          .where(and(eq(pmIssues.id, id), eq(pmIssues.tenant_id, tenantId)))
          .limit(1);
        if (!issue) throw new NotFoundException('Issue not found');
        await this.assertTeamAccess(tx, tenantId, userId, issue.team_id);
        const [updated] = await tx
          .update(pmIssues)
          .set({ deleted_at: null, updated_at: new Date() })
          .where(eq(pmIssues.id, id))
          .returning();
        await this.audit.log({
          tenantId,
          actorUserId: userId,
          action: 'pm.issue.restore',
          resourceType: 'pm_issue',
          resourceId: id,
        });
        await this.domainEvents.publish(
          {
            name: 'pm.issue.restored',
            tenantId,
            actorUserId: userId,
            payload: { issue_id: id, team_id: issue.team_id, sync: [{ t: 'pm_issues', id }] },
          },
          tx,
        );
        return { data: updated! };
      },
      userId,
    );
  }

  /** Move to another team: renumbers via the target counter (§9.4 bulk key ⇧M). */
  async moveTeam(tenantId: string, userId: string, id: string, targetTeamId: string) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const issue = await this.loadIssue(tx, tenantId, id);
        if (issue.team_id === targetTeamId) return { data: issue };
        await this.assertTeamAccess(tx, tenantId, userId, issue.team_id);
        const target = await this.assertTeamAccess(tx, tenantId, userId, targetTeamId);

        // Map the state by category into the target team's default for it.
        const [currentState] = await tx
          .select()
          .from(pmWorkflowStates)
          .where(eq(pmWorkflowStates.id, issue.state_id))
          .limit(1);
        const targetStates = await tx
          .select()
          .from(pmWorkflowStates)
          .where(and(eq(pmWorkflowStates.team_id, targetTeamId), eq(pmWorkflowStates.category, currentState?.category ?? 'backlog')));
        const targetState =
          targetStates.find((s) => s.is_default_for_category) ?? targetStates[0] ?? null;
        if (!targetState) throw new BadRequestException('target team lacks a matching state category');

        const [counter] = await tx
          .update(pmTeamCounters)
          .set({ last_number: sql`${pmTeamCounters.last_number} + 1` })
          .where(eq(pmTeamCounters.team_id, targetTeamId))
          .returning({ last_number: pmTeamCounters.last_number });
        if (!counter?.last_number) throw new BadRequestException('target team counter missing');

        const [updated] = await tx
          .update(pmIssues)
          .set({
            team_id: targetTeamId,
            number: counter.last_number,
            state_id: targetState.id,
            cycle_id: null, // cycles are per-team
            updated_at: new Date(),
          })
          .where(eq(pmIssues.id, id))
          .returning();
        await this.writeHistory(tx, tenantId, id, userId, [
          { field: 'team', from: issue.team_id, to: targetTeamId },
        ]);
        await this.domainEvents.publish(
          {
            name: 'pm.issue.updated',
            tenantId,
            actorUserId: userId,
            payload: {
              issue_id: id,
              team_id: targetTeamId,
              moved_from_team_id: issue.team_id,
              sync: [{ t: 'pm_issues', id }],
            },
          },
          tx,
        );
        void target;
        return { data: updated! };
      },
      userId,
    );
  }

  // ─── reads (REST / kill-switch path) ──────────────────────────────────────

  async list(
    tenantId: string,
    userId: string,
    query: { team_id?: string; project_id?: string; page?: number; limit?: number },
  ) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const page = Math.max(1, query.page ?? 1);
        const limit = Math.min(200, Math.max(1, query.limit ?? 100));
        const where = [eq(pmIssues.tenant_id, tenantId), isNull(pmIssues.deleted_at)];
        if (query.project_id) where.push(eq(pmIssues.project_id, query.project_id));
        if (query.team_id) {
          await this.assertTeamAccess(tx, tenantId, userId, query.team_id);
          where.push(eq(pmIssues.team_id, query.team_id));
        } else {
          // Without a team filter: restrict to visible teams.
          const visible = await this.visibleTeamIds(tx, tenantId, userId);
          if (!visible.length) return { data: [], pagination: { page, limit, total: 0 } };
          where.push(sql`${pmIssues.team_id} IN (${sql.join(visible.map((t) => sql`${t}::uuid`), sql`, `)})` as never);
        }
        const rows = await tx
          .select()
          .from(pmIssues)
          .where(and(...where))
          .orderBy(desc(pmIssues.updated_at))
          .limit(limit)
          .offset((page - 1) * limit);
        return { data: rows, pagination: { page, limit } };
      },
      userId,
    );
  }

  async get(tenantId: string, userId: string, id: string) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const issue = await this.loadIssue(tx, tenantId, id);
        await this.assertTeamAccess(tx, tenantId, userId, issue.team_id);
        return { data: issue };
      },
      userId,
    );
  }

  /** Shared with sync bootstrap/delta via PmVisibilityService — kept here for REST list. */
  private async visibleTeamIds(tx: Db, tenantId: string, userId: string): Promise<string[]> {
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
}
