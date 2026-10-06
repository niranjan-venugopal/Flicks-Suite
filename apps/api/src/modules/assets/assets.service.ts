import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, asc, desc, eq, ilike, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  assetAssignments,
  assets,
  employees,
  memberships,
  tenants,
  users,
  type AssetCategory,
  type AssetCondition,
  type AssetStatus,
} from '@flicks/db/schema';
import type { Db } from '@flicks/db';
import { DatabaseService } from '../../core/database/database.service';
import { R2Service } from '../../core/storage/r2.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { MediaService } from '../media/public';
import {
  ASSET_LIST_DEFAULT_LIMIT,
  ASSET_LIST_MAX_LIMIT,
  type AssignAssetDto,
  type CreateAssetDto,
  type ListAssetsQueryDto,
  type ReturnAssetDto,
  type UpdateAssetDto,
} from './assets.dto';

/**
 * Company asset register (Round P R4).
 *
 * HR/Owner registers equipment (laptop, phone, SIM, ID card …) with a tag,
 * photo, serial and purchase info, hands it to a person (during onboarding
 * or later), the person acknowledges receipt from "My assets", HR records
 * the return at exit. `assets.status = 'assigned'` is never set by hand: it
 * follows the ONE open `asset_assignments` row (partial unique).
 *
 * Doctrine:
 *  - Every tenant read/write runs in withTenant with an explicit tenant
 *    predicate (rule 1); every id from a DTO (employee_id) is existence-
 *    checked inside the same transaction with the tenant predicate (rule 2)
 *    — a bare FK would accept another tenant's employee.
 *  - Write flows lock the asset row (FOR UPDATE) first, so assign / return /
 *    acknowledge / status changes serialise per asset; the partial unique on
 *    open assignments is the last line of defence (23505 → 409).
 *  - Server-picked tags (blank asset_tag) are allocated under a per-tenant
 *    transaction advisory lock, so two admins adding at once never compute
 *    the same AST-NNNN; the tag unique index stays the backstop and a lost
 *    race is retried rather than surfaced as a 409 the user cannot act on.
 *  - Self-service (My assets / acknowledge) resolves the caller through a
 *    LIVE membership (active, not expired) inside the tx — the JWT guard
 *    only verifies the token.
 *  - No network inside a tenant transaction (rule 7): the photo pipeline is
 *    tx1 load → R2 work → tx2 write → delete the old object after commit;
 *    signed URLs are minted after the transaction; the assign fan-out
 *    (in-app + email) is best-effort after commit and can never fail the
 *    write (rule 6).
 *  - Soft delete (deleted_at) keeps history readable and frees the tag; the
 *    employees module counts assignment history via public.ts so anyone with
 *    equipment history is archived, never hard-deleted.
 */

export type AssetRow = typeof assets.$inferSelect;
type AssignmentRow = typeof assetAssignments.$inferSelect;

export interface AssetAssignmentSummary {
  id: string;
  employee_id: string;
  employee_name: string;
  employee_code: string | null;
  /** Signed avatar URL of the holder (users.avatar_key via the employee's user), when they have one. */
  employee_avatar_url: string | null;
  assigned_at: string;
  assigned_by_name: string | null;
  issue_condition: AssetCondition | null;
  notes: string | null;
  acknowledged_at: string | null;
}

export interface Asset {
  id: string;
  asset_tag: string;
  name: string;
  category: AssetCategory;
  brand: string | null;
  model: string | null;
  serial_number: string | null;
  /** Signed URLs of the 256 / 64 px photo variants; null without a photo. */
  photo_url: string | null;
  photo_thumb_url: string | null;
  purchase_date: string | null;
  /** Decimal string from numeric(15,2), e.g. "54999.00". */
  purchase_value: string | null;
  currency: string;
  condition: AssetCondition;
  status: AssetStatus;
  notes: string | null;
  created_at: string;
  updated_at: string;
  /** The open assignment, or null when nobody holds it. */
  current_assignment: AssetAssignmentSummary | null;
}

export interface AssetHistoryRow extends AssetAssignmentSummary {
  returned_at: string | null;
  returned_by_name: string | null;
  return_condition: AssetCondition | null;
  return_notes: string | null;
}

export interface AssetDetail extends Asset {
  /** Every assignment, newest first (the open one first when present). */
  history: AssetHistoryRow[];
}

export interface AssetsSummary {
  total: number;
  assigned: number;
  in_stock: number;
  under_repair: number;
  retired: number;
  lost: number;
  /** Open assignments the holder has not acknowledged yet. */
  awaiting_acknowledgement: number;
}

export interface MyAsset {
  asset: Omit<Asset, 'current_assignment'>;
  assignment: {
    id: string;
    assigned_at: string;
    assigned_by_name: string | null;
    issue_condition: AssetCondition | null;
    notes: string | null;
    acknowledged_at: string | null;
  };
}

export type EmployeeAssetHistoryRow = AssetHistoryRow & {
  asset_id: string;
  asset_tag: string;
  asset_name: string;
  category: AssetCategory;
};

export interface EmployeeAssets {
  /** Open assignments (what they hold now). */
  current: Asset[];
  /** Returned assignments, newest first. */
  history: EmployeeAssetHistoryRow[];
}

export const ASSET_TAG_PREFIX = 'AST-';
/** A backdated issue is fine; a future one is a typo — allow clock skew of a day. */
const ASSIGNED_AT_FUTURE_GRACE_MS = 24 * 60 * 60 * 1000;
const PG_UNIQUE_VIOLATION = '23505';
/** Photo URLs are short-lived (15 min, like policy PDFs) — the list re-signs on every read. */
export const ASSET_PHOTO_URL_TTL_S = 15 * 60;
/** Server-picked tag: the advisory lock makes a collision all but impossible; the retry covers the rest. */
const TAG_ALLOCATION_ATTEMPTS = 3;

export const ASSETS_CSV_COLUMNS = [
  'asset_tag',
  'name',
  'category',
  'brand',
  'model',
  'serial_number',
  'status',
  'condition',
  'holder_name',
  'holder_code',
  'assigned_at',
  'acknowledged_at',
  'purchase_date',
  'purchase_value',
  'currency',
  'notes',
] as const;

// Aliased joins: the open assignment + its holder (and the holder's user, where
// the photo lives), the issuer and the person who recorded the return.
const openA = alias(assetAssignments, 'open_assignment');
const holder = alias(employees, 'asset_holder');
const holderUser = alias(users, 'asset_holder_user');
const assignedBy = alias(users, 'asset_assigned_by');
const returnedBy = alias(users, 'asset_returned_by');

const iso = (d: Date | string | null | undefined): string | null =>
  d == null ? null : d instanceof Date ? d.toISOString() : new Date(d).toISOString();

const fullName = (first: string | null | undefined, last: string | null | undefined): string =>
  `${first ?? ''} ${last ?? ''}`.trim();

/** Assigned first, then stock, repair, retired, lost — what the register page wants on top. */
const STATUS_ORDER = sql`CASE ${assets.status} WHEN 'assigned' THEN 0 WHEN 'in_stock' THEN 1 WHEN 'under_repair' THEN 2 WHEN 'retired' THEN 3 ELSE 4 END`;

/**
 * RFC 4180 cell: quote when the value has a comma, quote or newline, and
 * neutralise spreadsheet formula triggers (=, +, -, @, tab, CR) with a
 * leading apostrophe — names/notes are free text and Excel runs formulas
 * found in CSV cells (CWE-1236; same convention as policies / fam-billing).
 */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Postgres unique violation on the thrown value or up its `cause` chain (drizzle re-throws with `cause`). */
function uniqueViolation(err: unknown): { constraint: string | null } | null {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    const c = current as { code?: string; constraint?: string; constraint_name?: string; cause?: unknown };
    if (c.code === PG_UNIQUE_VIOLATION) return { constraint: c.constraint_name ?? c.constraint ?? null };
    current = c.cause;
  }
  return null;
}

/** ILIKE pattern with the user's wildcards escaped (the default escape char is `\`). */
function containsPattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, '\\$&')}%`;
}

/**
 * A real calendar date in YYYY-MM-DD (the DTO regex only checks the shape;
 * Postgres would 500 on 2026-13-45). `label` is the product-voice field name
 * for the toast ("Purchase date"), never the wire key.
 */
function normaliseDate(v: string | null | undefined, label: string): string | null {
  if (v == null) return null;
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) {
    throw new BadRequestException(`${label} isn’t a real calendar date (use YYYY-MM-DD)`);
  }
  return v;
}

const tagTaken = (tag: string) =>
  new ConflictException({ code: 'ASSET_TAG_TAKEN', message: `Asset tag ${tag} is already in use` });
const tagAllocationFailed = () =>
  new ConflictException({
    code: 'ASSET_TAG_ALLOCATION_FAILED',
    message: 'Couldn’t allocate the next asset tag — please try again',
  });
const assetAssigned = () => new ConflictException({ code: 'ASSET_ASSIGNED', message: 'Return the asset first' });

@Injectable()
export class AssetsService {
  private readonly logger = new Logger(AssetsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly media: MediaService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    // Photo URLs are signed for 15 minutes straight through R2Service (the
    // shared avatar signer has no TTL knob and uses the 24 h default).
    // StorageModule is @Global(), so DI supplies it without an import here;
    // Optional + LAST so the hand-built spec constructor keeps compiling —
    // without it photos fall back to the shared signer.
    @Optional() private readonly r2?: R2Service,
  ) {}

  // ─── Shared helpers ────────────────────────────────────────────────────────

  private appUrl(): string {
    return (this.config.get<string>('APP_URL') ?? 'http://localhost:3000').replace(/\/+$/, '');
  }

  private async logAudit(dto: Parameters<AuditService['log']>[0]): Promise<void> {
    try {
      await this.audit.log(dto);
    } catch (err) {
      this.logger.warn(`audit ${dto.action} failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Signed URL for a stored avatar key; null when there is none or signing fails (read paths never 503). */
  private async sign(key: string | null, legacy: string | null, size: 256 | 64): Promise<string | null> {
    if (!key && !legacy) return null;
    try {
      return await this.media.servedUrl(key, legacy, size);
    } catch (err) {
      this.logger.warn(`signing ${key ?? legacy} failed: ${err instanceof Error ? err.message : err}`);
      return legacy;
    }
  }

  /**
   * 15-minute signed URL of a photo variant (256 / 64), straight through
   * R2Service like policy PDFs. Without an injected R2Service (hand-built
   * specs) it uses the shared avatar signer; never throws.
   */
  private async signPhoto(key: string | null, size: 256 | 64): Promise<string | null> {
    if (!key) return null;
    if (!this.r2) return this.sign(key, null, size);
    if (!this.r2.isConfigured()) return null;
    const k = size === 64 ? key.replace('_256.webp', '_64.webp') : key;
    try {
      return await this.r2.signedGetUrl(k, ASSET_PHOTO_URL_TTL_S);
    } catch (err) {
      this.logger.warn(`signing asset photo ${k} failed: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  /** The live asset row (404 for other tenants / soft-deleted); `forUpdate` locks it for the write flows. */
  private async loadLiveTx(tx: Db, tenantId: string, id: string, forUpdate = false): Promise<AssetRow> {
    const q = tx
      .select()
      .from(assets)
      .where(and(eq(assets.tenant_id, tenantId), eq(assets.id, id), isNull(assets.deleted_at)))
      .limit(1);
    const [row] = forUpdate ? await q.for('update') : await q;
    if (!row) throw new NotFoundException('Asset not found');
    return row;
  }

  /** The open assignment of an asset with the holder's name, or null. */
  private async openAssignmentTx(tx: Db, tenantId: string, assetId: string) {
    const [row] = await tx
      .select({
        id: assetAssignments.id,
        employee_id: assetAssignments.employee_id,
        assigned_at: assetAssignments.assigned_at,
        acknowledged_at: assetAssignments.acknowledged_at,
        first: holder.first_name,
        last: holder.last_name,
      })
      .from(assetAssignments)
      .leftJoin(holder, and(eq(holder.id, assetAssignments.employee_id), eq(holder.tenant_id, tenantId)))
      .where(
        and(
          eq(assetAssignments.tenant_id, tenantId),
          eq(assetAssignments.asset_id, assetId),
          isNull(assetAssignments.returned_at),
        ),
      )
      .limit(1);
    if (!row) return null;
    return { ...row, employee_name: fullName(row.first, row.last) || 'a former employee' };
  }

  /**
   * Is `tag` used by another LIVE asset of the tenant? Case-insensitive, so
   * `lap-1` cannot sit beside `LAP-1` (the unique index itself is exact and
   * stays the race backstop).
   */
  private async tagTakenTx(tx: Db, tenantId: string, tag: string, exceptId?: string): Promise<boolean> {
    const rows = await tx
      .select({ id: assets.id })
      .from(assets)
      .where(
        and(
          eq(assets.tenant_id, tenantId),
          sql`lower(${assets.asset_tag}) = ${tag.toLowerCase()}`,
          isNull(assets.deleted_at),
        ),
      )
      .limit(2);
    return rows.some((r) => r.id !== exceptId);
  }

  /**
   * Serialise server-side tag allocation per tenant for the rest of the
   * transaction (released at commit/rollback — the invoice-numbering
   * pattern). The waiter's next SELECT runs on a fresh snapshot (READ
   * COMMITTED), so it sees the winner's row and picks the following number.
   */
  private async lockTagAllocationTx(tx: Db, tenantId: string): Promise<void> {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`assets:tag:${tenantId}`}))`);
  }

  /**
   * 'AST-' + 4-digit next number over EVERY tag ever used in the tenant
   * (deleted rows included, so a reused number never collides with history).
   */
  private async nextTagTx(tx: Db, tenantId: string): Promise<string> {
    const rows = await tx
      .select({ tag: assets.asset_tag })
      .from(assets)
      .where(and(eq(assets.tenant_id, tenantId), sql`${assets.asset_tag} ~ '^AST-[0-9]+$'`));
    let max = 0;
    for (const r of rows) {
      const m = /^AST-(\d+)$/.exec(r.tag);
      if (!m) continue;
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > max) max = n;
    }
    return `${ASSET_TAG_PREFIX}${String(max + 1).padStart(4, '0')}`;
  }

  /**
   * The caller's employee record in this tenant (memberships.employee_id) —
   * only while the seat is LIVE (active and not past access_expires_at). A
   * deactivated or expired seat whose access token has not lapsed yet reads
   * as "no employee": /me → [], acknowledge → 403. Same rule as policies.
   */
  private async callerEmployeeIdTx(tx: Db, tenantId: string, userId: string): Promise<string | null> {
    const [m] = await tx
      .select({
        employee_id: memberships.employee_id,
        status: memberships.status,
        access_expires_at: memberships.access_expires_at,
      })
      .from(memberships)
      .where(and(eq(memberships.tenant_id, tenantId), eq(memberships.user_id, userId)))
      .limit(1);
    if (!m || m.status !== 'active') return null;
    if (m.access_expires_at && new Date(m.access_expires_at).getTime() <= Date.now()) return null;
    return m.employee_id ?? null;
  }

  private async tenantNameTx(tx: Db, tenantId: string): Promise<string> {
    const [t] = await tx.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    return t?.name ?? 'your company';
  }

  private async userNameTx(tx: Db, userId: string): Promise<string | null> {
    const [u] = await tx.select({ name: users.full_name }).from(users).where(eq(users.id, userId)).limit(1);
    return u?.name ?? null;
  }

  // ─── Row shapes ────────────────────────────────────────────────────────────

  /**
   * Asset rows with their open assignment + holder in ONE query (the open
   * assignment is at most one row per asset, so joins never fan out). The
   * holder join carries the explicit tenant predicate (rule 1 defence in
   * depth — the FK alone would admit another tenant's employee row).
   */
  private assetSelect(tx: Db, tenantId: string) {
    return tx
      .select({
        asset: assets,
        a_id: openA.id,
        a_employee_id: openA.employee_id,
        a_assigned_at: openA.assigned_at,
        a_issue_condition: openA.issue_condition,
        a_notes: openA.notes,
        a_acknowledged_at: openA.acknowledged_at,
        h_first: holder.first_name,
        h_last: holder.last_name,
        h_code: holder.employee_code,
        h_avatar_url: holder.avatar_url,
        hu_avatar_key: holderUser.avatar_key,
        hu_avatar_url: holderUser.avatar_url,
        ab_name: assignedBy.full_name,
      })
      .from(assets)
      .leftJoin(
        openA,
        and(eq(openA.asset_id, assets.id), eq(openA.tenant_id, assets.tenant_id), isNull(openA.returned_at)),
      )
      .leftJoin(holder, and(eq(holder.id, openA.employee_id), eq(holder.tenant_id, tenantId)))
      .leftJoin(holderUser, eq(holderUser.id, holder.user_id))
      .leftJoin(assignedBy, eq(assignedBy.id, openA.assigned_by))
      .$dynamic();
  }

  /** Assignment rows (open + returned) with holder, issuer, returner and the asset's identity. */
  private historySelect(tx: Db, tenantId: string) {
    return tx
      .select({
        row: assetAssignments,
        h_first: holder.first_name,
        h_last: holder.last_name,
        h_code: holder.employee_code,
        h_avatar_url: holder.avatar_url,
        hu_avatar_key: holderUser.avatar_key,
        hu_avatar_url: holderUser.avatar_url,
        ab_name: assignedBy.full_name,
        rb_name: returnedBy.full_name,
        asset_tag: assets.asset_tag,
        asset_name: assets.name,
        asset_category: assets.category,
      })
      .from(assetAssignments)
      .innerJoin(assets, and(eq(assets.id, assetAssignments.asset_id), eq(assets.tenant_id, tenantId)))
      .leftJoin(holder, and(eq(holder.id, assetAssignments.employee_id), eq(holder.tenant_id, tenantId)))
      .leftJoin(holderUser, eq(holderUser.id, holder.user_id))
      .leftJoin(assignedBy, eq(assignedBy.id, assetAssignments.assigned_by))
      .leftJoin(returnedBy, eq(returnedBy.id, assetAssignments.returned_by))
      .$dynamic();
  }

  private async toAsset(r: Awaited<ReturnType<AssetsService['assetSelect']>>[number]): Promise<Asset> {
    const a = r.asset;
    const [photo_url, photo_thumb_url] = a.photo_key
      ? await Promise.all([this.signPhoto(a.photo_key, 256), this.signPhoto(a.photo_key, 64)])
      : [null, null];
    const current_assignment: AssetAssignmentSummary | null =
      r.a_id && r.a_employee_id
        ? {
            id: r.a_id,
            employee_id: r.a_employee_id,
            employee_name: fullName(r.h_first, r.h_last) || 'Former employee',
            employee_code: r.h_code ?? null,
            employee_avatar_url: await this.sign(r.hu_avatar_key ?? null, r.hu_avatar_url ?? r.h_avatar_url ?? null, 64),
            assigned_at: iso(r.a_assigned_at)!,
            assigned_by_name: r.ab_name ?? null,
            issue_condition: (r.a_issue_condition as AssetCondition | null) ?? null,
            notes: r.a_notes ?? null,
            acknowledged_at: iso(r.a_acknowledged_at),
          }
        : null;
    return {
      id: a.id,
      asset_tag: a.asset_tag,
      name: a.name,
      category: a.category as AssetCategory,
      brand: a.brand,
      model: a.model,
      serial_number: a.serial_number,
      photo_url,
      photo_thumb_url,
      purchase_date: a.purchase_date,
      purchase_value: a.purchase_value,
      currency: a.currency,
      condition: a.condition as AssetCondition,
      status: a.status as AssetStatus,
      notes: a.notes,
      created_at: iso(a.created_at)!,
      updated_at: iso(a.updated_at)!,
      current_assignment,
    };
  }

  private async toHistoryRow(
    r: Awaited<ReturnType<AssetsService['historySelect']>>[number],
  ): Promise<EmployeeAssetHistoryRow> {
    const row: AssignmentRow = r.row;
    return {
      id: row.id,
      employee_id: row.employee_id,
      employee_name: fullName(r.h_first, r.h_last) || 'Former employee',
      employee_code: r.h_code ?? null,
      employee_avatar_url: await this.sign(r.hu_avatar_key ?? null, r.hu_avatar_url ?? r.h_avatar_url ?? null, 64),
      assigned_at: iso(row.assigned_at)!,
      assigned_by_name: r.ab_name ?? null,
      issue_condition: (row.issue_condition as AssetCondition | null) ?? null,
      notes: row.notes,
      acknowledged_at: iso(row.acknowledged_at),
      returned_at: iso(row.returned_at),
      returned_by_name: r.rb_name ?? null,
      return_condition: (row.return_condition as AssetCondition | null) ?? null,
      return_notes: row.return_notes,
      asset_id: row.asset_id,
      asset_tag: r.asset_tag,
      asset_name: r.asset_name,
      category: r.asset_category as AssetCategory,
    };
  }

  private toAssetHistoryRow(r: EmployeeAssetHistoryRow): AssetHistoryRow {
    const { asset_id: _a, asset_tag: _t, asset_name: _n, category: _c, ...rest } = r;
    return rest;
  }

  /** Detail = asset + every assignment, the open one first, then newest first. Signed AFTER the tx. */
  private async detail(tenantId: string, id: string, userId?: string): Promise<AssetDetail> {
    const out = await this.db.withTenant(
      tenantId,
      async (tx) => {
        const [hit] = await this.assetSelect(tx, tenantId).where(
          and(eq(assets.tenant_id, tenantId), eq(assets.id, id), isNull(assets.deleted_at)),
        );
        if (!hit) return null;
        const history = await this.historySelect(tx, tenantId)
          .where(and(eq(assetAssignments.tenant_id, tenantId), eq(assetAssignments.asset_id, id)))
          .orderBy(
            sql`(${assetAssignments.returned_at} IS NULL) DESC`,
            desc(assetAssignments.assigned_at),
            desc(assetAssignments.created_at),
          );
        return { hit, history };
      },
      userId,
    );
    if (!out) throw new NotFoundException('Asset not found');
    const asset = await this.toAsset(out.hit);
    const history: AssetHistoryRow[] = [];
    for (const h of out.history) history.push(this.toAssetHistoryRow(await this.toHistoryRow(h)));
    return { ...asset, history };
  }

  // ─── Register (admin) ──────────────────────────────────────────────────────

  private listWhere(tenantId: string, q: ListAssetsQueryDto): SQL {
    const conds: SQL[] = [eq(assets.tenant_id, tenantId), isNull(assets.deleted_at)];
    if (q.status) conds.push(eq(assets.status, q.status));
    if (q.category) conds.push(eq(assets.category, q.category));
    if (q.employee_id) conds.push(eq(openA.employee_id, q.employee_id));
    const term = q.q?.trim();
    if (term) {
      const p = containsPattern(term);
      conds.push(
        or(
          ilike(assets.asset_tag, p),
          ilike(assets.name, p),
          ilike(assets.serial_number, p),
          ilike(assets.brand, p),
          ilike(assets.model, p),
        )!,
      );
    }
    return and(...conds)!;
  }

  /** Live rows, assigned first then by tag; `total` is the unpaged count under the same filters. */
  async list(tenantId: string, q: ListAssetsQueryDto = {}, userId?: string): Promise<{ data: Asset[]; total: number }> {
    const limit = Math.min(Math.max(1, q.limit ?? ASSET_LIST_DEFAULT_LIMIT), ASSET_LIST_MAX_LIMIT);
    const offset = Math.max(0, q.offset ?? 0);
    const where = this.listWhere(tenantId, q);
    const { rows, total } = await this.db.withTenant(
      tenantId,
      async (tx) => {
        const rows = await this.assetSelect(tx, tenantId)
          .where(where)
          .orderBy(STATUS_ORDER, asc(assets.asset_tag), asc(assets.created_at))
          .limit(limit)
          .offset(offset);
        const [c] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(assets)
          .leftJoin(
            openA,
            and(eq(openA.asset_id, assets.id), eq(openA.tenant_id, assets.tenant_id), isNull(openA.returned_at)),
          )
          .where(where);
        return { rows, total: Number(c?.n ?? 0) };
      },
      userId,
    );
    const data: Asset[] = [];
    for (const r of rows) data.push(await this.toAsset(r));
    return { data, total };
  }

  async summary(tenantId: string, userId?: string): Promise<{ data: AssetsSummary }> {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const live = and(eq(assets.tenant_id, tenantId), isNull(assets.deleted_at));
        const [s] = await tx
          .select({
            total: sql<number>`count(*)::int`,
            assigned: sql<number>`count(*) filter (where ${assets.status} = 'assigned')::int`,
            in_stock: sql<number>`count(*) filter (where ${assets.status} = 'in_stock')::int`,
            under_repair: sql<number>`count(*) filter (where ${assets.status} = 'under_repair')::int`,
            retired: sql<number>`count(*) filter (where ${assets.status} = 'retired')::int`,
            lost: sql<number>`count(*) filter (where ${assets.status} = 'lost')::int`,
          })
          .from(assets)
          .where(live);
        const [w] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(assetAssignments)
          .innerJoin(assets, eq(assets.id, assetAssignments.asset_id))
          .where(
            and(
              eq(assetAssignments.tenant_id, tenantId),
              isNull(assetAssignments.returned_at),
              isNull(assetAssignments.acknowledged_at),
              eq(assets.tenant_id, tenantId),
              isNull(assets.deleted_at),
            ),
          );
        return {
          data: {
            total: Number(s?.total ?? 0),
            assigned: Number(s?.assigned ?? 0),
            in_stock: Number(s?.in_stock ?? 0),
            under_repair: Number(s?.under_repair ?? 0),
            retired: Number(s?.retired ?? 0),
            lost: Number(s?.lost ?? 0),
            awaiting_acknowledgement: Number(w?.n ?? 0),
          },
        };
      },
      userId,
    );
  }

  async nextTag(tenantId: string, userId?: string): Promise<{ data: { asset_tag: string } }> {
    const asset_tag = await this.db.withTenant(tenantId, (tx) => this.nextTagTx(tx, tenantId), userId);
    return { data: { asset_tag } };
  }

  /** The whole live register as CSV (UTF-8 BOM for Excel), formula-safe. */
  async exportCsv(tenantId: string, userId?: string): Promise<string> {
    const rows = await this.db.withTenant(
      tenantId,
      (tx) =>
        this.assetSelect(tx, tenantId)
          .where(and(eq(assets.tenant_id, tenantId), isNull(assets.deleted_at)))
          .orderBy(STATUS_ORDER, asc(assets.asset_tag), asc(assets.created_at)),
      userId,
    );
    const lines: unknown[][] = [[...ASSETS_CSV_COLUMNS]];
    for (const r of rows) {
      const a = r.asset;
      const holderName = r.a_id ? fullName(r.h_first, r.h_last) || 'Former employee' : '';
      lines.push([
        a.asset_tag,
        a.name,
        a.category,
        a.brand,
        a.model,
        a.serial_number,
        a.status,
        a.condition,
        holderName,
        r.a_id ? r.h_code : '',
        r.a_id ? iso(r.a_assigned_at) : '',
        r.a_id ? iso(r.a_acknowledged_at) : '',
        a.purchase_date,
        a.purchase_value,
        a.currency,
        a.notes,
      ]);
    }
    return '﻿' + lines.map((l) => l.map(csvCell).join(',')).join('\n') + '\n';
  }

  async get(tenantId: string, id: string, userId?: string): Promise<{ data: AssetDetail }> {
    return { data: await this.detail(tenantId, id, userId) };
  }

  /**
   * Register a piece of equipment. An explicit tag must be free among live
   * rows (409 ASSET_TAG_TAKEN, case-insensitive); a blank tag is allocated
   * by the server under the per-tenant advisory lock, and a lost race on the
   * unique index (the backstop) is retried with a fresh number instead of
   * being handed to a user who never typed a tag (house rule 8).
   */
  async create(tenantId: string, userId: string, dto: CreateAssetDto): Promise<{ data: Asset }> {
    const name = dto.name.trim();
    if (!name) throw new BadRequestException('Give the asset a name');
    const requestedTag = dto.asset_tag?.trim() || null;
    const purchaseDate = normaliseDate(dto.purchase_date ?? null, 'Purchase date');
    const values: Omit<typeof assets.$inferInsert, 'asset_tag'> = {
      tenant_id: tenantId,
      name,
      category: dto.category,
      brand: dto.brand?.trim() || null,
      model: dto.model?.trim() || null,
      serial_number: dto.serial_number?.trim() || null,
      purchase_date: purchaseDate,
      purchase_value: dto.purchase_value == null ? null : String(dto.purchase_value),
      currency: (dto.currency ?? 'INR').toUpperCase(),
      condition: dto.condition ?? 'good',
      status: 'in_stock',
      notes: dto.notes?.trim() || null,
      created_by: userId,
      updated_by: userId,
    };
    let created: AssetRow | undefined;
    for (let attempt = 1; !created; attempt++) {
      try {
        created = await this.db.withTenant(
          tenantId,
          async (tx) => {
            let tag = requestedTag;
            if (!tag) {
              await this.lockTagAllocationTx(tx, tenantId);
              tag = await this.nextTagTx(tx, tenantId);
            }
            if (await this.tagTakenTx(tx, tenantId, tag)) throw tagTaken(tag);
            const [row] = await tx
              .insert(assets)
              .values({ ...values, asset_tag: tag })
              .returning();
            return row!;
          },
          userId,
        );
      } catch (err) {
        if (!uniqueViolation(err)) throw err;
        // The unique index won a race the pre-check missed. An explicit tag is
        // the user's to change; a server-picked one is ours to pick again.
        if (requestedTag) throw tagTaken(requestedTag);
        if (attempt >= TAG_ALLOCATION_ATTEMPTS) throw tagAllocationFailed();
        this.logger.warn(`asset tag allocation collided for tenant ${tenantId} (attempt ${attempt}) — retrying`);
      }
    }
    await this.logAudit({
      tenantId,
      actorUserId: userId,
      action: 'asset.created',
      resourceType: 'asset',
      resourceId: created.id,
      afterState: {
        asset_tag: created.asset_tag,
        name: created.name,
        category: created.category,
        serial_number: created.serial_number,
        condition: created.condition,
        status: created.status,
      },
    });
    const { history: _h, ...asset } = await this.detail(tenantId, created.id, userId);
    return { data: asset };
  }

  /**
   * Edit the register entry. `status` only moves while nobody holds the asset
   * (409 ASSET_ASSIGNED otherwise) and never to 'assigned'; a tag change must
   * stay unique among live rows (409 ASSET_TAG_TAKEN).
   */
  async update(tenantId: string, userId: string, id: string, dto: UpdateAssetDto): Promise<{ data: AssetDetail }> {
    const patch: Partial<typeof assets.$inferInsert> = {};
    // NOT NULL columns: `null` reads as "leave it" (the DTO maps it to
    // undefined too — belt and braces, so a stray null is never a 500).
    if (dto.asset_tag != null) {
      const tag = dto.asset_tag.trim();
      if (tag) patch.asset_tag = tag;
    }
    if (dto.name != null) {
      const name = dto.name.trim();
      if (!name) throw new BadRequestException('Give the asset a name');
      patch.name = name;
    }
    if (dto.category != null) patch.category = dto.category;
    if (dto.brand !== undefined) patch.brand = dto.brand?.trim() || null;
    if (dto.model !== undefined) patch.model = dto.model?.trim() || null;
    if (dto.serial_number !== undefined) patch.serial_number = dto.serial_number?.trim() || null;
    if (dto.purchase_date !== undefined) patch.purchase_date = normaliseDate(dto.purchase_date, 'Purchase date');
    if (dto.purchase_value !== undefined) {
      patch.purchase_value = dto.purchase_value == null ? null : String(dto.purchase_value);
    }
    if (dto.currency != null) patch.currency = dto.currency.toUpperCase();
    if (dto.condition != null) patch.condition = dto.condition;
    if (dto.status != null) patch.status = dto.status;
    if (dto.notes !== undefined) patch.notes = dto.notes?.trim() || null;

    let out: { before: AssetRow; after: AssetRow; fields: string[] };
    try {
      out = await this.db.withTenant(
        tenantId,
        async (tx) => {
          const before = await this.loadLiveTx(tx, tenantId, id, true);
          if (Object.keys(patch).length === 0) return { before, after: before, fields: [] };
          if (patch.status !== undefined && patch.status !== before.status) {
            if (await this.openAssignmentTx(tx, tenantId, id)) throw assetAssigned();
          }
          if (patch.asset_tag !== undefined && patch.asset_tag !== before.asset_tag) {
            if (await this.tagTakenTx(tx, tenantId, patch.asset_tag, id)) throw tagTaken(patch.asset_tag);
          }
          const [after] = await tx
            .update(assets)
            .set({ ...patch, updated_by: userId, updated_at: new Date() })
            .where(and(eq(assets.tenant_id, tenantId), eq(assets.id, id)))
            .returning();
          const fields = (Object.keys(patch) as Array<keyof AssetRow>).filter(
            (k) => String(before[k] ?? null) !== String(after![k] ?? null),
          );
          return { before, after: after!, fields };
        },
        userId,
      );
    } catch (err) {
      // The tag unique index is the only unique on assets besides the PK, so a
      // 23505 here is a tag race the pre-check missed.
      if (patch.asset_tag && uniqueViolation(err)) throw tagTaken(patch.asset_tag);
      throw err;
    }
    if (out.fields.length) {
      const pick = (row: AssetRow) =>
        Object.fromEntries(out.fields.map((k) => [k, row[k as keyof AssetRow] ?? null])) as Record<string, unknown>;
      await this.logAudit({
        tenantId,
        actorUserId: userId,
        action: 'asset.updated',
        resourceType: 'asset',
        resourceId: id,
        beforeState: pick(out.before),
        afterState: pick(out.after),
        metadata: { fields: out.fields },
      });
    }
    return { data: await this.detail(tenantId, id, userId) };
  }

  // ─── Photo (house rule 7: tx1 check → R2 → tx2 write → delete old after commit) ──

  async uploadPhoto(tenantId: string, userId: string, id: string, buffer: Buffer): Promise<{ data: AssetDetail }> {
    if (!buffer?.length) throw new BadRequestException('Attach the photo as "file"');
    // tx1 — the asset must exist (and be ours) before anything leaves the server.
    await this.db.withTenant(tenantId, (tx) => this.loadLiveTx(tx, tenantId, id), userId);

    // Validates by magic bytes + size, re-encodes to 256/64 WebP and uploads;
    // throws 400 on a bad file, 503 when storage is unconfigured.
    const media = await this.media.processImage(buffer, `tenants/${tenantId}/assets/${id}/photo`);

    let previousKey: string | null = null;
    try {
      await this.db.withTenant(
        tenantId,
        async (tx) => {
          const row = await this.loadLiveTx(tx, tenantId, id, true);
          previousKey = row.photo_key;
          const now = new Date();
          await tx
            .update(assets)
            .set({ photo_key: media.key256, photo_updated_at: now, updated_by: userId, updated_at: now })
            .where(and(eq(assets.tenant_id, tenantId), eq(assets.id, id)));
        },
        userId,
      );
    } catch (err) {
      await this.media.deleteImage(media.key256).catch(() => undefined);
      throw err;
    }
    if (previousKey && previousKey !== media.key256) {
      await this.media.deleteImage(previousKey).catch((err: unknown) => {
        this.logger.warn(`deleting previous asset photo ${previousKey} failed: ${err instanceof Error ? err.message : err}`);
      });
    }
    await this.logAudit({
      tenantId,
      actorUserId: userId,
      action: 'asset.photo_updated',
      resourceType: 'asset',
      resourceId: id,
      metadata: { replaced: !!previousKey },
    });
    return { data: await this.detail(tenantId, id, userId) };
  }

  async removePhoto(tenantId: string, userId: string, id: string): Promise<{ data: AssetDetail }> {
    const previousKey = await this.db.withTenant(
      tenantId,
      async (tx) => {
        const row = await this.loadLiveTx(tx, tenantId, id, true);
        if (!row.photo_key) return null;
        const now = new Date();
        await tx
          .update(assets)
          .set({ photo_key: null, photo_updated_at: now, updated_by: userId, updated_at: now })
          .where(and(eq(assets.tenant_id, tenantId), eq(assets.id, id)));
        return row.photo_key;
      },
      userId,
    );
    if (previousKey) {
      await this.media.deleteImage(previousKey).catch((err: unknown) => {
        this.logger.warn(`deleting asset photo ${previousKey} failed: ${err instanceof Error ? err.message : err}`);
      });
      await this.logAudit({
        tenantId,
        actorUserId: userId,
        action: 'asset.photo_removed',
        resourceType: 'asset',
        resourceId: id,
      });
    }
    return { data: await this.detail(tenantId, id, userId) };
  }

  // ─── Assign / return ───────────────────────────────────────────────────────

  /**
   * Hand the asset to a person. Inside the tx: the asset is live and not
   * retired/lost, nobody holds it, the employee exists in THIS tenant and has
   * not left. Writes the assignment, flips the asset to 'assigned' with the
   * issue condition. After commit: audit, then a best-effort in-app + email
   * nudge to the holder to acknowledge receipt.
   */
  async assign(tenantId: string, userId: string, id: string, dto: AssignAssetDto): Promise<{ data: AssetDetail }> {
    const assignedAt = dto.assigned_at ? new Date(dto.assigned_at) : new Date();
    if (Number.isNaN(assignedAt.getTime())) throw new BadRequestException('The issue date isn’t a valid date');
    if (assignedAt.getTime() > Date.now() + ASSIGNED_AT_FUTURE_GRACE_MS) {
      throw new BadRequestException('The issue date can’t be in the future');
    }
    const notes = dto.notes?.trim() || null;

    let out: {
      asset: AssetRow;
      assignment: AssignmentRow;
      employee: { id: string; name: string; user_id: string | null; work_email: string };
      companyName: string;
      issuedBy: string | null;
    };
    try {
      out = await this.db.withTenant(
        tenantId,
        async (tx) => {
          const asset = await this.loadLiveTx(tx, tenantId, id, true);
          if (asset.status === 'retired' || asset.status === 'lost') {
            throw new ConflictException({
              code: 'ASSET_UNAVAILABLE',
              message: `This asset is ${asset.status} — set it back to In stock first`,
            });
          }
          const open = await this.openAssignmentTx(tx, tenantId, id);
          if (open) {
            throw new ConflictException({
              code: 'ASSET_ALREADY_ASSIGNED',
              message: `Already assigned to ${open.employee_name} — record the return first`,
            });
          }
          // Rule 2: the employee id came from the client — prove it belongs to
          // this tenant inside the transaction; the FK alone would not.
          const [emp] = await tx
            .select({
              id: employees.id,
              first_name: employees.first_name,
              last_name: employees.last_name,
              status: employees.status,
              user_id: employees.user_id,
              work_email: employees.work_email,
              deleted_at: employees.deleted_at,
            })
            .from(employees)
            .where(and(eq(employees.tenant_id, tenantId), eq(employees.id, dto.employee_id)))
            .limit(1)
            // FOR SHARE: removeEmployee locks the row FOR UPDATE for its whole
            // transaction, so an assign racing a removal waits and then sees
            // deleted_at instead of attaching equipment to an archived ghost.
            .for('share');
          if (!emp || emp.deleted_at) throw new NotFoundException('Employee not found');
          const name = fullName(emp.first_name, emp.last_name);
          if (emp.status === 'separated' || emp.status === 'absconded') {
            throw new BadRequestException(`${name} is no longer with the company`);
          }
          const issueCondition = dto.issue_condition ?? (asset.condition as AssetCondition);
          const [assignment] = await tx
            .insert(assetAssignments)
            .values({
              tenant_id: tenantId,
              asset_id: id,
              employee_id: emp.id,
              assigned_at: assignedAt,
              assigned_by: userId,
              issue_condition: issueCondition,
              notes,
            })
            .returning();
          await tx
            .update(assets)
            .set({ status: 'assigned', condition: issueCondition, updated_by: userId, updated_at: new Date() })
            .where(and(eq(assets.tenant_id, tenantId), eq(assets.id, id)));
          const companyName = await this.tenantNameTx(tx, tenantId);
          const issuedBy = await this.userNameTx(tx, userId);
          return {
            asset,
            assignment: assignment!,
            employee: { id: emp.id, name, user_id: emp.user_id, work_email: emp.work_email },
            companyName,
            issuedBy,
          };
        },
        userId,
      );
    } catch (err) {
      // Lost the race on the open-assignment partial unique.
      if (uniqueViolation(err)) {
        throw new ConflictException({
          code: 'ASSET_ALREADY_ASSIGNED',
          message: 'Already assigned to someone else — record the return first',
        });
      }
      throw err;
    }

    await this.logAudit({
      tenantId,
      actorUserId: userId,
      action: 'asset.assigned',
      resourceType: 'asset',
      resourceId: id,
      afterState: { status: 'assigned', condition: out.assignment.issue_condition },
      metadata: { employee_id: out.employee.id, assignment_id: out.assignment.id },
    });
    await this.notifyAssigned(tenantId, out);
    return { data: await this.detail(tenantId, id, userId) };
  }

  /** Best-effort after commit (rule 6): a bell for the holder's user (when they have a seat) + an email to their work address. */
  private async notifyAssigned(
    tenantId: string,
    out: {
      asset: AssetRow;
      assignment: AssignmentRow;
      employee: { id: string; name: string; user_id: string | null; work_email: string };
      companyName: string;
      issuedBy: string | null;
    },
  ): Promise<void> {
    const { asset, assignment, employee } = out;
    if (employee.user_id) {
      try {
        await this.notifications.createInAppNotification(
          employee.user_id,
          'asset.assigned',
          `${asset.name} (${asset.asset_tag}) was issued to you — please acknowledge receipt`,
          '/assets/me',
          tenantId,
          { groupKey: `asset:${asset.id}` },
        );
      } catch (err) {
        this.logger.warn(`asset.assigned in-app to ${employee.user_id} failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    if (employee.work_email) {
      try {
        // The template is added by the notifications module; an unknown name
        // renders its generic fallback, so the cast is safe either way.
        const template = 'asset-assigned' as Parameters<NotificationsService['sendEmail']>[0];
        await this.notifications.sendEmail(
          template,
          employee.work_email,
          {
            assetName: asset.name,
            assetTag: asset.asset_tag,
            companyName: out.companyName,
            link: `${this.appUrl()}/assets/me`,
            issuedBy: out.issuedBy,
            issueCondition: assignment.issue_condition,
            notes: assignment.notes,
          },
          employee.user_id ? { userId: employee.user_id } : undefined,
        );
      } catch (err) {
        this.logger.warn(`asset.assigned email to ${employee.work_email} failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  /** Take it back: closes the open assignment and moves the asset to `next_status` (default in_stock) in the returned condition. */
  async returnAsset(tenantId: string, userId: string, id: string, dto: ReturnAssetDto): Promise<{ data: AssetDetail }> {
    const nextStatus: AssetStatus = dto.next_status ?? 'in_stock';
    const out = await this.db.withTenant(
      tenantId,
      async (tx) => {
        await this.loadLiveTx(tx, tenantId, id, true);
        const open = await this.openAssignmentTx(tx, tenantId, id);
        if (!open) {
          throw new ConflictException({ code: 'ASSET_NOT_ASSIGNED', message: 'Nobody holds this asset right now' });
        }
        const now = new Date();
        await tx
          .update(assetAssignments)
          .set({
            returned_at: now,
            returned_by: userId,
            return_condition: dto.return_condition,
            return_notes: dto.return_notes?.trim() || null,
          })
          .where(and(eq(assetAssignments.tenant_id, tenantId), eq(assetAssignments.id, open.id)));
        await tx
          .update(assets)
          .set({ status: nextStatus, condition: dto.return_condition, updated_by: userId, updated_at: now })
          .where(and(eq(assets.tenant_id, tenantId), eq(assets.id, id)));
        return open;
      },
      userId,
    );
    await this.logAudit({
      tenantId,
      actorUserId: userId,
      action: 'asset.returned',
      resourceType: 'asset',
      resourceId: id,
      afterState: { status: nextStatus, condition: dto.return_condition },
      metadata: { employee_id: out.employee_id, assignment_id: out.id, next_status: nextStatus },
    });
    return { data: await this.detail(tenantId, id, userId) };
  }

  // ─── Self-service (any tenant member) ──────────────────────────────────────

  /** What the signed-in person holds (open assignments on live assets, newest first). No employee record → []. */
  async myAssets(tenantId: string, userId: string): Promise<{ data: MyAsset[] }> {
    const rows = await this.db.withTenant(
      tenantId,
      async (tx) => {
        const employeeId = await this.callerEmployeeIdTx(tx, tenantId, userId);
        if (!employeeId) return [];
        return this.assetSelect(tx, tenantId)
          .where(and(eq(assets.tenant_id, tenantId), isNull(assets.deleted_at), eq(openA.employee_id, employeeId)))
          .orderBy(desc(openA.assigned_at), desc(openA.created_at));
      },
      userId,
    );
    const data: MyAsset[] = [];
    for (const r of rows) {
      const { current_assignment, ...asset } = await this.toAsset(r);
      if (!current_assignment) continue;
      data.push({
        // Security audit 2026-10-06: what the company paid is HR's business,
        // not the holder's — the self-service view never carries it.
        asset: { ...asset, purchase_date: null, purchase_value: null },
        assignment: {
          id: current_assignment.id,
          assigned_at: current_assignment.assigned_at,
          assigned_by_name: current_assignment.assigned_by_name,
          issue_condition: current_assignment.issue_condition,
          notes: current_assignment.notes,
          acknowledged_at: current_assignment.acknowledged_at,
        },
      });
    }
    return { data };
  }

  /**
   * "I received this." Only the current holder (the caller's membership →
   * employee record) may acknowledge; idempotent — the first timestamp wins.
   * No open assignment / unknown asset → 404, somebody else's asset → 403.
   */
  async acknowledge(
    tenantId: string,
    userId: string,
    id: string,
  ): Promise<{ data: { asset_id: string; acknowledged_at: string } }> {
    const out = await this.db.withTenant(
      tenantId,
      async (tx) => {
        await this.loadLiveTx(tx, tenantId, id, true);
        const open = await this.openAssignmentTx(tx, tenantId, id);
        if (!open) throw new NotFoundException('This asset is not assigned to anyone');
        const callerEmployeeId = await this.callerEmployeeIdTx(tx, tenantId, userId);
        if (!callerEmployeeId || callerEmployeeId !== open.employee_id) {
          throw new ForbiddenException('Only the person holding this asset can acknowledge it');
        }
        if (open.acknowledged_at) {
          return { acknowledgedAt: open.acknowledged_at, fresh: false, employeeId: open.employee_id, assignmentId: open.id };
        }
        const now = new Date();
        await tx
          .update(assetAssignments)
          .set({ acknowledged_at: now })
          .where(
            and(
              eq(assetAssignments.tenant_id, tenantId),
              eq(assetAssignments.id, open.id),
              isNull(assetAssignments.acknowledged_at),
            ),
          );
        return { acknowledgedAt: now, fresh: true, employeeId: open.employee_id, assignmentId: open.id };
      },
      userId,
    );
    if (out.fresh) {
      await this.logAudit({
        tenantId,
        actorUserId: userId,
        actorEmployeeId: out.employeeId,
        action: 'asset.acknowledged',
        resourceType: 'asset',
        resourceId: id,
        metadata: { assignment_id: out.assignmentId },
      });
    }
    return { data: { asset_id: id, acknowledged_at: iso(out.acknowledgedAt)! } };
  }

  // ─── Per-employee view (admin) ─────────────────────────────────────────────

  /** What one employee holds now + what they returned (newest first); 404 when the employee is not in the tenant. */
  async byEmployee(tenantId: string, employeeId: string, userId?: string): Promise<{ data: EmployeeAssets }> {
    const out = await this.db.withTenant(
      tenantId,
      async (tx) => {
        const [emp] = await tx
          .select({ id: employees.id })
          .from(employees)
          .where(and(eq(employees.tenant_id, tenantId), eq(employees.id, employeeId)))
          .limit(1);
        if (!emp) throw new NotFoundException('Employee not found');
        const current = await this.assetSelect(tx, tenantId)
          .where(and(eq(assets.tenant_id, tenantId), isNull(assets.deleted_at), eq(openA.employee_id, employeeId)))
          .orderBy(desc(openA.assigned_at), desc(openA.created_at));
        const history = await this.historySelect(tx, tenantId)
          .where(
            and(
              eq(assetAssignments.tenant_id, tenantId),
              eq(assetAssignments.employee_id, employeeId),
              isNotNull(assetAssignments.returned_at),
            ),
          )
          .orderBy(desc(assetAssignments.returned_at), desc(assetAssignments.assigned_at));
        return { current, history };
      },
      userId,
    );
    const current: Asset[] = [];
    for (const r of out.current) current.push(await this.toAsset(r));
    const history: EmployeeAssetHistoryRow[] = [];
    for (const h of out.history) history.push(await this.toHistoryRow(h));
    return { data: { current, history } };
  }

  // ─── Delete (soft) ─────────────────────────────────────────────────────────

  /**
   * Soft delete: the row keeps its history, the tag becomes reusable. 409
   * ASSET_ASSIGNED while somebody holds it. No read surface shows a deleted
   * asset's photo and there is no restore path, so the photo objects are
   * deleted after commit (best-effort) and the key cleared with the row —
   * otherwise every deleted asset would leak two private objects forever.
   */
  async remove(tenantId: string, userId: string, id: string): Promise<{ data: { deleted: true } }> {
    const before = await this.db.withTenant(
      tenantId,
      async (tx) => {
        const row = await this.loadLiveTx(tx, tenantId, id, true);
        if (await this.openAssignmentTx(tx, tenantId, id)) throw assetAssigned();
        const now = new Date();
        await tx
          .update(assets)
          .set({ deleted_at: now, photo_key: null, updated_by: userId, updated_at: now })
          .where(and(eq(assets.tenant_id, tenantId), eq(assets.id, id)));
        return row;
      },
      userId,
    );
    if (before.photo_key) {
      const key = before.photo_key;
      await this.media.deleteImage(key).catch((err: unknown) => {
        this.logger.warn(`deleting photo ${key} of deleted asset failed: ${err instanceof Error ? err.message : err}`);
      });
    }
    await this.logAudit({
      tenantId,
      actorUserId: userId,
      action: 'asset.deleted',
      resourceType: 'asset',
      resourceId: id,
      beforeState: { asset_tag: before.asset_tag, name: before.name, status: before.status },
    });
    return { data: { deleted: true } };
  }
}
