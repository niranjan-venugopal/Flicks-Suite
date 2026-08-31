import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { deals, leads, users, workflowRuns, workflows } from '@flicks/db/schema';
import type { DbAdmin } from '@flicks/db';
import { DB_SERVICE_ROLE } from '../../core/database/database.module';
import { DatabaseService } from '../../core/database/database.service';
import { AuditService } from '../audit/audit.service';
import { DomainEventsService, type DomainEventEnvelope } from '../../core/events/domain-events.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ActivitiesService } from './activities.service';
import { DealsService } from './deals.service';
import { LeadsService } from './leads.service';
import { CrmEmailService } from './email.service';

/**
 * Workflows (PRD v5 §8, C12): trigger → conditions → actions over the domain-
 * event bus. Guards (also promised in the builder UI):
 *  • idempotent — one run per (workflow, event), enforced by unique index;
 *  • loop-protected — chain depth ≤ 2 per subject/minute, then runs are
 *    recorded as `skipped` instead of firing;
 *  • capped — 20 active workflows, 2,000 runs/tenant/day;
 *  • email actions go through CrmEmailService, so DNC and the daily send
 *    throttle apply exactly as they do to humans.
 */

export const WORKFLOW_TRIGGERS = [
  'crm.lead.created',
  'crm.form.submitted',
  'crm.deal.created',
  'crm.deal.stage_changed',
  'crm.deal.won',
  'crm.deal.lost',
  'crm.activity.overdue',
  'crm.email.bounced',
  'crm.email.replied',
] as const;

const CONDITION_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'starts_with', 'is_set', 'not_set'] as const;
const ACTION_TYPES = ['create_activity', 'notify', 'assign_owner_round_robin', 'send_template_email', 'move_stage'] as const;

const MAX_ACTIVE_WORKFLOWS = 20;
const MAX_RUNS_PER_DAY = 2_000;
const MAX_CHAIN_PER_MINUTE = 2;

export interface WorkflowCondition {
  field: string;
  op: (typeof CONDITION_OPS)[number];
  value?: string | number;
}
export interface WorkflowAction {
  type: (typeof ACTION_TYPES)[number];
  // create_activity
  activity_type?: string;
  subject?: string;
  due_in_hours?: number;
  assign_to?: 'owner' | 'actor' | string;
  // notify
  target?: 'owner' | 'actor' | string;
  message?: string;
  // send_template_email
  template_id?: string;
  // move_stage
  stage_id?: string;
}

type RunStep = { label: string; status: 'ok' | 'error' | 'skipped'; error?: string };

@Injectable()
export class WorkflowsService {
  private readonly logger = new Logger(WorkflowsService.name);

  constructor(
    private readonly db: DatabaseService,
    @Inject(DB_SERVICE_ROLE) private readonly dbAdmin: DbAdmin,
    private readonly audit: AuditService,
    private readonly domainEvents: DomainEventsService,
    private readonly notifications: NotificationsService,
    private readonly activities: ActivitiesService,
    private readonly deals: DealsService,
    private readonly leads: LeadsService,
    private readonly email: CrmEmailService,
  ) {}

  // ─── Management ──────────────────────────────────────────────────────────────

  async list(tenantId: string) {
    return this.db.withTenant(tenantId, async (tx) => {
      const rows = await tx.select().from(workflows).orderBy(desc(workflows.created_at));
      return { data: rows, limits: { max_active: MAX_ACTIVE_WORKFLOWS, runs_per_day: MAX_RUNS_PER_DAY, chain_depth: MAX_CHAIN_PER_MINUTE } };
    });
  }

  async create(
    tenantId: string,
    userId: string,
    dto: { name: string; trigger: string; conditions?: WorkflowCondition[]; actions?: WorkflowAction[]; active?: boolean },
  ) {
    if (!dto.name?.trim()) throw new BadRequestException('Workflow name is required');
    if (!WORKFLOW_TRIGGERS.includes(dto.trigger as never)) {
      throw new BadRequestException(`Unknown trigger — use one of: ${WORKFLOW_TRIGGERS.join(', ')}`);
    }
    const conditions = this.validateConditions(dto.conditions ?? []);
    const actions = this.validateActions(dto.actions ?? []);

    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(workflows).where(eq(workflows.active, true));
        if ((dto.active ?? true) && n! >= MAX_ACTIVE_WORKFLOWS) {
          throw new BadRequestException(`Beta limit: max ${MAX_ACTIVE_WORKFLOWS} active workflows — pause one first`);
        }
        const [row] = await tx
          .insert(workflows)
          .values({
            tenant_id: tenantId,
            name: dto.name.trim(),
            trigger: dto.trigger,
            conditions,
            actions,
            active: dto.active ?? true,
            created_by: userId,
          })
          .returning();
        await this.audit.log({ tenantId, actorUserId: userId, action: 'crm.workflow.create', resourceType: 'workflow', resourceId: row!.id });
        return { data: row! };
      },
      userId,
    );
  }

  async setActive(tenantId: string, userId: string, id: string, active: boolean) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        if (active) {
          const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(workflows).where(and(eq(workflows.active, true), sql`${workflows.id} <> ${id}`));
          if (n! >= MAX_ACTIVE_WORKFLOWS) throw new BadRequestException(`Beta limit: max ${MAX_ACTIVE_WORKFLOWS} active workflows`);
        }
        const [row] = await tx.update(workflows).set({ active, updated_at: new Date() }).where(eq(workflows.id, id)).returning();
        if (!row) throw new NotFoundException('Workflow not found');
        return { data: row };
      },
      userId,
    );
  }

  async runs(tenantId: string, workflowId?: string) {
    return this.db.withTenant(tenantId, async (tx) => {
      const rows = await tx
        .select({ run: workflowRuns, workflow_name: workflows.name })
        .from(workflowRuns)
        .innerJoin(workflows, eq(workflows.id, workflowRuns.workflow_id))
        .where(workflowId ? eq(workflowRuns.workflow_id, workflowId) : undefined)
        .orderBy(desc(workflowRuns.created_at))
        .limit(100);
      return { data: rows.map((r) => ({ ...r.run, workflow_name: r.workflow_name })) };
    });
  }

  // ─── Engine ──────────────────────────────────────────────────────────────────

  /** Every CRM domain event flows through here (in-process lane, wildcard). */
  @OnEvent('domain.crm.**')
  async onDomainEvent(env: DomainEventEnvelope): Promise<void> {
    try {
      await this.handle(env);
    } catch (err) {
      this.logger.error(`workflow engine failed for ${env.name}: ${err instanceof Error ? err.message : err}`);
    }
  }

  async handle(env: DomainEventEnvelope): Promise<number> {
    if (!env.tenantId || !WORKFLOW_TRIGGERS.includes(env.name as never)) return 0;
    const tenantId = env.tenantId;

    const candidates = await this.dbAdmin
      .select()
      .from(workflows)
      .where(and(eq(workflows.tenant_id, tenantId), eq(workflows.trigger, env.name), eq(workflows.active, true)));
    if (candidates.length === 0) return 0;

    // Daily cap (beta limit) — checked once per event.
    const dayStart = new Date(new Date().toISOString().slice(0, 10));
    const [{ today }] = await this.dbAdmin
      .select({ today: sql<number>`count(*)::int` })
      .from(workflowRuns)
      .where(and(eq(workflowRuns.tenant_id, tenantId), gte(workflowRuns.created_at, dayStart)));
    if (today! >= MAX_RUNS_PER_DAY) {
      this.logger.warn(`tenant ${tenantId}: workflow daily run cap reached (${MAX_RUNS_PER_DAY})`);
      return 0;
    }

    const subject = this.subjectOf(env);
    const ctx = await this.buildContext(tenantId, env, subject);

    let fired = 0;
    for (const wf of candidates) {
      const conditions = (wf.conditions as WorkflowCondition[]) ?? [];
      if (!conditions.every((c) => this.evalCondition(c, ctx))) continue;

      // Loop guard: same subject churning through workflows within a minute.
      let depth = 0;
      if (subject.id) {
        const [{ recent }] = await this.dbAdmin
          .select({ recent: sql<number>`count(*)::int` })
          .from(workflowRuns)
          .where(and(
            eq(workflowRuns.tenant_id, tenantId),
            eq(workflowRuns.subject_id, subject.id),
            gte(workflowRuns.created_at, new Date(Date.now() - 60_000)),
            sql`${workflowRuns.status} <> 'skipped'`,
          ));
        depth = recent!;
      }

      // Claim the (workflow, event) pair — redelivery lands on the conflict.
      const [claim] = await this.dbAdmin
        .insert(workflowRuns)
        .values({
          tenant_id: tenantId,
          workflow_id: wf.id,
          event_id: env.id,
          subject_type: subject.type,
          subject_id: subject.id,
          status: depth >= MAX_CHAIN_PER_MINUTE ? 'skipped' : 'ok',
          steps: depth >= MAX_CHAIN_PER_MINUTE ? [{ label: `Loop guard — chain depth ${depth} reached, actions skipped`, status: 'skipped' }] : [],
          depth,
        })
        .onConflictDoNothing()
        .returning();
      if (!claim) continue; // already ran for this event
      if (claim.status === 'skipped') {
        this.logger.warn(`workflow ${wf.id}: loop guard tripped for subject ${subject.id}`);
        continue;
      }

      const steps = await this.execute(tenantId, env, wf, ctx, subject);
      const failed = steps.some((s) => s.status === 'error');
      await this.dbAdmin.update(workflowRuns).set({ status: failed ? 'error' : 'ok', steps }).where(eq(workflowRuns.id, claim.id));
      await this.dbAdmin
        .update(workflows)
        .set({ runs_count: sql`${workflows.runs_count} + 1`, last_run_at: new Date() })
        .where(eq(workflows.id, wf.id));
      await this.domainEvents.publish({
        name: failed ? 'crm.workflow.run_failed' : 'crm.workflow.run_completed',
        tenantId,
        payload: { workflow_id: wf.id, run_id: claim.id, trigger: env.name, subject_id: subject.id },
      });
      fired += 1;
    }
    return fired;
  }

  private async execute(
    tenantId: string,
    env: DomainEventEnvelope,
    wf: typeof workflows.$inferSelect,
    ctx: Record<string, unknown>,
    subject: { type: string | null; id: string | null },
  ): Promise<RunStep[]> {
    const steps: RunStep[] = [];
    const actingUser = wf.created_by ?? env.actorUserId ?? (ctx.owner_user_id as string | null);
    const resolveUser = (spec?: string): string | null => {
      if (spec === 'owner' || !spec) return (ctx.owner_user_id as string | null) ?? actingUser;
      if (spec === 'actor') return env.actorUserId ?? actingUser;
      return spec;
    };

    for (const action of (wf.actions as WorkflowAction[]) ?? []) {
      try {
        switch (action.type) {
          case 'create_activity': {
            if (!actingUser) throw new Error('no acting user available');
            const assignee = resolveUser(action.assign_to);
            await this.activities.create(tenantId, actingUser, {
              type: action.activity_type ?? 'task',
              subject: action.subject ?? 'Follow up',
              deal_id: (ctx.deal_id as string) || undefined,
              person_id: (ctx.person_id as string) || undefined,
              assignee_user_id: assignee ?? undefined,
              due_at: new Date(Date.now() + (action.due_in_hours ?? 24) * 3600_000).toISOString(),
            });
            steps.push({ label: `Task created — “${action.subject ?? 'Follow up'}”`, status: 'ok' });
            break;
          }
          case 'notify': {
            const target = resolveUser(action.target);
            if (!target) throw new Error('nobody to notify');
            const link = ctx.deal_id ? `/crm/deals/${ctx.deal_id as string}` : ctx.lead_id ? '/crm/leads' : '/crm';
            // Detached (round C): never throws at source, so the awaited
            // version couldn't fail this step either — it only added latency.
            void this.notifications.createInAppNotification(
              target,
              'crm.workflow.notify',
              action.message?.slice(0, 300) || `Workflow “${wf.name}” fired`,
              link,
              tenantId,
            );
            steps.push({ label: 'Notification sent', status: 'ok' });
            break;
          }
          case 'assign_owner_round_robin': {
            if (subject.type !== 'lead' || !subject.id) throw new Error('round-robin assignment applies to lead triggers');
            const owner = await this.leads.pickRoundRobinOwner(tenantId);
            if (!owner) throw new Error('no eligible members');
            await this.dbAdmin
              .update(leads)
              .set({ owner_user_id: owner, status: sql`CASE WHEN ${leads.status} = 'new' THEN 'working' ELSE ${leads.status} END`, updated_at: new Date() })
              .where(and(eq(leads.id, subject.id), eq(leads.tenant_id, tenantId)));
            ctx.owner_user_id = owner; // later actions (notify owner) see the new owner
            steps.push({ label: 'Owner assigned — round-robin', status: 'ok' });
            break;
          }
          case 'send_template_email': {
            if (!actingUser) throw new Error('no acting user available');
            if (!action.template_id) throw new Error('template_id missing');
            if (!ctx.person_id && !ctx.deal_id) throw new Error('no recipient on this trigger');
            try {
              await this.email.send(tenantId, actingUser, {
                deal_id: (ctx.deal_id as string) || undefined,
                person_id: (ctx.person_id as string) || undefined,
                template_id: action.template_id,
                subject: '',
                body_html: '',
              });
              steps.push({ label: 'Template email sent', status: 'ok' });
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              if (/do.?not.?contact|unsubscribed/i.test(msg)) {
                steps.push({ label: 'Email skipped — recipient is do-not-contact', status: 'skipped' });
              } else throw err;
            }
            break;
          }
          case 'move_stage': {
            if (!actingUser) throw new Error('no acting user available');
            if (!ctx.deal_id) throw new Error('move_stage applies to deal triggers');
            if (!action.stage_id) throw new Error('stage_id missing');
            await this.deals.moveStage(tenantId, actingUser, ctx.deal_id as string, { stage_id: action.stage_id });
            steps.push({ label: 'Deal moved', status: 'ok' });
            break;
          }
        }
      } catch (err) {
        steps.push({ label: this.actionLabel(action), status: 'error', error: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
      }
    }
    return steps;
  }

  // ─── Context & conditions ────────────────────────────────────────────────────

  private subjectOf(env: DomainEventEnvelope): { type: string | null; id: string | null } {
    const p = env.payload;
    if (p.deal_id) return { type: 'deal', id: p.deal_id as string };
    if (p.lead_id) return { type: 'lead', id: p.lead_id as string };
    if (p.activity_id) return { type: 'activity', id: p.activity_id as string };
    if (p.message_id) return { type: 'email', id: p.message_id as string };
    return { type: null, id: null };
  }

  /** Flat context: event payload + live subject columns (ids/enums/amounts). */
  private async buildContext(tenantId: string, env: DomainEventEnvelope, subject: { type: string | null; id: string | null }) {
    const ctx: Record<string, unknown> = { ...env.payload, trigger: env.name };
    if (subject.type === 'deal' && subject.id) {
      const [d] = await this.dbAdmin
        .select({
          stage_id: deals.stage_id,
          pipeline_id: deals.pipeline_id,
          status: deals.status,
          owner_user_id: deals.owner_user_id,
          source: deals.source,
          value_base: deals.value_base_amount,
          currency: deals.currency,
          person_id: deals.primary_person_id,
          company_id: deals.company_id,
        })
        .from(deals)
        .where(and(eq(deals.id, subject.id), eq(deals.tenant_id, tenantId)))
        .limit(1);
      if (d) Object.assign(ctx, { ...d, value_base: Number(d.value_base), deal_id: subject.id });
    }
    if (subject.type === 'lead' && subject.id) {
      const [l] = await this.dbAdmin
        .select({ source: leads.source, score: leads.score, status: leads.status, owner_user_id: leads.owner_user_id, email: leads.email })
        .from(leads)
        .where(and(eq(leads.id, subject.id), eq(leads.tenant_id, tenantId)))
        .limit(1);
      if (l) Object.assign(ctx, { source: l.source, score: l.score, status: l.status, owner_user_id: l.owner_user_id, has_email: Boolean(l.email), lead_id: subject.id });
    }
    return ctx;
  }

  private evalCondition(c: WorkflowCondition, ctx: Record<string, unknown>): boolean {
    const raw = ctx[c.field];
    if (c.op === 'is_set') return raw !== null && raw !== undefined && raw !== '';
    if (c.op === 'not_set') return raw === null || raw === undefined || raw === '';
    const num = Number(raw);
    const cnum = Number(c.value);
    const bothNum = !Number.isNaN(num) && !Number.isNaN(cnum) && raw !== '' && c.value !== '';
    switch (c.op) {
      case 'eq': return bothNum ? num === cnum : String(raw ?? '') === String(c.value ?? '');
      case 'neq': return bothNum ? num !== cnum : String(raw ?? '') !== String(c.value ?? '');
      case 'gt': return bothNum && num > cnum;
      case 'gte': return bothNum && num >= cnum;
      case 'lt': return bothNum && num < cnum;
      case 'lte': return bothNum && num <= cnum;
      case 'contains': return String(raw ?? '').toLowerCase().includes(String(c.value ?? '').toLowerCase());
      case 'starts_with': return String(raw ?? '').toLowerCase().startsWith(String(c.value ?? '').toLowerCase());
      default: return false;
    }
  }

  private actionLabel(a: WorkflowAction): string {
    switch (a.type) {
      case 'create_activity': return `Create task — “${a.subject ?? 'Follow up'}”`;
      case 'notify': return 'Notify';
      case 'assign_owner_round_robin': return 'Assign owner — round-robin';
      case 'send_template_email': return 'Send template email';
      case 'move_stage': return 'Move deal stage';
    }
  }

  private validateConditions(conditions: WorkflowCondition[]): WorkflowCondition[] {
    if (!Array.isArray(conditions) || conditions.length > 10) throw new BadRequestException('Max 10 conditions');
    for (const c of conditions) {
      if (!c.field?.trim() || !/^[a-z0-9_.]{1,60}$/i.test(c.field)) throw new BadRequestException(`Bad condition field "${c.field}"`);
      if (!CONDITION_OPS.includes(c.op)) throw new BadRequestException(`Bad condition op "${c.op}"`);
    }
    return conditions.map((c) => ({ field: c.field.trim(), op: c.op, value: c.value }));
  }

  private validateActions(actions: WorkflowAction[]): WorkflowAction[] {
    if (!Array.isArray(actions) || actions.length === 0) throw new BadRequestException('A workflow needs at least one action');
    if (actions.length > 5) throw new BadRequestException('Max 5 actions per workflow');
    for (const a of actions) {
      if (!ACTION_TYPES.includes(a.type)) throw new BadRequestException(`Unknown action type "${a.type}"`);
      if (a.type === 'send_template_email' && !a.template_id) throw new BadRequestException('send_template_email needs template_id');
      if (a.type === 'move_stage' && !a.stage_id) throw new BadRequestException('move_stage needs stage_id');
    }
    return actions;
  }
}
