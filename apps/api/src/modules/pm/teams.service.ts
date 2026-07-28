import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, gte, isNull, sql } from 'drizzle-orm';
import {
  pmTeams,
  pmTeamMemberships,
  pmTeamCounters,
  pmWorkflowStates,
  pmLabels,
  pmIssues,
  pmProjects,
  memberships,
  tenants,
  users,
} from '@flicks/db/schema';
import type { Db } from '@flicks/db';
import { PM_STATE_CATEGORIES } from '@flicks/shared/pm';
import { DatabaseService } from '../../core/database/database.service';
import { AuditService } from '../audit/audit.service';
import { DomainEventsService } from '../../core/events/domain-events.service';

/**
 * PM teams (PRD v6 §4). Workspace = tenant; work happens in teams. First call
 * into an empty workspace self-heals (house rule: never a dead end): a default
 * team is minted from the company name with the seeded state set, and every
 * active member joins it (AC-ZERO — a new team is productive with zero setup).
 */

// §4.2 / Appendix B — seed states per new team (colors = design tokens).
const SEED_STATES: Array<{ name: string; color: string; category: string; default?: boolean }> = [
  { name: 'Triage', color: '#9B7BFA', category: 'triage', default: true },
  { name: 'Backlog', color: '#5C6477', category: 'backlog', default: true },
  { name: 'Todo', color: '#A8B0C2', category: 'unstarted', default: true },
  { name: 'In Progress', color: '#FED800', category: 'started', default: true },
  { name: 'In Review', color: '#3E7BFA', category: 'started' },
  { name: 'Done', color: '#27D280', category: 'completed', default: true },
  { name: 'Canceled', color: '#5C6477', category: 'canceled', default: true },
  { name: 'Duplicate', color: '#5C6477', category: 'canceled' },
];

function keyFromName(name: string): string {
  const words = name.toUpperCase().replace(/[^A-Z0-9 ]/g, '').split(/\s+/).filter(Boolean);
  const initials = words.map((w) => w[0]).join('');
  const key = (initials.length >= 2 ? initials : (words[0] ?? 'TEAM')).slice(0, 6);
  return key.length >= 2 ? key : `${key}T`.slice(0, 6);
}

@Injectable()
export class PmTeamsService {
  private readonly logger = new Logger(PmTeamsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly domainEvents: DomainEventsService,
  ) {}

  /** Seed states + counter for a team inside the caller's tx. */
  private async seedTeamInternals(tx: Db, tenantId: string, teamId: string) {
    const rows = SEED_STATES.map((s, i) => ({
      tenant_id: tenantId,
      team_id: teamId,
      name: s.name,
      color: s.color,
      category: s.category,
      position: i + 1,
      is_default_for_category: s.default ?? false,
    }));
    const created = await tx.insert(pmWorkflowStates).values(rows).returning();
    await tx.insert(pmTeamCounters).values({ team_id: teamId, tenant_id: tenantId, last_number: 0 });
    const backlog = created.find((s) => s.category === 'backlog');
    if (backlog) {
      await tx.update(pmTeams).set({ default_state_id: backlog.id }).where(eq(pmTeams.id, teamId));
    }
    return created;
  }

  /**
   * Self-heal: ensure the workspace has at least one team. Returns true if it
   * seeded. Called from list() and by the sync bootstrap.
   */
  async ensureWorkspace(tenantId: string, actorUserId: string): Promise<boolean> {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        // Concurrent first hits (StrictMode double-mount, two tabs) race the
        // check-then-seed and the loser dies on pm_teams_tenant_id_key_key —
        // a tx-scoped advisory lock serializes seeders per tenant so the
        // loser re-checks after the winner commits.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`pm_seed:${tenantId}`}))`);
        const [existing] = await tx
          .select({ id: pmTeams.id })
          .from(pmTeams)
          .where(and(eq(pmTeams.tenant_id, tenantId), isNull(pmTeams.deleted_at)))
          .limit(1);
        if (existing) return false;

        const [tenant] = await tx
          .select({ name: tenants.name })
          .from(tenants)
          .where(eq(tenants.id, tenantId))
          .limit(1);
        const name = tenant?.name?.trim() || 'Team';
        const key = keyFromName(name);

        const [team] = await tx
          .insert(pmTeams)
          .values({ tenant_id: tenantId, key, name, color: '#3E7BFA', is_private: false })
          .returning();

        await this.seedTeamInternals(tx, tenantId, team!.id);

        // Org-open default team: every active member joins (Linear onboarding
        // norm); the first owner/admin becomes lead.
        const activeMembers = await tx
          .select({ user_id: memberships.user_id, role: memberships.role })
          .from(memberships)
          .where(and(eq(memberships.tenant_id, tenantId), eq(memberships.status, 'active')));
        if (activeMembers.length > 0) {
          const leadId =
            activeMembers.find((m) => m.role === 'owner')?.user_id ??
            activeMembers.find((m) => m.role === 'admin')?.user_id ??
            actorUserId;
          await tx.insert(pmTeamMemberships).values(
            activeMembers
              .filter((m) => m.role !== 'auditor')
              .map((m) => ({
                team_id: team!.id,
                tenant_id: tenantId,
                user_id: m.user_id,
                is_lead: m.user_id === leadId,
              })),
          );
        }

        await this.domainEvents.publish(
          {
            name: 'pm.team.created',
            tenantId,
            actorUserId,
            payload: { team_id: team!.id, sync: [{ t: 'pm_teams', id: team!.id }] },
          },
          tx,
        );
        this.logger.log(`PM workspace seeded for tenant ${tenantId}: team ${key}`);
        return true;
      },
      actorUserId,
    );
  }

  /** Teams visible to the user (public ∪ member) + own memberships. */
  async list(tenantId: string, userId: string) {
    await this.ensureWorkspace(tenantId, userId);
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const mine = await tx
          .select()
          .from(pmTeamMemberships)
          .where(and(eq(pmTeamMemberships.tenant_id, tenantId), eq(pmTeamMemberships.user_id, userId)));
        const mineIds = new Set(mine.map((m) => m.team_id));
        const teams = (
          await tx
            .select()
            .from(pmTeams)
            .where(and(eq(pmTeams.tenant_id, tenantId), isNull(pmTeams.deleted_at)))
            .orderBy(asc(pmTeams.created_at))
        ).filter((t) => !t.is_private || mineIds.has(t.id));
        const teamIds = teams.map((t) => t.id);
        const states = teamIds.length
          ? await tx
              .select()
              .from(pmWorkflowStates)
              .where(eq(pmWorkflowStates.tenant_id, tenantId))
              .orderBy(asc(pmWorkflowStates.position))
          : [];
        const labels = await tx.select().from(pmLabels).where(eq(pmLabels.tenant_id, tenantId));
        const membershipsAll = await tx
          .select()
          .from(pmTeamMemberships)
          .where(eq(pmTeamMemberships.tenant_id, tenantId));
        return {
          data: {
            teams,
            memberships: mine,
            // P15 — member rows/avatars per visible team.
            memberships_all: membershipsAll.filter((m) => teamIds.includes(m.team_id)),
            states: states.filter((s) => teamIds.includes(s.team_id)),
            labels,
          },
        };
      },
      userId,
    );
  }

  /** Create a team (Owner/Admin/Manager — enforced at the controller). */
  async create(
    tenantId: string,
    userId: string,
    dto: { key: string; name: string; color?: string; is_private?: boolean; timezone?: string },
  ) {
    const key = (dto.key ?? '').toUpperCase().trim();
    if (!/^[A-Z0-9]{2,6}$/.test(key)) {
      throw new BadRequestException('Team key must be 2–6 characters, A–Z and 0–9');
    }
    if (!dto.name?.trim()) throw new BadRequestException('Team name is required');

    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const [dupe] = await tx
          .select({ id: pmTeams.id })
          .from(pmTeams)
          .where(and(eq(pmTeams.tenant_id, tenantId), eq(pmTeams.key, key), isNull(pmTeams.deleted_at)))
          .limit(1);
        if (dupe) throw new BadRequestException(`Team key ${key} is already in use`);

        const [team] = await tx
          .insert(pmTeams)
          .values({
            tenant_id: tenantId,
            key,
            name: dto.name.trim(),
            color: dto.color ?? '#3E7BFA',
            is_private: dto.is_private ?? false,
            timezone: dto.timezone ?? null,
          })
          .returning();
        await this.seedTeamInternals(tx, tenantId, team!.id);
        await tx.insert(pmTeamMemberships).values({
          team_id: team!.id,
          tenant_id: tenantId,
          user_id: userId,
          is_lead: true,
        });

        await this.audit.log({
          tenantId,
          actorUserId: userId,
          action: 'pm.team.create',
          resourceType: 'pm_team',
          resourceId: team!.id,
          metadata: { key, is_private: team!.is_private },
        });
        await this.domainEvents.publish(
          {
            name: 'pm.team.created',
            tenantId,
            actorUserId: userId,
            payload: { team_id: team!.id, sync: [{ t: 'pm_teams', id: team!.id }] },
          },
          tx,
        );
        return { data: team! };
      },
      userId,
    );
  }

  /** §16 — team settings need Owner/Admin OR team lead. */
  private async assertSettingsAccess(tx: Db, tenantId: string, userId: string, teamId: string, role?: string) {
    if (role === 'owner' || role === 'admin' || role === 'super_admin' || role === 'fam') return;
    const [m] = await tx
      .select({ is_lead: pmTeamMemberships.is_lead })
      .from(pmTeamMemberships)
      .where(and(eq(pmTeamMemberships.team_id, teamId), eq(pmTeamMemberships.user_id, userId)))
      .limit(1);
    if (!m?.is_lead) throw new BadRequestException('Team settings need Owner/Admin or the team lead');
  }

  /** §7.1 cycle config + team basics (Owner/Admin or team lead — §16). */
  async updateConfig(
    tenantId: string,
    userId: string,
    role: string,
    teamId: string,
    patch: {
      name?: string;
      color?: string;
      timezone?: string;
      cycles_enabled?: boolean;
      cycle_length_weeks?: number;
      cooldown_days?: number;
      cycle_start_dow?: number;
      cycle_auto_add_started?: boolean;
      upcoming_cycles?: number;
      triage_enabled?: boolean;
      gh_auto_branch?: boolean;
      gh_auto_pr_open?: boolean;
      gh_auto_pr_merge?: boolean;
      gh_auto_pr_close?: boolean;
      gh_magic_words?: boolean;
      gh_bot_comment?: boolean;
      is_private?: boolean;
      estimate_scale?: string;
    },
  ) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        await this.assertSettingsAccess(tx, tenantId, userId, teamId, role);
        const clean: Record<string, unknown> = {};
        if (patch.name !== undefined && patch.name.trim()) clean.name = patch.name.trim();
        if (patch.color !== undefined) clean.color = patch.color;
        if (patch.timezone !== undefined) clean.timezone = patch.timezone;
        if (patch.cycles_enabled !== undefined) clean.cycles_enabled = patch.cycles_enabled;
        if (patch.cycle_length_weeks !== undefined) {
          if (patch.cycle_length_weeks < 1 || patch.cycle_length_weeks > 6) throw new BadRequestException('cycle_length_weeks 1–6');
          clean.cycle_length_weeks = patch.cycle_length_weeks;
        }
        if (patch.cooldown_days !== undefined) {
          if (patch.cooldown_days < 0 || patch.cooldown_days > 7) throw new BadRequestException('cooldown_days 0–7');
          clean.cooldown_days = patch.cooldown_days;
        }
        if (patch.cycle_start_dow !== undefined) {
          if (patch.cycle_start_dow < 0 || patch.cycle_start_dow > 6) throw new BadRequestException('cycle_start_dow 0–6');
          clean.cycle_start_dow = patch.cycle_start_dow;
        }
        if (patch.cycle_auto_add_started !== undefined) clean.cycle_auto_add_started = patch.cycle_auto_add_started;
        if (patch.upcoming_cycles !== undefined) clean.upcoming_cycles = Math.min(Math.max(patch.upcoming_cycles, 1), 4);
        if (patch.triage_enabled !== undefined) clean.triage_enabled = patch.triage_enabled;
        for (const k of ['gh_auto_branch', 'gh_auto_pr_open', 'gh_auto_pr_merge', 'gh_auto_pr_close', 'gh_magic_words', 'gh_bot_comment'] as const) {
          if (patch[k] !== undefined) clean[k] = patch[k];
        }
        if (patch.estimate_scale !== undefined) {
          if (!['count', 'linear', 'fibonacci', 'exponential', 'tshirt'].includes(patch.estimate_scale)) {
            throw new BadRequestException('estimate_scale invalid');
          }
          clean.estimate_scale = patch.estimate_scale;
        }
        if (patch.is_private !== undefined) {
          clean.is_private = patch.is_private;
          // §4.4 — visibility changes are always audit-logged.
          await this.audit.log({
            tenantId,
            actorUserId: userId,
            action: patch.is_private ? 'pm.team.make_private' : 'pm.team.make_public',
            resourceType: 'pm_team',
            resourceId: teamId,
            metadata: {},
          });
        }
        if (!Object.keys(clean).length) throw new BadRequestException('empty patch');
        const [team] = await tx
          .update(pmTeams)
          .set(clean)
          .where(and(eq(pmTeams.id, teamId), eq(pmTeams.tenant_id, tenantId)))
          .returning();
        if (!team) throw new BadRequestException('team not found');
        await this.domainEvents.publish(
          {
            name: 'pm.team.updated',
            tenantId,
            actorUserId: userId,
            payload: { team_id: teamId, sync: [{ t: 'pm_teams', id: teamId }] },
          },
          tx,
        );
        return { data: team };
      },
      userId,
    );
  }

  /** Rename/recolor a state, or add one within a category (§4.2). */
  async upsertState(
    tenantId: string,
    userId: string,
    role: string,
    teamId: string,
    dto: { id?: string; name: string; color: string; category?: string; position?: number },
  ) {
    if (!dto.name?.trim() || !dto.color?.trim()) throw new BadRequestException('name and color are required');
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        await this.assertSettingsAccess(tx, tenantId, userId, teamId, role);
        let row;
        if (dto.id) {
          const [existing] = await tx
            .select()
            .from(pmWorkflowStates)
            .where(and(eq(pmWorkflowStates.id, dto.id), eq(pmWorkflowStates.team_id, teamId)))
            .limit(1);
          if (!existing) throw new BadRequestException('state not found on this team');
          [row] = await tx
            .update(pmWorkflowStates)
            .set({ name: dto.name.trim(), color: dto.color })
            .where(eq(pmWorkflowStates.id, dto.id))
            .returning();
        } else {
          if (!PM_STATE_CATEGORIES.includes((dto.category ?? '') as never)) {
            throw new BadRequestException('category is required for a new state');
          }
          [row] = await tx
            .insert(pmWorkflowStates)
            .values({
              tenant_id: tenantId,
              team_id: teamId,
              name: dto.name.trim(),
              color: dto.color,
              category: dto.category!,
              position: dto.position ?? 99,
            })
            .returning();
        }
        await this.domainEvents.publish(
          {
            name: dto.id ? 'pm.state.updated' : 'pm.state.created',
            tenantId,
            actorUserId: userId,
            payload: { state_id: row!.id, team_id: teamId, sync: [{ t: 'pm_workflow_states', id: row!.id }] },
          },
          tx,
        );
        return { data: row! };
      },
      userId,
    );
  }

  /** Workspace or team label create/update (§4.3). */
  async upsertLabel(
    tenantId: string,
    userId: string,
    role: string,
    dto: { id?: string; team_id?: string | null; name: string; color: string; description?: string },
  ) {
    if (!dto.name?.trim() || !dto.color?.trim()) throw new BadRequestException('name and color are required');
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        // Workspace labels: Owner/Admin. Team labels: settings access.
        if (dto.team_id) await this.assertSettingsAccess(tx, tenantId, userId, dto.team_id, role);
        else if (!['owner', 'admin', 'super_admin', 'fam'].includes(role)) {
          throw new BadRequestException('Workspace labels need Owner/Admin');
        }
        let row;
        if (dto.id) {
          [row] = await tx
            .update(pmLabels)
            .set({ name: dto.name.trim(), color: dto.color, description: dto.description ?? null })
            .where(and(eq(pmLabels.id, dto.id), eq(pmLabels.tenant_id, tenantId)))
            .returning();
          if (!row) throw new BadRequestException('label not found');
        } else {
          [row] = await tx
            .insert(pmLabels)
            .values({
              tenant_id: tenantId,
              team_id: dto.team_id ?? null,
              name: dto.name.trim(),
              color: dto.color,
              description: dto.description ?? null,
            })
            .returning();
        }
        await this.domainEvents.publish(
          {
            name: dto.id ? 'pm.label.updated' : 'pm.label.created',
            tenantId,
            actorUserId: userId,
            payload: { label_id: row!.id, sync: [{ t: 'pm_labels', id: row!.id }] },
          },
          tx,
        );
        return { data: row! };
      },
      userId,
    );
  }

  /** users-lite roster for assignee pickers / avatar rendering (bootstrap model). */
  async usersLite(tenantId: string, userId: string) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const rows = await tx
          .select({ id: users.id, name: users.full_name, avatar_url: users.avatar_url })
          .from(users)
          .innerJoin(memberships, eq(memberships.user_id, users.id))
          .where(and(eq(memberships.tenant_id, tenantId), eq(memberships.status, 'active')));
        return rows;
      },
      userId,
    );
  }

  // ─── Members (§4.4, P15) ──────────────────────────────────────────────────

  async addMember(tenantId: string, userId: string, role: string, teamId: string, memberUserId: string) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        await this.assertSettingsAccess(tx, tenantId, userId, teamId, role);
        const [m] = await tx
          .select({ user_id: memberships.user_id })
          .from(memberships)
          .where(and(eq(memberships.tenant_id, tenantId), eq(memberships.user_id, memberUserId), eq(memberships.status, 'active')))
          .limit(1);
        if (!m) throw new BadRequestException('Not an active workspace member');
        const [team] = await tx
          .select({ is_private: pmTeams.is_private })
          .from(pmTeams)
          .where(and(eq(pmTeams.id, teamId), eq(pmTeams.tenant_id, tenantId)))
          .limit(1);
        await tx
          .insert(pmTeamMemberships)
          .values({ tenant_id: tenantId, team_id: teamId, user_id: memberUserId })
          .onConflictDoNothing();
        // Owner/Admin self-add to a PRIVATE team is legal but always audited
        // and visible (P15 confirm modal copy).
        await this.audit.log({
          tenantId,
          actorUserId: userId,
          action: userId === memberUserId && team?.is_private ? 'pm.team.self_add' : 'pm.team.member_add',
          resourceType: 'pm_team',
          resourceId: teamId,
          metadata: { member_user_id: memberUserId },
        });
        await this.domainEvents.publish(
          {
            name: 'pm.team.updated',
            tenantId,
            actorUserId: userId,
            payload: { team_id: teamId, sync: [{ t: 'pm_teams', id: teamId }, { t: 'pm_team_memberships', id: teamId }] },
          },
          tx,
        );
        return { data: { added: true } };
      },
      userId,
    );
  }

  async removeMember(tenantId: string, userId: string, role: string, teamId: string, memberUserId: string) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        await this.assertSettingsAccess(tx, tenantId, userId, teamId, role);
        await tx
          .delete(pmTeamMemberships)
          .where(and(eq(pmTeamMemberships.team_id, teamId), eq(pmTeamMemberships.user_id, memberUserId)))
          .returning();
        await this.audit.log({
          tenantId,
          actorUserId: userId,
          action: 'pm.team.member_remove',
          resourceType: 'pm_team',
          resourceId: teamId,
          metadata: { member_user_id: memberUserId },
        });
        await this.domainEvents.publish(
          {
            name: 'pm.team.updated',
            tenantId,
            actorUserId: userId,
            payload: { team_id: teamId, sync: [{ t: 'pm_teams', id: teamId }, { t: 'pm_team_memberships', id: teamId }] },
          },
          tx,
        );
        return { data: { removed: true } };
      },
      userId,
    );
  }

  /** Public teams are open to join (P15 teams index "Join"). */
  async joinTeam(tenantId: string, userId: string, teamId: string) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const [team] = await tx
          .select({ is_private: pmTeams.is_private })
          .from(pmTeams)
          .where(and(eq(pmTeams.id, teamId), eq(pmTeams.tenant_id, tenantId), isNull(pmTeams.deleted_at)))
          .limit(1);
        if (!team) throw new BadRequestException('team not found');
        if (team.is_private) throw new BadRequestException('Private team — invite only');
        await tx
          .insert(pmTeamMemberships)
          .values({ tenant_id: tenantId, team_id: teamId, user_id: userId })
          .onConflictDoNothing();
        await this.domainEvents.publish(
          { name: 'pm.team.updated', tenantId, actorUserId: userId, payload: { team_id: teamId, sync: [{ t: 'pm_teams', id: teamId }, { t: 'pm_team_memberships', id: teamId }] } },
          tx,
        );
        return { data: { joined: true } };
      },
      userId,
    );
  }

  /** Soft-delete (Danger zone) — Owner/Admin only, 30-day restorable rows. */
  async deleteTeam(tenantId: string, userId: string, teamId: string) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const [team] = await tx
          .update(pmTeams)
          .set({ deleted_at: new Date() })
          .where(and(eq(pmTeams.id, teamId), eq(pmTeams.tenant_id, tenantId), isNull(pmTeams.deleted_at)))
          .returning();
        if (!team) throw new BadRequestException('team not found');
        await this.audit.log({
          tenantId,
          actorUserId: userId,
          action: 'pm.team.delete',
          resourceType: 'pm_team',
          resourceId: teamId,
          metadata: { key: team.key },
        });
        await this.domainEvents.publish(
          { name: 'pm.team.deleted', tenantId, actorUserId: userId, payload: { team_id: teamId, sync: [{ t: 'pm_teams', id: teamId }] } },
          tx,
        );
        return { data: { deleted: true } };
      },
      userId,
    );
  }

  // ─── Recently deleted (§15.4, P18): 30-day restore window ─────────────────

  async recentlyDeleted(tenantId: string, userId: string) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const cutoff = new Date(Date.now() - 30 * 86_400_000);
        const issues = await tx
          .select({
            id: pmIssues.id, number: pmIssues.number, title: pmIssues.title,
            team_id: pmIssues.team_id, deleted_at: pmIssues.deleted_at,
          })
          .from(pmIssues)
          .where(and(eq(pmIssues.tenant_id, tenantId), gte(pmIssues.deleted_at, cutoff)))
          .orderBy(sql`${pmIssues.deleted_at} DESC`)
          .limit(100);
        const projects = await tx
          .select({ id: pmProjects.id, name: pmProjects.name, deleted_at: pmProjects.deleted_at })
          .from(pmProjects)
          .where(and(eq(pmProjects.tenant_id, tenantId), gte(pmProjects.deleted_at, cutoff)))
          .orderBy(sql`${pmProjects.deleted_at} DESC`)
          .limit(100);
        const teamKeys = await tx
          .select({ id: pmTeams.id, key: pmTeams.key })
          .from(pmTeams)
          .where(eq(pmTeams.tenant_id, tenantId));
        const keyOf = new Map(teamKeys.map((t) => [t.id, t.key]));
        return {
          data: {
            issues: issues.map((i) => ({ ...i, key: `${keyOf.get(i.team_id) ?? '?'}-${i.number}` })),
            projects,
          },
        };
      },
      userId,
    );
  }

  /** Hard-delete one soft-deleted row ahead of the 30-day purge (P18 Purge). */
  async purgeDeleted(tenantId: string, userId: string, kind: string, id: string) {
    if (kind !== 'issue' && kind !== 'project') throw new BadRequestException('kind must be issue|project');
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const table = kind === 'issue' ? pmIssues : pmProjects;
        const [row] = await tx
          .delete(table)
          .where(and(eq(table.id, id), eq(table.tenant_id, tenantId), sql`${table.deleted_at} IS NOT NULL`))
          .returning({ id: table.id });
        if (!row) throw new BadRequestException('Not found in recently deleted');
        await this.audit.log({
          tenantId,
          actorUserId: userId,
          action: `pm.${kind}.purge`,
          resourceType: kind === 'issue' ? 'pm_issue' : 'pm_project',
          resourceId: id,
          metadata: {},
        });
        return { data: { purged: true } };
      },
      userId,
    );
  }
}
