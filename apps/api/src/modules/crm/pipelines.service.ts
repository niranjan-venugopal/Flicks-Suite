import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { deals, pipelines, pipelineStages, lostReasons } from '@flicks/db/schema';
import type { Db } from '@flicks/db';
import { DatabaseService } from '../../core/database/database.service';
import { AuditService } from '../audit/audit.service';
import { ensureDefaultLostReasons } from './lost-reasons.seed';

const seedLogger = new Logger('ensureDefaultPipeline');

/**
 * The default "Sales" pipeline migration 0032 seeded for the tenants that
 * existed when it ran — the same stages `DealsService.ensureDefaultPipeline`
 * heals for the board / deal-create paths.
 */
const DEFAULT_PIPELINE_STAGES: ReadonlyArray<
  [name: string, winProbability: number, rottingDays: number | null, stageType: string]
> = [
  ['Qualified', 10, null, 'open'],
  ['Contact Made', 25, null, 'open'],
  ['Demo Scheduled', 40, 7, 'open'],
  ['Proposal Sent', 60, 10, 'open'],
  ['Negotiation', 80, 10, 'open'],
  ['Won', 100, null, 'won'],
  ['Lost', 0, null, 'lost'],
];

type LivePipeline = { id: string; name: string; is_default: boolean; created_at: Date };

/** Every live pipeline of the tenant, oldest first (a tenant has a handful). */
function livePipelines(tx: Db, tenantId: string): Promise<LivePipeline[]> {
  return tx
    .select({
      id: pipelines.id,
      name: pipelines.name,
      is_default: pipelines.is_default,
      created_at: pipelines.created_at,
    })
    .from(pipelines)
    .where(and(eq(pipelines.tenant_id, tenantId), isNull(pipelines.deleted_at)))
    .orderBy(asc(pipelines.created_at), asc(pipelines.id));
}

/**
 * The signature of a seeded default: `is_default` is written ONLY by the two
 * seeders (migration 0032 and the heal below / `DealsService`'s copy) and the
 * name is always "Sales" — `createPipeline` never sets it, so a tenant with
 * two live rows matching this was seeded twice.
 */
const isSeededDefault = (p: LivePipeline) => p.is_default && p.name === 'Sales';

/**
 * Collapse a double seed. `GET /crm/pipelines` (this seeder, advisory-locked)
 * and `GET /crm/board` (`DealsService.ensureDefaultPipeline`, a plain
 * read→insert with NO lock) run concurrently from `/crm/deals`, and nothing
 * in the schema makes two default "Sales" rows impossible — so on a tenant
 * that has lost reasons but no pipeline yet, both transactions can insert and
 * both commit (reproduced locally 4/6 runs). Until the board/deal-create
 * paths call THIS helper, heal on the next read: keep the oldest seeded
 * default (or the one that already holds deals), soft-delete the deal-less
 * extras and their stages. Never touches a pipeline that holds a deal, a
 * user-created pipeline (`is_default=false`) or a renamed one.
 */
async function collapseDuplicateDefaults(tx: Db, tenantId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`pipelines:${tenantId}`}))`);
  const dupes = (await livePipelines(tx, tenantId)).filter(isSeededDefault);
  if (dupes.length < 2) return;

  const inUse = await tx
    .select({ pipeline_id: deals.pipeline_id })
    .from(deals)
    .where(
      and(
        eq(deals.tenant_id, tenantId),
        inArray(
          deals.pipeline_id,
          dupes.map((p) => p.id),
        ),
        isNull(deals.deleted_at),
      ),
    )
    .groupBy(deals.pipeline_id);
  const used = new Set(inUse.map((r) => r.pipeline_id));
  const keeper = dupes.find((p) => used.has(p.id)) ?? dupes[0]!;
  const victims = dupes.filter((p) => p.id !== keeper.id && !used.has(p.id)).map((p) => p.id);
  if (victims.length === 0) return;

  const now = new Date();
  await tx
    .update(pipelineStages)
    .set({ deleted_at: now })
    .where(
      and(
        eq(pipelineStages.tenant_id, tenantId),
        inArray(pipelineStages.pipeline_id, victims),
        isNull(pipelineStages.deleted_at),
      ),
    );
  await tx
    .update(pipelines)
    .set({ deleted_at: now })
    .where(and(eq(pipelines.tenant_id, tenantId), inArray(pipelines.id, victims), isNull(pipelines.deleted_at)));
  seedLogger.warn(
    `tenant ${tenantId}: collapsed ${victims.length} duplicate default pipeline(s) (double seed) — kept ${keeper.id}`,
  );
}

/**
 * Guarantee the tenant has a pipeline (Round P R1.6). Tenants created after
 * migration 0032 have none, and while the board / deal-create paths heal
 * that, `GET /crm/pipelines` did not — so `/crm/deals` fetched the pipeline
 * list first, cached `[]`, and showed an empty CRM. Same default as
 * `DealsService.ensureDefaultPipeline` (lost reasons first, then "Sales"
 * with its seven stages); idempotent and race-safe like
 * `ensureDefaultLostReasons` (fast-path read → per-tenant advisory lock →
 * re-check → insert). Must run inside a tenant transaction.
 *
 * The advisory lock only serialises callers of THIS function — see
 * `collapseDuplicateDefaults` for the unlocked `DealsService` copy it still
 * races against, and why a second seeded default is healed on read.
 */
export async function ensureDefaultPipeline(tx: Db, tenantId: string): Promise<void> {
  await ensureDefaultLostReasons(tx, tenantId);
  const existing = await livePipelines(tx, tenantId);
  if (existing.length > 0) {
    if (existing.filter(isSeededDefault).length > 1) await collapseDuplicateDefaults(tx, tenantId);
    return;
  }

  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`pipelines:${tenantId}`}))`);
  const again = await livePipelines(tx, tenantId);
  if (again.length > 0) {
    if (again.filter(isSeededDefault).length > 1) await collapseDuplicateDefaults(tx, tenantId);
    return;
  }

  const [pl] = await tx
    .insert(pipelines)
    .values({ tenant_id: tenantId, name: 'Sales', is_default: true, display_order: 0 })
    .returning();
  await tx.insert(pipelineStages).values(
    DEFAULT_PIPELINE_STAGES.map(([name, prob, rot, type], i) => ({
      tenant_id: tenantId,
      pipeline_id: pl!.id,
      name,
      display_order: i,
      win_probability: prob,
      rotting_days: rot,
      stage_type: type,
    })),
  );
}

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
      // Round P R1.6: heal on read so a fresh tenant never caches an empty
      // pipeline list (the board and deal-create paths already do this).
      await ensureDefaultPipeline(tx, tenantId);
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
      // Round I: tenants created after migration 0032 had no reasons at all,
      // so the "Mark as lost" dialog could never be confirmed. Heal on read.
      await ensureDefaultLostReasons(tx, tenantId);
      const rows = await tx
        .select()
        .from(lostReasons)
        .where(and(eq(lostReasons.tenant_id, tenantId), eq(lostReasons.archived, false)))
        .orderBy(asc(lostReasons.display_order), asc(lostReasons.label));
      return { data: rows };
    });
  }

  /**
   * Resolve the default pipeline (or first). Heals a missing one like
   * `list()`; the NotFound below is only reachable if the seed itself failed.
   */
  async defaultPipeline(tenantId: string) {
    return this.db.withTenant(tenantId, async (tx) => {
      await ensureDefaultPipeline(tx, tenantId);
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
