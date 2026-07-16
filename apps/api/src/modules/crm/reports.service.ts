import { BadRequestException, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import {
  activities,
  deals,
  dealStageHistory,
  emailMessages,
  lostReasons,
  memberships,
  pipelines,
  pipelineStages,
  salesGoals,
  users,
} from '@flicks/db/schema';
import type { Db } from '@flicks/db';
import { DatabaseService } from '../../core/database/database.service';
import { AuditService } from '../audit/audit.service';

/**
 * CRM reports (PRD v5 §10, C16/C17, §19.6 goals). All sums in the tenant's
 * base currency (deals carry value_base_amount snapshots). Read-only over
 * RLS-scoped queries; goals are the only writes.
 */

const MS_DAY = 86_400_000;

function monthKey(d: Date): string {
  return d.toISOString().slice(0, 7);
}
function monthStart(key: string): Date {
  return new Date(`${key}-01T00:00:00.000Z`);
}
function addMonths(key: string, n: number): string {
  const d = monthStart(key);
  d.setUTCMonth(d.getUTCMonth() + n);
  return monthKey(d);
}

@Injectable()
export class ReportsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  /**
   * C16 dashboard: pipeline snapshot, funnel conversion, win/loss by
   * source & owner, lost reasons, sales velocity, activity leaderboard.
   * `days` bounds the closed/activity aggregations (default 90).
   */
  async overview(tenantId: string, opts: { days?: number; pipeline_id?: string } = {}) {
    const days = Math.min(Math.max(opts.days ?? 90, 7), 365);
    const since = new Date(Date.now() - days * MS_DAY);

    return this.db.withTenant(tenantId, async (tx) => {
      const pl = opts.pipeline_id
        ? (await tx.select().from(pipelines).where(and(eq(pipelines.id, opts.pipeline_id), isNull(pipelines.deleted_at))).limit(1))[0]
        : (await tx.select().from(pipelines).where(isNull(pipelines.deleted_at)).orderBy(asc(pipelines.display_order)).limit(1))[0];
      if (!pl) return { data: null };
      const stages = await tx
        .select()
        .from(pipelineStages)
        .where(and(eq(pipelineStages.pipeline_id, pl.id), isNull(pipelineStages.deleted_at)))
        .orderBy(asc(pipelineStages.display_order));
      const openStages = stages.filter((s) => s.stage_type === 'open');

      // 1 · Pipeline snapshot: open deals per stage (raw, weighted, avg age in stage).
      const snapshotRows = await tx
        .select({
          stage_id: deals.stage_id,
          count: sql<number>`count(*)::int`,
          raw: sql<number>`coalesce(sum(${deals.value_base_amount}), 0)::float`,
          avg_days: sql<number>`coalesce(avg(extract(epoch from now() - ${deals.updated_at})) / 86400, 0)::float`,
        })
        .from(deals)
        .where(and(eq(deals.pipeline_id, pl.id), eq(deals.status, 'open'), isNull(deals.deleted_at)))
        .groupBy(deals.stage_id);
      const snapMap = new Map(snapshotRows.map((r) => [r.stage_id, r]));
      const snapshot = openStages.map((s) => {
        const r = snapMap.get(s.id);
        return {
          stage_id: s.id,
          stage: s.name,
          win_probability: s.win_probability,
          count: r?.count ?? 0,
          raw: r?.raw ?? 0,
          weighted: (r?.raw ?? 0) * (s.win_probability / 100),
          avg_days: Math.round(r?.avg_days ?? 0),
        };
      });

      // 2 · Funnel: of deals CREATED in the window, how many ever reached each stage.
      const windowDeals = await tx
        .select({ id: deals.id, status: deals.status })
        .from(deals)
        .where(and(eq(deals.pipeline_id, pl.id), gte(deals.created_at, since), isNull(deals.deleted_at)));
      const windowIds = windowDeals.map((d) => d.id);
      const reached = windowIds.length
        ? await tx
            .select({ stage_id: dealStageHistory.to_stage_id, n: sql<number>`count(distinct ${dealStageHistory.deal_id})::int` })
            .from(dealStageHistory)
            .where(inArray(dealStageHistory.deal_id, windowIds))
            .groupBy(dealStageHistory.to_stage_id)
        : [];
      const reachedMap = new Map(reached.map((r) => [r.stage_id, r.n]));
      const total = windowIds.length;
      const wonInWindowSet = windowDeals.filter((d) => d.status === 'won').length;
      const funnel = [
        ...openStages.map((s) => ({ stage: s.name, count: reachedMap.get(s.id) ?? 0, pct: total ? Math.round(((reachedMap.get(s.id) ?? 0) / total) * 100) : 0 })),
        { stage: 'Won', count: wonInWindowSet, pct: total ? Math.round((wonInWindowSet / total) * 100) : 0 },
      ];

      // 3 · Win/loss over the window (decided deals), by source and by owner.
      const decided = await tx
        .select({
          status: deals.status,
          source: deals.source,
          owner: deals.owner_user_id,
          owner_name: users.full_name,
          value: sql<number>`${deals.value_base_amount}::float`,
          cycle_days: sql<number>`extract(epoch from coalesce(${deals.won_at}, ${deals.lost_at}) - ${deals.created_at}) / 86400`,
          lost_reason_id: deals.lost_reason_id,
        })
        .from(deals)
        .leftJoin(users, eq(users.id, deals.owner_user_id))
        .where(and(
          eq(deals.pipeline_id, pl.id),
          inArray(deals.status, ['won', 'lost']),
          sql`coalesce(${deals.won_at}, ${deals.lost_at}) >= ${since.toISOString()}`,
          isNull(deals.deleted_at),
        ));
      const dim = (key: (d: typeof decided[number]) => string | null) => {
        const groups = new Map<string, { won: number; lost: number; size: number; cycle: number }>();
        for (const d of decided) {
          const k = key(d) ?? '—';
          const g = groups.get(k) ?? { won: 0, lost: 0, size: 0, cycle: 0 };
          if (d.status === 'won') { g.won += 1; g.size += d.value; g.cycle += Math.max(0, d.cycle_days ?? 0); }
          else g.lost += 1;
          groups.set(k, g);
        }
        return [...groups.entries()]
          .map(([k, g]) => ({
            key: k,
            won: g.won,
            lost: g.lost,
            win_rate: g.won + g.lost ? Math.round((g.won / (g.won + g.lost)) * 100) : 0,
            avg_size: g.won ? g.size / g.won : 0,
            avg_cycle_days: g.won ? Math.round(g.cycle / g.won) : null,
          }))
          .sort((a, b) => b.won + b.lost - (a.won + a.lost))
          .slice(0, 8);
      };
      const winLoss = {
        by_source: dim((d) => d.source),
        by_owner: dim((d) => d.owner_name),
        overall_win_rate: decided.length ? Math.round((decided.filter((d) => d.status === 'won').length / decided.length) * 100) : 0,
      };

      // Lost reasons distribution.
      const lostRows = decided.filter((d) => d.status === 'lost');
      const reasons = await tx.select().from(lostReasons);
      const reasonName = new Map(reasons.map((r) => [r.id, r.label]));
      const lostByReason = new Map<string, number>();
      for (const d of lostRows) {
        const label = (d.lost_reason_id && reasonName.get(d.lost_reason_id)) || 'Unspecified';
        lostByReason.set(label, (lostByReason.get(label) ?? 0) + 1);
      }
      const lost_reasons = [...lostByReason.entries()].map(([label, n]) => ({ label, count: n })).sort((a, b) => b.count - a.count);

      // 4 · Sales velocity per month over the last 6 months:
      //     (# open at month end × avg won size × win rate) ÷ avg cycle days.
      const velocity: Array<{ month: string; value: number }> = [];
      const nowKey = monthKey(new Date());
      for (let i = 5; i >= 0; i--) {
        const mk = addMonths(nowKey, -i);
        const mEnd = monthStart(addMonths(mk, 1));
        const [openAt] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(deals)
          .where(and(
            eq(deals.pipeline_id, pl.id),
            lt(deals.created_at, mEnd),
            sql`(${deals.status} = 'open' OR coalesce(${deals.won_at}, ${deals.lost_at}) >= ${mEnd.toISOString()})`,
            isNull(deals.deleted_at),
          ));
        // Window-wide win rate/size/cycle: month-sliced rates whipsaw on
        // small tenants, so only the open count varies by month.
        const wins = decided.filter((d) => d.status === 'won');
        const winRate = decided.length ? wins.length / decided.length : 0;
        const avgSize = wins.length ? wins.reduce((a, d) => a + d.value, 0) / wins.length : 0;
        const avgCycle = wins.length ? Math.max(1, wins.reduce((a, d) => a + Math.max(0, d.cycle_days ?? 0), 0) / wins.length) : 30;
        velocity.push({ month: mk, value: Math.round(((openAt!.n * avgSize * winRate) / avgCycle) * 100) / 100 });
      }

      // 5 · Activity leaderboard over the window + §19.6 goal progress this month.
      const reps = await tx
        .select({ user_id: memberships.user_id, name: users.full_name })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.user_id))
        .where(and(eq(memberships.status, 'active'), sql`${memberships.role} <> 'auditor'`));
      const actRows = await tx
        .select({ assignee: activities.assignee_user_id, type: activities.type, n: sql<number>`count(*)::int` })
        .from(activities)
        .where(and(gte(activities.completed_at, since), sql`${activities.completed_at} IS NOT NULL`))
        .groupBy(activities.assignee_user_id, activities.type);
      const emailRows = await tx
        .select({ sender: emailMessages.sender_user_id, n: sql<number>`count(*)::int` })
        .from(emailMessages)
        .where(and(eq(emailMessages.direction, 'out'), gte(emailMessages.created_at, since)))
        .groupBy(emailMessages.sender_user_id);
      const emailMap = new Map(emailRows.map((r) => [r.sender, r.n]));
      const thisMonth = monthKey(new Date());
      const goals = await tx.select().from(salesGoals).where(eq(salesGoals.period, thisMonth));
      const goalByUser = new Map(goals.filter((g) => g.user_id).map((g) => [g.user_id, Number(g.target_base)]));
      const wonThisMonth = await tx
        .select({ owner: deals.owner_user_id, total: sql<number>`coalesce(sum(${deals.value_base_amount}), 0)::float` })
        .from(deals)
        .where(and(eq(deals.status, 'won'), gte(deals.won_at, monthStart(thisMonth)), isNull(deals.deleted_at)))
        .groupBy(deals.owner_user_id);
      const wonMap = new Map(wonThisMonth.map((r) => [r.owner, r.total]));

      const leaderboard = reps.map((r) => {
        const acts = actRows.filter((a) => a.assignee === r.user_id);
        const byType = (t: string) => acts.filter((a) => a.type === t).reduce((s, a) => s + a.n, 0);
        const goal = goalByUser.get(r.user_id);
        return {
          user_id: r.user_id,
          name: r.name,
          calls: byType('call'),
          meetings: byType('meeting'),
          tasks: byType('task'),
          emails: emailMap.get(r.user_id) ?? 0,
          goal_target: goal ?? null,
          goal_pct: goal ? Math.min(100, Math.round(((wonMap.get(r.user_id) ?? 0) / goal) * 100)) : null,
        };
      }).sort((a, b) => (b.calls + b.meetings + b.tasks + b.emails) - (a.calls + a.meetings + a.tasks + a.emails));

      return {
        data: {
          pipeline: { id: pl.id, name: pl.name },
          window_days: days,
          snapshot,
          funnel,
          win_loss: winLoss,
          lost_reasons,
          velocity,
          leaderboard,
        },
      };
    });
  }

  /**
   * C17 forecast: next N months by expected close. weighted = Σ value×prob;
   * committed = Σ value in stages with probability ≥ 70; won = closed-won in
   * the month; goal from sales_goals (team row). Includes a drill-down list.
   */
  async forecast(tenantId: string, opts: { months?: number } = {}) {
    const months = Math.min(Math.max(opts.months ?? 4, 2), 12);
    return this.db.withTenant(tenantId, async (tx) => {
      const stages = await tx.select().from(pipelineStages).where(isNull(pipelineStages.deleted_at));
      const probOf = new Map(stages.map((s) => [s.id, s.win_probability]));

      const startKey = monthKey(new Date());
      const horizonStart = monthStart(startKey);
      const horizonEnd = monthStart(addMonths(startKey, months));

      const open = await tx
        .select({
          id: deals.id, title: deals.title, stage_id: deals.stage_id, owner_name: users.full_name,
          value: sql<number>`${deals.value_base_amount}::float`,
          close: deals.expected_close_date,
        })
        .from(deals)
        .leftJoin(users, eq(users.id, deals.owner_user_id))
        .where(and(eq(deals.status, 'open'), isNull(deals.deleted_at), sql`${deals.expected_close_date} IS NOT NULL`));
      const won = await tx
        .select({ won_at: deals.won_at, value: sql<number>`${deals.value_base_amount}::float` })
        .from(deals)
        .where(and(eq(deals.status, 'won'), gte(deals.won_at, horizonStart), lt(deals.won_at, horizonEnd), isNull(deals.deleted_at)));
      const goals = await tx.select().from(salesGoals).where(isNull(salesGoals.user_id));
      const teamGoal = new Map(goals.map((g) => [g.period, Number(g.target_base)]));

      const rows = [];
      for (let i = 0; i < months; i++) {
        const mk = addMonths(startKey, i);
        const mStart = monthStart(mk);
        const mEnd = monthStart(addMonths(mk, 1));
        const inMonth = open.filter((d) => {
          const c = new Date(`${d.close}T00:00:00.000Z`);
          return c >= mStart && c < mEnd;
        });
        const weighted = inMonth.reduce((s, d) => s + d.value * ((probOf.get(d.stage_id) ?? 0) / 100), 0);
        const committed = inMonth.filter((d) => (probOf.get(d.stage_id) ?? 0) >= 70).reduce((s, d) => s + d.value, 0);
        const wonSum = won.filter((w) => w.won_at! >= mStart && w.won_at! < mEnd).reduce((s, w) => s + w.value, 0);
        const goal = teamGoal.get(mk) ?? null;
        rows.push({
          period: mk,
          weighted: Math.round(weighted),
          committed: Math.round(committed),
          won: Math.round(wonSum),
          goal,
          gap_to_goal: goal != null ? Math.max(0, Math.round(goal - wonSum - committed)) : null,
          deals: inMonth
            .sort((a, b) => b.value - a.value)
            .slice(0, 10)
            .map((d) => ({ id: d.id, title: d.title, owner_name: d.owner_name, value: d.value, probability: probOf.get(d.stage_id) ?? 0 })),
        });
      }
      return { data: rows };
    });
  }

  // ─── §19.6 goals ─────────────────────────────────────────────────────────────

  async listGoals(tenantId: string, period?: string) {
    return this.db.withTenant(tenantId, async (tx) => {
      const rows = await tx
        .select({ goal: salesGoals, user_name: users.full_name })
        .from(salesGoals)
        .leftJoin(users, eq(users.id, salesGoals.user_id))
        .where(period ? eq(salesGoals.period, period) : undefined)
        .orderBy(desc(salesGoals.period));
      return { data: rows.map((r) => ({ ...r.goal, target_base: Number(r.goal.target_base), user_name: r.user_name })) };
    });
  }

  /** Upsert one goal (team when user_id omitted). Target 0 removes it. */
  async setGoal(tenantId: string, userId: string, dto: { period: string; user_id?: string | null; target_base: number }) {
    if (!/^\d{4}-\d{2}$/.test(dto.period)) throw new BadRequestException('period must be YYYY-MM');
    if (!(dto.target_base >= 0)) throw new BadRequestException('target_base must be ≥ 0');
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        if (dto.user_id) await this.assertMember(tx, tenantId, dto.user_id);
        const where = and(
          eq(salesGoals.period, dto.period),
          dto.user_id ? eq(salesGoals.user_id, dto.user_id) : isNull(salesGoals.user_id),
        );
        if (dto.target_base === 0) {
          await tx.delete(salesGoals).where(where);
          return { data: null };
        }
        const [existing] = await tx.select().from(salesGoals).where(where).limit(1);
        const [row] = existing
          ? await tx.update(salesGoals).set({ target_base: dto.target_base.toFixed(2), updated_at: new Date() }).where(eq(salesGoals.id, existing.id)).returning()
          : await tx.insert(salesGoals).values({
              tenant_id: tenantId, user_id: dto.user_id ?? null, period: dto.period,
              target_base: dto.target_base.toFixed(2), created_by: userId,
            }).returning();
        await this.audit.log({ tenantId, actorUserId: userId, action: 'crm.goal.set', resourceType: 'sales_goal', resourceId: row!.id });
        return { data: { ...row!, target_base: Number(row!.target_base) } };
      },
      userId,
    );
  }

  private async assertMember(tx: Db, tenantId: string, userId: string) {
    const [m] = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.tenant_id, tenantId), eq(memberships.user_id, userId), eq(memberships.status, 'active')))
      .limit(1);
    if (!m) throw new BadRequestException('user_id is not an active member');
  }
}
