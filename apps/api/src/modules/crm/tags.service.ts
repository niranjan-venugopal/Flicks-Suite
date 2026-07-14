import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { recordTags, tags } from '@flicks/db/schema';
import { DatabaseService } from '../../core/database/database.service';
import { AuditService } from '../audit/audit.service';

const OBJECT_TYPES = ['person', 'company', 'deal', 'lead'] as const;
/** Curated palette — matches the prototype's tag tones. */
const TAG_COLORS = ['#3E7BFA', '#27D280', '#FED800', '#F8786B', '#9B7BFA', '#FF8A3D', '#22C9D6', '#FF6E9C'];

/**
 * Tags (PRD v5 §19.1) — light labels attachable to people/companies/deals/leads
 * via record_tags. Label-unique per tenant (case-insensitive); attach is
 * idempotent. Chips render on kanban cards, deal headers and list rows.
 */
@Injectable()
export class TagsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async list(tenantId: string) {
    return this.db.withTenant(tenantId, async (tx) => {
      const rows = await tx.select().from(tags).orderBy(asc(tags.label));
      return { data: rows };
    });
  }

  async create(tenantId: string, userId: string, dto: { label: string; color?: string }) {
    const label = dto.label?.trim();
    if (!label) throw new BadRequestException('Tag label is required');
    if (label.length > 40) throw new BadRequestException('Tag label is too long (max 40)');
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const [existing] = await tx
          .select()
          .from(tags)
          .where(sql`lower(${tags.label}) = lower(${label})`)
          .limit(1);
        if (existing) return { data: existing }; // idempotent by label
        const [count] = await tx.select({ n: sql<number>`count(*)::int` }).from(tags);
        const color = dto.color ?? TAG_COLORS[(count?.n ?? 0) % TAG_COLORS.length]!;
        const [row] = await tx.insert(tags).values({ tenant_id: tenantId, label, color }).returning();
        await this.audit.log({ tenantId, actorUserId: userId, action: 'crm.tag.create', resourceType: 'tag', resourceId: row!.id });
        return { data: row! };
      },
      userId,
    );
  }

  async attach(tenantId: string, userId: string, objectType: string, objectId: string, tagId: string) {
    if (!OBJECT_TYPES.includes(objectType as never)) throw new BadRequestException('Invalid object type');
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        // RLS-scoped tag lookup — a foreign tenant's tag id resolves to nothing.
        const [t] = await tx.select({ id: tags.id }).from(tags).where(eq(tags.id, tagId)).limit(1);
        if (!t) throw new NotFoundException('Tag not found');
        await tx
          .insert(recordTags)
          .values({ tenant_id: tenantId, tag_id: tagId, object_type: objectType, object_id: objectId })
          .onConflictDoNothing();
        return { data: { attached: true } };
      },
      userId,
    );
  }

  async detach(tenantId: string, userId: string, objectType: string, objectId: string, tagId: string) {
    if (!OBJECT_TYPES.includes(objectType as never)) throw new BadRequestException('Invalid object type');
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        await tx
          .delete(recordTags)
          .where(
            and(
              eq(recordTags.tag_id, tagId),
              eq(recordTags.object_type, objectType),
              eq(recordTags.object_id, objectId),
            ),
          );
        return { data: { detached: true } };
      },
      userId,
    );
  }
}
