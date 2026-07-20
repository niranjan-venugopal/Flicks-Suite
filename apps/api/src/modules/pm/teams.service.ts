import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import {
  pmTeams,
  pmTeamMemberships,
  pmTeamCounters,
  pmWorkflowStates,
  pmLabels,
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
        return {
          data: {
            teams,
            memberships: mine,
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
}
