import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { pipelines, pipelineStages, lostReasons } from '@flicks/db/schema';
import { DatabaseService } from '../../core/database/database.service';
import { AuditService } from '../audit/audit.service';

/**
 * Pipelines, stages & lost reasons (PRD v5 §4.1). Each pipeline enforces
 * exactly one Won and one Lost terminal (app-level). Owner/Admin manage them
 * (§13); the guard on the controller enforces that.
 */
@Injectable()
export class PipelinesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  /** All pipelines with their ordered stages. */
  async list(tenantId: string) {
    return this.db.withTenant(tenantId, async (tx) => {
      const pls = await tx
        .select()
        .from(pipelines)
        .where(isNull(pipelines.deleted_at))
        .orderBy(asc(pipelines.display_order));
      const stages = await tx
        .select()
        .from(pipelineStages)
        .where(isNull(pipelineStages.deleted_at))
        .orderBy(asc(pipelineStages.display_order));
      return {
        data: pls.map((p) => ({
          ...p,
          stages: stages.filter((s) => s.pipeline_id === p.id),
        })),
      };
    });
  }

  async lostReasons(tenantId: string) {
    return this.db.withTenant(tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(lostReasons)
        .where(eq(lostReasons.archived, false))
        .orderBy(asc(lostReasons.display_order));
      return { data: rows };
    });
  }

  /** Resolve the default pipeline (or first), throwing if a tenant has none. */
  async defaultPipeline(tenantId: string) {
    return this.db.withTenant(tenantId, async (tx) => {
      const [p] = await tx
        .select()
        .from(pipelines)
        .where(isNull(pipelines.deleted_at))
        .orderBy(asc(pipelines.display_order))
        .limit(1);
      if (!p) throw new NotFoundException('No pipeline configured');
      return p;
    });
  }

  async createPipeline(tenantId: string, userId: string, dto: { name: string; stages?: Array<{ name: string; win_probability?: number; rotting_days?: number; stage_type?: string }> }) {
    if (!dto.name?.trim()) throw new BadRequestException('Pipeline name is required');
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const [count] = await tx
          .select({ n: pipelines.id })
          .from(pipelines)
          .where(isNull(pipelines.deleted_at));
        const [p] = await tx
          .insert(pipelines)
          .values({ tenant_id: tenantId, name: dto.name.trim(), display_order: count ? 99 : 0 })
          .returning();
        // Seed stages: given, else a sensible default with Won/Lost terminals.
        const stageDefs = dto.stages?.length
          ? dto.stages
          : [
              { name: 'Qualified', win_probability: 10, stage_type: 'open' },
              { name: 'Proposal', win_probability: 60, stage_type: 'open' },
              { name: 'Won', win_probability: 100, stage_type: 'won' },
              { name: 'Lost', win_probability: 0, stage_type: 'lost' },
            ];
        this.assertTerminals(stageDefs);
        await tx.insert(pipelineStages).values(
          stageDefs.map((s, i) => ({
            tenant_id: tenantId,
            pipeline_id: p!.id,
            name: s.name,
            display_order: i,
            win_probability: s.win_probability ?? 0,
            rotting_days: s.rotting_days ?? null,
            stage_type: s.stage_type ?? 'open',
          })),
        );
        await this.audit.log({
          tenantId,
          actorUserId: userId,
          action: 'crm.pipeline.create',
          resourceType: 'pipeline',
          resourceId: p!.id,
        });
        return { data: p! };
      },
      userId,
    );
  }

  private assertTerminals(stages: Array<{ stage_type?: string }>) {
    const won = stages.filter((s) => s.stage_type === 'won').length;
    const lost = stages.filter((s) => s.stage_type === 'lost').length;
    if (won !== 1 || lost !== 1) {
      throw new BadRequestException('A pipeline needs exactly one Won and one Lost stage');
    }
  }
}
