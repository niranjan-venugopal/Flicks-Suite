import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { sql } from 'drizzle-orm';
import type { DbAdmin } from '@flicks/db';
import { DB_SERVICE_ROLE } from '../core/database/database.module';
import { DatabaseService } from '../core/database/database.service';
import { runsWorkloads } from '../core/worker/worker-mode';
import { tenantTodayISOTx } from '../core/common/workday';
import {
  ApprovalRoutingService,
  ESCALATION_SLA_MS,
} from '../modules/approvals/approval-routing.service';
import type {
  ApprovalKind,
  EscalationReason,
  Route,
  RouteState,
} from '../modules/approvals/approval-routing.service';

const KINDS: ApprovalKind[] = ['leave', 'regularization', 'timesheet'];
/** Per tenant, per kind, per tick — one tenant's backlog cannot starve the rest. */
const PER_TENANT_BATCH = 200;
/** Overall cap per kind per tick — a 15-minute cadence drains any realistic backlog. */
const BATCH = 2000;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "17 Sep" for a YYYY-MM-DD (calendar date, zone-free). */
export function fmtShortDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return iso;
  return `${d} ${MONTHS[m - 1] ?? ''}`.trim();
}

/** "17 Sep" · "17–19 Sep" · "30 Sep – 2 Oct". */
export function fmtDateRange(startIso: string, endIso: string): string {
  if (startIso === endIso) return fmtShortDate(startIso);
  const sameMonth = startIso.slice(0, 7) === endIso.slice(0, 7);
  return sameMonth
    ? `${Number(startIso.slice(8, 10))}–${fmtShortDate(endIso)}`
    : `${fmtShortDate(startIso)} – ${fmtShortDate(endIso)}`;
}

/** The one-line summary inside the escalation notice — no nested parentheses. */
export function whatFor(kind: ApprovalKind, c: Candidate): string {
  if (kind === 'leave') {
    const days = Number(c.total_days ?? 0);
    const dayLabel = days === 1 ? '1 day' : `${Number.isInteger(days) ? days : days.toFixed(1)} days`;
    return `${c.leave_type ?? 'Leave'}, ${fmtDateRange(c.start_date ?? '', c.end_date ?? c.start_date ?? '')}, ${dayLabel}`;
  }
  if (kind === 'regularization') {
    return `${(c.request_type ?? 'regularization').replace(/_/g, ' ')}, ${fmtShortDate(c.attendance_date ?? '')}`;
  }
  const hours = Number(c.total_hours ?? 0);
  return `week of ${fmtShortDate(c.period_start ?? '')}, ${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`;
}

export interface SweepResult {
  ranAt: string;
  scanned: number;
  escalated: number;
  skipped: number;
  failed: number;
  byKind: Record<ApprovalKind, number>;
}

export interface Candidate {
  id: string;
  tenant_id: string;
  employee_id: string;
  escalation_level: number;
  employee_name: string | null;
  // Raw summary columns per kind (formatted by whatFor).
  leave_type?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  total_days?: number | null;
  attendance_date?: string | null;
  request_type?: string | null;
  period_start?: string | null;
  period_end?: string | null;
  total_hours?: number | null;
}

/**
 * Round L item 2 — the 24 h escalation sweep. Every 15 minutes, for each of
 * leave requests / regularizations / timesheets, scan the OPEN items still
 * below level 2 (oldest anchor first, capped per tenant so one workspace's
 * backlog cannot starve the rest) and decide, per item, INSIDE the tenant
 * transaction — the scan is a hint, never a verdict:
 *   • no valid reporting manager at all (legacy rows, manager removed /
 *     separated / seat deactivated) ⇒ level 2 `no_manager` right away —
 *     under the queue rule nobody else would ever see such an item;
 *   • level-0 anchor (applied_at / created_at / submitted_at) > 24 h old, or
 *     level-1 escalated_at > 24 h old ⇒ `sla`;
 *   • the current reviewer (live reporting manager at L0, escalated_to at
 *     L1) is on approved FULL-DAY leave TODAY — "today" from A's
 *     tenantTodayISOTx (default shift tz → tenant tz → IST), never from SQL:
 *     tenants.timezone is free text and one bad string would have taken the
 *     whole statement, and so the sweep for every tenant, down;
 *   • the level-1 reviewer can no longer act (removed / deactivated) ⇒
 *     `no_skip_manager`.
 * Then plan the next level (0 → 1 when a valid L1 exists and is not on
 * leave, else → 2; 1 → 2) and apply it with the guarded UPDATE. After commit
 * the NEW reviewers get the in-app row + email. Per-item try/catch: one bad
 * row never stops the sweep.
 *
 * The scan runs on dbAdmin (a cron has no tenant) with every join pinned to
 * the row's tenant_id; all reads that decide and all writes happen under
 * withTenant.
 */
@Injectable()
export class ApprovalEscalationJob {
  private readonly logger = new Logger(ApprovalEscalationJob.name);

  constructor(
    @Inject(DB_SERVICE_ROLE) private readonly dbAdmin: DbAdmin,
    private readonly databaseService: DatabaseService,
    private readonly routing: ApprovalRoutingService,
  ) {}

  @Cron('*/15 * * * *', { name: 'approval-escalation', timeZone: 'UTC' })
  async tick(): Promise<void> {
    if (!runsWorkloads()) return;
    try {
      const r = await this.runSweep(new Date());
      if (r.escalated || r.failed) {
        this.logger.log(
          `approval-escalation: ${r.escalated} escalated (${r.byKind.leave} leave, ${r.byKind.regularization} regularization, ${r.byKind.timesheet} timesheet), ${r.skipped} skipped, ${r.failed} failed of ${r.scanned} scanned`,
        );
      }
    } catch (err) {
      this.logger.error(`approval-escalation failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Exported for the spec and the FAM `POST fam/jobs/approval-escalation/run` trigger. */
  async runSweep(now: Date): Promise<SweepResult> {
    const result: SweepResult = {
      ranAt: now.toISOString(),
      scanned: 0,
      escalated: 0,
      skipped: 0,
      failed: 0,
      byKind: { leave: 0, regularization: 0, timesheet: 0 },
    };
    for (const kind of KINDS) {
      let candidates: Candidate[] = [];
      try {
        candidates = await this.selectCandidates(kind);
      } catch (err) {
        result.failed++;
        this.logger.warn(`approval-escalation: ${kind} scan failed: ${err instanceof Error ? err.message : err}`);
        continue;
      }
      result.scanned += candidates.length;
      for (const c of candidates) {
        try {
          const moved = await this.processOne(kind, c, now);
          if (moved) {
            result.escalated++;
            result.byKind[kind]++;
          } else {
            result.skipped++;
          }
        } catch (err) {
          result.failed++;
          this.logger.warn(
            `approval-escalation: ${kind} ${c.id} (tenant ${c.tenant_id}) failed: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    }
    return result;
  }

  // ─── Scan ────────────────────────────────────────────────────────────────

  private async selectCandidates(kind: ApprovalKind): Promise<Candidate[]> {
    const table =
      kind === 'leave'
        ? sql.identifier('leave_requests')
        : kind === 'regularization'
          ? sql.identifier('attendance_regularizations')
          : sql.identifier('timesheet_periods');
    const open = kind === 'timesheet' ? 'submitted' : 'pending';
    const anchor =
      kind === 'leave'
        ? sql`COALESCE(r.applied_at, r.created_at)`
        : kind === 'regularization'
          ? sql`r.created_at`
          : sql`r.submitted_at`;
    // Raw summary columns (text/float so postgres.js hands back plain values);
    // the sentence is built in whatFor.
    const summary =
      kind === 'leave'
        ? sql`lt.name AS leave_type, r.start_date::text AS start_date, r.end_date::text AS end_date, r.total_days::float AS total_days`
        : kind === 'regularization'
          ? sql`r.attendance_date::text AS attendance_date, r.request_type::text AS request_type`
          : sql`r.period_start::text AS period_start, r.period_end::text AS period_end, r.total_hours::float AS total_hours`;
    const extraJoin =
      kind === 'leave'
        ? sql`LEFT JOIN leave_types lt ON lt.id = r.leave_type_id AND lt.tenant_id = r.tenant_id`
        : sql``;

    // Every open item below level 2, oldest anchor first, at most
    // PER_TENANT_BATCH per tenant. No timezone maths and no reviewer lookups
    // here — those are decided per item, inside the tenant transaction.
    const rows = (await this.dbAdmin.execute(sql`
      SELECT c.* FROM (
        SELECT r.id, r.tenant_id, r.employee_id, r.escalation_level,
               (COALESCE(e.first_name, '') || ' ' || COALESCE(e.last_name, '')) AS employee_name,
               ${summary},
               row_number() OVER (PARTITION BY r.tenant_id ORDER BY ${anchor} ASC NULLS LAST, r.id ASC) AS rn
          FROM ${table} r
          JOIN employees e ON e.id = r.employee_id AND e.tenant_id = r.tenant_id
          ${extraJoin}
         WHERE r.status::text = ${open}
           AND r.escalation_level < 2
           AND e.deleted_at IS NULL
      ) c
      WHERE c.rn <= ${PER_TENANT_BATCH}
      ORDER BY c.tenant_id, c.rn
      LIMIT ${BATCH}
    `)) as unknown as Candidate[];
    return Array.from(rows);
  }

  // ─── Per item ────────────────────────────────────────────────────────────

  /** True when the item moved a level (and its new reviewers were told). */
  private async processOne(kind: ApprovalKind, c: Candidate, now: Date): Promise<boolean> {
    const tenantId = c.tenant_id;
    const cutoff = now.getTime() - ESCALATION_SLA_MS;
    const open = kind === 'timesheet' ? 'submitted' : 'pending';

    const outcome = await this.databaseService.withTenant(
      tenantId,
      async (tx): Promise<{ state: RouteState; route: Route } | null> => {
        // The scan is a hint: re-read under the tenant transaction so a
        // decision or a concurrent sweep that landed since is respected.
        const live = await this.routing.readStateTx(tx, tenantId, kind, c.id);
        if (!live || live.status !== open || live.level >= 2) return null;
        // "Today" as the tenant sees it (A's resolver: default shift tz →
        // tenant tz → IST) — resolved lazily, only for the on-leave checks.
        let todayCache: string | null = null;
        const today = async () => (todayCache ??= await tenantTodayISOTx(tx, tenantId, now));

        const route = await this.routing.resolveRouteTx(tx, tenantId, live.employeeId);
        let trigger: EscalationReason | null = null;
        if (live.level === 0) {
          if (!route.l0) {
            trigger = 'no_manager';
          } else if (live.anchor && live.anchor.getTime() < cutoff) {
            trigger = 'sla';
          } else if (
            await this.routing.reviewerOnLeaveTodayTx(tx, tenantId, route.l0.employeeId, await today())
          ) {
            trigger = 'reviewer_on_leave';
          }
        } else {
          if (live.escalatedAt && live.escalatedAt.getTime() < cutoff) {
            trigger = 'sla';
          } else if (
            !live.escalatedTo ||
            !(await this.routing.isLiveReviewerTx(tx, tenantId, live.escalatedTo))
          ) {
            // The L1 reviewer is gone (FK SET NULL, removed, separated or
            // their seat was deactivated) — nobody holds it.
            trigger = 'no_skip_manager';
          } else if (
            await this.routing.reviewerOnLeaveTodayTx(tx, tenantId, live.escalatedTo, await today())
          ) {
            trigger = 'reviewer_on_leave';
          }
        }
        if (!trigger) return null;

        const plan = await this.routing.planEscalationTx(
          tx,
          tenantId,
          route,
          live.level,
          trigger,
          await today(),
        );
        if (!plan) return null;
        const state = await this.routing.escalateTx(tx, tenantId, kind, c.id, live.level, plan.reason, {
          level: plan.level,
          escalatedTo: plan.escalatedTo,
        });
        return state ? { state, route } : null;
      },
    );
    if (!outcome) return false;

    // After commit — no network inside the tenant transaction (house rule 7).
    await this.routing.notifyEscalation(tenantId, kind, c.id, outcome.state, outcome.route, {
      employeeName: (c.employee_name ?? '').trim(),
      what: whatFor(kind, c),
    });
    return true;
  }
}
