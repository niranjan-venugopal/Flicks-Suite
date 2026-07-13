import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { customFieldDefs } from '@flicks/db/schema';
import { DatabaseService } from '../../core/database/database.service';
import { AuditService } from '../audit/audit.service';

const OBJECT_TYPES = ['deal', 'person', 'company', 'lead'] as const;
const FIELD_TYPES = ['text', 'number', 'date', 'select', 'multiselect', 'checkbox', 'url'] as const;

/**
 * Custom field definitions (PRD v5 §9.1). Defines the extra fields a tenant can
 * put on deals/contacts/companies/leads; the VALUES live in each record's
 * existing `custom` jsonb column, so no per-value table is needed. Owner/Admin
 * manage these (enforced at the controller).
 */
@Injectable()
export class CustomFieldsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  /** Active (non-archived) field defs, optionally scoped to one object type. */
  async list(tenantId: string, objectType?: string) {
    return this.db.withTenant(tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(customFieldDefs)
        .where(
          objectType
            ? and(eq(customFieldDefs.archived, false), eq(customFieldDefs.object_type, objectType))
            : eq(customFieldDefs.archived, false),
        )
        .orderBy(asc(customFieldDefs.object_type), asc(customFieldDefs.display_order));
      return { data: rows };
    });
  }

  async create(
    tenantId: string,
    userId: string,
    dto: {
      object_type: string;
      key?: string;
      label: string;
      field_type: string;
      options?: string[];
      is_required?: boolean;
      display_order?: number;
    },
  ) {
    if (!OBJECT_TYPES.includes(dto.object_type as never)) throw new BadRequestException('Invalid object_type');
    if (!FIELD_TYPES.includes(dto.field_type as never)) throw new BadRequestException('Invalid field_type');
    if (!dto.label?.trim()) throw new BadRequestException('Field label is required');
    // Derive a stable key from the label when not supplied (snake_case, ascii).
    const key = (dto.key?.trim() || dto.label)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 60);
    if (!key) throw new BadRequestException('Could not derive a field key from the label');

    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const [existing] = await tx
          .select({ id: customFieldDefs.id })
          .from(customFieldDefs)
          .where(
            and(
              eq(customFieldDefs.object_type, dto.object_type),
              eq(customFieldDefs.key, key),
              eq(customFieldDefs.archived, false),
            ),
          )
          .limit(1);
        if (existing) throw new BadRequestException(`A ${dto.object_type} field with key "${key}" already exists`);

        const [row] = await tx
          .insert(customFieldDefs)
          .values({
            tenant_id: tenantId,
            object_type: dto.object_type,
            key,
            label: dto.label.trim(),
            field_type: dto.field_type,
            options: dto.options ?? [],
            is_required: dto.is_required ?? false,
            display_order: dto.display_order ?? 0,
          })
          .returning();
        await this.audit.log({ tenantId, actorUserId: userId, action: 'crm.custom_field.create', resourceType: 'custom_field', resourceId: row!.id });
        return { data: row! };
      },
      userId,
    );
  }

  async update(tenantId: string, userId: string, id: string, dto: Record<string, unknown>) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const patch: Record<string, unknown> = {};
        for (const k of ['label', 'options', 'is_required', 'display_order'] as const) {
          if (k in dto) patch[k] = dto[k];
        }
        if (Object.keys(patch).length === 0) throw new BadRequestException('Nothing to update');
        const [row] = await tx.update(customFieldDefs).set(patch).where(eq(customFieldDefs.id, id)).returning();
        if (!row) throw new NotFoundException('Custom field not found');
        await this.audit.log({ tenantId, actorUserId: userId, action: 'crm.custom_field.update', resourceType: 'custom_field', resourceId: id });
        return { data: row };
      },
      userId,
    );
  }

  async archive(tenantId: string, userId: string, id: string) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const [row] = await tx
          .update(customFieldDefs)
          .set({ archived: true })
          .where(and(eq(customFieldDefs.id, id), eq(customFieldDefs.archived, false)))
          .returning({ id: customFieldDefs.id });
        if (!row) throw new NotFoundException('Custom field not found');
        await this.audit.log({ tenantId, actorUserId: userId, action: 'crm.custom_field.archive', resourceType: 'custom_field', resourceId: id });
        return { data: { archived: true } };
      },
      userId,
    );
  }
}
