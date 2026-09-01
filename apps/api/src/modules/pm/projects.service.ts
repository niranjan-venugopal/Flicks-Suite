import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  pmProjects,
  pmProjectTeams,
  pmProjectMembers,
  pmProjectMilestones,
  pmProjectUpdates,
  pmInitiatives,
  pmInitiativeProjects,
  pmIssues,
  pmTeams,
  pmWorkflowStates,
  memberships,
  users,
} from '@flicks/db/schema';
import type { Db } from '@flicks/db';
import { PM_PROJECT_STATUSES, PM_PROJECT_HEALTH } from '@flicks/shared/pm';
import { DatabaseService } from '../../core/database/database.service';
import { AuditService } from '../audit/audit.service';
import { DomainEventsService } from '../../core/events/domain-events.service';
import { MediaService } from '../media/media.service';
import { PmVisibilityService } from './sync/visibility.service';

/**
 * PM projects + milestones + health updates + initiatives (PRD v6 §6).
 * One service, two transports — REST controller and the sync mutation
 * executor both land here. Every write publishes a pm.* event in the same
 * transaction with `sync` refs so the FSE delta picks the rows up.
 *
 * Progress is COMPUTED, never stored (§6.1): scope/started/done by estimate
 * points with per-issue fallback weight 1 — degrades to plain count when
 * nothing is estimated. Sync clients compute the same numbers from the local
 * graph; REST list/detail responses carry them server-side.
 */

export interface CreateProjectInput {
  id?: string;
  name: string;
  summary?: string | null;
  description_md?: string | null;
  icon?: string | null;
  color?: string | null;
  status?: string;
  lead_user_id?: string | null;
  start_date?: string | null;
  target_date?: string | null;
  team_ids?: string[];
  deal_id?: string | null;
}

const PROJECT_PATCH_FIELDS = [
  'name', 'summary', 'description_md', 'icon', 'color', 'status',
  'lead_user_id', 'start_date', 'target_date',
] as const;

@Injectable()
export class PmProjectsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly domainEvents: DomainEventsService,
    private readonly visibility: PmVisibilityService,
    private readonly media: MediaService,
  ) {}

  /**
   * Round E — the raw R2 storage key never leaves the API: REST payloads
   * carry a signed logo_url instead (pure local crypto; the sync projections
   * do the same in sync.service.ts).
   */
  private async stripAndSignLogo<T extends { logo_key: string | null }>(row: T) {
    const { logo_key, ...rest } = row;
    return {
      ...rest,
      logo_url: logo_key ? await this.media.servedUrl(logo_key, null, 64) : null,
    };
  }

  // ─── helpers ──────────────────────────────────────────────────────────────

  private async loadProject(tx: Db, tenantId: string, id: string, opts: { withDeleted?: boolean } = {}) {
    const conds = [eq(pmProjects.id, id), eq(pmProjects.tenant_id, tenantId)];
    if (!opts.withDeleted) conds.push(isNull(pmProjects.deleted_at));
    const [project] = await tx.select().from(pmProjects).where(and(...conds)).limit(1);
    if (!project) throw new NotFoundException('Project not found');
    return project;
  }

  private async assertProjectAccess(
    tx: Db,
    tenantId: string,
    userId: string,
    id: string,
    opts: { withDeleted?: boolean } = {},
  ) {
    const visible = await this.visibility.visibleProjectIdsTx(tx, tenantId, userId, opts);
    if (!visible.includes(id)) throw new ForbiddenException('Project not visible to you');
  }

  /**
   * Authority to delete or restore a project — a SEPARATE question from
   * `assertProjectAccess`, which only asks "is this project in your readable
   * set". Visibility alone let any non-guest member destroy any project they
   * could see, while deleting a mere *team* already required owner/admin
   * (pm.controller.ts `@Roles('owner','admin')`).
   *
   * The bar is the initiative bar (`assertInitiativeRole`: manager and above)
   * plus the project's own lead, so someone who runs a project can always
   * retire it — otherwise an employee lead would be stuck with a project they
   * created and nobody to ask (house rule 8, no dead ends).
   *
   * Enforced HERE rather than with a `@Roles` decorator because there are two
   * doors into this service: the REST controller and the FSE sync mutation
   * executor (`sync/mutation-executor.service.ts` `case 'project.delete'`),
   * which reaches it through /pm/sync/mutate and carries no @Roles at all.
   */
  private assertMayDeleteProject(
    role: string | undefined,
    project: { lead_user_id: string | null },
    userId: string,
    verb: 'delete' | 'restore',
  ) {
    if (role && !['employee', 'auditor', 'guest'].includes(role)) return;
    if (project.lead_user_id && project.lead_user_id === userId) return;
    throw new ForbiddenException(
      `Only the project lead, or a manager and above, can ${verb} a project.`,
    );
  }

  private async assertActiveMember(tx: Db, tenantId: string, userIds: string[]) {
    const clean = userIds.filter(Boolean);
    if (!clean.length) return;
    const rows = await tx
      .select({ user_id: memberships.user_id })
      .from(memberships)
      .where(and(eq(memberships.tenant_id, tenantId), inArray(memberships.user_id, clean), eq(memberships.status, 'active')));
    const found = new Set(rows.map((r) => r.user_id));
    for (const id of clean) {
      if (!found.has(id)) throw new BadRequestException('user is not an active member of this workspace');
    }
  }

  private async assertTeamsInTenant(tx: Db, tenantId: string, teamIds: string[]) {
    if (!teamIds.length) return;
    const rows = await tx
      .select({ id: pmTeams.id })
      .from(pmTeams)
      .where(and(eq(pmTeams.tenant_id, tenantId), inArray(pmTeams.id, teamIds), isNull(pmTeams.deleted_at)));
    if (rows.length !== new Set(teamIds).size) {
      throw new BadRequestException('team_ids contain a team outside this workspace');
    }
  }

  /** Progress by estimate points (fallback weight 1) across linked issues. */
  private async computeProgress(tx: Db, tenantId: string, projectIds: string[]) {
    const out = new Map<string, { scope: number; started: number; done: number }>();
    for (const id of projectIds) out.set(id, { scope: 0, started: 0, done: 0 });
    if (!projectIds.length) return out;
    const rows = await tx
      .select({
        project_id: pmIssues.project_id,
        estimate: pmIssues.estimate,
        category: pmWorkflowStates.category,
      })
      .from(pmIssues)
      .innerJoin(pmWorkflowStates, eq(pmWorkflowStates.id, pmIssues.state_id))
      .where(and(eq(pmIssues.tenant_id, tenantId), inArray(pmIssues.project_id, projectIds), isNull(pmIssues.deleted_at)));
    for (const r of rows) {
      if (!r.project_id || r.category === 'canceled') continue;
      const w = r.estimate != null ? Number(r.estimate) : 1;
      const p = out.get(r.project_id)!;
      p.scope += w;
      if (r.category === 'completed') p.done += w;
      else if (r.category === 'started') p.started += w;
    }
    return out;
  }

  // ─── projects ─────────────────────────────────────────────────────────────

  async list(tenantId: string, userId: string) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const visible = await this.visibility.visibleProjectIdsTx(tx, tenantId, userId);
        if (!visible.length) return { data: { projects: [], teams: {}, progress: {} } };
        const projects = await tx
          .select()
          .from(pmProjects)
          .where(and(eq(pmProjects.tenant_id, tenantId), inArray(pmProjects.id, visible), isNull(pmProjects.deleted_at)))
          .orderBy(asc(pmProjects.target_date), asc(pmProjects.name));
        const links = await tx
          .select({ project_id: pmProjectTeams.project_id, team_id: pmProjectTeams.team_id })
          .from(pmProjectTeams)
          .where(and(eq(pmProjectTeams.tenant_id, tenantId), inArray(pmProjectTeams.project_id, visible)));
        const teams: Record<string, string[]> = {};
        for (const l of links) (teams[l.project_id] ??= []).push(l.team_id);
        const progress = Object.fromEntries(await this.computeProgress(tx, tenantId, visible));
        return {
          data: { projects: await Promise.all(projects.map((p) => this.stripAndSignLogo(p))), teams, progress },
        };
      },
      userId,
    );
  }

  /** Lazy detail: description + milestones + updates + linked issues + members. */
  async detail(tenantId: string, userId: string, id: string) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        await this.assertProjectAccess(tx, tenantId, userId, id);
        const project = await this.loadProject(tx, tenantId, id);
        const [milestones, updates, teamLinks, members, issues] = await Promise.all([
          tx
            .select()
            .from(pmProjectMilestones)
            .where(and(eq(pmProjectMilestones.tenant_id, tenantId), eq(pmProjectMilestones.project_id, id)))
            .orderBy(asc(pmProjectMilestones.position), asc(pmProjectMilestones.created_at)),
          tx
            .select()
            .from(pmProjectUpdates)
            .where(and(eq(pmProjectUpdates.tenant_id, tenantId), eq(pmProjectUpdates.project_id, id)))
            .orderBy(desc(pmProjectUpdates.created_at))
            .limit(30),
          tx
            .select({ team_id: pmProjectTeams.team_id })
            .from(pmProjectTeams)
            .where(and(eq(pmProjectTeams.tenant_id, tenantId), eq(pmProjectTeams.project_id, id))),
          tx
            .select({ user_id: pmProjectMembers.user_id })
            .from(pmProjectMembers)
            .where(and(eq(pmProjectMembers.tenant_id, tenantId), eq(pmProjectMembers.project_id, id))),
          tx
            .select({
              id: pmIssues.id, team_id: pmIssues.team_id, number: pmIssues.number,
              title: pmIssues.title, state_id: pmIssues.state_id, priority: pmIssues.priority,
              estimate: pmIssues.estimate, assignee_user_id: pmIssues.assignee_user_id,
              milestone_id: pmIssues.milestone_id, due_date: pmIssues.due_date,
              completed_at: pmIssues.completed_at,
            })
            .from(pmIssues)
            .where(and(eq(pmIssues.tenant_id, tenantId), eq(pmIssues.project_id, id), isNull(pmIssues.deleted_at)))
            .orderBy(asc(pmIssues.number)),
        ]);
        const progress = (await this.computeProgress(tx, tenantId, [id])).get(id)!;
        return {
          data: {
            project: await this.stripAndSignLogo(project),
            milestones,
            updates,
            team_ids: teamLinks.map((t) => t.team_id),
            member_ids: members.map((m) => m.user_id),
            issues,
            progress,
          },
        };
      },
      userId,
    );
  }

  async create(tenantId: string, userId: string, input: CreateProjectInput) {
    if (!input.name?.trim()) throw new BadRequestException('Project name is required');
    if (input.status && !PM_PROJECT_STATUSES.includes(input.status as never)) {
      throw new BadRequestException('invalid status');
    }
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        await this.visibility.assertNotGuestTx(tx, tenantId, userId, 'project management');
        const teamIds = [...new Set(input.team_ids ?? [])];
        await this.assertTeamsInTenant(tx, tenantId, teamIds);
        await this.assertActiveMember(tx, tenantId, input.lead_user_id ? [input.lead_user_id] : []);
        const [project] = await tx
          .insert(pmProjects)
          .values({
            ...(input.id ? { id: input.id } : {}),
            tenant_id: tenantId,
            name: input.name.trim(),
            summary: input.summary ?? null,
            description_md: input.description_md ?? null,
            icon: input.icon ?? null,
            color: input.color ?? null,
            status: input.status ?? 'planned',
            lead_user_id: input.lead_user_id ?? userId,
            start_date: input.start_date ?? null,
            target_date: input.target_date ?? null,
            deal_id: input.deal_id ?? null,
            created_by: userId,
          })
          .returning();
        if (teamIds.length) {
          await tx.insert(pmProjectTeams).values(
            teamIds.map((team_id) => ({ tenant_id: tenantId, project_id: project!.id, team_id })),
          );
        }
        await this.domainEvents.publish(
          {
            name: 'pm.project.created',
            tenantId,
            actorUserId: userId,
            payload: {
              project_id: project!.id,
              sync: [
                { t: 'pm_projects', id: project!.id },
                { t: 'pm_project_teams', id: project!.id },
              ],
            },
          },
          tx,
        );
        return { data: await this.stripAndSignLogo(project!) };
      },
      userId,
    );
  }

  async update(tenantId: string, userId: string, id: string, patch: Record<string, unknown>) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        await this.visibility.assertNotGuestTx(tx, tenantId, userId, 'project management');
        await this.assertProjectAccess(tx, tenantId, userId, id);
        const project = await this.loadProject(tx, tenantId, id);
        const clean: Record<string, unknown> = {};
        for (const f of PROJECT_PATCH_FIELDS) {
          if (f in patch) clean[f] = patch[f];
        }
        if (!Object.keys(clean).length) return { data: await this.stripAndSignLogo(project) };
        if ('name' in clean && !String(clean.name ?? '').trim()) {
          throw new BadRequestException('Project name is required');
        }
        if ('status' in clean && !PM_PROJECT_STATUSES.includes(clean.status as never)) {
          throw new BadRequestException('invalid status');
        }
        if ('lead_user_id' in clean && clean.lead_user_id) {
          await this.assertActiveMember(tx, tenantId, [clean.lead_user_id as string]);
        }
        const statusChanged = 'status' in clean && clean.status !== project.status;
        const completing = statusChanged && clean.status === 'completed';
        const [row] = await tx
          .update(pmProjects)
          .set({
            ...clean,
            ...(completing ? { completed_at: new Date() } : {}),
            ...(statusChanged && !completing && project.status === 'completed' ? { completed_at: null } : {}),
            updated_at: new Date(),
          })
          .where(and(eq(pmProjects.id, id), eq(pmProjects.tenant_id, tenantId)))
          .returning();
        await this.domainEvents.publish(
          {
            name: completing ? 'pm.project.completed' : statusChanged ? 'pm.project.status_changed' : 'pm.project.updated',
            tenantId,
            actorUserId: userId,
            payload: {
              project_id: id,
              // deal_id rides completed too — the CRM timeline echo needs it.
              ...(statusChanged || completing ? { status: clean.status, deal_id: project.deal_id } : {}),
              sync: [{ t: 'pm_projects', id }],
            },
          },
          tx,
        );
        return { data: await this.stripAndSignLogo(row!) };
      },
      userId,
    );
  }

  async setTeams(tenantId: string, userId: string, id: string, teamIds: string[]) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        await this.visibility.assertNotGuestTx(tx, tenantId, userId, 'project management');
        await this.assertProjectAccess(tx, tenantId, userId, id);
        await this.loadProject(tx, tenantId, id);
        const clean = [...new Set(teamIds)];
        await this.assertTeamsInTenant(tx, tenantId, clean);
        await tx.delete(pmProjectTeams).where(and(eq(pmProjectTeams.tenant_id, tenantId), eq(pmProjectTeams.project_id, id)));
        if (clean.length) {
          await tx.insert(pmProjectTeams).values(clean.map((team_id) => ({ tenant_id: tenantId, project_id: id, team_id })));
        }
        await this.domainEvents.publish(
          {
            name: 'pm.project.updated',
            tenantId,
            actorUserId: userId,
            payload: { project_id: id, sync: [{ t: 'pm_projects', id }, { t: 'pm_project_teams', id }] },
          },
          tx,
        );
        return { data: { project_id: id, team_ids: clean } };
      },
      userId,
    );
  }

  /** §6.3 — post a health update; latest health denormalizes onto the project. */
  async postUpdate(tenantId: string, userId: string, id: string, input: { id?: string; health: string; body_md: string }) {
    if (!PM_PROJECT_HEALTH.includes(input.health as never)) throw new BadRequestException('invalid health');
    if (!input.body_md?.trim()) throw new BadRequestException('Update body is required');
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        await this.visibility.assertNotGuestTx(tx, tenantId, userId, 'project management');
        await this.assertProjectAccess(tx, tenantId, userId, id);
        const project = await this.loadProject(tx, tenantId, id);
        const [update] = await tx
          .insert(pmProjectUpdates)
          .values({
            ...(input.id ? { id: input.id } : {}),
            tenant_id: tenantId,
            project_id: id,
            health: input.health,
            body_md: input.body_md.trim(),
            author_user_id: userId,
          })
          .returning();
        if (project.health !== input.health) {
          await tx
            .update(pmProjects)
            .set({ health: input.health, updated_at: new Date() })
            .where(and(eq(pmProjects.id, id), eq(pmProjects.tenant_id, tenantId)));
        }
        await this.domainEvents.publish(
          {
            name: 'pm.project.health_updated',
            tenantId,
            actorUserId: userId,
            payload: {
              project_id: id,
              update_id: update!.id,
              health: input.health,
              deal_id: project.deal_id,
              sync: [
                { t: 'pm_project_updates', id: update!.id },
                { t: 'pm_projects', id },
              ],
            },
          },
          tx,
        );
        return { data: update! };
      },
      userId,
    );
  }

  /**
   * Delete a project — and its issues with it (founder round 20).
   *
   * The issues are the point. Before this, softDelete stamped pm_projects and
   * stopped, so every issue in the project stayed live in the issues list, My
   * Issues, Triage, search and the sync bootstrap, pointing at a project that
   * no longer existed. Cascading here fixes all of those at once, in the one
   * place, instead of teaching six read paths to join pm_projects.
   *
   * Each cascaded issue is stamped with `deleted_with_project_id` so restore
   * can give back exactly this set — an issue the user had already deleted by
   * hand before the project went must stay deleted when it comes back.
   *
   * Every affected row is named in the domain event's `sync` refs: the delta
   * re-fetches what the refs name, finds the rows now filtered out by
   * deleted_at, and turns them into tombstones for live clients. Without the
   * issue refs the sidebar would keep rendering them until the next reload.
   */
  async softDelete(tenantId: string, userId: string, id: string, actorRole?: string) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        await this.visibility.assertNotGuestTx(tx, tenantId, userId, 'project management');
        await this.assertProjectAccess(tx, tenantId, userId, id);
        const project = await this.loadProject(tx, tenantId, id);
        this.assertMayDeleteProject(actorRole, project, userId, 'delete');
        const now = new Date();
        await tx
          .update(pmProjects)
          .set({ deleted_at: now, updated_at: now })
          .where(and(eq(pmProjects.id, id), eq(pmProjects.tenant_id, tenantId)));
        // Only the LIVE issues: one already deleted keeps its own deleted_at
        // and its NULL marker, so restore leaves it alone.
        const cascaded = await tx
          .update(pmIssues)
          .set({ deleted_at: now, deleted_with_project_id: id, updated_at: now })
          .where(
            and(
              eq(pmIssues.tenant_id, tenantId),
              eq(pmIssues.project_id, id),
              isNull(pmIssues.deleted_at),
            ),
          )
          .returning({ id: pmIssues.id });
        await this.audit.log({
          tenantId,
          actorUserId: userId,
          action: 'pm.project.delete',
          resourceType: 'pm_project',
          resourceId: id,
          metadata: { name: project.name, cascaded_issues: cascaded.length },
        });
        await this.domainEvents.publish(
          {
            name: 'pm.project.updated',
            tenantId,
            actorUserId: userId,
            payload: {
              project_id: id,
              deleted: true,
              cascaded_issues: cascaded.length,
              sync: [
                { t: 'pm_projects', id },
                ...cascaded.map((r) => ({ t: 'pm_issues', id: r.id })),
              ],
            },
          },
          tx,
        );
        return { data: { id, deleted: true, cascaded_issues: cascaded.length } };
      },
      userId,
    );
  }

  /**
   * Undo a project delete, giving back exactly what that delete took.
   *
   * `deleted_with_project_id` is the whole reason this is precise: it names the
   * issues THIS project's delete swallowed, so issues the user had deleted by
   * hand beforehand stay deleted. The marker is cleared as they come back, so a
   * second delete/restore cycle starts from a clean slate.
   *
   * The sync refs list the project's scoped rows as well as the issues. The
   * client's `pm_projects` tombstone purges milestones, health updates, team
   * links and member links along with the project (store.ts applyTombstones),
   * and the delta only re-fetches what the refs name — so a restore that named
   * only `pm_projects` handed back a project with no milestones and no team
   * chips until the next full reload.
   */
  async restore(tenantId: string, userId: string, id: string, actorRole?: string) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        await this.visibility.assertNotGuestTx(tx, tenantId, userId, 'project management');
        const project = await this.loadProject(tx, tenantId, id, { withDeleted: true });
        // Restore is a write like every sibling op — a private team's project
        // must not be un-deleted by someone who can't even see it.
        await this.assertProjectAccess(tx, tenantId, userId, id, { withDeleted: true });
        if (!project.deleted_at) return { data: project };
        this.assertMayDeleteProject(actorRole, project, userId, 'restore');
        const now = new Date();
        const [row] = await tx
          .update(pmProjects)
          .set({ deleted_at: null, updated_at: now })
          .where(and(eq(pmProjects.id, id), eq(pmProjects.tenant_id, tenantId)))
          .returning();
        const revived = await tx
          .update(pmIssues)
          .set({ deleted_at: null, deleted_with_project_id: null, updated_at: now })
          .where(
            and(
              eq(pmIssues.tenant_id, tenantId),
              eq(pmIssues.deleted_with_project_id, id),
            ),
          )
          .returning({ id: pmIssues.id });
        // The delete writes an audit row; the restore did not. Both halves of a
        // destructive action belong in the log an Owner reads.
        await this.audit.log({
          tenantId,
          actorUserId: userId,
          action: 'pm.project.restore',
          resourceType: 'pm_project',
          resourceId: id,
          metadata: { name: project.name, restored_issues: revived.length },
        });
        await this.domainEvents.publish(
          {
            name: 'pm.project.updated',
            tenantId,
            actorUserId: userId,
            payload: {
              project_id: id,
              restored: true,
              restored_issues: revived.length,
              sync: [
                { t: 'pm_projects', id },
                { t: 'pm_project_teams', id },
                { t: 'pm_project_members', id },
                ...revived.map((r) => ({ t: 'pm_issues', id: r.id })),
              ],
            },
          },
          tx,
        );
        return { data: await this.stripAndSignLogo(row!) };
      },
      userId,
    );
  }

  // ─── project members + privacy (round E) ──────────────────────────────────

  /**
   * Who may manage a project's members or flip its privacy: the guests bar
   * verbatim (guests.service.ts `assertMayManageGuests`) — the project lead,
   * plus manager and above. Enforced in the service because the sync door
   * carries no @Roles.
   */
  private assertMayManageMembers(
    project: { lead_user_id: string | null },
    actorUserId: string,
    role: string | undefined,
    what: string,
  ) {
    if (role && ['fam', 'owner', 'admin', 'manager'].includes(role)) return;
    if (
      role &&
      role !== 'guest' &&
      role !== 'auditor' &&
      project.lead_user_id &&
      project.lead_user_id === actorUserId
    ) {
      return;
    }
    throw new ForbiddenException(`${what} is for the project lead, or a manager and above`);
  }

  /** Refs for every LIVE issue in the project (privacy flips + membership on
   *  private projects must converge issues on affected clients too). */
  private async liveIssueRefs(tx: Db, tenantId: string, id: string) {
    const rows = await tx
      .select({ id: pmIssues.id })
      .from(pmIssues)
      .where(and(eq(pmIssues.tenant_id, tenantId), eq(pmIssues.project_id, id), isNull(pmIssues.deleted_at)));
    return rows.map((r) => ({ t: 'pm_issues', id: r.id }));
  }

  /** Members list with identity + workspace role, avatars signed (round E). */
  async listMembers(tenantId: string, userId: string, id: string) {
    const project = await this.db.withTenant(
      tenantId,
      async (tx) => {
        await this.assertProjectAccess(tx, tenantId, userId, id);
        return this.loadProject(tx, tenantId, id);
      },
      userId,
    );
    const rows = await this.db.withTenant(
      tenantId,
      (tx) =>
        tx
          .select({
            user_id: pmProjectMembers.user_id,
            added_at: pmProjectMembers.created_at,
            name: users.full_name,
            email: users.email,
            avatar_url: users.avatar_url,
            avatar_key: users.avatar_key,
            role: memberships.role,
          })
          .from(pmProjectMembers)
          .innerJoin(users, eq(pmProjectMembers.user_id, users.id))
          .innerJoin(
            memberships,
            and(eq(memberships.user_id, pmProjectMembers.user_id), eq(memberships.tenant_id, tenantId)),
          )
          .where(
            and(
              eq(pmProjectMembers.tenant_id, tenantId),
              eq(pmProjectMembers.project_id, id),
              // Guests keep their own card (guests.service list) — the members
              // panel is the INTERNAL roster.
              sql`${memberships.role} <> 'guest'`,
            ),
          )
          .orderBy(asc(pmProjectMembers.created_at)),
      userId,
    );
    const data = await Promise.all(
      rows.map(async ({ avatar_key, ...r }) => ({
        ...r,
        avatar_url: await this.media.servedUrl(avatar_key ?? null, r.avatar_url, 64),
        is_lead: project.lead_user_id === r.user_id,
      })),
    );
    return { data, total: data.length };
  }

  async addMember(tenantId: string, actorUserId: string, role: string | undefined, id: string, memberUserId: string) {
    const result = await this.db.withTenant(
      tenantId,
      async (tx) => {
        await this.assertProjectAccess(tx, tenantId, actorUserId, id);
        const project = await this.loadProject(tx, tenantId, id);
        this.assertMayManageMembers(project, actorUserId, role, 'Managing project members');
        // Target must be an active, internal workspace member (house rule #2 —
        // the id comes from a DTO). Guests come through the guest invite flow,
        // which provisions their seat + billing; never through this door.
        const [target] = await tx
          .select({ role: memberships.role })
          .from(memberships)
          .where(
            and(
              eq(memberships.tenant_id, tenantId),
              eq(memberships.user_id, memberUserId),
              eq(memberships.status, 'active'),
            ),
          )
          .limit(1);
        if (!target) throw new BadRequestException('user is not an active member of this workspace');
        if (target.role === 'guest') {
          throw new BadRequestException('Guests are invited from the Guests card, not added as members');
        }
        await tx
          .insert(pmProjectMembers)
          .values({ tenant_id: tenantId, project_id: id, user_id: memberUserId })
          .onConflictDoNothing();
        await this.domainEvents.publish(
          {
            name: 'pm.project.member_added',
            tenantId,
            actorUserId,
            payload: {
              project_id: id,
              user_id: memberUserId,
              sync: [
                { t: 'pm_project_members', id },
                // A private project APPEARS for the new member via these refs.
                ...(project.is_private
                  ? [{ t: 'pm_projects', id }, { t: 'pm_project_teams', id }, ...(await this.liveIssueRefs(tx, tenantId, id))]
                  : []),
              ],
            },
          },
          tx,
        );
        return { data: { project_id: id, user_id: memberUserId } };
      },
      actorUserId,
    );
    await this.audit.log({
      tenantId,
      actorUserId,
      action: 'pm.project.member_added',
      resourceType: 'pm_project',
      resourceId: id,
      metadata: { user_id: memberUserId },
    });
    return result;
  }

  async removeMember(tenantId: string, actorUserId: string, role: string | undefined, id: string, memberUserId: string) {
    const result = await this.db.withTenant(
      tenantId,
      async (tx) => {
        await this.assertProjectAccess(tx, tenantId, actorUserId, id);
        const project = await this.loadProject(tx, tenantId, id);
        this.assertMayManageMembers(project, actorUserId, role, 'Managing project members');
        const [target] = await tx
          .select({ role: memberships.role })
          .from(memberships)
          .where(and(eq(memberships.tenant_id, tenantId), eq(memberships.user_id, memberUserId)))
          .limit(1);
        if (target?.role === 'guest') {
          throw new BadRequestException('Guest access is revoked from the Guests card');
        }
        await tx
          .delete(pmProjectMembers)
          .where(
            and(
              eq(pmProjectMembers.tenant_id, tenantId),
              eq(pmProjectMembers.project_id, id),
              eq(pmProjectMembers.user_id, memberUserId),
            ),
          );
        await this.domainEvents.publish(
          {
            name: 'pm.project.member_removed',
            tenantId,
            actorUserId,
            payload: {
              project_id: id,
              user_id: memberUserId,
              sync: [
                { t: 'pm_project_members', id },
                // A private project DISAPPEARS for the removed member: the
                // delta's re-fetch misses become tombstones on their client.
                ...(project.is_private
                  ? [{ t: 'pm_projects', id }, { t: 'pm_project_teams', id }, ...(await this.liveIssueRefs(tx, tenantId, id))]
                  : []),
              ],
            },
          },
          tx,
        );
        return { data: { project_id: id, user_id: memberUserId, removed: true } };
      },
      actorUserId,
    );
    await this.audit.log({
      tenantId,
      actorUserId,
      action: 'pm.project.member_removed',
      resourceType: 'pm_project',
      resourceId: id,
      metadata: { user_id: memberUserId },
    });
    return result;
  }

  /**
   * Flip a project Private/public (round E, founder decision). Private =
   * visible only to its members, its lead, and owner/admin-class roles — the
   * rule itself lives in PmVisibilityService. Default false, so existing
   * projects are untouched. Refs name the project AND its live issues so
   * every affected client converges (appear or tombstone) without a reload.
   */
  async setVisibilityFlag(tenantId: string, actorUserId: string, role: string | undefined, id: string, isPrivate: boolean) {
    const result = await this.db.withTenant(
      tenantId,
      async (tx) => {
        await this.assertProjectAccess(tx, tenantId, actorUserId, id);
        const project = await this.loadProject(tx, tenantId, id);
        this.assertMayManageMembers(project, actorUserId, role, 'Changing project visibility');
        if (project.is_private === isPrivate) return { data: await this.stripAndSignLogo(project) };
        const [row] = await tx
          .update(pmProjects)
          .set({ is_private: isPrivate, updated_at: new Date() })
          .where(and(eq(pmProjects.id, id), eq(pmProjects.tenant_id, tenantId)))
          .returning();
        await this.domainEvents.publish(
          {
            name: 'pm.project.updated',
            tenantId,
            actorUserId,
            payload: {
              project_id: id,
              is_private: isPrivate,
              sync: [
                { t: 'pm_projects', id },
                { t: 'pm_project_teams', id },
                { t: 'pm_project_members', id },
                ...(await this.liveIssueRefs(tx, tenantId, id)),
              ],
            },
          },
          tx,
        );
        return { data: await this.stripAndSignLogo(row!) };
      },
      actorUserId,
    );
    await this.audit.log({
      tenantId,
      actorUserId,
      action: isPrivate ? 'pm.project.made_private' : 'pm.project.made_public',
      resourceType: 'pm_project',
      resourceId: id,
    });
    return result;
  }

  // ─── project logo (round E) ───────────────────────────────────────────────

  /**
   * Upload/replace the project logo. Authorization + the previous-key
   * snapshot happen inside a tenant tx; the R2 upload is network and stays
   * OUTSIDE any transaction (house rule 7); then the key lands in a second
   * tx that also publishes the sync ref, so every client's project row
   * refreshes with a newly signed logo_url. Same bar as renaming (any
   * non-guest who can see the project) — the logo is part of editing it.
   */
  async uploadLogo(tenantId: string, userId: string, id: string, buffer: Buffer) {
    const prevKey = await this.db.withTenant(
      tenantId,
      async (tx) => {
        await this.visibility.assertNotGuestTx(tx, tenantId, userId, 'project management');
        await this.assertProjectAccess(tx, tenantId, userId, id);
        const project = await this.loadProject(tx, tenantId, id);
        return project.logo_key;
      },
      userId,
    );
    const media = await this.media.processImage(buffer, `tenants/${tenantId}/pm-projects/${id}/logo`, true);
    const row = await this.db.withTenant(
      tenantId,
      async (tx) => {
        const [updated] = await tx
          .update(pmProjects)
          .set({ logo_key: media.key256, logo_updated_at: new Date(), updated_at: new Date() })
          .where(and(eq(pmProjects.id, id), eq(pmProjects.tenant_id, tenantId)))
          .returning();
        await this.domainEvents.publish(
          {
            name: 'pm.project.updated',
            tenantId,
            actorUserId: userId,
            payload: { project_id: id, sync: [{ t: 'pm_projects', id }] },
          },
          tx,
        );
        return updated!;
      },
      userId,
    );
    if (prevKey) void this.media.deleteImage(prevKey).catch(() => undefined);
    await this.audit.log({
      tenantId,
      actorUserId: userId,
      action: 'pm.project.logo_updated',
      resourceType: 'pm_project',
      resourceId: id,
    });
    return { data: await this.stripAndSignLogo(row) };
  }

  async removeLogo(tenantId: string, userId: string, id: string) {
    const { row, prevKey } = await this.db.withTenant(
      tenantId,
      async (tx) => {
        await this.visibility.assertNotGuestTx(tx, tenantId, userId, 'project management');
        await this.assertProjectAccess(tx, tenantId, userId, id);
        const project = await this.loadProject(tx, tenantId, id);
        if (!project.logo_key) return { row: project, prevKey: null as string | null };
        const [updated] = await tx
          .update(pmProjects)
          .set({ logo_key: null, logo_updated_at: new Date(), updated_at: new Date() })
          .where(and(eq(pmProjects.id, id), eq(pmProjects.tenant_id, tenantId)))
          .returning();
        await this.domainEvents.publish(
          {
            name: 'pm.project.updated',
            tenantId,
            actorUserId: userId,
            payload: { project_id: id, sync: [{ t: 'pm_projects', id }] },
          },
          tx,
        );
        return { row: updated!, prevKey: project.logo_key };
      },
      userId,
    );
    if (prevKey) {
      void this.media.deleteImage(prevKey).catch(() => undefined);
      await this.audit.log({
        tenantId,
        actorUserId: userId,
        action: 'pm.project.logo_removed',
        resourceType: 'pm_project',
        resourceId: id,
      });
    }
    return { data: await this.stripAndSignLogo(row) };
  }

  // ─── milestones (§6.2) ────────────────────────────────────────────────────

  async createMilestone(
    tenantId: string,
    userId: string,
    input: { id?: string; project_id: string; name: string; target_date?: string | null; position?: number },
  ) {
    if (!input.name?.trim()) throw new BadRequestException('Milestone name is required');
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        await this.visibility.assertNotGuestTx(tx, tenantId, userId, 'project management');
        await this.assertProjectAccess(tx, tenantId, userId, input.project_id);
        await this.loadProject(tx, tenantId, input.project_id);
        const [row] = await tx
          .insert(pmProjectMilestones)
          .values({
            ...(input.id ? { id: input.id } : {}),
            tenant_id: tenantId,
            project_id: input.project_id,
            name: input.name.trim(),
            target_date: input.target_date ?? null,
            position: input.position ?? 0,
          })
          .returning();
        await this.domainEvents.publish(
          {
            name: 'pm.project.milestone_changed',
            tenantId,
            actorUserId: userId,
            payload: { project_id: input.project_id, milestone_id: row!.id, sync: [{ t: 'pm_project_milestones', id: row!.id }] },
          },
          tx,
        );
        return { data: row! };
      },
      userId,
    );
  }

  async updateMilestone(
    tenantId: string,
    userId: string,
    id: string,
    patch: { name?: string; target_date?: string | null; position?: number },
  ) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        await this.visibility.assertNotGuestTx(tx, tenantId, userId, 'project management');
        const [ms] = await tx
          .select()
          .from(pmProjectMilestones)
          .where(and(eq(pmProjectMilestones.id, id), eq(pmProjectMilestones.tenant_id, tenantId)))
          .limit(1);
        if (!ms) throw new NotFoundException('Milestone not found');
        await this.assertProjectAccess(tx, tenantId, userId, ms.project_id);
        const clean: Record<string, unknown> = {};
        if (patch.name !== undefined) {
          if (!patch.name?.trim()) throw new BadRequestException('Milestone name is required');
          clean.name = patch.name.trim();
        }
        if (patch.target_date !== undefined) clean.target_date = patch.target_date;
        if (patch.position !== undefined) clean.position = patch.position;
        if (!Object.keys(clean).length) return { data: ms };
        const [row] = await tx
          .update(pmProjectMilestones)
          .set(clean)
          .where(and(eq(pmProjectMilestones.id, id), eq(pmProjectMilestones.tenant_id, tenantId)))
          .returning();
        await this.domainEvents.publish(
          {
            name: 'pm.project.milestone_changed',
            tenantId,
            actorUserId: userId,
            payload: { project_id: ms.project_id, milestone_id: id, sync: [{ t: 'pm_project_milestones', id }] },
          },
          tx,
        );
        return { data: row! };
      },
      userId,
    );
  }

  async deleteMilestone(tenantId: string, userId: string, id: string) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        await this.visibility.assertNotGuestTx(tx, tenantId, userId, 'project management');
        const [ms] = await tx
          .select()
          .from(pmProjectMilestones)
          .where(and(eq(pmProjectMilestones.id, id), eq(pmProjectMilestones.tenant_id, tenantId)))
          .limit(1);
        if (!ms) throw new NotFoundException('Milestone not found');
        await this.assertProjectAccess(tx, tenantId, userId, ms.project_id);
        // Hard delete; issues pointing here get milestone_id=NULL via FK.
        await tx.delete(pmProjectMilestones).where(and(eq(pmProjectMilestones.id, id), eq(pmProjectMilestones.tenant_id, tenantId)));
        await this.domainEvents.publish(
          {
            name: 'pm.project.milestone_changed',
            tenantId,
            actorUserId: userId,
            payload: { project_id: ms.project_id, milestone_id: id, deleted: true, sync: [{ t: 'pm_project_milestones', id }] },
          },
          tx,
        );
        return { data: { id, deleted: true } };
      },
      userId,
    );
  }

  // ─── initiatives (§6.4 — light) ───────────────────────────────────────────

  async listInitiatives(tenantId: string, userId: string) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        // Initiatives are a portfolio surface — empty for guests.
        const guestScope = await this.visibility.guestScopeTx(tx, tenantId, userId);
        if (guestScope) return { data: { initiatives: [], projects: {} } };
        const initiatives = await tx
          .select()
          .from(pmInitiatives)
          .where(and(eq(pmInitiatives.tenant_id, tenantId), isNull(pmInitiatives.deleted_at)))
          .orderBy(asc(pmInitiatives.target_quarter), asc(pmInitiatives.name));
        const links = await tx
          .select()
          .from(pmInitiativeProjects)
          .where(eq(pmInitiativeProjects.tenant_id, tenantId))
          .orderBy(asc(pmInitiativeProjects.position));
        const projects: Record<string, string[]> = {};
        for (const l of links) (projects[l.initiative_id] ??= []).push(l.project_id);
        return { data: { initiatives, projects } };
      },
      userId,
    );
  }

  async createInitiative(
    tenantId: string,
    userId: string,
    role: string,
    input: { id?: string; name: string; description?: string | null; owner_user_id?: string | null; target_quarter?: string | null },
  ) {
    this.assertInitiativeRole(role);
    if (!input.name?.trim()) throw new BadRequestException('Initiative name is required');
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        await this.visibility.assertNotGuestTx(tx, tenantId, userId, 'project management');
        await this.assertActiveMember(tx, tenantId, input.owner_user_id ? [input.owner_user_id] : []);
        const [row] = await tx
          .insert(pmInitiatives)
          .values({
            ...(input.id ? { id: input.id } : {}),
            tenant_id: tenantId,
            name: input.name.trim(),
            description: input.description ?? null,
            owner_user_id: input.owner_user_id ?? userId,
            target_quarter: input.target_quarter ?? null,
          })
          .returning();
        await this.domainEvents.publish(
          { name: 'pm.initiative.created', tenantId, actorUserId: userId, payload: { initiative_id: row!.id, sync: [{ t: 'pm_initiatives', id: row!.id }] } },
          tx,
        );
        return { data: row! };
      },
      userId,
    );
  }

  async updateInitiative(
    tenantId: string,
    userId: string,
    role: string,
    id: string,
    patch: { name?: string; description?: string | null; status?: string; owner_user_id?: string | null; target_quarter?: string | null },
  ) {
    this.assertInitiativeRole(role);
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        await this.visibility.assertNotGuestTx(tx, tenantId, userId, 'project management');
        const [init] = await tx
          .select()
          .from(pmInitiatives)
          .where(and(eq(pmInitiatives.id, id), eq(pmInitiatives.tenant_id, tenantId), isNull(pmInitiatives.deleted_at)))
          .limit(1);
        if (!init) throw new NotFoundException('Initiative not found');
        const clean: Record<string, unknown> = {};
        if (patch.name !== undefined) {
          if (!patch.name?.trim()) throw new BadRequestException('Initiative name is required');
          clean.name = patch.name.trim();
        }
        if (patch.description !== undefined) clean.description = patch.description;
        if (patch.status !== undefined) {
          if (!['active', 'completed', 'paused'].includes(patch.status)) throw new BadRequestException('invalid status');
          clean.status = patch.status;
        }
        if (patch.owner_user_id !== undefined) {
          if (patch.owner_user_id) await this.assertActiveMember(tx, tenantId, [patch.owner_user_id]);
          clean.owner_user_id = patch.owner_user_id;
        }
        if (patch.target_quarter !== undefined) clean.target_quarter = patch.target_quarter;
        if (!Object.keys(clean).length) return { data: init };
        const [row] = await tx
          .update(pmInitiatives)
          .set({ ...clean, updated_at: new Date() })
          .where(and(eq(pmInitiatives.id, id), eq(pmInitiatives.tenant_id, tenantId)))
          .returning();
        await this.domainEvents.publish(
          { name: 'pm.initiative.updated', tenantId, actorUserId: userId, payload: { initiative_id: id, sync: [{ t: 'pm_initiatives', id }] } },
          tx,
        );
        return { data: row! };
      },
      userId,
    );
  }

  async setInitiativeProjects(tenantId: string, userId: string, role: string, id: string, projectIds: string[]) {
    this.assertInitiativeRole(role);
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        await this.visibility.assertNotGuestTx(tx, tenantId, userId, 'project management');
        const [init] = await tx
          .select({ id: pmInitiatives.id })
          .from(pmInitiatives)
          .where(and(eq(pmInitiatives.id, id), eq(pmInitiatives.tenant_id, tenantId), isNull(pmInitiatives.deleted_at)))
          .limit(1);
        if (!init) throw new NotFoundException('Initiative not found');
        const clean = [...new Set(projectIds)];
        // Validate against the tenant WITH deleted rows: a client can
        // legitimately still hold the id of a project that was soft-deleted a
        // moment ago, and rejecting the whole write for it turned an "add one
        // project to this lane" into a hard failure. Only truly foreign ids
        // are an error. Soft-deleted ids are accepted and simply not
        // re-inserted — their lane rows are preserved below.
        let liveIds: string[] = [];
        if (clean.length) {
          const rows = await tx
            .select({ id: pmProjects.id, deleted_at: pmProjects.deleted_at })
            .from(pmProjects)
            .where(and(eq(pmProjects.tenant_id, tenantId), inArray(pmProjects.id, clean)));
          if (rows.length !== clean.length) throw new BadRequestException('project_ids contain a project outside this workspace');
          liveIds = rows.filter((r) => !r.deleted_at).map((r) => r.id);
        }
        // Replace only the LIVE projects' lane rows. A soft-deleted project's
        // row stays put whatever the client sent: the client cannot see it
        // (tombstoned locally), so a full replace built from the client's view
        // silently destroyed it — and the project then came back from
        // Recently deleted without its lane placement, unrecoverably
        // (founder round A, the destructive full-set-replace class).
        await tx.delete(pmInitiativeProjects).where(
          and(
            eq(pmInitiativeProjects.tenant_id, tenantId),
            eq(pmInitiativeProjects.initiative_id, id),
            inArray(
              pmInitiativeProjects.project_id,
              tx
                .select({ id: pmProjects.id })
                .from(pmProjects)
                .where(and(eq(pmProjects.tenant_id, tenantId), isNull(pmProjects.deleted_at))),
            ),
          ),
        );
        if (liveIds.length) {
          await tx.insert(pmInitiativeProjects).values(
            liveIds.map((project_id, i) => ({ tenant_id: tenantId, initiative_id: id, project_id, position: i })),
          );
        }
        await this.domainEvents.publish(
          { name: 'pm.initiative.updated', tenantId, actorUserId: userId, payload: { initiative_id: id, sync: [{ t: 'pm_initiatives', id }, { t: 'pm_initiative_projects', id }] } },
          tx,
        );
        return { data: { initiative_id: id, project_ids: clean } };
      },
      userId,
    );
  }

  /** Initiatives are Manager+ (§16 matrix — 'member' cannot create/edit). */
  private assertInitiativeRole(role: string) {
    if (['employee', 'auditor'].includes(role)) {
      throw new ForbiddenException('Initiatives are manager-and-above');
    }
  }
}
