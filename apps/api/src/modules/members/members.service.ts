import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  invoices,
  membershipGrants,
  memberships,
  tenantRoleModuleDefaults,
  tenants,
  users,
} from '@flicks/db/schema';
import { DB_SERVICE_ROLE } from '../../core/database/database.module';
import type { DbAdmin } from '@flicks/db';
import { DatabaseService } from '../../core/database/database.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuthService } from '../auth/auth.service';
import { ModuleAccessService } from '../../core/auth/module-access.service';
import type { UserRole } from '@flicks/shared/types';
import type { GrantModule } from '../../core/auth/decorators/require-grant.decorator';
import {
  MANAGED_MODULES,
  POLICY_ROLES,
  type GrantInputDto,
  type InviteAuditorDto,
  type UpdateGrantsDto,
  type UpdateRoleDefaultsDto,
  type UpsertGrantDto,
} from './members.dto';

/**
 * Auditor membership + grants (PRD §3, §4.4).
 *
 * Auditors are finance-scoped, multi-company and non-billable: one user row,
 * one membership per company they review, with `membership_grants` rows that
 * the InvoicingGrantGuard consults instead of the role hierarchy. Seat
 * counting (`WHERE role <> 'auditor'`) keeps them off the bill.
 *
 * Cross-tenant operations (find-or-create the invitee's user row, My
 * Companies) run on the service-role connection — at invite time the invitee
 * may belong to other tenants, and My Companies is by definition a
 * cross-tenant listing keyed strictly to the caller's own user_id (the
 * memberships self-visibility RLS policy remains defence-in-depth).
 */
@Injectable()
export class MembersService {
  // Review-grade defaults per PRD §13.3 Q2 — applied when the invite omits
  // explicit grants.
  private static readonly DEFAULT_AUDITOR_GRANTS: GrantInputDto[] = [
    { module: 'invoicing', access_level: 'view', capabilities: {} },
    { module: 'reports', access_level: 'view', capabilities: {} },
    { module: 'org_financial', access_level: 'view', capabilities: {} },
  ];

  constructor(
    private readonly db: DatabaseService,
    @Inject(DB_SERVICE_ROLE) private readonly dbAdmin: DbAdmin,
    private readonly auditService: AuditService,
    private readonly notificationsService: NotificationsService,
    private readonly authService: AuthService,
    private readonly moduleAccess: ModuleAccessService,
  ) {}

  // ─── Invite ────────────────────────────────────────────────────────────────

  async inviteAuditor(dto: InviteAuditorDto, actorUserId: string, tenantId: string) {
    const normalizedEmail = dto.email.toLowerCase().trim();

    let [user] = await this.dbAdmin
      .select()
      .from(users)
      .where(eq(users.email, normalizedEmail))
      .limit(1);

    if (!user) {
      [user] = await this.dbAdmin
        .insert(users)
        .values({
          email: normalizedEmail,
          full_name: dto.full_name ?? normalizedEmail.split('@')[0],
        })
        .returning();
    }

    const [existing] = await this.dbAdmin
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.user_id, user.id),
          eq(memberships.tenant_id, tenantId),
        ),
      )
      .limit(1);

    if (existing && existing.status !== 'deactivated') {
      throw new ConflictException(
        `${normalizedEmail} already has ${existing.status === 'invited' ? 'a pending invite to' : 'access to'} this workspace`,
      );
    }

    const accessExpiresAt = dto.access_expires_at
      ? new Date(`${dto.access_expires_at}T23:59:59.999Z`)
      : null;

    let membership;
    if (existing) {
      // Re-inviting a previously revoked auditor reuses the row (the
      // (tenant, user) pair is unique).
      [membership] = await this.dbAdmin
        .update(memberships)
        .set({
          role: 'auditor',
          status: 'invited',
          is_external: dto.is_external ?? true,
          access_expires_at: accessExpiresAt,
          invited_by: actorUserId,
          invited_at: new Date(),
          accepted_at: null,
        })
        .where(eq(memberships.id, existing.id))
        .returning();
    } else {
      [membership] = await this.dbAdmin
        .insert(memberships)
        .values({
          tenant_id: tenantId,
          user_id: user.id,
          role: 'auditor',
          status: 'invited',
          is_external: dto.is_external ?? true,
          access_expires_at: accessExpiresAt,
          invited_by: actorUserId,
          invited_at: new Date(),
        })
        .returning();
    }

    const grants = await this.replaceGrants(
      tenantId,
      membership.id,
      dto.grants?.length ? dto.grants : MembersService.DEFAULT_AUDITOR_GRANTS,
    );

    const [tenant] = await this.dbAdmin
      .select({ name: tenants.name })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    const [inviter] = await this.dbAdmin
      .select({ name: users.full_name, email: users.email })
      .from(users)
      .where(eq(users.id, actorUserId))
      .limit(1);

    const magicLinkUrl = await this.authService.issueInviteMagicLink(
      user.id,
      normalizedEmail,
    );

    await this.notificationsService.sendEmail('auditor-invite', normalizedEmail, {
      companyName: tenant?.name ?? 'a company',
      inviterName: inviter?.name ?? inviter?.email ?? 'An administrator',
      scopeSummary: this.scopeSummary(grants),
      note: dto.note,
      accessExpiresAt: dto.access_expires_at,
      magicLinkUrl,
    });

    await this.auditService.log({
      tenantId,
      actorUserId,
      action: 'membership.auditor_invited',
      resourceType: 'membership',
      resourceId: membership.id,
      afterState: {
        email: normalizedEmail,
        grants: grants.map((g) => `${g.module}:${g.access_level}`),
        access_expires_at: dto.access_expires_at ?? null,
      },
    });

    return { data: { membership, grants } };
  }

  // ─── PM guest seats (round 7) ──────────────────────────────────────────────
  // Project-scoped external collaborators. Same mechanics as auditors
  // (find-or-create user, external membership, grant-row-driven module
  // access, magic-link invite) but the grant is {pm: edit} and per-project
  // visibility is enforced by PmVisibilityService. Non-billable.

  async inviteGuest(
    tenantId: string,
    actorUserId: string,
    input: { email: string; fullName?: string; projectName: string },
  ): Promise<{
    userId: string;
    membershipId: string;
    status: 'invited' | 'active';
    magicLinkSent: boolean;
  }> {
    const normalizedEmail = input.email.toLowerCase().trim();

    let [user] = await this.dbAdmin
      .select()
      .from(users)
      .where(eq(users.email, normalizedEmail))
      .limit(1);
    if (!user) {
      [user] = await this.dbAdmin
        .insert(users)
        .values({
          email: normalizedEmail,
          full_name: input.fullName ?? normalizedEmail.split('@')[0],
        })
        .returning();
    }

    const [existing] = await this.dbAdmin
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.user_id, user.id),
          eq(memberships.tenant_id, tenantId),
        ),
      )
      .limit(1);

    // A real member of this workspace never becomes a guest — add their
    // team to the project instead.
    if (
      existing &&
      existing.status !== 'deactivated' &&
      existing.role !== 'guest'
    ) {
      throw new ConflictException(
        `${normalizedEmail} is already a member of this workspace — add their team to the project instead`,
      );
    }

    let membership = existing;
    let magicLinkSent = false;

    if (existing && existing.status !== 'deactivated') {
      // Existing guest (active or invited): membership untouched — the
      // caller just adds another pm_project_members row. Re-send the invite
      // email only while they haven't joined yet.
      magicLinkSent = existing.status === 'invited';
    } else if (existing) {
      // Previously revoked guest — reuse the row (tenant+user is unique).
      [membership] = await this.dbAdmin
        .update(memberships)
        .set({
          role: 'guest',
          status: 'invited',
          is_external: true,
          invited_by: actorUserId,
          invited_at: new Date(),
          accepted_at: null,
        })
        .where(eq(memberships.id, existing.id))
        .returning();
      magicLinkSent = true;
    } else {
      [membership] = await this.dbAdmin
        .insert(memberships)
        .values({
          tenant_id: tenantId,
          user_id: user.id,
          role: 'guest',
          status: 'invited',
          is_external: true,
          invited_by: actorUserId,
          invited_at: new Date(),
        })
        .returning();
      magicLinkSent = true;
    }

    // Grant-row-driven PM access (PmGrantGuard default for guests is 'none').
    await this.replaceGrants(tenantId, membership!.id, [
      { module: 'pm', access_level: 'edit', capabilities: {} },
    ]);

    if (magicLinkSent) {
      try {
        const [tenant] = await this.dbAdmin
          .select({ name: tenants.name })
          .from(tenants)
          .where(eq(tenants.id, tenantId))
          .limit(1);
        const [inviter] = await this.dbAdmin
          .select({ name: users.full_name, email: users.email })
          .from(users)
          .where(eq(users.id, actorUserId))
          .limit(1);
        const magicLinkUrl = await this.authService.issueInviteMagicLink(
          user.id,
          normalizedEmail,
        );
        await this.notificationsService.sendEmail(
          'pm-guest-invite',
          normalizedEmail,
          {
            projectName: input.projectName,
            companyName: tenant?.name ?? 'a company',
            inviterName: inviter?.name ?? inviter?.email ?? 'A teammate',
            magicLinkUrl,
          },
        );
      } catch {
        magicLinkSent = false; // best-effort — the guest can still sign in by email
      }
    }

    await this.auditService.log({
      tenantId,
      actorUserId,
      action: 'membership.guest_invited',
      resourceType: 'membership',
      resourceId: membership!.id,
      afterState: { email: normalizedEmail, project: input.projectName },
    });

    return {
      userId: user.id,
      membershipId: membership!.id,
      status: membership!.status === 'active' ? 'active' : 'invited',
      magicLinkSent,
    };
  }

  /** Deactivate a guest membership (their last project link was removed). */
  async revokeGuestMembership(
    tenantId: string,
    actorUserId: string,
    guestUserId: string,
  ): Promise<void> {
    const [membership] = await this.dbAdmin
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.user_id, guestUserId),
          eq(memberships.tenant_id, tenantId),
          eq(memberships.role, 'guest'),
        ),
      )
      .limit(1);
    if (!membership) return; // not a guest here — nothing to revoke

    await this.dbAdmin
      .update(memberships)
      .set({ status: 'deactivated' })
      .where(eq(memberships.id, membership.id));
    await this.replaceGrants(tenantId, membership.id, []);

    await this.auditService.log({
      tenantId,
      actorUserId,
      action: 'membership.guest_revoked',
      resourceType: 'membership',
      resourceId: membership.id,
    });
  }

  // ─── Grants ────────────────────────────────────────────────────────────────

  async updateGrants(
    membershipId: string,
    dto: UpdateGrantsDto,
    actorUserId: string,
    tenantId: string,
  ) {
    const [membership] = await this.dbAdmin
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.id, membershipId),
          eq(memberships.tenant_id, tenantId),
        ),
      )
      .limit(1);
    if (!membership) throw new NotFoundException('Member not found');

    const before = await this.dbAdmin
      .select()
      .from(membershipGrants)
      .where(eq(membershipGrants.membership_id, membershipId));

    const grants = await this.replaceGrants(tenantId, membershipId, dto.grants);

    await this.auditService.log({
      tenantId,
      actorUserId,
      action: 'membership.grants_changed',
      resourceType: 'membership',
      resourceId: membershipId,
      beforeState: {
        grants: before.map((g) => `${g.module}:${g.access_level}`),
      },
      afterState: {
        grants: grants.map((g) => `${g.module}:${g.access_level}`),
      },
    });

    return { data: { grants } };
  }

  /**
   * Set ONE module for one member (Settings → Module access).
   *
   * Deliberately not the replace-all endpoint: that one deletes every row it
   * is not told about, so a screen showing three modules would silently revoke
   * an auditor's org_financial row or a PM guest's pm:edit row. Writing 'none'
   * stores an explicit row — that is how revocation is expressed now that a
   * row wins over the role default.
   */
  async upsertGrant(
    membershipId: string,
    module: string,
    dto: UpsertGrantDto,
    actorUserId: string,
    tenantId: string,
  ) {
    const membership = await this.assertGrantTarget(membershipId, tenantId);

    const [before] = await this.dbAdmin
      .select()
      .from(membershipGrants)
      .where(
        and(
          eq(membershipGrants.membership_id, membershipId),
          eq(membershipGrants.module, module),
        ),
      )
      .limit(1);

    // 'none' clears capabilities too: a stale {record_payments:true} left on a
    // revoked row would still light up the sidebar's Payments item.
    const capabilities =
      dto.access_level === 'none' ? {} : (dto.capabilities ?? before?.capabilities ?? {});

    const [row] = await this.db.withTenant(tenantId, (tx) =>
      tx
        .insert(membershipGrants)
        .values({
          tenant_id: tenantId,
          membership_id: membershipId,
          module,
          access_level: dto.access_level,
          capabilities,
        })
        .onConflictDoUpdate({
          target: [membershipGrants.membership_id, membershipGrants.module],
          set: {
            access_level: dto.access_level,
            capabilities,
            updated_at: new Date(),
          },
        })
        .returning(),
    );

    await this.auditService.log({
      tenantId,
      actorUserId,
      action: 'membership.grants_changed',
      resourceType: 'membership',
      resourceId: membershipId,
      beforeState: {
        grants: before ? [`${before.module}:${before.access_level}`] : [],
      },
      afterState: { grants: [`${module}:${dto.access_level}`] },
      metadata: { module, role: membership.role },
    });

    return { data: { grant: row } };
  }

  /**
   * Drop a member's explicit row for a module — they fall back to whatever
   * their role gets in this workspace ("Reset to role default").
   */
  async clearGrant(
    membershipId: string,
    module: string,
    actorUserId: string,
    tenantId: string,
  ) {
    await this.assertGrantTarget(membershipId, tenantId);
    await this.db.withTenant(tenantId, (tx) =>
      tx
        .delete(membershipGrants)
        .where(
          and(
            eq(membershipGrants.membership_id, membershipId),
            eq(membershipGrants.module, module),
          ),
        ),
    );
    await this.auditService.log({
      tenantId,
      actorUserId,
      action: 'membership.grants_changed',
      resourceType: 'membership',
      resourceId: membershipId,
      afterState: { grants: [`${module}:role-default`] },
      metadata: { module, cleared: true },
    });
    return { data: { ok: true } };
  }

  /**
   * Members whose grants may be edited here. Guests are excluded on purpose:
   * their pm:edit row IS their project access, it is written by the project
   * invite, and clearing it from Settings would strand them with no way back
   * in except a re-invite.
   */
  private async assertGrantTarget(membershipId: string, tenantId: string) {
    const [membership] = await this.dbAdmin
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.id, membershipId),
          eq(memberships.tenant_id, tenantId),
        ),
      )
      .limit(1);
    if (!membership) throw new NotFoundException('Member not found');
    if (membership.role === 'guest') {
      throw new ConflictException(
        'Guest access is managed from the project they were invited to, not from module access.',
      );
    }
    return membership;
  }

  // ─── Workspace role policy (Settings → Module access → By role) ────────────

  /** Current per-role module policy, including the shipped defaults. */
  async getRoleDefaults(tenantId: string, userId: string) {
    const rows = await this.db.withTenant(
      tenantId,
      (tx) =>
        tx
          .select({
            role: tenantRoleModuleDefaults.role,
            module: tenantRoleModuleDefaults.module,
            accessLevel: tenantRoleModuleDefaults.access_level,
          })
          .from(tenantRoleModuleDefaults)
          .where(eq(tenantRoleModuleDefaults.tenant_id, tenantId)),
      userId,
    );
    const explicit = new Map(
      rows.map((r) => [`${r.role}|${r.module}`, r.accessLevel]),
    );

    const defaults = [];
    for (const role of POLICY_ROLES) {
      for (const module of MANAGED_MODULES) {
        const key = `${role}|${module}`;
        const level = await this.moduleAccess.defaultLevel(
          tenantId,
          role as UserRole,
          module as GrantModule,
          userId,
        );
        defaults.push({
          role,
          module,
          access_level: level,
          is_custom: explicit.has(key),
        });
      }
    }
    return { data: { defaults } };
  }

  /** Replace the workspace's role policy for the modules it names. */
  async updateRoleDefaults(
    dto: UpdateRoleDefaultsDto,
    actorUserId: string,
    tenantId: string,
  ) {
    await this.db.withTenant(
      tenantId,
      async (tx) => {
        for (const d of dto.defaults) {
          await tx
            .insert(tenantRoleModuleDefaults)
            .values({
              tenant_id: tenantId,
              role: d.role,
              module: d.module,
              access_level: d.access_level,
              updated_by: actorUserId,
            })
            .onConflictDoUpdate({
              target: [
                tenantRoleModuleDefaults.tenant_id,
                tenantRoleModuleDefaults.role,
                tenantRoleModuleDefaults.module,
              ],
              set: {
                access_level: d.access_level,
                updated_by: actorUserId,
                updated_at: new Date(),
              },
            });
        }
      },
      actorUserId,
    );
    // The resolver caches the policy for 30s — a Settings save must bite now.
    this.moduleAccess.invalidateTenant(tenantId);

    await this.auditService.log({
      tenantId,
      actorUserId,
      action: 'tenant.role_module_defaults_changed',
      resourceType: 'tenant',
      resourceId: tenantId,
      afterState: {
        defaults: dto.defaults.map(
          (d) => `${d.role}:${d.module}:${d.access_level}`,
        ),
      },
    });

    return this.getRoleDefaults(tenantId, actorUserId);
  }

  /** Replace the full grant set for a membership inside the tenant context. */
  private async replaceGrants(
    tenantId: string,
    membershipId: string,
    inputs: GrantInputDto[],
  ) {
    return this.db.withTenant(tenantId, async (tx) => {
      await tx
        .delete(membershipGrants)
        .where(eq(membershipGrants.membership_id, membershipId));
      const effective = inputs.filter((g) => g.access_level !== 'none');
      if (effective.length === 0) return [];
      return tx
        .insert(membershipGrants)
        .values(
          effective.map((g) => ({
            tenant_id: tenantId,
            membership_id: membershipId,
            module: g.module,
            access_level: g.access_level,
            capabilities: g.capabilities ?? {},
          })),
        )
        .returning();
    });
  }

  private scopeSummary(
    grants: { module: string; access_level: string }[],
  ): string {
    if (grants.length === 0) return 'No modules yet';
    const label: Record<string, string> = {
      invoicing: 'Invoicing',
      reports: 'Reports',
      org_financial: 'Financial details',
      payroll: 'Payroll',
      expenses: 'Expenses',
      crm: 'CRM',
      pm: 'Projects',
    };
    // 'none' rows are explicit revocations, not scopes — an invite email that
    // reads "Invoicing (none)" is worse than saying nothing.
    const granted = grants.filter((g) => g.access_level !== 'none');
    if (granted.length === 0) return 'No modules yet';
    return granted
      .map((g) => `${label[g.module] ?? g.module} (${g.access_level})`)
      .join(' · ');
  }

  // ─── Seats (PRD §13.3 Q3 — auditors & guests are non-billable) ─────────────

  async seats(tenantId: string) {
    const [row] = await this.dbAdmin
      .select({
        billable: sql<number>`count(*) filter (where ${memberships.role} not in ('auditor', 'guest') and ${memberships.status} = 'active')`,
        auditors: sql<number>`count(*) filter (where ${memberships.role} = 'auditor' and ${memberships.status} = 'active')`,
        guests: sql<number>`count(*) filter (where ${memberships.role} = 'guest' and ${memberships.status} = 'active')`,
        pendingInvites: sql<number>`count(*) filter (where ${memberships.status} = 'invited')`,
      })
      .from(memberships)
      .where(eq(memberships.tenant_id, tenantId));

    return {
      data: {
        billable: Number(row?.billable ?? 0),
        auditors: Number(row?.auditors ?? 0),
        guests: Number(row?.guests ?? 0),
        pendingInvites: Number(row?.pendingInvites ?? 0),
      },
    };
  }

  // ─── My Companies (PRD §3.4) ───────────────────────────────────────────────

  async getMyCompanies(userId: string) {
    const rows = await this.dbAdmin
      .select({
        membershipId: memberships.id,
        tenantId: memberships.tenant_id,
        role: memberships.role,
        status: memberships.status,
        isExternal: memberships.is_external,
        accessExpiresAt: memberships.access_expires_at,
        invitedAt: memberships.invited_at,
        name: tenants.name,
        slug: tenants.slug,
        logoUrl: tenants.logo_url,
        gstin: tenants.gstin,
        city: tenants.city,
      })
      .from(memberships)
      .innerJoin(tenants, eq(memberships.tenant_id, tenants.id))
      .where(
        and(
          eq(memberships.user_id, userId),
          inArray(memberships.status, ['active', 'invited']),
        ),
      )
      .orderBy(memberships.created_at);

    // Anyone who doesn't already OWN a workspace may create their own
    // (guests/employees/auditors exploring the product — round 7). Server
    // enforcement lives in onboarding.createTenant; this drives the CTAs.
    const canCreateWorkspace = !rows.some((r) => r.role === 'owner');

    if (rows.length === 0) return { data: [], canCreateWorkspace };

    const membershipIds = rows.map((r) => r.membershipId);
    const tenantIds = rows.map((r) => r.tenantId);

    const grantRows = await this.dbAdmin
      .select()
      .from(membershipGrants)
      .where(inArray(membershipGrants.membership_id, membershipIds));

    // Light per-company pills for the switcher / My Companies rows: overdue
    // count + INR outstanding across receivable statuses.
    const statRows = await this.dbAdmin
      .select({
        tenantId: invoices.tenant_id,
        overdueCount: sql<number>`count(*) filter (where ${invoices.status} = 'OVERDUE')`,
        outstanding: sql<string>`coalesce(sum(${invoices.amount_outstanding}) filter (where ${invoices.status} in ('SENT','VIEWED','PARTIALLY_PAID','OVERDUE') and ${invoices.currency} = 'INR'), 0)`,
      })
      .from(invoices)
      .where(
        and(
          inArray(invoices.tenant_id, tenantIds),
          eq(invoices.document_type, 'INVOICE'),
        ),
      )
      .groupBy(invoices.tenant_id);

    const statsByTenant = new Map(statRows.map((s) => [s.tenantId, s]));
    const grantsByMembership = new Map<string, typeof grantRows>();
    for (const g of grantRows) {
      const list = grantsByMembership.get(g.membership_id) ?? [];
      list.push(g);
      grantsByMembership.set(g.membership_id, list);
    }

    return {
      canCreateWorkspace,
      data: rows.map((r) => {
        const stats = statsByTenant.get(r.tenantId);
        return {
          membershipId: r.membershipId,
          tenantId: r.tenantId,
          name: r.name,
          slug: r.slug,
          logoUrl: r.logoUrl,
          gstin: r.gstin,
          city: r.city,
          role: r.role,
          status: r.status,
          isExternal: r.isExternal,
          accessExpiresAt: r.accessExpiresAt,
          grants: (grantsByMembership.get(r.membershipId) ?? []).map((g) => ({
            module: g.module,
            access_level: g.access_level,
            capabilities: g.capabilities ?? {},
          })),
          stats: {
            overdueCount: Number(stats?.overdueCount ?? 0),
            outstanding: stats?.outstanding ?? '0',
            currency: 'INR',
          },
        };
      }),
    };
  }
}
