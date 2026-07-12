import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { and, asc, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import {
  dealProducts,
  deals,
  dealStageHistory,
  directoryCompanies,
  directoryPeople,
  memberships,
  pipelines,
  pipelineStages,
  tenants,
} from '@flicks/db/schema';
import type { Db } from '@flicks/db';
import type { JwtPayload } from '@flicks/shared/types';
import { DatabaseService } from '../../core/database/database.service';
import { AuditService } from '../audit/audit.service';
import { DomainEventsService } from '../../core/events/domain-events.service';
import { InvoicingPublicService } from '../invoicing/public';
import { FxService } from './fx.service';

/**
 * Deals & the kanban board (PRD v5 §4). Money is stored in the deal's own
 * currency plus a base-currency snapshot (value_base_amount) taken at set-time
 * via FxService, so board/forecast sums and reports are stable regardless of
 * later rate moves (§12.1). Stage moves are transactional: they write
 * deal_stage_history, maintain stage_entered_at, apply won/lost semantics, and
 * publish domain events + a socket broadcast for the live board.
 */
@Injectable()
export class DealsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly domainEvents: DomainEventsService,
    private readonly fx: FxService,
    private readonly eventEmitter: EventEmitter2,
    private readonly invoicing: InvoicingPublicService,
  ) {}

  private async baseCurrency(tx: Db, tenantId: string): Promise<string> {
    const [t] = await tx.select({ currency: tenants.currency }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    return t?.currency ?? 'INR';
  }

  private async loadStage(tx: Db, tenantId: string, stageId: string) {
    const [s] = await tx
      .select()
      .from(pipelineStages)
      .where(and(eq(pipelineStages.id, stageId), isNull(pipelineStages.deleted_at)))
      .limit(1);
    if (!s) throw new BadRequestException('Stage not found in this pipeline');
    return s;
  }

  /**
   * Validate that inbound foreign-key references belong to THIS tenant before we
   * write them onto a deal. Postgres FK checks run as the table owner and bypass
   * RLS, so a global-by-id FK (company_id, primary_person_id, owner_user_id)
   * would happily accept another tenant's row id. These lookups run under the
   * tenant transaction (RLS-scoped), so a cross-tenant id resolves to nothing
   * and is rejected. `owner_user_id` must be a live (non-deactivated) member.
   */
  private async assertRefsInTenant(
    tx: Db,
    tenantId: string,
    refs: { company_id?: string | null; primary_person_id?: string | null; owner_user_id?: string | null },
  ): Promise<void> {
    if (refs.company_id) {
      const [c] = await tx
        .select({ id: directoryCompanies.id })
        .from(directoryCompanies)
        .where(and(eq(directoryCompanies.id, refs.company_id), isNull(directoryCompanies.deleted_at)))
        .limit(1);
      if (!c) throw new BadRequestException('company_id does not belong to this workspace');
    }
    if (refs.primary_person_id) {
      const [p] = await tx
        .select({ id: directoryPeople.id })
        .from(directoryPeople)
        .where(and(eq(directoryPeople.id, refs.primary_person_id), isNull(directoryPeople.deleted_at)))
        .limit(1);
      if (!p) throw new BadRequestException('primary_person_id does not belong to this workspace');
    }
    if (refs.owner_user_id) {
      const [m] = await tx
        .select({ id: memberships.id })
        .from(memberships)
        .where(
          and(
            eq(memberships.tenant_id, tenantId),
            eq(memberships.user_id, refs.owner_user_id),
            ne(memberships.status, 'deactivated'),
          ),
        )
        .limit(1);
      if (!m) throw new BadRequestException('owner_user_id is not an active member of this workspace');
    }
  }

  // ─── Board (kanban) ─────────────────────────────────────────────────────────
  /** Open deals for a pipeline, grouped by stage, with count + base sum + weighted sum. */
  async board(tenantId: string, pipelineId?: string) {
    return this.db.withTenant(tenantId, async (tx) => {
      const base = await this.baseCurrency(tx, tenantId);
      const pl = pipelineId
        ? (await tx.select().from(pipelines).where(and(eq(pipelines.id, pipelineId), isNull(pipelines.deleted_at))).limit(1))[0]
        : (await tx.select().from(pipelines).where(isNull(pipelines.deleted_at)).orderBy(asc(pipelines.display_order)).limit(1))[0];
      if (!pl) throw new NotFoundException('Pipeline not found');

      const stages = await tx
        .select()
        .from(pipelineStages)
        .where(and(eq(pipelineStages.pipeline_id, pl.id), isNull(pipelineStages.deleted_at)))
        .orderBy(asc(pipelineStages.display_order));

      const openDeals = await tx
        .select()
        .from(deals)
        .where(and(eq(deals.pipeline_id, pl.id), eq(deals.status, 'open'), isNull(deals.deleted_at)))
        .orderBy(desc(deals.updated_at));

      const now = Date.now();
      const columns = stages
        .filter((s) => s.stage_type === 'open')
        .map((s) => {
          const cards = openDeals
            .filter((d) => d.stage_id === s.id)
            .map((d) => {
              const enteredMs = new Date(d.stage_entered_at as unknown as string).getTime();
              const idleDays = Math.floor((now - enteredMs) / 86_400_000);
              const rot = s.rotting_days ?? null;
              const rotState = rot == null ? null : idleDays >= rot * 1.5 ? 'red' : idleDays >= rot ? 'amber' : null;
              return { ...d, idle_days: idleDays, rot_state: rotState };
            });
          const sumBase = cards.reduce((a, d) => a + parseFloat(d.value_base_amount), 0);
          const weighted = cards.reduce((a, d) => a + parseFloat(d.value_base_amount) * (s.win_probability / 100), 0);
          return {
            stage: s,
            cards,
            count: cards.length,
            sum_base: Math.round(sumBase * 100) / 100,
            weighted_base: Math.round(weighted * 100) / 100,
          };
        });

      return { data: { pipeline: pl, base_currency: base, columns } };
    });
  }

  async get(tenantId: string, id: string) {
    return this.db.withTenant(tenantId, async (tx) => {
      const [d] = await tx.select().from(deals).where(and(eq(deals.id, id), isNull(deals.deleted_at))).limit(1);
      if (!d) throw new NotFoundException('Deal not found');
      const history = await tx
        .select()
        .from(dealStageHistory)
        .where(eq(dealStageHistory.deal_id, id))
        .orderBy(desc(dealStageHistory.changed_at));
      return { data: { ...d, stage_history: history } };
    });
  }

  // ─── Create ─────────────────────────────────────────────────────────────────
  async create(
    tenantId: string,
    userId: string,
    dto: {
      title: string;
      pipeline_id?: string;
      stage_id?: string;
      company_id?: string;
      primary_person_id?: string;
      owner_user_id?: string;
      value_amount?: number;
      currency?: string;
      expected_close_date?: string;
      source?: string;
    },
  ) {
    if (!dto.title?.trim()) throw new BadRequestException('Deal title is required');

    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const base = await this.baseCurrency(tx, tenantId);
        // Resolve pipeline + entry stage (first open stage of the pipeline).
        const pl = dto.pipeline_id
          ? (await tx.select().from(pipelines).where(and(eq(pipelines.id, dto.pipeline_id), isNull(pipelines.deleted_at))).limit(1))[0]
          : (await tx.select().from(pipelines).where(isNull(pipelines.deleted_at)).orderBy(asc(pipelines.display_order)).limit(1))[0];
        if (!pl) throw new BadRequestException('No pipeline available');
        const stages = await tx
          .select()
          .from(pipelineStages)
          .where(and(eq(pipelineStages.pipeline_id, pl.id), isNull(pipelineStages.deleted_at)))
          .orderBy(asc(pipelineStages.display_order));
        const stage = dto.stage_id
          ? stages.find((s) => s.id === dto.stage_id)
          : stages.find((s) => s.stage_type === 'open');
        if (!stage) throw new BadRequestException('No valid stage for this pipeline');

        // Reject cross-tenant / dangling references before writing them (FK
        // checks bypass RLS). owner defaults to the acting user, who is a member.
        await this.assertRefsInTenant(tx, tenantId, {
          company_id: dto.company_id ?? null,
          primary_person_id: dto.primary_person_id ?? null,
          owner_user_id: dto.owner_user_id ?? null,
        });

        const currency = (dto.currency ?? base).toUpperCase();
        const amount = dto.value_amount ?? 0;
        const { fxRate, baseAmount } = await this.fx.toBase(amount, currency, base);

        const [d] = await tx
          .insert(deals)
          .values({
            tenant_id: tenantId,
            pipeline_id: pl.id,
            stage_id: stage.id,
            title: dto.title.trim(),
            company_id: dto.company_id ?? null,
            primary_person_id: dto.primary_person_id ?? null,
            owner_user_id: dto.owner_user_id ?? userId,
            value_amount: amount.toFixed(2),
            currency,
            fx_rate_to_base: fxRate.toFixed(6),
            value_base_amount: baseAmount.toFixed(2),
            expected_close_date: dto.expected_close_date ?? null,
            status: stage.stage_type === 'open' ? 'open' : stage.stage_type,
            source: dto.source ?? 'manual',
            created_by: userId,
            updated_by: userId,
          })
          .returning();

        await tx.insert(dealStageHistory).values({
          tenant_id: tenantId,
          deal_id: d!.id,
          from_stage_id: null,
          to_stage_id: stage.id,
          changed_by: userId,
        });

        await this.audit.log({
          tenantId, actorUserId: userId, action: 'crm.deal.create',
          resourceType: 'deal', resourceId: d!.id,
        });
        await this.domainEvents.publish(
          { name: 'crm.deal.created', tenantId, actorUserId: userId, payload: { deal_id: d!.id, pipeline_id: pl.id, value_base: baseAmount } },
          tx,
        );
        return { data: d! };
      },
      userId,
    );
  }

  // ─── Update (re-snapshots FX if value/currency change) ───────────────────────
  async update(tenantId: string, userId: string, id: string, dto: Record<string, unknown>) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const [existing] = await tx.select().from(deals).where(and(eq(deals.id, id), isNull(deals.deleted_at))).limit(1);
        if (!existing) throw new NotFoundException('Deal not found');

        // Reject cross-tenant / dangling references before writing them.
        await this.assertRefsInTenant(tx, tenantId, {
          company_id: 'company_id' in dto ? (dto.company_id as string | null) : null,
          primary_person_id: 'primary_person_id' in dto ? (dto.primary_person_id as string | null) : null,
          owner_user_id: 'owner_user_id' in dto ? (dto.owner_user_id as string | null) : null,
        });

        const patch: Record<string, unknown> = { updated_by: userId, updated_at: new Date() };
        const allowed = ['title', 'company_id', 'primary_person_id', 'owner_user_id', 'expected_close_date', 'source', 'custom'];
        for (const k of allowed) if (k in dto) patch[k] = dto[k];

        // Value/currency change → re-snapshot to base.
        if ('value_amount' in dto || 'currency' in dto) {
          const base = await this.baseCurrency(tx, tenantId);
          const amount = 'value_amount' in dto ? Number(dto.value_amount) : parseFloat(existing.value_amount);
          const currency = ('currency' in dto ? String(dto.currency) : existing.currency).toUpperCase();
          const { fxRate, baseAmount } = await this.fx.toBase(amount, currency, base);
          patch.value_amount = amount.toFixed(2);
          patch.currency = currency;
          patch.fx_rate_to_base = fxRate.toFixed(6);
          patch.value_base_amount = baseAmount.toFixed(2);
        }

        const [d] = await tx.update(deals).set(patch).where(eq(deals.id, id)).returning();
        await this.audit.log({ tenantId, actorUserId: userId, action: 'crm.deal.update', resourceType: 'deal', resourceId: id });
        await this.domainEvents.publish(
          { name: 'crm.deal.updated', tenantId, actorUserId: userId, payload: { deal_id: id } },
          tx,
        );
        return { data: d! };
      },
      userId,
    );
  }

  // ─── Stage move (the kanban drag-drop) ───────────────────────────────────────
  async moveStage(
    tenantId: string,
    userId: string,
    id: string,
    dto: { stage_id: string; lost_reason_id?: string; lost_reason_note?: string },
  ) {
    const result = await this.db.withTenant(
      tenantId,
      async (tx) => {
        // Row-lock the deal so concurrent stage moves serialize: without FOR
        // UPDATE, two moves under READ COMMITTED both read the same
        // stage_entered_at and write conflicting history / a lost update.
        const [d] = await tx
          .select()
          .from(deals)
          .where(and(eq(deals.id, id), isNull(deals.deleted_at)))
          .limit(1)
          .for('update');
        if (!d) throw new NotFoundException('Deal not found');
        const target = await this.loadStage(tx, tenantId, dto.stage_id);
        if (target.pipeline_id !== d.pipeline_id) {
          throw new BadRequestException('Stage belongs to a different pipeline');
        }
        if (target.id === d.stage_id) return { deal: d, moved: false, target };

        // Lost stages may require a reason.
        if (target.stage_type === 'lost' && !dto.lost_reason_id && !dto.lost_reason_note) {
          // Reason is configurable per tenant; default to optional (accept).
        }

        const now = new Date();
        const secondsInPrev = Math.floor(
          (now.getTime() - new Date(d.stage_entered_at as unknown as string).getTime()) / 1000,
        );
        await tx.insert(dealStageHistory).values({
          tenant_id: tenantId,
          deal_id: id,
          from_stage_id: d.stage_id,
          to_stage_id: target.id,
          changed_by: userId,
          seconds_in_previous_stage: secondsInPrev,
        });

        const patch: Record<string, unknown> = {
          stage_id: target.id,
          stage_entered_at: now,
          updated_by: userId,
          updated_at: now,
        };
        if (target.stage_type === 'won') {
          patch.status = 'won';
          patch.won_at = now;
          patch.lost_at = null;
          // Leaving Lost → clear the stale loss reason.
          patch.lost_reason_id = null;
          patch.lost_reason_note = null;
        } else if (target.stage_type === 'lost') {
          patch.status = 'lost';
          patch.lost_at = now;
          patch.won_at = null;
          patch.lost_reason_id = dto.lost_reason_id ?? null;
          patch.lost_reason_note = dto.lost_reason_note ?? null;
        } else {
          patch.status = 'open';
          patch.won_at = null;
          patch.lost_at = null;
          // Reopened into an open stage → clear any prior loss reason.
          patch.lost_reason_id = null;
          patch.lost_reason_note = null;
        }

        const [updated] = await tx.update(deals).set(patch).where(eq(deals.id, id)).returning();
        await this.audit.log({
          tenantId, actorUserId: userId, action: 'crm.deal.stage_change',
          resourceType: 'deal', resourceId: id,
          metadata: { from: d.stage_id, to: target.id, type: target.stage_type },
        });
        await this.domainEvents.publish(
          { name: 'crm.deal.stage_changed', tenantId, actorUserId: userId, payload: { deal_id: id, to_stage: target.id, status: patch.status } },
          tx,
        );
        if (target.stage_type === 'won') {
          await this.domainEvents.publish({ name: 'crm.deal.won', tenantId, actorUserId: userId, payload: { deal_id: id, value_base: parseFloat(updated!.value_base_amount) } }, tx);
        } else if (target.stage_type === 'lost') {
          await this.domainEvents.publish({ name: 'crm.deal.lost', tenantId, actorUserId: userId, payload: { deal_id: id, lost_reason_id: dto.lost_reason_id ?? null } }, tx);
        }
        return { deal: updated!, moved: true, target };
      },
      userId,
    );

    // Live board broadcast (in-process → CRM socket gateway).
    if (result.moved) {
      this.eventEmitter.emit('crm.board.changed', {
        tenantId,
        pipelineId: result.deal.pipeline_id,
        dealId: id,
        stageId: result.target.id,
      });
    }
    return { data: result.deal };
  }

  // ─── Reopen (won/lost → open) — manager-and-up, enforced at controller ───────
  async reopen(tenantId: string, user: JwtPayload, id: string) {
    if (!['owner', 'admin', 'manager'].includes(user.role)) {
      throw new ForbiddenException('Only managers and above can reopen a deal');
    }
    const result = await this.db.withTenant(
      tenantId,
      async (tx) => {
        const [d] = await tx
          .select()
          .from(deals)
          .where(and(eq(deals.id, id), isNull(deals.deleted_at)))
          .limit(1)
          .for('update');
        if (!d) throw new NotFoundException('Deal not found');
        if (d.status === 'open') return { deal: d, moved: false };
        // Move back to the first open stage of the pipeline. Refuse to reopen a
        // pipeline that has no open stage rather than strand the deal on the
        // won/lost column it currently sits in.
        const [firstOpen] = await tx
          .select()
          .from(pipelineStages)
          .where(and(eq(pipelineStages.pipeline_id, d.pipeline_id), eq(pipelineStages.stage_type, 'open'), isNull(pipelineStages.deleted_at)))
          .orderBy(asc(pipelineStages.display_order))
          .limit(1);
        if (!firstOpen) throw new BadRequestException('This pipeline has no open stage to reopen into');

        const now = new Date();
        const secondsInPrev = Math.floor(
          (now.getTime() - new Date(d.stage_entered_at as unknown as string).getTime()) / 1000,
        );
        // Reopening is a stage move too — record it so history stays coherent.
        await tx.insert(dealStageHistory).values({
          tenant_id: tenantId,
          deal_id: id,
          from_stage_id: d.stage_id,
          to_stage_id: firstOpen.id,
          changed_by: user.sub,
          seconds_in_previous_stage: secondsInPrev,
        });
        const [updated] = await tx
          .update(deals)
          .set({ status: 'open', won_at: null, lost_at: null, lost_reason_id: null, lost_reason_note: null, stage_id: firstOpen.id, stage_entered_at: now, updated_by: user.sub, updated_at: now })
          .where(eq(deals.id, id))
          .returning();
        await this.audit.log({ tenantId, actorUserId: user.sub, action: 'crm.deal.reopen', resourceType: 'deal', resourceId: id });
        await this.domainEvents.publish({ name: 'crm.deal.reopened', tenantId, actorUserId: user.sub, payload: { deal_id: id } }, tx);
        return { deal: updated!, moved: true };
      },
      user.sub,
    );

    if (result.moved) {
      this.eventEmitter.emit('crm.board.changed', {
        tenantId,
        pipelineId: result.deal.pipeline_id,
        dealId: id,
        stageId: result.deal.stage_id,
      });
    }
    return { data: result.deal };
  }

  /**
   * Deal → DRAFT invoice (§4.4, the flagship suite hook). Resolves (or creates)
   * the billing customer from the deal's linked directory company/person via the
   * invoicing facade, turns deal_products (or the deal value) into lines, creates
   * a DRAFT invoice back-linked to the deal, and echoes it on the timeline.
   * Returns the invoice id so the UI can open the existing invoice editor.
   */
  async createInvoice(tenantId: string, userId: string, dealId: string) {
    // Gather the deal + products + directory refs (app-role, tenant-scoped).
    const { deal, products, company, person } = await this.db.withTenant(tenantId, async (tx) => {
      const [d] = await tx.select().from(deals).where(and(eq(deals.id, dealId), isNull(deals.deleted_at))).limit(1);
      if (!d) throw new NotFoundException('Deal not found');
      const prods = await tx.select().from(dealProducts).where(eq(dealProducts.deal_id, dealId)).orderBy(asc(dealProducts.display_order));
      const [co] = d.company_id
        ? await tx.select().from(directoryCompanies).where(eq(directoryCompanies.id, d.company_id)).limit(1)
        : [undefined];
      const [pe] = d.primary_person_id
        ? await tx.select().from(directoryPeople).where(eq(directoryPeople.id, d.primary_person_id)).limit(1)
        : [undefined];
      return { deal: d, products: prods, company: co, person: pe };
    });

    // Idempotency: a deal maps to at most one draft invoice. If we already
    // minted one, return it instead of creating a duplicate (double-click, retry).
    if (deal.invoice_id) {
      const existing = await this.invoicing.getInvoiceRef(tenantId, deal.invoice_id);
      if (existing) {
        return { data: { invoice_id: existing.id, customer_id: existing.customer_id } };
      }
      // Back-link is stale (invoice deleted) — fall through and re-create.
    }

    // Resolve or create the billing customer via the invoicing facade.
    let customer = await this.invoicing.findCustomerByDirectoryRef(tenantId, {
      companyId: deal.company_id,
      personId: deal.primary_person_id,
    });
    if (!customer) {
      const name = company?.name ?? person?.display_name ?? deal.title;
      customer = await this.invoicing.createCustomerFromDirectory(tenantId, userId, {
        display_name: name,
        customer_type: company ? 'business' : 'individual',
        email: (company ? null : person?.email) ?? null,
        phone: company?.phone ?? person?.phone ?? null,
        country_code: company?.country_code ?? null,
        directory_company_id: deal.company_id,
        directory_person_id: deal.primary_person_id,
      });
    }

    // Lines: from deal_products, else a single line for the deal value. Bill the
    // DISCOUNTED per-unit rate (line_total / quantity) so a product's discount_pct
    // is carried onto the invoice instead of being silently dropped (over-billing).
    const lines = products.length
      ? products.map((p) => {
          const qty = parseFloat(p.quantity);
          const lineTotal = parseFloat(p.line_total);
          const effRate = qty !== 0 ? lineTotal / qty : lineTotal;
          return {
            item_id: p.item_id ?? undefined,
            item_name: p.name,
            quantity: p.quantity,
            rate: effRate.toFixed(2),
          };
        })
      : [{ item_name: deal.title, quantity: '1', rate: deal.value_amount }];

    const invoice = await this.invoicing.createDraftInvoiceFromDeal(tenantId, userId, {
      dealId,
      customerId: customer.id,
      currency: deal.currency,
      lines,
    });

    await this.audit.log({ tenantId, actorUserId: userId, action: 'crm.deal.invoice_created', resourceType: 'deal', resourceId: dealId, metadata: { invoice_id: invoice.id } });
    await this.domainEvents.publish({ name: 'crm.deal.invoice_created', tenantId, actorUserId: userId, payload: { deal_id: dealId, invoice_id: invoice.id } });
    return { data: { invoice_id: invoice.id, customer_id: customer.id } };
  }

  async remove(tenantId: string, userId: string, id: string) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const [d] = await tx
          .update(deals)
          .set({ deleted_at: new Date(), updated_by: userId })
          .where(and(eq(deals.id, id), isNull(deals.deleted_at)))
          .returning({ id: deals.id });
        if (!d) throw new NotFoundException('Deal not found');
        await this.audit.log({ tenantId, actorUserId: userId, action: 'crm.deal.delete', resourceType: 'deal', resourceId: id });
        return { data: { deleted: true } };
      },
      userId,
    );
  }

  /** Weighted forecast for a pipeline/period (base currency). */
  async forecast(tenantId: string, pipelineId?: string) {
    return this.db.withTenant(tenantId, async (tx) => {
      const base = await this.baseCurrency(tx, tenantId);
      const rows = await tx
        .select({
          open_count: sql<number>`count(*) filter (where ${deals.status} = 'open')::int`,
          open_base: sql<number>`coalesce(sum(${deals.value_base_amount}) filter (where ${deals.status} = 'open'),0)`,
          won_base: sql<number>`coalesce(sum(${deals.value_base_amount}) filter (where ${deals.status} = 'won'),0)`,
        })
        .from(deals)
        .where(and(isNull(deals.deleted_at), pipelineId ? eq(deals.pipeline_id, pipelineId) : undefined));
      // Weighted = Σ open value_base × stage win_probability.
      const [{ weighted }] = await tx
        .select({ weighted: sql<number>`coalesce(sum(${deals.value_base_amount} * ${pipelineStages.win_probability} / 100.0),0)` })
        .from(deals)
        .innerJoin(pipelineStages, eq(pipelineStages.id, deals.stage_id))
        .where(and(eq(deals.status, 'open'), isNull(deals.deleted_at), pipelineId ? eq(deals.pipeline_id, pipelineId) : undefined));
      const r = rows[0]!;
      return {
        data: {
          base_currency: base,
          open_count: r.open_count,
          open_value: Number(r.open_base),
          weighted_value: Math.round(Number(weighted) * 100) / 100,
          won_value: Number(r.won_base),
        },
      };
    });
  }
}
