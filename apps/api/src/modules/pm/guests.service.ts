import { Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { pmProjects, pmProjectMembers, memberships, users } from '@flicks/db/schema';
import type { Db } from '@flicks/db';
import { DatabaseService } from '../../core/database/database.service';
import { AuditService } from '../audit/audit.service';
import { DomainEventsService } from '../../core/events/domain-events.service';
import { MembersPublicService } from '../members/public';

/**
 * PM guest seats (round 7): project-scoped external collaborators.
 *
 * The membership side (find-or-create user, external 'guest' membership,
 * {pm: edit} grant, magic-link invite email) lives in the members module and
 * is reached through its public facade; this service owns the
 * pm_project_members rows that define WHAT the guest can see — the
 * visibility layer (PmVisibilityService.scopeTx) reads them.
 */
@Injectable()
export class PmGuestsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly domainEvents: DomainEventsService,
    private readonly membersPublic: MembersPublicService,
  ) {}

  private async loadProject(tx: Db, tenantId: string, id: string) {
    const [project] = await tx
      .select({ id: pmProjects.id, name: pmProjects.name })
      .from(pmProjects)
      .where(
        and(
          eq(pmProjects.id, id),
          eq(pmProjects.tenant_id, tenantId),
          isNull(pmProjects.deleted_at),
        ),
      )
      .limit(1);
    if (!project) throw new NotFoundException('Project not found');
    return project;
  }

  async invite(
    tenantId: string,
    actorUserId: string,
    projectId: string,
    dto: { email: string; full_name?: string },
  ) {
    // Existence-check the DTO-supplied project id INSIDE the tenant context
    // before anything else (FK checks bypass RLS — house rule #2).
    const project = await this.db.withTenant(tenantId, (tx) =>
      this.loadProject(tx, tenantId, projectId),
    );

    const invite = await this.membersPublic.inviteExternalGuest(
      tenantId,
      actorUserId,
      { email: dto.email, fullName: dto.full_name, projectName: project.name },
    );

    await this.db.withTenant(tenantId, async (tx) => {
      await tx
        .insert(pmProjectMembers)
        .values({
          tenant_id: tenantId,
          project_id: projectId,
          user_id: invite.userId,
        })
        .onConflictDoNothing();

      await this.domainEvents.publish(
        {
          name: 'pm.project.member_added',
          tenantId,
          actorUserId,
          payload: {
            project_id: projectId,
            user_id: invite.userId,
            sync: [{ t: 'pm_project_members', id: projectId }],
          },
        },
        tx,
      );
    });

    await this.audit.log({
      tenantId,
      actorUserId,
      action: 'pm.project.guest_invited',
      resourceType: 'pm_project',
      resourceId: projectId,
      afterState: { email: dto.email.toLowerCase().trim() },
    });

    return {
      data: {
        userId: invite.userId,
        status: invite.status,
        magicLinkSent: invite.magicLinkSent,
      },
    };
  }

  async list(tenantId: string, projectId: string) {
    const rows = await this.db.withTenant(tenantId, async (tx) => {
      await this.loadProject(tx, tenantId, projectId);
      return tx
        .select({
          userId: pmProjectMembers.user_id,
          addedAt: pmProjectMembers.created_at,
          email: users.email,
          fullName: users.full_name,
          avatarUrl: users.avatar_url,
          role: memberships.role,
          status: memberships.status,
          invitedAt: memberships.invited_at,
        })
        .from(pmProjectMembers)
        .innerJoin(users, eq(pmProjectMembers.user_id, users.id))
        .innerJoin(
          memberships,
          and(
            eq(memberships.user_id, pmProjectMembers.user_id),
            eq(memberships.tenant_id, tenantId),
          ),
        )
        .where(
          and(
            eq(pmProjectMembers.tenant_id, tenantId),
            eq(pmProjectMembers.project_id, projectId),
            eq(memberships.role, 'guest'),
          ),
        )
        .orderBy(pmProjectMembers.created_at);
    });
    return { data: rows, total: rows.length };
  }

  async revoke(
    tenantId: string,
    actorUserId: string,
    projectId: string,
    guestUserId: string,
  ) {
    const remaining = await this.db.withTenant(tenantId, async (tx) => {
      await this.loadProject(tx, tenantId, projectId);

      await tx
        .delete(pmProjectMembers)
        .where(
          and(
            eq(pmProjectMembers.tenant_id, tenantId),
            eq(pmProjectMembers.project_id, projectId),
            eq(pmProjectMembers.user_id, guestUserId),
          ),
        );

      const [row] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(pmProjectMembers)
        .where(
          and(
            eq(pmProjectMembers.tenant_id, tenantId),
            eq(pmProjectMembers.user_id, guestUserId),
          ),
        );

      await this.domainEvents.publish(
        {
          name: 'pm.project.member_removed',
          tenantId,
          actorUserId,
          payload: {
            project_id: projectId,
            user_id: guestUserId,
            sync: [{ t: 'pm_project_members', id: projectId }],
          },
        },
        tx,
      );

      return Number(row?.count ?? 0);
    });

    // Last project link gone → the guest's membership itself is revoked
    // (facade no-ops for non-guest roles, so a member who happened to be a
    // project member is never deactivated by this path).
    if (remaining === 0) {
      await this.membersPublic.revokeGuestMembership(
        tenantId,
        actorUserId,
        guestUserId,
      );
    }

    await this.audit.log({
      tenantId,
      actorUserId,
      action: 'pm.project.guest_revoked',
      resourceType: 'pm_project',
      resourceId: projectId,
      afterState: { user_id: guestUserId, membership_revoked: remaining === 0 },
    });

    return { data: { removed: true, membershipRevoked: remaining === 0 } };
  }
}
