import {
  Injectable,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, ilike, or, desc, sql } from 'drizzle-orm';
import { hsnSacCodes, tenantHsnSacCodes } from '@flicks/db/schema';
import { DatabaseService } from '../../core/database/database.service';
import { AuditService } from '../audit/audit.service';
import type { HsnSacSearchDto, AddCustomHsnDto } from './dto/invoicing.dto';

/**
 * HSN/SAC lookup (PRD §5). Search unions the global master (hsn_sac_codes, no
 * RLS) with the tenant's own additions (tenant_hsn_sac_codes, RLS). Both queries
 * run inside withTenant so the tenant table is scoped correctly; the global
 * table has no RLS so it is fully readable.
 */
@Injectable()
export class HsnSacService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async search(tenantId: string, dto: HsnSacSearchDto) {
    const term = `%${dto.q}%`;
    return this.db.withTenant(tenantId, async (tx) => {
      const globalConds = [
        or(ilike(hsnSacCodes.code, term), ilike(hsnSacCodes.description, term))!,
      ];
      if (dto.type) globalConds.push(eq(hsnSacCodes.type, dto.type));
      const globalRows = await tx
        .select({
          code: hsnSacCodes.code,
          type: hsnSacCodes.type,
          description: hsnSacCodes.description,
          default_gst_rate: hsnSacCodes.default_gst_rate,
          category: hsnSacCodes.category,
          source: sql<string>`'global'`,
        })
        .from(hsnSacCodes)
        .where(and(...globalConds))
        .orderBy(desc(hsnSacCodes.popularity))
        .limit(20);

      const tenantConds = [
        eq(tenantHsnSacCodes.tenant_id, tenantId),
        or(
          ilike(tenantHsnSacCodes.code, term),
          ilike(tenantHsnSacCodes.description, term),
        )!,
      ];
      if (dto.type) tenantConds.push(eq(tenantHsnSacCodes.type, dto.type));
      const tenantRows = await tx
        .select({
          code: tenantHsnSacCodes.code,
          type: tenantHsnSacCodes.type,
          description: tenantHsnSacCodes.description,
          default_gst_rate: tenantHsnSacCodes.default_gst_rate,
          category: tenantHsnSacCodes.category,
          source: sql<string>`'tenant'`,
        })
        .from(tenantHsnSacCodes)
        .where(and(...tenantConds))
        .limit(20);

      // Tenant additions first, then global; de-dup by code.
      const seen = new Set<string>();
      const data = [...tenantRows, ...globalRows].filter((r) => {
        if (seen.has(r.code)) return false;
        seen.add(r.code);
        return true;
      });
      return { data };
    });
  }

  async addCustom(dto: AddCustomHsnDto, userId: string, tenantId: string) {
    try {
      const created = await this.db.withTenant(tenantId, (tx) =>
        tx
          .insert(tenantHsnSacCodes)
          .values({ ...dto, tenant_id: tenantId, created_by: userId })
          .returning(),
      );
      await this.audit.log({
        tenantId,
        actorUserId: userId,
        action: 'invoicing.hsn_sac.add_custom',
        resourceType: 'tenant_hsn_sac_code',
        resourceId: created[0]!.id,
        afterState: created[0] as unknown as Record<string, unknown>,
      });
      return { data: created[0] };
    } catch (err) {
      if (
        typeof err === 'object' &&
        err !== null &&
        (err as { code?: string }).code === '23505'
      ) {
        throw new ConflictException(`Code "${dto.code}" already exists`);
      }
      throw err;
    }
  }

  async removeCustom(id: string, userId: string, tenantId: string) {
    const deleted = await this.db.withTenant(tenantId, (tx) =>
      tx
        .delete(tenantHsnSacCodes)
        .where(eq(tenantHsnSacCodes.id, id))
        .returning(),
    );
    if (!deleted[0]) throw new NotFoundException('Custom code not found');
    await this.audit.log({
      tenantId,
      actorUserId: userId,
      action: 'invoicing.hsn_sac.remove_custom',
      resourceType: 'tenant_hsn_sac_code',
      resourceId: id,
    });
    return { data: { id } };
  }
}
