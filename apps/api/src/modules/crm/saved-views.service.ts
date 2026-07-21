import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, or } from 'drizzle-orm';
import { savedViews } from '@flicks/db/schema';
import { DatabaseService } from '../../core/database/database.service';
import { AuditService } from '../audit/audit.service';

// PM object types joined in PRD v6 §9.4 (migration 0044 extends the CHECK);
// PM consumes this service through the crm public facade only.
const OBJECT_TYPES = ['deal', 'person', 'company', 'lead', 'pm_issue', 'pm_project'] as const;

/**
 * Saved views (PRD v5 §9.2) — a named filter/sort/column set on a list or board.
 * RLS keeps rows tenant-scoped; this service enforces the owner-vs-shared rule:
 * you see shared views plus your own, and only the owner may edit or delete one.
 */
@Injectable()
export class SavedViewsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  /** Views visible to this user: shared ones + their own, for an object type. */
  async list(tenantId: string, userId: string, objectType?: string) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const visible = or(eq(savedViews.is_shared, true), eq(savedViews.owner_user_id, userId));
        const rows = await tx
          .select()
          .from(savedViews)
          .where(objectType ? and(eq(savedViews.object_type, objectType), visible) : visible)
          .orderBy(asc(savedViews.name));
        return { data: rows };
      },
      userId,
    );
  }

  async create(
    tenantId: string,
    userId: string,
    dto: {
      object_type: string;
      name: string;
      is_shared?: boolean;
      filters?: Record<string, unknown>;
      sort?: Record<string, unknown>;
      columns?: string[];
    },
  ) {
    if (!OBJECT_TYPES.includes(dto.object_type as never)) throw new BadRequestException('Invalid object_type');
    if (!dto.name?.trim()) throw new BadRequestException('View name is required');
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const [row] = await tx
          .insert(savedViews)
          .values({
            tenant_id: tenantId,
            object_type: dto.object_type,
            name: dto.name.trim(),
            owner_user_id: userId,
            is_shared: dto.is_shared ?? false,
            filters: dto.filters ?? {},
            sort: dto.sort ?? {},
            columns: dto.columns ?? [],
          })
          .returning();
        await this.audit.log({ tenantId, actorUserId: userId, action: 'crm.saved_view.create', resourceType: 'saved_view', resourceId: row!.id });
        return { data: row! };
      },
      userId,
    );
  }

  async update(tenantId: string, userId: string, id: string, dto: Record<string, unknown>) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const [existing] = await tx.select().from(savedViews).where(eq(savedViews.id, id)).limit(1);
        if (!existing) throw new NotFoundException('View not found');
        if (existing.owner_user_id !== userId) throw new ForbiddenException('Only the owner can edit this view');
        const patch: Record<string, unknown> = { updated_at: new Date() };
        for (const k of ['name', 'is_shared', 'filters', 'sort', 'columns'] as const) {
          if (k in dto) patch[k] = dto[k];
        }
        const [row] = await tx.update(savedViews).set(patch).where(eq(savedViews.id, id)).returning();
        await this.audit.log({ tenantId, actorUserId: userId, action: 'crm.saved_view.update', resourceType: 'saved_view', resourceId: id });
        return { data: row! };
      },
      userId,
    );
  }

  async remove(tenantId: string, userId: string, id: string) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const [existing] = await tx.select({ owner: savedViews.owner_user_id }).from(savedViews).where(eq(savedViews.id, id)).limit(1);
        if (!existing) throw new NotFoundException('View not found');
        if (existing.owner !== userId) throw new ForbiddenException('Only the owner can delete this view');
        await tx.delete(savedViews).where(eq(savedViews.id, id));
        await this.audit.log({ tenantId, actorUserId: userId, action: 'crm.saved_view.delete', resourceType: 'saved_view', resourceId: id });
        return { data: { deleted: true } };
      },
      userId,
    );
  }
}
