import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import {
  pmCycles,
  pmCycleSnapshots,
  pmIssues,
  pmTeams,
  pmTeamMemberships,
  pmWorkflowStates,
} from '@flicks/db/schema';
import type { DbAdmin } from '@flicks/db';
import { DB_SERVICE_ROLE } from '../../core/database/database.module';
import { DatabaseService } from '../../core/database/database.service';
import { DomainEventsService } from '../../core/events/domain-events.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PmVisibilityService } from './sync/visibility.service';

/**
 * PM cycles + Autopilot + snapshots (PRD v6 §7). The sweep is EXPOSED with an
 * injectable `now` (fake-clock acceptance tests, §7.3) and runs hourly from
 * PmJobs — boundaries are stored TIMESTAMPTZ computed at team-timezone
 * midnight, so "a Berlin team's cycle flips at Berlin midnight regardless of
 * tenant tz" (§17) holds by construction.
 *
 * Autopilot rollover (§7.1) at ends_at:
 *   priority 1–2  → moved to the next cycle
 *   priority 0/3–4 → returned to backlog (cycle_id cleared) + ONE Cycle
 *                    Review digest to team lead + assignees — exactly once
 *                    by construction (the digest rides the single
 *                    active→completed status flip).
 */

const DAY_MS = 86_400_000;

/** Local date parts of an instant in a tz. */
function partsInTz(d: Date, tz: string): { y: number; m: number; day: number; hour: number; dow: number } {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', hourCycle: 'h23', weekday: 'short',
    });
    const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
    const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return {
      y: Number(parts.year), m: Number(parts.month), day: Number(parts.day),
      hour: Number(parts.hour), dow: dowMap[parts.weekday as string] ?? 1,
    };
  } catch {
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), dow: d.getUTCDay() };
  }
}

/** The tz's UTC offset (ms) at an instant. */
function tzOffsetMs(d: Date, tz: string): number {
  const p = partsInTz(d, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.day, p.hour, d.getUTCMinutes(), d.getUTCSeconds());
  const rounded = new Date(d);
  rounded.setUTCMilliseconds(0);
  return asUtc - rounded.getTime();
}

/** Midnight (00:00) of the given local date in tz, as a UTC instant. */
function midnightInTz(y: number, m: number, day: number, tz: string): Date {
  // Two-pass: guess UTC midnight, correct by the tz offset at that instant.
  let guess = new Date(Date.UTC(y, m - 1, day, 0, 0, 0));
  for (let i = 0; i < 2; i++) {
    const off = tzOffsetMs(guess, tz);
    guess = new Date(Date.UTC(y, m - 1, day, 0, 0, 0) - off);
  }
  return guess;
}

/** Next occurrence of `dow` (0–6) at local midnight in tz, strictly after `from`. */
function nextDowMidnight(from: Date, dow: number, tz: string): Date {
  for (let i = 1; i <= 8; i++) {
    const candidate = new Date(from.getTime() + i * DAY_MS);
    const p = partsInTz(candidate, tz);
    if (p.dow === dow) {
      const m = midnightInTz(p.y, p.m, p.day, tz);
      if (m > from) return m;
    }
  }
  return new Date(from.getTime() + 7 * DAY_MS); // unreachable fallback
}

export function dateInTz(d: Date, tz: string): string {
  const p = partsInTz(d, tz);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

@Injectable()
export class PmCyclesService {
  private readonly logger = new Logger(PmCyclesService.name);

  constructor(
    private readonly db: DatabaseService,
    @Inject(DB_SERVICE_ROLE) private readonly dbAdmin: DbAdmin,
    private readonly domainEvents: DomainEventsService,
    private readonly notifications: NotificationsService,
    private readonly visibility: PmVisibilityService,
  ) {}

  // ─── sweep (hourly from PmJobs; `now` injectable for fake-clock tests) ────

  async runCycleSweep(now: Date): Promise<{ created: number; activated: number; ended: number; snapshots: number }> {
    const teams = await this.dbAdmin
      .select()
      .from(pmTeams)
      .where(and(eq(pmTeams.cycles_enabled, true), isNull(pmTeams.deleted_at)));
    const out = { created: 0, activated: 0, ended: 0, snapshots: 0 };
    for (const team of teams) {
      try {
        const r = await this.sweepTeam(team, now);
        out.created += r.created;
        out.activated += r.activated;
        out.ended += r.ended;
        out.snapshots += r.snapshots;
      } catch (err) {
        this.logger.error(`cycle sweep failed for team ${team.id}: ${err instanceof Error ? err.message : err}`);
      }
    }
    return out;
  }

  private async sweepTeam(team: typeof pmTeams.$inferSelect, now: Date) {
    const tz = team.timezone ?? 'Asia/Kolkata';
    const lengthMs = (team.cycle_length_weeks ?? 2) * 7 * DAY_MS;
    const cooldownMs = (team.cooldown_days ?? 0) * DAY_MS;
    const out = { created: 0, activated: 0, ended: 0, snapshots: 0 };

    // 1. END + Autopilot — guarded status flip makes the digest exactly-once.
    const ending = await this.dbAdmin
      .select()
      .from(pmCycles)
      .where(and(eq(pmCycles.team_id, team.id), eq(pmCycles.status, 'active')));
    for (const cycle of ending) {
      if (cycle.ends_at > now) continue;
      await this.endCycleWithAutopilot(team, cycle, now);
      out.ended++;
    }

    // 2. MAINTAIN upcoming cycles (create so N future cycles always exist).
    const all = await this.dbAdmin
      .select()
      .from(pmCycles)
      .where(eq(pmCycles.team_id, team.id))
      .orderBy(asc(pmCycles.number));
    const want = team.upcoming_cycles ?? 2;
    let last = all[all.length - 1];
    // Invariant: non-completed cycles (current + upcoming) cover want+1 windows.
    const toCreate = Math.max(0, want + 1 - all.filter((c) => c.status !== 'completed').length);
    for (let i = 0; i < toCreate; i++) {
      const startsAt = last
        ? new Date(last.ends_at.getTime() + cooldownMs)
        : nextDowMidnight(now, team.cycle_start_dow ?? 1, tz);
      const endsAt = new Date(startsAt.getTime() + lengthMs);
      const cooldownEndsAt = new Date(endsAt.getTime() + cooldownMs);
      const number = (last?.number ?? 0) + 1;
      const [created] = await this.dbAdmin
        .insert(pmCycles)
        .values({
          tenant_id: team.tenant_id, team_id: team.id, number,
          starts_at: startsAt, ends_at: endsAt, cooldown_ends_at: cooldownEndsAt,
          status: 'upcoming',
        })
        .onConflictDoNothing()
        .returning();
      if (created) {
        last = created;
        out.created++;
        await this.publishCycleEvent(team.tenant_id, 'pm.cycle.created', created.id, { team_id: team.id, number });
      } else {
        break; // number collision — another sweep instance won
      }
    }

    // 3. ACTIVATE at starts_at — blocked while the previous cooldown runs.
    const refreshed = await this.dbAdmin
      .select()
      .from(pmCycles)
      .where(eq(pmCycles.team_id, team.id))
      .orderBy(asc(pmCycles.number));
    for (const cycle of refreshed) {
      if (cycle.status !== 'upcoming' || cycle.starts_at > now || cycle.ends_at <= now) continue;
      const prev = refreshed.find((c) => c.number === cycle.number - 1);
      if (prev && prev.cooldown_ends_at > now) continue; // §7.2 cooldown blocks activation
      const [flipped] = await this.dbAdmin
        .update(pmCycles)
        .set({ status: 'active' })
        .where(and(eq(pmCycles.id, cycle.id), eq(pmCycles.status, 'upcoming')))
        .returning();
      if (flipped) {
        out.activated++;
        await this.publishCycleEvent(team.tenant_id, 'pm.cycle.started', cycle.id, { team_id: team.id, number: cycle.number });
      }
    }

    // 4. SNAPSHOT active cycles once per team-local day (§7.3).
    const active = (await this.dbAdmin
      .select()
      .from(pmCycles)
      .where(and(eq(pmCycles.team_id, team.id), eq(pmCycles.status, 'active'))))[0];
    if (active) {
      const took = await this.takeSnapshot(team.tenant_id, active.id, dateInTz(now, tz));
      if (took) out.snapshots++;
    }
    return out;
  }

  private async endCycleWithAutopilot(team: typeof pmTeams.$inferSelect, cycle: typeof pmCycles.$inferSelect, now: Date) {
    const tz = team.timezone ?? 'Asia/Kolkata';
    // Guarded flip — everything downstream runs exactly once.
    const [flipped] = await this.dbAdmin
      .update(pmCycles)
      .set({ status: 'completed' })
      .where(and(eq(pmCycles.id, cycle.id), eq(pmCycles.status, 'active')))
      .returning();
    if (!flipped) return;

    // Final snapshot at the boundary.
    await this.takeSnapshot(team.tenant_id, cycle.id, dateInTz(cycle.ends_at, tz), { force: true });

    // Ensure the NEXT cycle exists for urgent/high rollover.
    const cooldownMs = (team.cooldown_days ?? 0) * DAY_MS;
    const lengthMs = (team.cycle_length_weeks ?? 2) * 7 * DAY_MS;
    let [next] = await this.dbAdmin
      .select()
      .from(pmCycles)
      .where(and(eq(pmCycles.team_id, team.id), eq(pmCycles.number, cycle.number + 1)));
    if (!next) {
      const startsAt = new Date(cycle.ends_at.getTime() + cooldownMs);
      [next] = await this.dbAdmin
        .insert(pmCycles)
        .values({
          tenant_id: team.tenant_id, team_id: team.id, number: cycle.number + 1,
          starts_at: startsAt, ends_at: new Date(startsAt.getTime() + lengthMs),
          cooldown_ends_at: new Date(startsAt.getTime() + lengthMs + cooldownMs),
          status: 'upcoming',
        })
        .onConflictDoNothing()
        .returning();
    }

    // Autopilot: split incomplete issues by priority.
    const states = await this.dbAdmin
      .select({ id: pmWorkflowStates.id, category: pmWorkflowStates.category })
      .from(pmWorkflowStates)
      .where(eq(pmWorkflowStates.team_id, team.id));
    const closedStateIds = states.filter((s) => s.category === 'completed' || s.category === 'canceled').map((s) => s.id);
    const open = await this.dbAdmin
      .select({
        id: pmIssues.id, priority: pmIssues.priority, assignee_user_id: pmIssues.assignee_user_id,
        number: pmIssues.number, state_id: pmIssues.state_id,
      })
      .from(pmIssues)
      .where(and(eq(pmIssues.cycle_id, cycle.id), isNull(pmIssues.deleted_at)));
    const incomplete = open.filter((i) => !closedStateIds.includes(i.state_id));
    const rollForward = incomplete.filter((i) => i.priority === 1 || i.priority === 2);
    const returned = incomplete.filter((i) => !(i.priority === 1 || i.priority === 2)); // 0 treated as low

    if (rollForward.length && next) {
      await this.dbAdmin
        .update(pmIssues)
        .set({ cycle_id: next.id, updated_at: now })
        .where(inArray(pmIssues.id, rollForward.map((i) => i.id)));
    }
    if (returned.length) {
      await this.dbAdmin
        .update(pmIssues)
        .set({ cycle_id: null, updated_at: now })
        .where(inArray(pmIssues.id, returned.map((i) => i.id)));
    }

    await this.publishCycleEvent(team.tenant_id, 'pm.cycle.ended', cycle.id, { team_id: team.id, number: cycle.number });
    await this.publishCycleEvent(team.tenant_id, 'pm.cycle.rollover_completed', cycle.id, {
      team_id: team.id,
      number: cycle.number,
      moved: rollForward.length,
      returned: returned.length,
      // sync refs so clients pick up the re-cycled issues without a poll
      sync: [
        { t: 'pm_cycles', id: cycle.id },
        ...(next ? [{ t: 'pm_cycles', id: next.id }] : []),
        ...incomplete.map((i) => ({ t: 'pm_issues', id: i.id })),
      ],
    });

    // ONE Cycle Review digest → team lead + each assignee of returned issues.
    if (returned.length) {
      const recipients = new Set<string>();
      const teamLeads = await this.dbAdmin
        .select({ user_id: pmTeamMemberships.user_id })
        .from(pmTeamMemberships)
        .where(and(eq(pmTeamMemberships.team_id, team.id), eq(pmTeamMemberships.is_lead, true)));
      for (const l of teamLeads) recipients.add(l.user_id);
      for (const i of returned) if (i.assignee_user_id) recipients.add(i.assignee_user_id);
      const msg = `${returned.length} issue${returned.length === 1 ? '' : 's'} didn't make Cycle ${cycle.number} — re-plan or leave in backlog.`;
      for (const uid of recipients) {
        await this.notifications
          .createInAppNotification(uid, 'pm.cycle.review', msg, '/pm/cycle', team.tenant_id)
          .catch(() => undefined);
      }
    }
  }

  /** Upsert today's snapshot; returns true when written (once per local day). */
  private async takeSnapshot(tenantId: string, cycleId: string, snapshotDate: string, opts: { force?: boolean } = {}): Promise<boolean> {
    const [existing] = await this.dbAdmin
      .select({ cycle_id: pmCycleSnapshots.cycle_id })
      .from(pmCycleSnapshots)
      .where(and(eq(pmCycleSnapshots.cycle_id, cycleId), eq(pmCycleSnapshots.snapshot_date, snapshotDate)));
    if (existing && !opts.force) return false;

    const issues = await this.dbAdmin
      .select({ estimate: pmIssues.estimate, state_id: pmIssues.state_id })
      .from(pmIssues)
      .where(and(eq(pmIssues.cycle_id, cycleId), isNull(pmIssues.deleted_at)));
    const stateIds = [...new Set(issues.map((i) => i.state_id))];
    const cats = stateIds.length
      ? await this.dbAdmin
          .select({ id: pmWorkflowStates.id, category: pmWorkflowStates.category })
          .from(pmWorkflowStates)
          .where(inArray(pmWorkflowStates.id, stateIds))
      : [];
    const catOf = new Map(cats.map((c) => [c.id, c.category]));
    let scope = 0;
    let started = 0;
    let completed = 0;
    for (const i of issues) {
      const cat = catOf.get(i.state_id);
      if (cat === 'canceled') continue;
      const w = i.estimate != null ? Number(i.estimate) : 1;
      scope += w;
      if (cat === 'completed') completed += w;
      else if (cat === 'started') started += w;
    }
    await this.dbAdmin
      .insert(pmCycleSnapshots)
      .values({
        tenant_id: tenantId, cycle_id: cycleId, snapshot_date: snapshotDate,
        scope_points: String(scope), started_points: String(started), completed_points: String(completed),
      })
      .onConflictDoUpdate({
        target: [pmCycleSnapshots.cycle_id, pmCycleSnapshots.snapshot_date],
        set: { scope_points: String(scope), started_points: String(started), completed_points: String(completed) },
      });
    await this.publishCycleEvent(tenantId, 'pm.cycle.snapshot_taken', cycleId, { date: snapshotDate });
    return true;
  }

  private async publishCycleEvent(tenantId: string, name: string, cycleId: string, extra: Record<string, unknown>) {
    await this.domainEvents
      .publish({
        name: name as never,
        tenantId,
        actorUserId: null as never,
        payload: { cycle_id: cycleId, ...(extra.sync ? {} : { sync: [{ t: 'pm_cycles', id: cycleId }] }), ...extra },
      })
      .catch((err) => this.logger.warn(`cycle event ${name} failed: ${err instanceof Error ? err.message : err}`));
  }

  // ─── REST read model (§7.3 header + P13 page) ─────────────────────────────

  async teamCycles(tenantId: string, userId: string, teamId: string) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const visible = await this.visibility.visibleTeamIdsTx(tx, tenantId, userId);
        if (!visible.includes(teamId)) throw new NotFoundException('Team not found');
        const cycles = await tx
          .select()
          .from(pmCycles)
          .where(and(eq(pmCycles.tenant_id, tenantId), eq(pmCycles.team_id, teamId)))
          .orderBy(desc(pmCycles.number))
          .limit(12);
        const active = cycles.find((c) => c.status === 'active') ?? null;
        const snapshots = active
          ? await tx
              .select()
              .from(pmCycleSnapshots)
              .where(and(eq(pmCycleSnapshots.tenant_id, tenantId), eq(pmCycleSnapshots.cycle_id, active.id)))
              .orderBy(asc(pmCycleSnapshots.snapshot_date))
          : [];

        // Stats (§7.3): velocity = 3-cycle rolling completed points; completion
        // = completed/scope avg over those cycles; creep = scope growth after
        // the active cycle's first snapshot.
        const completedCycles = cycles.filter((c) => c.status === 'completed').slice(0, 3);
        const finals = completedCycles.length
          ? await tx
              .select()
              .from(pmCycleSnapshots)
              .where(and(
                eq(pmCycleSnapshots.tenant_id, tenantId),
                inArray(pmCycleSnapshots.cycle_id, completedCycles.map((c) => c.id)),
              ))
              .orderBy(asc(pmCycleSnapshots.snapshot_date))
          : [];
        const finalByCycle = new Map<string, { completed: number; scope: number }>();
        for (const s of finals) {
          finalByCycle.set(s.cycle_id, { completed: Number(s.completed_points), scope: Number(s.scope_points) }); // last write wins (asc order)
        }
        const perCycle = completedCycles
          .map((c) => ({ number: c.number, ...(finalByCycle.get(c.id) ?? { completed: 0, scope: 0 }) }));
        const velocity = perCycle.length
          ? Math.round((perCycle.reduce((a, c) => a + c.completed, 0) / perCycle.length) * 10) / 10
          : null;
        const completionRate = perCycle.length
          ? Math.round(
              (perCycle.reduce((a, c) => a + (c.scope ? c.completed / c.scope : 0), 0) / perCycle.length) * 100,
            )
          : null;
        const creep =
          snapshots.length >= 2 && Number(snapshots[0]!.scope_points) > 0
            ? Math.round(
                ((Number(snapshots[snapshots.length - 1]!.scope_points) - Number(snapshots[0]!.scope_points)) /
                  Number(snapshots[0]!.scope_points)) * 100,
              )
            : 0;

        return {
          data: {
            cycles,
            active,
            snapshots,
            stats: { velocity, completion_rate: completionRate, creep, previous: perCycle },
          },
        };
      },
      userId,
    );
  }
}
