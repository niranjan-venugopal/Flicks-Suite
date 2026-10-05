import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'crypto';
import * as FileType from 'file-type';
import { and, asc, desc, eq, gt, inArray, isNull, notExists, or, sql } from 'drizzle-orm';
import {
  companyPolicies,
  memberships,
  policyAcknowledgements,
  tenants,
  users,
  POLICY_TARGET_ROLES,
  type PolicyKind,
  type PolicyStatus,
  type PolicyTargetRole,
} from '@flicks/db/schema';
import type { Db } from '@flicks/db';
import type { UserRole } from '@flicks/shared/types';
import { DatabaseService } from '../../core/database/database.service';
import { R2Service } from '../../core/storage/r2.service';
import { ModuleAccessService, type AccessLevel } from '../../core/auth/module-access.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { cleanMarkdown } from '../pm/public';
import {
  POLICY_BODY_MAX_LEN,
  type AcknowledgePolicyDto,
  type CreatePolicyDto,
  type PublishPolicyDto,
  type UpdatePolicyDto,
} from './policies.dto';

/**
 * Company policies (Round P R3).
 *
 * HR/Owner — or any seat the Owner grants the 'policies' module — writes a
 * policy as rich text (markdown, cleaned by the PM cleaner) or uploads a PDF,
 * publishes it and "asks employees to agree": the web shows a BLOCKING gate at
 * the member's next sign-in (PolicyGate, after the terms re-acceptance gate)
 * plus a step in self-onboarding. HR sees who signed / who is pending and can
 * remind (one reminder per policy per hour).
 *
 * Doctrine:
 *  - Every tenant read/write runs in withTenant with an explicit tenant
 *    predicate; the caller's membership (liveness + LIVE role) is read inside
 *    the same transaction, never trusted from the JWT.
 *  - "Applies to me" = my LIVE membership role ∈ applies_to_roles, where
 *    NULL means every standard role (owner/admin/manager/finance/employee).
 *    guest / auditor / fam / super_admin seats are never asked. LIVE means
 *    status 'active' AND access_expires_at unset or in the future — the same
 *    liveness the PoliciesGrantGuard applies, so a seat the guard turns away
 *    is never counted as pending, reminded or asked to agree.
 *  - "Pending for me" = published ∧ requires_acknowledgement ∧ applies to me ∧
 *    no acknowledgement row for (policy, CURRENT version, me).
 *  - version moves ONLY on publish-with-reacknowledgement; editing the body or
 *    replacing the PDF of a published policy keeps the version (and existing
 *    acknowledgements) until HR re-publishes with the flag. Because those
 *    edits are live immediately, a PUBLISHED policy can never be patched into
 *    an unreadable state (pdf without a file / rich text without a body) —
 *    the blocking gate would otherwise trap every applicable member.
 *  - No network inside a tenant transaction: the R2 put happens before the
 *    row update, signed URLs are minted after the transaction, and the
 *    publish / remind fan-out (in-app + email, best-effort) runs after commit.
 *  - Counts and the acknowledgement roster are single queries (no N+1).
 */

export type PolicyRow = typeof companyPolicies.$inferSelect;
type MembershipRole = (typeof memberships.$inferSelect)['role'];

export interface Policy {
  id: string;
  title: string;
  category: string | null;
  kind: PolicyKind;
  version: number;
  status: PolicyStatus;
  requires_acknowledgement: boolean;
  applies_to_roles: string[] | null;
  published_at: string | null;
  archived_at: string | null;
  updated_at: string;
  file_name: string | null;
  file_size_bytes: number | null;
  /** Acknowledgements of the CURRENT version by applicable ACTIVE members (archived/draft → 0). */
  signed_count: number;
  /** Applicable ACTIVE members still to agree to the CURRENT version (archived/draft/not required → 0). */
  pending_count: number;
  /** When HR last sent a reminder for the CURRENT version (the 1/hour throttle marker; a version bump clears it); null = never. */
  last_reminded_at: string | null;
}

export interface PolicyDetail extends Policy {
  body_md: string | null;
  /** 15-minute signed GET for PDF policies; null for rich text or when storage is unconfigured. */
  file_url: string | null;
}

export interface PendingPolicy {
  id: string;
  title: string;
  category: string | null;
  kind: PolicyKind;
  version: number;
  published_at: string | null;
  body_md: string | null;
  file_url: string | null;
}

export interface AckMember {
  user_id: string;
  name: string;
  email: string;
  role: string;
}

export interface PolicyActor {
  userId: string;
  tenantId: string;
  membershipId?: string;
  role: UserRole;
}

export interface PolicyUpload {
  buffer: Buffer;
  originalname?: string;
}

export const POLICY_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const POLICY_FILE_URL_TTL_S = 15 * 60;
export const POLICY_REMIND_INTERVAL_MS = 60 * 60 * 1000;

/** Seats that are never asked to agree (and never see /policies/pending). */
const SELF_SERVICE_EXCLUDED_ROLES: ReadonlySet<string> = new Set(['guest', 'auditor', 'fam', 'super_admin']);
const STANDARD_ROLES: readonly string[] = POLICY_TARGET_ROLES;
const STANDARD_ROLES_SQL = sql`ARRAY['owner','admin','manager','finance','employee']::text[]`;
const FAN_OUT_CONCURRENCY = 5;

const iso = (d: Date | string | null | undefined): string | null =>
  d == null ? null : d instanceof Date ? d.toISOString() : new Date(d).toISOString();

/** Does the policy apply to a member holding this role? */
export function policyAppliesToRole(policy: Pick<PolicyRow, 'applies_to_roles'>, role: string): boolean {
  if (SELF_SERVICE_EXCLUDED_ROLES.has(role)) return false;
  return policy.applies_to_roles === null ? STANDARD_ROLES.includes(role) : policy.applies_to_roles.includes(role);
}

/** Display name for the stored PDF: control chars + path separators out, ≤ 255, never empty. */
function displayFileName(name: string | undefined): string {
  const cleaned = (name ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/]+/g, '_')
    .trim()
    .slice(0, 255);
  return cleaned || 'policy.pdf';
}

/**
 * RFC 4180 cell: quote when the value has a comma, quote or newline, and
 * neutralise spreadsheet formula triggers (=, +, -, @, tab, CR) with a
 * leading apostrophe — names are member-editable free text and Excel runs
 * formulas found in CSV cells (CWE-1236; same convention as fam-billing).
 */
function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Live seat: active AND (no access window OR the window is still open) — mirrors ModuleAccessService.loadContext. */
function liveMembershipWhere() {
  return and(
    eq(memberships.status, 'active'),
    or(isNull(memberships.access_expires_at), gt(memberships.access_expires_at, sql`now()`)),
  );
}
const LIVE_MEMBERSHIP_SQL = sql`m.status = 'active' AND (m.access_expires_at IS NULL OR m.access_expires_at > now())`;

/** Does the row read by callerMembershipTx describe a live seat? */
function isLiveMembership(m: { status: string; access_expires_at: Date | null } | null): boolean {
  return !!m && m.status === 'active' && (!m.access_expires_at || new Date(m.access_expires_at).getTime() > Date.now());
}

/** publish() content rule, shared with update(): a pdf needs its file, rich text needs a body. */
function hasReadableContent(row: Pick<PolicyRow, 'kind' | 'body_md' | 'file_key'>): boolean {
  return row.kind === 'pdf' ? !!row.file_key : !!row.body_md?.trim();
}

@Injectable()
export class PoliciesService {
  private readonly logger = new Logger(PoliciesService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly r2: R2Service,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
    private readonly access: ModuleAccessService,
    private readonly config: ConfigService,
  ) {}

  // ─── Shared helpers ────────────────────────────────────────────────────────

  /** Markdown cleaned by the PM cleaner (scripts/tags/javascript: links out; ≤ 100 000 chars). */
  private cleanBody(input: string | null | undefined): string | null {
    if (input == null) return null;
    return cleanMarkdown(input, { maxLen: POLICY_BODY_MAX_LEN, label: 'Policy text' }) || null;
  }

  /** null / [] → every standard role; otherwise the de-duplicated list in canonical order. */
  private normalizeRoles(input: PolicyTargetRole[] | null | undefined): string[] | null {
    if (!input || input.length === 0) return null;
    const wanted = new Set<string>(input);
    return STANDARD_ROLES.filter((r) => wanted.has(r));
  }

  /** SHA-256(ip + server salt) — never the raw IP (consent-ledger convention). */
  ipHash(ip?: string | null): string | null {
    if (!ip) return null;
    const salt = this.config.get<string>('JWT_SECRET') ?? 'flicks-consent';
    return createHash('sha256').update(`${ip}${salt}`).digest('hex');
  }

  private appUrl(): string {
    return (this.config.get<string>('APP_URL') ?? 'http://localhost:3000').replace(/\/+$/, '');
  }

  /** 15-minute signed GET for a PDF key; null when storage is unconfigured or signing fails (read paths never 503). */
  private async signedFileUrl(row: Pick<PolicyRow, 'kind' | 'file_key'>): Promise<string | null> {
    if (row.kind !== 'pdf' || !row.file_key || !this.r2.isConfigured()) return null;
    try {
      return await this.r2.signedGetUrl(row.file_key, POLICY_FILE_URL_TTL_S);
    } catch (err) {
      this.logger.warn(`Signing policy file ${row.file_key} failed: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  /**
   * Manage level for the caller ('none' | 'view' | 'edit') — the same
   * resolution the PoliciesGrantGuard uses, so GET /policies/:id can let a
   * view-grant holder open any status while a plain member only opens what
   * applies to them. Any failure reads as 'none' (the stricter branch).
   */
  private async manageLevel(actor: PolicyActor): Promise<AccessLevel> {
    try {
      const res = await this.access.resolve(actor.tenantId, actor.membershipId, actor.role, 'policies', actor.userId);
      return res.moduleEnabled && res.membershipActive ? res.level : 'none';
    } catch (err) {
      this.logger.warn(`policies access resolve failed: ${err instanceof Error ? err.message : err}`);
      return 'none';
    }
  }

  /** The caller's membership in this tenant (LIVE role + liveness) — read inside the tx, never from the JWT. */
  private async callerMembershipTx(tx: Db, tenantId: string, userId: string) {
    const [m] = await tx
      .select({
        id: memberships.id,
        role: memberships.role,
        status: memberships.status,
        access_expires_at: memberships.access_expires_at,
        employee_id: memberships.employee_id,
      })
      .from(memberships)
      .where(and(eq(memberships.tenant_id, tenantId), eq(memberships.user_id, userId)))
      .limit(1);
    return m ?? null;
  }

  /**
   * Policies with their signed / pending counts for the CURRENT version in ONE
   * query (two correlated counts over active memberships in the applicable
   * roles). `where` always carries the tenant predicate.
   */
  private async selectWithCounts(tx: Db, tenantId: string, extra?: ReturnType<typeof eq>) {
    // Drizzle strips the table qualifier from columns inside sql`` chunks of a
    // single-table select list, which makes "id" ambiguous inside these
    // correlated subqueries — so the outer row is referenced by raw name.
    const outer = (col: 'id' | 'version' | 'tenant_id' | 'applies_to_roles') =>
      sql.raw(`"company_policies"."${col}"`);
    const applicable = sql`coalesce(${outer('applies_to_roles')}, ${STANDARD_ROLES_SQL})`;
    const where = extra ? and(eq(companyPolicies.tenant_id, tenantId), extra) : eq(companyPolicies.tenant_id, tenantId);
    return tx
      .select({
        row: companyPolicies,
        applicable: sql<string>`(
          SELECT count(*) FROM ${memberships} m
          WHERE m.tenant_id = ${outer('tenant_id')}
            AND ${LIVE_MEMBERSHIP_SQL}
            AND m.role::text = ANY(${applicable})
        )`,
        signed: sql<string>`(
          SELECT count(*) FROM ${memberships} m
          JOIN ${policyAcknowledgements} a
            ON a.tenant_id = m.tenant_id
           AND a.user_id = m.user_id
           AND a.policy_id = ${outer('id')}
           AND a.policy_version = ${outer('version')}
          WHERE m.tenant_id = ${outer('tenant_id')}
            AND ${LIVE_MEMBERSHIP_SQL}
            AND m.role::text = ANY(${applicable})
        )`,
      })
      .from(companyPolicies)
      .where(where)
      .orderBy(
        sql`CASE ${companyPolicies.status} WHEN 'published' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END`,
        desc(companyPolicies.updated_at),
      );
  }

  private toPolicy(row: PolicyRow, applicable: string | number, signed: string | number): Policy {
    const published = row.status === 'published';
    const signedCount = published ? Number(signed) : 0;
    const pendingCount =
      published && row.requires_acknowledgement ? Math.max(0, Number(applicable) - signedCount) : 0;
    return {
      id: row.id,
      title: row.title,
      category: row.category,
      kind: row.kind as PolicyKind,
      version: row.version,
      status: row.status as PolicyStatus,
      requires_acknowledgement: row.requires_acknowledgement,
      applies_to_roles: row.applies_to_roles,
      published_at: iso(row.published_at),
      archived_at: iso(row.archived_at),
      updated_at: iso(row.updated_at) ?? new Date().toISOString(),
      file_name: row.file_name,
      file_size_bytes: row.file_size_bytes,
      signed_count: signedCount,
      pending_count: pendingCount,
      last_reminded_at: iso(row.last_reminded_at),
    };
  }

  /** Detail for a policy the caller is already allowed to see (signed URL minted AFTER the tx). */
  private async detail(tenantId: string, id: string, userId?: string): Promise<PolicyDetail> {
    const [hit] = await this.db.withTenant(
      tenantId,
      (tx) => this.selectWithCounts(tx, tenantId, eq(companyPolicies.id, id)),
      userId,
    );
    if (!hit) throw new NotFoundException('Policy not found');
    return {
      ...this.toPolicy(hit.row, hit.applicable, hit.signed),
      body_md: hit.row.body_md,
      file_url: await this.signedFileUrl(hit.row),
    };
  }

  private async loadForWriteTx(tx: Db, tenantId: string, id: string): Promise<PolicyRow> {
    const [row] = await tx
      .select()
      .from(companyPolicies)
      .where(and(eq(companyPolicies.tenant_id, tenantId), eq(companyPolicies.id, id)))
      .limit(1)
      .for('update');
    if (!row) throw new NotFoundException('Policy not found');
    return row;
  }

  /**
   * Roster for a policy version in ONE query: every LIVE member whose role
   * the policy applies to, left-joined to their acknowledgement of that
   * version. Ordered by name for the HR table and the CSV.
   */
  private async rosterTx(tx: Db, tenantId: string, policy: Pick<PolicyRow, 'id' | 'version' | 'applies_to_roles'>) {
    const roles = (policy.applies_to_roles ?? STANDARD_ROLES) as MembershipRole[];
    return tx
      .select({
        user_id: memberships.user_id,
        name: users.full_name,
        email: users.email,
        role: memberships.role,
        acknowledged_at: policyAcknowledgements.acknowledged_at,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.user_id))
      .leftJoin(
        policyAcknowledgements,
        and(
          eq(policyAcknowledgements.tenant_id, memberships.tenant_id),
          eq(policyAcknowledgements.user_id, memberships.user_id),
          eq(policyAcknowledgements.policy_id, policy.id),
          eq(policyAcknowledgements.policy_version, policy.version),
        ),
      )
      .where(and(eq(memberships.tenant_id, tenantId), liveMembershipWhere(), inArray(memberships.role, roles)))
      .orderBy(asc(users.full_name), asc(users.email));
  }

  /** Every applicable LIVE member (the publish audience of an informational policy). */
  private async applicableMembersTx(tx: Db, tenantId: string, policy: Pick<PolicyRow, 'id' | 'version' | 'applies_to_roles'>): Promise<AckMember[]> {
    const roster = await this.rosterTx(tx, tenantId, policy);
    return roster.map((r) => ({ user_id: r.user_id, name: r.name, email: r.email, role: r.role }));
  }

  /** Applicable LIVE members with NO acknowledgement of the policy's current version. */
  private async pendingMembersTx(tx: Db, tenantId: string, policy: Pick<PolicyRow, 'id' | 'version' | 'applies_to_roles'>): Promise<AckMember[]> {
    const roster = await this.rosterTx(tx, tenantId, policy);
    return roster
      .filter((r) => !r.acknowledged_at)
      .map((r) => ({ user_id: r.user_id, name: r.name, email: r.email, role: r.role }));
  }

  private async tenantNameTx(tx: Db, tenantId: string): Promise<string> {
    const [t] = await tx.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    return t?.name ?? 'your company';
  }

  /**
   * Best-effort fan-out AFTER commit: one in-app row (collapsed per policy via
   * groupKey) + one email per recipient, a few at a time. Nothing here can
   * fail the surrounding publish / remind — every send is wrapped, and an
   * email template the notifications module does not (yet) know simply
   * renders its generic fallback.
   *
   * 'published_info' is the first publish of a policy that does NOT require
   * acknowledgement: members still learn it exists (neutral in-app line,
   * same 'policy.published' type), but no "please agree" email goes out.
   */
  private async fanOut(
    kind: 'published' | 'published_info' | 'reminder',
    tenantId: string,
    policy: Pick<PolicyRow, 'id' | 'title'>,
    recipients: AckMember[],
    companyName: string,
  ): Promise<number> {
    if (!recipients.length) return 0;
    const link = `${this.appUrl()}/policies`;
    const inAppType = kind === 'reminder' ? 'policy.reminder' : 'policy.published';
    const message =
      kind === 'published'
        ? `New policy "${policy.title}" needs your acknowledgement`
        : kind === 'published_info'
          ? `New policy "${policy.title}" has been published`
          : `Reminder: please agree to "${policy.title}"`;
    const template = (kind === 'reminder' ? 'policy-reminder' : 'policy-published') as Parameters<
      NotificationsService['sendEmail']
    >[0];
    const sendMail = kind !== 'published_info';
    const props = { policyTitle: policy.title, companyName, link };

    for (let i = 0; i < recipients.length; i += FAN_OUT_CONCURRENCY) {
      const chunk = recipients.slice(i, i + FAN_OUT_CONCURRENCY);
      await Promise.all(
        chunk.map(async (r) => {
          try {
            await this.notifications.createInAppNotification(r.user_id, inAppType, message, '/policies', tenantId, {
              groupKey: `policy:${policy.id}`,
            });
          } catch (err) {
            this.logger.warn(`policy ${kind} in-app to ${r.user_id} failed: ${err instanceof Error ? err.message : err}`);
          }
          if (!sendMail) return;
          try {
            await this.notifications.sendEmail(template, r.email, props, { userId: r.user_id });
          } catch (err) {
            this.logger.warn(`policy ${kind} email to ${r.email} failed: ${err instanceof Error ? err.message : err}`);
          }
        }),
      );
    }
    return recipients.length;
  }

  private async logAudit(dto: Parameters<AuditService['log']>[0]): Promise<void> {
    try {
      await this.audit.log(dto);
    } catch (err) {
      this.logger.warn(`audit ${dto.action} failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // ─── Management (policies:view / policies:edit) ────────────────────────────

  async list(tenantId: string, userId?: string): Promise<{ data: Policy[] }> {
    const rows = await this.db.withTenant(tenantId, (tx) => this.selectWithCounts(tx, tenantId), userId);
    return { data: rows.map((r) => this.toPolicy(r.row, r.applicable, r.signed)) };
  }

  /**
   * One policy. A manage-grant holder (view or edit) opens any status; any
   * other tenant member opens it only when it is published and applies to
   * their LIVE membership role — everything else is a 404 (no existence leak).
   */
  async get(actor: PolicyActor, id: string): Promise<{ data: PolicyDetail }> {
    const level = await this.manageLevel(actor);
    const hit = await this.db.withTenant(
      actor.tenantId,
      async (tx) => {
        const [found] = await this.selectWithCounts(tx, actor.tenantId, eq(companyPolicies.id, id));
        if (!found) return null;
        if (level !== 'none') return found;
        const m = await this.callerMembershipTx(tx, actor.tenantId, actor.userId);
        if (!isLiveMembership(m)) return null;
        if (found.row.status !== 'published' || !policyAppliesToRole(found.row, m!.role)) return null;
        return found;
      },
      actor.userId,
    );
    if (!hit) throw new NotFoundException('Policy not found');
    return {
      data: {
        ...this.toPolicy(hit.row, hit.applicable, hit.signed),
        body_md: hit.row.body_md,
        file_url: await this.signedFileUrl(hit.row),
      },
    };
  }

  async create(tenantId: string, userId: string, dto: CreatePolicyDto): Promise<{ data: PolicyDetail }> {
    const title = dto.title.trim();
    if (!title) throw new BadRequestException('Give the policy a title');
    const bodyMd = this.cleanBody(dto.body_md);
    const row = await this.db.withTenant(
      tenantId,
      async (tx) => {
        const [created] = await tx
          .insert(companyPolicies)
          .values({
            tenant_id: tenantId,
            title,
            category: dto.category?.trim() || null,
            kind: dto.kind,
            body_md: bodyMd,
            requires_acknowledgement: dto.requires_acknowledgement ?? true,
            applies_to_roles: this.normalizeRoles(dto.applies_to_roles),
            created_by: userId,
            updated_by: userId,
          })
          .returning();
        return created!;
      },
      userId,
    );
    await this.logAudit({
      tenantId,
      actorUserId: userId,
      action: 'policy.created',
      resourceType: 'company_policy',
      resourceId: row.id,
      afterState: { title: row.title, kind: row.kind, requires_acknowledgement: row.requires_acknowledgement, applies_to_roles: row.applies_to_roles },
    });
    return { data: await this.detail(tenantId, row.id, userId) };
  }

  /**
   * Edits never move the version: a published policy's body/file change is
   * live under the same version until re-published with the flag. Because it
   * is live at once, a PUBLISHED policy must stay readable after the patch —
   * switching it to 'pdf' before a file exists, or clearing the text of a
   * rich-text policy, is a 400 that names the next step (drafts are free to
   * be incomplete; publish() checks them).
   */
  async update(tenantId: string, userId: string, id: string, dto: UpdatePolicyDto): Promise<{ data: PolicyDetail }> {
    const patch: Partial<typeof companyPolicies.$inferInsert> = {};
    if (dto.title !== undefined) {
      const title = dto.title.trim();
      if (!title) throw new BadRequestException('Give the policy a title');
      patch.title = title;
    }
    if (dto.kind !== undefined) patch.kind = dto.kind;
    if (dto.body_md !== undefined) patch.body_md = this.cleanBody(dto.body_md);
    if (dto.category !== undefined) patch.category = dto.category?.trim() || null;
    if (dto.requires_acknowledgement !== undefined) patch.requires_acknowledgement = dto.requires_acknowledgement;
    if (dto.applies_to_roles !== undefined) patch.applies_to_roles = this.normalizeRoles(dto.applies_to_roles);

    const { before, after } = await this.db.withTenant(
      tenantId,
      async (tx) => {
        const before = await this.loadForWriteTx(tx, tenantId, id);
        if (before.status === 'archived') {
          throw new BadRequestException('Archived policies can’t be edited — create a new policy instead.');
        }
        if (Object.keys(patch).length === 0) return { before, after: before };
        if (before.status === 'published') {
          const resulting = { ...before, ...patch } as Pick<PolicyRow, 'kind' | 'body_md' | 'file_key'>;
          if (!hasReadableContent(resulting)) {
            throw new BadRequestException(
              resulting.kind === 'pdf'
                ? 'Upload the PDF first — uploading switches a published policy to PDF for you.'
                : 'A published policy needs its text — archive it instead if it no longer applies.',
            );
          }
        }
        const [after] = await tx
          .update(companyPolicies)
          .set({ ...patch, updated_by: userId, updated_at: new Date() })
          .where(and(eq(companyPolicies.tenant_id, tenantId), eq(companyPolicies.id, id)))
          .returning();
        return { before, after: after! };
      },
      userId,
    );
    if (after !== before) {
      await this.logAudit({
        tenantId,
        actorUserId: userId,
        action: 'policy.updated',
        resourceType: 'company_policy',
        resourceId: id,
        beforeState: { title: before.title, kind: before.kind, category: before.category, requires_acknowledgement: before.requires_acknowledgement, applies_to_roles: before.applies_to_roles, body_len: before.body_md?.length ?? 0 },
        afterState: { title: after.title, kind: after.kind, category: after.category, requires_acknowledgement: after.requires_acknowledgement, applies_to_roles: after.applies_to_roles, body_len: after.body_md?.length ?? 0 },
        metadata: { fields: Object.keys(patch) },
      });
    }
    return { data: await this.detail(tenantId, id, userId) };
  }

  /** Magic-byte + size validation for a policy PDF (never trusts the client MIME or extension). */
  async validatePdf(buffer: Buffer | undefined): Promise<void> {
    if (!buffer?.length) throw new BadRequestException('Attach the PDF as "file"');
    if (buffer.length > POLICY_FILE_MAX_BYTES) {
      throw new BadRequestException('PDF is too large — maximum size is 10 MB.');
    }
    // file-type throws (End-Of-Stream) on a truncated header — e.g. a PNG
    // signature with nothing behind it — which must read as "not a PDF"
    // (400), never as a server error.
    let kind: { mime: string } | undefined;
    try {
      kind = await FileType.fromBuffer(buffer);
    } catch {
      kind = undefined;
    }
    if (!kind || kind.mime !== 'application/pdf') {
      throw new BadRequestException('Only PDF files are accepted for a policy — export the document as PDF and upload that.');
    }
  }

  /**
   * Replace / set the policy's PDF. Shape (house rule 7): validate → tx1
   * existence → R2 put (outside any tx) → tx2 row update → delete the previous
   * object after commit (best-effort). `kind` becomes 'pdf'.
   */
  async uploadFile(tenantId: string, userId: string, id: string, file: PolicyUpload): Promise<{ data: PolicyDetail }> {
    await this.validatePdf(file.buffer);
    if (!this.r2.isConfigured()) {
      throw new ServiceUnavailableException(
        'File storage is not configured on this server (R2_* env missing), so PDF policies can’t be stored — write the policy as rich text instead.',
      );
    }
    // tx1 — the policy must exist and be editable before anything leaves the server.
    await this.db.withTenant(
      tenantId,
      async (tx) => {
        const row = await this.loadForWriteTx(tx, tenantId, id);
        if (row.status === 'archived') {
          throw new BadRequestException('Archived policies can’t be edited — create a new policy instead.');
        }
      },
      userId,
    );

    const key = `tenants/${tenantId}/policies/${id}/${randomUUID()}.pdf`;
    await this.r2.putObject(key, file.buffer, 'application/pdf', 'private, max-age=900');

    const fileName = displayFileName(file.originalname);
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    let previousKey: string | null = null;
    try {
      await this.db.withTenant(
        tenantId,
        async (tx) => {
          const row = await this.loadForWriteTx(tx, tenantId, id);
          // Re-checked after the put: an archive from another tab between tx1
          // and tx2 must not attach a file to a read-only policy.
          if (row.status === 'archived') {
            throw new BadRequestException('Archived policies can’t be edited — create a new policy instead.');
          }
          previousKey = row.file_key;
          await tx
            .update(companyPolicies)
            .set({
              kind: 'pdf',
              file_key: key,
              file_name: fileName,
              file_size_bytes: file.buffer.length,
              file_sha256: sha256,
              updated_by: userId,
              updated_at: new Date(),
            })
            .where(and(eq(companyPolicies.tenant_id, tenantId), eq(companyPolicies.id, id)));
        },
        userId,
      );
    } catch (err) {
      await this.r2.deleteObjects([key]); // never throws
      throw err;
    }
    if (previousKey && previousKey !== key) await this.r2.deleteObjects([previousKey]);

    await this.logAudit({
      tenantId,
      actorUserId: userId,
      action: 'policy.file_uploaded',
      resourceType: 'company_policy',
      resourceId: id,
      afterState: { file_name: fileName, file_size_bytes: file.buffer.length, file_sha256: sha256 },
      metadata: { replaced: !!previousKey },
    });
    return { data: await this.detail(tenantId, id, userId) };
  }

  /**
   * draft → published (version stays). Already published: with
   * require_reacknowledgement the version bumps and everyone must agree again;
   * without it the current content is re-published under the same version (no
   * new acknowledgements needed — published_at keeps the version's original
   * date so the gate order and the HR list don't move; updated_at marks the
   * republish). 400 when there is nothing to publish.
   * Fan-out (after commit, best-effort) goes to every applicable LIVE member
   * still pending on the resulting version, excluding the publisher. A policy
   * that does not require acknowledgement notifies its audience in-app (no
   * email) on its FIRST publish only, so members learn it exists.
   * A version bump also clears the reminder throttle — nobody has been
   * reminded about the new version yet.
   */
  async publish(tenantId: string, userId: string, id: string, dto: PublishPolicyDto): Promise<{ data: PolicyDetail; notified: number }> {
    const out = await this.db.withTenant(
      tenantId,
      async (tx) => {
        const before = await this.loadForWriteTx(tx, tenantId, id);
        if (before.status === 'archived') {
          throw new BadRequestException('This policy is archived and can’t be published — create a new policy instead.');
        }
        if (!hasReadableContent(before)) {
          throw new BadRequestException(
            before.kind === 'pdf'
              ? 'Upload the policy PDF before publishing.'
              : 'Write the policy text before publishing.',
          );
        }
        const wasPublished = before.status === 'published';
        const bump = wasPublished && dto.require_reacknowledgement === true;
        const newVersion = !wasPublished || bump;
        const now = new Date();
        const [after] = await tx
          .update(companyPolicies)
          .set({
            status: 'published',
            version: bump ? before.version + 1 : before.version,
            published_at: newVersion ? now : before.published_at,
            published_by: newVersion ? userId : before.published_by,
            ...(bump ? { last_reminded_at: null } : {}),
            archived_at: null,
            updated_by: userId,
            updated_at: now,
          })
          .where(and(eq(companyPolicies.tenant_id, tenantId), eq(companyPolicies.id, id)))
          .returning();
        const notRequired = !after!.requires_acknowledgement;
        const audience = notRequired
          ? wasPublished
            ? []
            : await this.applicableMembersTx(tx, tenantId, after!)
          : await this.pendingMembersTx(tx, tenantId, after!);
        const recipients = audience.filter((m) => m.user_id !== userId);
        const companyName = await this.tenantNameTx(tx, tenantId);
        return { before, after: after!, recipients, companyName, bump, wasPublished, notRequired };
      },
      userId,
    );

    await this.logAudit({
      tenantId,
      actorUserId: userId,
      action: 'policy.published',
      resourceType: 'company_policy',
      resourceId: id,
      beforeState: { status: out.before.status, version: out.before.version },
      afterState: { status: 'published', version: out.after.version },
      metadata: { reacknowledgement: out.bump, republish: out.wasPublished && !out.bump, notified: out.recipients.length },
    });
    const notified = await this.fanOut(
      out.notRequired ? 'published_info' : 'published',
      tenantId,
      out.after,
      out.recipients,
      out.companyName,
    );
    return { data: await this.detail(tenantId, id, userId), notified };
  }

  /** Archived policies never appear in /pending and stop counting; idempotent. */
  async archive(tenantId: string, userId: string, id: string): Promise<{ data: PolicyDetail }> {
    const changed = await this.db.withTenant(
      tenantId,
      async (tx) => {
        const before = await this.loadForWriteTx(tx, tenantId, id);
        if (before.status === 'archived') return null;
        await tx
          .update(companyPolicies)
          .set({ status: 'archived', archived_at: new Date(), updated_by: userId, updated_at: new Date() })
          .where(and(eq(companyPolicies.tenant_id, tenantId), eq(companyPolicies.id, id)));
        return before;
      },
      userId,
    );
    if (changed) {
      await this.logAudit({
        tenantId,
        actorUserId: userId,
        action: 'policy.archived',
        resourceType: 'company_policy',
        resourceId: id,
        beforeState: { status: changed.status, version: changed.version },
        afterState: { status: 'archived' },
      });
    }
    return { data: await this.detail(tenantId, id, userId) };
  }

  /**
   * Who signed / who is pending for the CURRENT version, over LIVE
   * memberships in the applicable roles (never guest/auditor). The pending
   * list is empty unless the policy is published and requires acknowledgement;
   * the signed list stays visible on an archived policy (compliance history).
   */
  async acknowledgements(tenantId: string, id: string, userId?: string) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const [policy] = await tx
          .select()
          .from(companyPolicies)
          .where(and(eq(companyPolicies.tenant_id, tenantId), eq(companyPolicies.id, id)))
          .limit(1);
        if (!policy) throw new NotFoundException('Policy not found');
        const roster = await this.rosterTx(tx, tenantId, policy);
        const asksForAcks = policy.status === 'published' && policy.requires_acknowledgement;
        const signed = roster
          .filter((r) => !!r.acknowledged_at)
          .map((r) => ({ user_id: r.user_id, name: r.name, email: r.email, role: r.role as string, acknowledged_at: iso(r.acknowledged_at)! }));
        const pending = asksForAcks
          ? roster.filter((r) => !r.acknowledged_at).map((r) => ({ user_id: r.user_id, name: r.name, email: r.email, role: r.role as string }))
          : [];
        return { data: { version: policy.version, signed, pending } };
      },
      userId,
    );
  }

  /** CSV (UTF-8 BOM for Excel): name,email,role,status,acknowledged_at — signed rows first. */
  async acknowledgementsCsv(tenantId: string, id: string, userId?: string): Promise<string> {
    const { data } = await this.acknowledgements(tenantId, id, userId);
    const lines = [
      ['name', 'email', 'role', 'status', 'acknowledged_at'],
      ...data.signed.map((s) => [s.name, s.email, s.role, 'signed', s.acknowledged_at]),
      ...data.pending.map((p) => [p.name, p.email, p.role, 'pending', '']),
    ];
    return '﻿' + lines.map((l) => l.map(csvCell).join(',')).join('\n') + '\n';
  }

  /**
   * Nudge everyone still pending (in-app + email, after commit, best-effort),
   * at most once per hour per policy — the marker is company_policies.
   * last_reminded_at, set only when at least one reminder actually goes out
   * (and cleared by a version bump). "Everyone" includes the caller when they
   * are pending themselves, so `reminded` always equals the Pending tab.
   */
  async remind(tenantId: string, userId: string, id: string): Promise<{ data: { reminded: number } }> {
    const out = await this.db.withTenant(
      tenantId,
      async (tx) => {
        const policy = await this.loadForWriteTx(tx, tenantId, id);
        if (policy.status !== 'published' || !policy.requires_acknowledgement) {
          throw new BadRequestException('Reminders go out for published policies that require acknowledgement.');
        }
        if (policy.last_reminded_at && Date.now() - new Date(policy.last_reminded_at).getTime() < POLICY_REMIND_INTERVAL_MS) {
          throw new HttpException(
            { code: 'REMIND_TOO_SOON', message: 'A reminder went out less than an hour ago' },
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }
        const pending = await this.pendingMembersTx(tx, tenantId, policy);
        if (pending.length) {
          await tx
            .update(companyPolicies)
            .set({ last_reminded_at: new Date() })
            .where(and(eq(companyPolicies.tenant_id, tenantId), eq(companyPolicies.id, id)));
        }
        const companyName = await this.tenantNameTx(tx, tenantId);
        return { policy, pending, companyName };
      },
      userId,
    );
    if (!out.pending.length) return { data: { reminded: 0 } };

    await this.logAudit({
      tenantId,
      actorUserId: userId,
      action: 'policy.reminded',
      resourceType: 'company_policy',
      resourceId: id,
      metadata: { version: out.policy.version, reminded: out.pending.length },
    });
    const reminded = await this.fanOut('reminder', tenantId, out.policy, out.pending, out.companyName);
    return { data: { reminded } };
  }

  // ─── Self-service (any live tenant member) ─────────────────────────────────

  /**
   * Published policies that require acknowledgement, apply to the caller's
   * LIVE membership role and have no acknowledgement for the current version,
   * oldest publication first — exactly what the PolicyGate and the onboarding
   * step walk through. Guest / auditor / platform seats, and inactive
   * memberships, get [].
   */
  async pendingForUser(tenantId: string, userId: string): Promise<{ data: PendingPolicy[] }> {
    const rows = await this.db.withTenant(
      tenantId,
      async (tx) => {
        const m = await this.callerMembershipTx(tx, tenantId, userId);
        if (!isLiveMembership(m) || SELF_SERVICE_EXCLUDED_ROLES.has(m!.role)) return [];
        return tx
          .select()
          .from(companyPolicies)
          .where(
            and(
              eq(companyPolicies.tenant_id, tenantId),
              eq(companyPolicies.status, 'published'),
              eq(companyPolicies.requires_acknowledgement, true),
              sql`(${companyPolicies.applies_to_roles} IS NULL OR ${m!.role}::text = ANY(${companyPolicies.applies_to_roles}))`,
              notExists(
                tx
                  .select({ one: sql`1` })
                  .from(policyAcknowledgements)
                  .where(
                    and(
                      eq(policyAcknowledgements.tenant_id, tenantId),
                      eq(policyAcknowledgements.policy_id, companyPolicies.id),
                      eq(policyAcknowledgements.policy_version, companyPolicies.version),
                      eq(policyAcknowledgements.user_id, userId),
                    ),
                  ),
              ),
            ),
          )
          .orderBy(asc(companyPolicies.published_at), asc(companyPolicies.created_at));
      },
      userId,
    );
    const data: PendingPolicy[] = [];
    for (const row of rows) {
      data.push({
        id: row.id,
        title: row.title,
        category: row.category,
        kind: row.kind as PolicyKind,
        version: row.version,
        published_at: iso(row.published_at),
        body_md: row.body_md,
        file_url: await this.signedFileUrl(row),
      });
    }
    return { data };
  }

  /**
   * Record "I have read and agree" for the CURRENT version. Idempotent (ON
   * CONFLICT DO NOTHING on the per-version unique); 409 POLICY_VERSION_STALE
   * when the member read an older version; 404 when the policy is not
   * published or does not apply to the caller's live role.
   */
  async acknowledge(
    tenantId: string,
    userId: string,
    id: string,
    dto: AcknowledgePolicyDto,
    ctx: { ip?: string | null; userAgent?: string | null } = {},
  ): Promise<{ data: { policy_id: string; version: number; acknowledged_at: string } }> {
    const out = await this.db.withTenant(
      tenantId,
      async (tx) => {
        const m = await this.callerMembershipTx(tx, tenantId, userId);
        if (!isLiveMembership(m) || SELF_SERVICE_EXCLUDED_ROLES.has(m!.role)) {
          throw new NotFoundException('Policy not found');
        }
        const [policy] = await tx
          .select()
          .from(companyPolicies)
          .where(and(eq(companyPolicies.tenant_id, tenantId), eq(companyPolicies.id, id)))
          .limit(1);
        if (!policy || policy.status !== 'published' || !policyAppliesToRole(policy, m!.role)) {
          throw new NotFoundException('Policy not found');
        }
        if (dto.version !== policy.version) {
          throw new HttpException(
            { code: 'POLICY_VERSION_STALE', message: 'This policy was updated — please read the new version' },
            HttpStatus.CONFLICT,
          );
        }
        const inserted = await tx
          .insert(policyAcknowledgements)
          .values({
            tenant_id: tenantId,
            policy_id: policy.id,
            policy_version: policy.version,
            user_id: userId,
            employee_id: m!.employee_id ?? null,
            ip_hash: this.ipHash(ctx.ip),
            user_agent: ctx.userAgent?.trim().slice(0, 200) || null,
          })
          .onConflictDoNothing({
            target: [
              policyAcknowledgements.tenant_id,
              policyAcknowledgements.policy_id,
              policyAcknowledgements.policy_version,
              policyAcknowledgements.user_id,
            ],
          })
          .returning({ id: policyAcknowledgements.id });
        const [ack] = await tx
          .select({ acknowledged_at: policyAcknowledgements.acknowledged_at })
          .from(policyAcknowledgements)
          .where(
            and(
              eq(policyAcknowledgements.tenant_id, tenantId),
              eq(policyAcknowledgements.policy_id, policy.id),
              eq(policyAcknowledgements.policy_version, policy.version),
              eq(policyAcknowledgements.user_id, userId),
            ),
          )
          .limit(1);
        return { policy, acknowledgedAt: ack!.acknowledged_at, fresh: inserted.length > 0, employeeId: m!.employee_id ?? null };
      },
      userId,
    );
    if (out.fresh) {
      await this.logAudit({
        tenantId,
        actorUserId: userId,
        actorEmployeeId: out.employeeId ?? undefined,
        action: 'policy.acknowledged',
        resourceType: 'company_policy',
        resourceId: id,
        afterState: { version: out.policy.version },
        ipAddress: ctx.ip ?? undefined,
        userAgent: ctx.userAgent ?? undefined,
      });
    }
    return {
      data: { policy_id: id, version: out.policy.version, acknowledged_at: iso(out.acknowledgedAt)! },
    };
  }

  /** Every version the caller ever acknowledged in this workspace, newest first. */
  async myHistory(tenantId: string, userId: string) {
    const rows = await this.db.withTenant(
      tenantId,
      (tx) =>
        tx
          .select({
            policy_id: policyAcknowledgements.policy_id,
            title: companyPolicies.title,
            version: policyAcknowledgements.policy_version,
            acknowledged_at: policyAcknowledgements.acknowledged_at,
          })
          .from(policyAcknowledgements)
          .innerJoin(
            companyPolicies,
            and(eq(companyPolicies.id, policyAcknowledgements.policy_id), eq(companyPolicies.tenant_id, tenantId)),
          )
          .where(and(eq(policyAcknowledgements.tenant_id, tenantId), eq(policyAcknowledgements.user_id, userId)))
          .orderBy(desc(policyAcknowledgements.acknowledged_at)),
      userId,
    );
    return { data: rows.map((r) => ({ ...r, acknowledged_at: iso(r.acknowledged_at)! })) };
  }

  // ─── Data-export facade (consumed via public.ts by consent/data-export) ────

  /** Personal export: the caller's acknowledgements (policy title, version, when). */
  async exportForUser(tenantId: string, userId: string): Promise<Array<{ policy_title: string; version: number; acknowledged_at: string }>> {
    const { data } = await this.myHistory(tenantId, userId);
    return data.map((r) => ({ policy_title: r.title, version: r.version, acknowledged_at: r.acknowledged_at }));
  }

  /** Org export: every policy (flat) + every acknowledgement with the signer's name/email. */
  async exportForTenant(tenantId: string): Promise<{
    policies: Array<Record<string, unknown>>;
    acknowledgements: Array<Record<string, unknown>>;
  }> {
    return this.db.withTenant(tenantId, async (tx) => {
      const policies = await tx
        .select()
        .from(companyPolicies)
        .where(eq(companyPolicies.tenant_id, tenantId))
        .orderBy(asc(companyPolicies.created_at));
      const acks = await tx
        .select({
          policy_id: policyAcknowledgements.policy_id,
          policy_title: companyPolicies.title,
          policy_version: policyAcknowledgements.policy_version,
          user_id: policyAcknowledgements.user_id,
          user_name: users.full_name,
          user_email: users.email,
          employee_id: policyAcknowledgements.employee_id,
          acknowledged_at: policyAcknowledgements.acknowledged_at,
        })
        .from(policyAcknowledgements)
        .innerJoin(
          companyPolicies,
          and(eq(companyPolicies.id, policyAcknowledgements.policy_id), eq(companyPolicies.tenant_id, tenantId)),
        )
        .innerJoin(users, eq(users.id, policyAcknowledgements.user_id))
        .where(eq(policyAcknowledgements.tenant_id, tenantId))
        .orderBy(asc(policyAcknowledgements.acknowledged_at));
      return {
        policies: policies.map((p) => ({
          id: p.id,
          title: p.title,
          category: p.category,
          kind: p.kind,
          version: p.version,
          status: p.status,
          requires_acknowledgement: p.requires_acknowledgement,
          applies_to_roles: p.applies_to_roles ? p.applies_to_roles.join('|') : 'all',
          file_name: p.file_name,
          published_at: iso(p.published_at),
          archived_at: iso(p.archived_at),
          created_at: iso(p.created_at),
          updated_at: iso(p.updated_at),
          body_md: p.body_md,
        })),
        acknowledgements: acks.map((a) => ({ ...a, acknowledged_at: iso(a.acknowledged_at) })),
      };
    });
  }
}
