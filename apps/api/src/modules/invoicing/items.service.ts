import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { and, eq, ilike, or, isNull, desc, sql } from 'drizzle-orm';
import { items } from '@flicks/db/schema';
import { DatabaseService } from '../../core/database/database.service';
import { AuditService } from '../audit/audit.service';
import type {
  ListQueryDto,
  CreateItemDto,
  UpdateItemDto,
  ImportItemsDto,
} from './dto/invoicing.dto';

/** Items catalogue service (PRD §5). Tenant-scoped + audit-logged. */
@Injectable()
export class ItemsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async list(tenantId: string, query: ListQueryDto) {
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, 100);
    const offset = (page - 1) * limit;

    const conditions = [eq(items.tenant_id, tenantId), isNull(items.deleted_at)];
    if (query.status) conditions.push(eq(items.status, query.status));
    if (query.q) {
      const term = `%${query.q}%`;
      conditions.push(
        or(
          ilike(items.name, term),
          ilike(items.item_code, term),
          ilike(items.hsn_sac_code, term),
        )!,
      );
    }
    const where = and(...conditions);

    return this.db.withTenant(tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(items)
        .where(where)
        .orderBy(desc(items.created_at))
        .limit(limit)
        .offset(offset);
      const [{ total }] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(items)
        .where(where);
      return { data: rows, pagination: { page, limit, total: total ?? 0 } };
    });
  }

  async get(tenantId: string, id: string) {
    const row = await this.db.withTenant(tenantId, (tx) =>
      tx
        .select()
        .from(items)
        .where(and(eq(items.id, id), isNull(items.deleted_at)))
        .limit(1),
    );
    if (!row[0]) throw new NotFoundException('Item not found');
    return { data: row[0] };
  }

  async create(dto: CreateItemDto, userId: string, tenantId: string) {
    const code = dto.item_code?.trim() || (await this.nextCode(tenantId));
    try {
      const created = await this.db.withTenant(tenantId, (tx) =>
        tx
          .insert(items)
          .values({
            ...dto,
            tenant_id: tenantId,
            item_code: code,
            created_by: userId,
            updated_by: userId,
          })
          .returning(),
      );
      const item = created[0]!;
      await this.audit.log({
        tenantId,
        actorUserId: userId,
        action: 'invoicing.item.create',
        resourceType: 'item',
        resourceId: item.id,
        afterState: item as unknown as Record<string, unknown>,
      });
      return { data: item };
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(`Item code "${code}" already in use`);
      }
      throw err;
    }
  }

  async update(
    id: string,
    dto: UpdateItemDto,
    userId: string,
    tenantId: string,
  ) {
    const existing = (await this.get(tenantId, id)).data;
    const updated = await this.db.withTenant(tenantId, (tx) =>
      tx
        .update(items)
        .set({ ...dto, updated_by: userId, updated_at: new Date() })
        .where(eq(items.id, id))
        .returning(),
    );
    await this.audit.log({
      tenantId,
      actorUserId: userId,
      action: 'invoicing.item.update',
      resourceType: 'item',
      resourceId: id,
      beforeState: existing as unknown as Record<string, unknown>,
      afterState: updated[0] as unknown as Record<string, unknown>,
    });
    return { data: updated[0] };
  }

  async setStatus(
    id: string,
    status: 'active' | 'archived',
    userId: string,
    tenantId: string,
  ) {
    await this.get(tenantId, id);
    const updated = await this.db.withTenant(tenantId, (tx) =>
      tx
        .update(items)
        .set({ status, updated_by: userId, updated_at: new Date() })
        .where(eq(items.id, id))
        .returning(),
    );
    await this.audit.log({
      tenantId,
      actorUserId: userId,
      action: `invoicing.item.${status === 'archived' ? 'archive' : 'unarchive'}`,
      resourceType: 'item',
      resourceId: id,
    });
    return { data: updated[0] };
  }

  async importRows(dto: ImportItemsDto, userId: string, tenantId: string) {
    const results: { row: number; ok: boolean; id?: string; error?: string }[] =
      [];
    for (let i = 0; i < dto.rows.length; i++) {
      try {
        const created = await this.create(dto.rows[i]!, userId, tenantId);
        results.push({ row: i, ok: true, id: created.data.id });
      } catch (err) {
        results.push({
          row: i,
          ok: false,
          error: err instanceof Error ? err.message : 'unknown error',
        });
      }
    }
    return {
      data: results,
      meta: {
        total: results.length,
        succeeded: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length,
      },
    };
  }

  async exportAll(tenantId: string) {
    const rows = await this.db.withTenant(tenantId, (tx) =>
      tx
        .select()
        .from(items)
        .where(and(eq(items.tenant_id, tenantId), isNull(items.deleted_at)))
        .orderBy(desc(items.created_at)),
    );
    return { data: rows, meta: { total: rows.length } };
  }

  private async nextCode(tenantId: string): Promise<string> {
    const [{ total }] = await this.db.withTenant(tenantId, (tx) =>
      tx
        .select({ total: sql<number>`count(*)::int` })
        .from(items)
        .where(eq(items.tenant_id, tenantId)),
    );
    return `ITEM-${String((total ?? 0) + 1).padStart(4, '0')}`;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === '23505'
  );
}
