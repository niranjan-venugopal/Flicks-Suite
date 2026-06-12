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
  tenants,
  users,
} from '@flicks/db/schema';
import { DB_SERVICE_ROLE } from '../../core/database/database.module';
import type { DbAdmin } from '@flicks/db';
import { DatabaseService } from '../../core/database/database.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuthService } from '../auth/auth.service';
import type { GrantInputDto, InviteAuditorDto, UpdateGrantsDto } from './members.dto';

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
    };
    return grants
      .map((g) => `${label[g.module] ?? g.module} (${g.access_level})`)
      .join(' · ');
  }

  // ─── Seats (PRD §13.3 Q3 — auditors are non-billable) ─────────────────────

  async seats(tenantId: string) {
    const [row] = await this.dbAdmin
      .select({
        billable: sql<number>`count(*) filter (where ${memberships.role} <> 'auditor' and ${memberships.status} = 'active')`,
        auditors: sql<number>`count(*) filter (where ${memberships.role} = 'auditor' and ${memberships.status} = 'active')`,
        pendingInvites: sql<number>`count(*) filter (where ${memberships.status} = 'invited')`,
      })
      .from(memberships)
      .where(eq(memberships.tenant_id, tenantId));

    return {
      data: {
        billable: Number(row?.billable ?? 0),
        auditors: Number(row?.auditors ?? 0),
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

    if (rows.length === 0) return { data: [] };

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
