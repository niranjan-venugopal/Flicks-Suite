import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { AnyColumn, SQL } from 'drizzle-orm';
import {
  attendanceRegularizations,
  employees,
  leaveRequests,
  memberships,
  timesheetPeriods,
  users,
} from '@flicks/db/schema';
import type { Db } from '@flicks/db';
import { NotificationsService } from '../notifications/notifications.service';
import { employeeOnApprovedLeaveTx } from '../../core/common/workday';
import { dateInTimezone } from '../../core/common/time';

// ─────────────────────────────────────────────────────────────────────────────
// Round L item 2 — approval routing + 24 h escalation (founder decisions):
//
//   level 0  the reporting manager
//   level 1  the manager's manager (one hop)
//   level 2  Owner + HR Admins (memberships.role IN ('owner','admin'))
//
//   • 24 h CALENDAR hours (weekends/holidays included) from the level's
//     anchor — L0: COALESCE(applied_at, created_at) / created_at /
//     submitted_at; L1: escalated_at. The sweep runs every 15 min.
//   • Immediate skip when the current reviewer is on approved FULL-DAY leave
//     today (at apply time and in the sweep). Half-day leave does not count.
//   • No L0 (no manager, or manager = applicant by employees.user_id OR the
//     membership bridge) ⇒ level 2 immediately, reason `no_manager`.
//     L0 stuck and no valid L1 (missing / self / cycle) ⇒ level 2, reason
//     `no_skip_manager`.
//   • May act: the LIVE reporting manager always; the L1 manager once
//     escalation_level >= 1 AND escalated_to_employee_id = me; owner/admin
//     ALWAYS (opened directly); never the applicant (user_id + bridge).
//   • Queues / badge: direct reports always; L1 items for the skip-level
//     manager; owner/admin only L2 items (or where they are the direct /
//     skip-level manager). Team → Leave / Team → Timesheets stay
//     workspace-wide for owner/admin with a `routedToMe` flag per row.
//
// This service is the single home of the routing rules; leave, attendance
// (regularizations), timesheet and dashboard consume it through
// modules/approvals/public.ts. Everything that reads or writes tenant rows
// takes the caller's `withTenant` transaction (…Tx). Day semantics come from
// core/common/workday.ts (A's resolver) — never re-implemented here.
//
// Constructor deps are @Optional() so a service that is built by hand in a
// spec (`new LeaveService(db, audit, notifications)`) can fall back to
// `new ApprovalRoutingService(notifications, config)`; under Nest DI the
// ApprovalsModule always provides both.
// ─────────────────────────────────────────────────────────────────────────────

/** Roles whose review surface is the whole workspace (was copied in 3 services). */
export const ORG_WIDE_REVIEW_ROLES: ReadonlyArray<string> = ['owner', 'admin', 'fam', 'super_admin'];

/** The escalation clock: 24 calendar hours per level. */
export const ESCALATION_SLA_MS = 24 * 60 * 60 * 1000;

export { dateInTimezone };

export type ApprovalKind = 'leave' | 'regularization' | 'timesheet';
export type EscalationLevel = 0 | 1 | 2;
export type EscalationReason = 'sla' | 'reviewer_on_leave' | 'no_manager' | 'no_skip_manager';
export type MayAct = 'manager' | 'skip_manager' | 'org';

/** Who is asking — resolved once per request from the active membership. */
export interface ReviewerCtx {
  tenantId: string;
  userId: string;
  employeeId: string | null;
  /** owner / admin / platform staff — may act on anything, sees L2 in the queue. */
  orgWide: boolean;
  role: string;
}

export interface Recipient {
  userId: string | null;
  email: string | null;
  name: string;
}

export interface RoutePerson extends Recipient {
  employeeId: string;
}

/** The applicant's chain, with self-loops and cycles already cut. */
export interface Route {
  applicantEmployeeId: string;
  applicantUserId: string | null;
  l0: RoutePerson | null;
  l1: RoutePerson | null;
  /** Active owner/admin seats minus the applicant (raw; recipientsFor dedupes). */
  l2: Recipient[];
}

/** What gets stamped on the row (see routeStateColumns). */
export interface RouteState {
  level: EscalationLevel;
  reason: EscalationReason | null;
  escalatedAt: Date | null;
  /** The L1 manager the item was escalated to (level 1 only). */
  escalatedTo: string | null;
  /** Display-only snapshot of the L0 manager at apply time. */
  routedManager: string | null;
}

export interface EscalationPlan {
  level: 1 | 2;
  reason: EscalationReason;
  escalatedTo: string | null;
}

export interface EscalationSummary {
  employeeName: string;
  /** e.g. "CL · 2d (12 Sep – 13 Sep)", "week 2026-09-07 – 2026-09-13 · 40h". */
  what: string;
}

/** The three routed tables share these columns (migration 0062). */
export interface RoutedColumns {
  escalation_level: AnyColumn;
  escalated_to_employee_id: AnyColumn;
}

/** API shape of the escalation block on a pending row (null at level 0). */
export interface EscalationDto {
  level: EscalationLevel;
  reason: EscalationReason | null;
  at: string | null;
  toName: string | null;
}

/** Column values for an INSERT/UPDATE from a RouteState. */
export function routeStateColumns(state: RouteState) {
  return {
    escalation_level: state.level,
    escalated_at: state.escalatedAt,
    escalation_reason: state.reason,
    escalated_to_employee_id: state.escalatedTo,
    routed_manager_employee_id: state.routedManager,
  };
}

/** Rework / resubmit restart the clock: back to an un-routed row. */
export const RESET_ESCALATION = {
  escalation_level: 0,
  escalated_at: null,
  escalation_reason: null,
  escalated_to_employee_id: null,
  routed_manager_employee_id: null,
} as const;

/** Shape a row's escalation columns for the API (null when still at level 0). */
export function shapeEscalation(
  row: {
    escalation_level?: number | null;
    escalationLevel?: number | null;
    escalation_reason?: string | null;
    escalationReason?: string | null;
    escalated_at?: Date | string | null;
    escalatedAt?: Date | string | null;
  },
  toName: string | null = null,
): EscalationDto | null {
  const level = Number(row.escalation_level ?? row.escalationLevel ?? 0) as EscalationLevel;
  if (!level) return null;
  const at = row.escalated_at ?? row.escalatedAt ?? null;
  return {
    level,
    reason: (row.escalation_reason ?? row.escalationReason ?? null) as EscalationReason | null,
    at: at instanceof Date ? at.toISOString() : at ? String(at) : null,
    toName: toName ?? null,
  };
}

const KIND_LABEL: Record<ApprovalKind, string> = {
  leave: 'leave request',
  regularization: 'regularization request',
  timesheet: 'timesheet',
};

const REASON_TEXT: Record<EscalationReason, string> = {
  sla: 'no action for 24 hours',
  reviewer_on_leave: 'their manager is on leave today',
  no_manager: 'no reporting manager is set',
  no_skip_manager: 'there is no one above the manager to escalate to',
};

/** Employment statuses that can still review (soft-delete is checked separately). */
export const LIVE_EMPLOYEE_STATUSES = ['active', 'on_leave', 'notice_period'] as const;

/** The employee-facing view: the level only — never the reason or a name. */
export function authorRoutingView(level: number | null | undefined): {
  escalation: { level: EscalationLevel } | null;
  withLabel: 'manager' | 'hr';
} {
  const l = Number(level ?? 0) as EscalationLevel;
  return { escalation: l ? { level: l } : null, withLabel: l >= 2 ? 'hr' : 'manager' };
}

/** Deep links (Round K/I idioms): the page selects + highlights the row. */
export function approvalDeepLink(kind: ApprovalKind, id: string): string {
  const enc = encodeURIComponent(id);
  switch (kind) {
    case 'leave':
      return `/team/leave?request=${enc}`;
    case 'regularization':
      return `/inbox?tab=approvals&request=${enc}`;
    case 'timesheet':
      return `/team/timesheets?period=${enc}`;
  }
}

/**
 * SQL: the employee `employeeIdCol` (in `tenantExpr`) can still review — not
 * removed, a live employment status, and reachable through an ACTIVE
 * membership (employees.user_id or the membership bridge) whose user is
 * active. The same rule `resolveRouteTx` applies in code (loadPersonTx).
 */
export function isLiveReviewerSql(tenantExpr: SQL, employeeIdCol: AnyColumn | SQL): SQL {
  return sql`EXISTS (
        SELECT 1 FROM employees q_le
          JOIN memberships q_lm ON q_lm.tenant_id = q_le.tenant_id
                               AND q_lm.status = 'active'
                               AND (q_lm.employee_id = q_le.id
                                    OR (q_le.user_id IS NOT NULL AND q_lm.user_id = q_le.user_id))
          JOIN users q_lu ON q_lu.id = q_lm.user_id AND q_lu.status = 'active'
         WHERE q_le.id = ${employeeIdCol}
           AND q_le.tenant_id = ${tenantExpr}
           AND q_le.deleted_at IS NULL
           AND q_le.status IN ('active', 'on_leave', 'notice_period')
      )`;
}

/**
 * SQL: `applicantEmployeeCol`'s employee has a VALID reporting manager — a
 * live reviewer (isLiveReviewerSql) who is not the applicant themselves, by
 * row or by user (employees.user_id / the membership bridge). Exported so the
 * sweep and the queue predicate share one definition with resolveRouteTx.
 */
export function hasValidManagerSql(tenantExpr: SQL, applicantEmployeeCol: AnyColumn | SQL): SQL {
  return sql`EXISTS (
        SELECT 1 FROM employees q_ap
          JOIN employees q_mg ON q_mg.id = q_ap.reporting_manager_id
                             AND q_mg.tenant_id = q_ap.tenant_id
          JOIN memberships q_mm ON q_mm.tenant_id = q_mg.tenant_id
                               AND q_mm.status = 'active'
                               AND (q_mm.employee_id = q_mg.id
                                    OR (q_mg.user_id IS NOT NULL AND q_mm.user_id = q_mg.user_id))
          JOIN users q_mu ON q_mu.id = q_mm.user_id AND q_mu.status = 'active'
         WHERE q_ap.id = ${applicantEmployeeCol}
           AND q_ap.tenant_id = ${tenantExpr}
           AND q_mg.deleted_at IS NULL
           AND q_mg.status IN ('active', 'on_leave', 'notice_period')
           AND q_mg.id <> q_ap.id
           AND (q_ap.user_id IS NULL OR q_mm.user_id <> q_ap.user_id)
           AND NOT EXISTS (
             SELECT 1 FROM memberships q_am
              WHERE q_am.tenant_id = q_ap.tenant_id
                AND q_am.employee_id = q_ap.id
                AND q_am.status = 'active'
                AND q_am.user_id = q_mm.user_id
           )
      )`;
}

@Injectable()
export class ApprovalRoutingService {
  private readonly logger = new Logger(ApprovalRoutingService.name);

  constructor(
    @Optional() private readonly notifications?: NotificationsService,
    @Optional() private readonly config?: ConfigService,
  ) {}

  private appUrl(): string {
    return (this.config?.get<string>('APP_URL', 'http://localhost:3000') ?? 'http://localhost:3000').replace(/\/$/, '');
  }

  // ─── Reviewer ───────────────────────────────────────────────────────────

  /**
   * Who is asking. `roleHint` is the JWT role the guard already trusted;
   * without it (service-level callers) the active membership decides. The
   * employee id comes from the membership bridge first, then from
   * employees.user_id — never self-healed: a manager seat without an employee
   * row has an EMPTY team (but still the L2 queue when org-wide).
   */
  async resolveReviewerTx(
    tx: Db,
    tenantId: string,
    userId: string,
    roleHint?: string,
  ): Promise<ReviewerCtx> {
    const [m] = await tx
      .select({ employeeId: memberships.employee_id, role: memberships.role })
      .from(memberships)
      .where(
        and(
          eq(memberships.user_id, userId),
          eq(memberships.tenant_id, tenantId),
          eq(memberships.status, 'active'),
        ),
      )
      .limit(1);
    let employeeId = m?.employeeId ?? null;
    // The employees.user_id fallback only bridges an ACTIVE seat whose
    // membership row never got employee_id stamped — never a deactivated or
    // missing seat (that would hand a revoked user their old team back).
    if (m && !employeeId) {
      const [e] = await tx
        .select({ id: employees.id })
        .from(employees)
        .where(
          and(
            eq(employees.tenant_id, tenantId),
            eq(employees.user_id, userId),
            sql`${employees.deleted_at} IS NULL`,
          ),
        )
        .limit(1);
      employeeId = e?.id ?? null;
    }
    const role = roleHint ?? m?.role ?? '';
    return {
      tenantId,
      userId,
      employeeId,
      orgWide: ORG_WIDE_REVIEW_ROLES.includes(role),
      role,
    };
  }

  // ─── Route ──────────────────────────────────────────────────────────────

  /** users.id for an employee row through the active membership (bridge). */
  private async bridgeUserIdTx(tx: Db, tenantId: string, employeeId: string): Promise<string | null> {
    const [b] = await tx
      .select({ userId: memberships.user_id })
      .from(memberships)
      .where(
        and(
          eq(memberships.tenant_id, tenantId),
          eq(memberships.employee_id, employeeId),
          eq(memberships.status, 'active'),
        ),
      )
      .limit(1);
    return b?.userId ?? null;
  }

  /**
   * One employee who can still REVIEW, as a route person — or null when they
   * are removed, separated/inactive, have no active seat in the tenant
   * (employees.user_id or the membership bridge) or their user is not active.
   * Anyone else would hold an item for 24 h without ever being able to act.
   * Mirrors isLiveReviewerSql / hasValidManagerSql.
   */
  private async loadPersonTx(
    tx: Db,
    tenantId: string,
    employeeId: string,
  ): Promise<(RoutePerson & { managerId: string | null }) | null> {
    const [e] = await tx
      .select({
        id: employees.id,
        userId: employees.user_id,
        managerId: employees.reporting_manager_id,
        workEmail: employees.work_email,
        firstName: employees.first_name,
        lastName: employees.last_name,
        deletedAt: employees.deleted_at,
        status: employees.status,
        userEmail: users.email,
        userName: users.full_name,
        userStatus: users.status,
      })
      .from(employees)
      .leftJoin(users, eq(users.id, employees.user_id))
      .where(and(eq(employees.id, employeeId), eq(employees.tenant_id, tenantId)))
      .limit(1);
    if (!e || e.deletedAt) return null;
    if (!(LIVE_EMPLOYEE_STATUSES as ReadonlyArray<string>).includes(e.status)) return null;

    let userId = e.userId;
    let userStatus: string | null = e.userStatus ?? null;
    if (userId) {
      const [seat] = await tx
        .select({ id: memberships.id })
        .from(memberships)
        .where(
          and(
            eq(memberships.tenant_id, tenantId),
            eq(memberships.user_id, userId),
            eq(memberships.status, 'active'),
          ),
        )
        .limit(1);
      if (!seat) return null;
    } else {
      const [bridge] = await tx
        .select({ userId: memberships.user_id, status: users.status })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.user_id))
        .where(
          and(
            eq(memberships.tenant_id, tenantId),
            eq(memberships.employee_id, e.id),
            eq(memberships.status, 'active'),
          ),
        )
        .limit(1);
      userId = bridge?.userId ?? null;
      userStatus = bridge?.status ?? null;
    }
    if (!userId || userStatus !== 'active') return null;

    const name = `${e.firstName ?? ''} ${e.lastName ?? ''}`.trim() || e.userName || '';
    return {
      employeeId: e.id,
      userId,
      email: e.workEmail || e.userEmail || null,
      name,
      managerId: e.managerId ?? null,
    };
  }

  /** Can this employee still review (see loadPersonTx)? The sweep's L1 check. */
  async isLiveReviewerTx(tx: Db, tenantId: string, employeeId: string): Promise<boolean> {
    return (await this.loadPersonTx(tx, tenantId, employeeId)) !== null;
  }

  /**
   * The applicant's chain. Guards: a manager who is the applicant (same row,
   * or same user through employees.user_id / the membership bridge) is no
   * reviewer; the same for L1, which additionally may not be the L0 person
   * (A ↔ B cycles collapse to a single hop). Removed employees are cut.
   */
  async resolveRouteTx(tx: Db, tenantId: string, applicantEmployeeId: string): Promise<Route> {
    const [applicant] = await tx
      .select({
        id: employees.id,
        userId: employees.user_id,
        managerId: employees.reporting_manager_id,
      })
      .from(employees)
      .where(and(eq(employees.id, applicantEmployeeId), eq(employees.tenant_id, tenantId)))
      .limit(1);
    const applicantUserId = applicant
      ? (applicant.userId ?? (await this.bridgeUserIdTx(tx, tenantId, applicant.id)))
      : null;

    const sameUser = (a: string | null, b: string | null) => !!a && !!b && a === b;

    let l0: (RoutePerson & { managerId: string | null }) | null = null;
    if (applicant?.managerId && applicant.managerId !== applicantEmployeeId) {
      const cand = await this.loadPersonTx(tx, tenantId, applicant.managerId);
      if (cand && !sameUser(cand.userId, applicantUserId)) l0 = cand;
    }

    let l1: (RoutePerson & { managerId: string | null }) | null = null;
    if (l0?.managerId && l0.managerId !== applicantEmployeeId && l0.managerId !== l0.employeeId) {
      const cand = await this.loadPersonTx(tx, tenantId, l0.managerId);
      if (
        cand &&
        !sameUser(cand.userId, applicantUserId) &&
        !sameUser(cand.userId, l0.userId)
      ) {
        l1 = cand;
      }
    }

    // Owner + HR Admin seats that can actually act: active membership AND
    // an active user (a suspended/deleted user or an invited/deactivated seat
    // is no reviewer).
    const l2 = await tx
      .select({ userId: users.id, email: users.email, name: users.full_name })
      .from(memberships)
      .innerJoin(users, and(eq(users.id, memberships.user_id), eq(users.status, 'active')))
      .where(
        and(
          eq(memberships.tenant_id, tenantId),
          eq(memberships.status, 'active'),
          inArray(memberships.role, ['owner', 'admin']),
          applicantUserId ? ne(memberships.user_id, applicantUserId) : sql`true`,
        ),
      );

    const strip = (p: (RoutePerson & { managerId: string | null }) | null): RoutePerson | null =>
      p ? { employeeId: p.employeeId, userId: p.userId, email: p.email, name: p.name } : null;

    return {
      applicantEmployeeId,
      applicantUserId,
      l0: strip(l0),
      l1: strip(l1),
      l2: l2.map((r) => ({ userId: r.userId, email: r.email, name: r.name ?? '' })),
    };
  }

  /**
   * Approved FULL-DAY leave covering `today` (YYYY-MM-DD) — A's day resolver
   * (core/common/workday.ts). Half-day leave is not "on leave".
   */
  reviewerOnLeaveTodayTx(
    tx: Db,
    tenantId: string,
    employeeId: string,
    today: string,
  ): Promise<boolean> {
    return employeeOnApprovedLeaveTx(tx, tenantId, employeeId, today);
  }

  /**
   * Where an item goes NEXT from `fromLevel` (null when already at L2):
   *   0 → 1 when a valid L1 exists and is not on leave today, else → 2
   *   1 → 2
   * `trigger` becomes the stored reason, except an SLA breach with no L1 at
   * all, which reads `no_skip_manager`; no L0 at all always reads `no_manager`.
   */
  async planEscalationTx(
    tx: Db,
    tenantId: string,
    route: Route,
    fromLevel: number,
    trigger: EscalationReason,
    today: string,
  ): Promise<EscalationPlan | null> {
    if (fromLevel >= 2) return null;
    if (!route.l0) return { level: 2, reason: 'no_manager', escalatedTo: null };
    if (fromLevel === 0) {
      const l1 = route.l1;
      if (l1 && !(await this.reviewerOnLeaveTodayTx(tx, tenantId, l1.employeeId, today))) {
        return { level: 1, reason: trigger, escalatedTo: l1.employeeId };
      }
      return {
        level: 2,
        reason: l1 ? trigger : trigger === 'sla' ? 'no_skip_manager' : trigger,
        escalatedTo: null,
      };
    }
    return { level: 2, reason: trigger, escalatedTo: null };
  }

  /**
   * The state a NEW item is born with: level 0 with the manager snapshotted;
   * level 1/2 straight away when the manager is on approved full-day leave
   * today; level 2 (`no_manager`) when there is no valid manager at all.
   */
  async initialStateTx(
    tx: Db,
    tenantId: string,
    applicantEmployeeId: string,
    today: string,
    now: Date = new Date(),
  ): Promise<{ state: RouteState; route: Route }> {
    const route = await this.resolveRouteTx(tx, tenantId, applicantEmployeeId);
    if (!route.l0) {
      return {
        route,
        state: { level: 2, reason: 'no_manager', escalatedAt: now, escalatedTo: null, routedManager: null },
      };
    }
    if (await this.reviewerOnLeaveTodayTx(tx, tenantId, route.l0.employeeId, today)) {
      const plan = await this.planEscalationTx(tx, tenantId, route, 0, 'reviewer_on_leave', today);
      return {
        route,
        state: {
          level: plan?.level ?? 2,
          reason: plan?.reason ?? 'reviewer_on_leave',
          escalatedAt: now,
          escalatedTo: plan?.escalatedTo ?? null,
          routedManager: route.l0.employeeId,
        },
      };
    }
    return {
      route,
      state: { level: 0, reason: null, escalatedAt: null, escalatedTo: null, routedManager: route.l0.employeeId },
    };
  }

  // ─── Queue predicate + may-act guard ────────────────────────────────────

  /**
   * SQL narrowing a routed table to what the reviewer's QUEUE (Inbox →
   * Approvals, badge, /pending routes) shows:
   *   direct report (live reporting_manager_id)
   *   OR (escalation_level >= 1 AND escalated_to_employee_id = me)
   *   OR org-wide AND (escalation_level = 2 OR the applicant has no valid
   *      manager at all — a row that was never stamped, e.g. from before
   *      0062, is HR's from the start rather than nobody's)
   * and never the reviewer's own request (employees.user_id + the membership
   * bridge). Works whether or not `employees` is joined — every lookup is a
   * correlated subquery on the applicant column, prefixed `q_` so it never
   * collides with the caller's aliases.
   */
  queuePredicate(
    reviewer: ReviewerCtx,
    table: RoutedColumns,
    applicantEmployeeCol: AnyColumn | SQL,
  ): SQL {
    const t = reviewer.tenantId;
    const me = reviewer.userId;
    const notApplicant = sql`NOT EXISTS (
        SELECT 1 FROM employees q_ae
         WHERE q_ae.id = ${applicantEmployeeCol}
           AND q_ae.tenant_id = ${t}::uuid
           AND q_ae.user_id = ${me}::uuid
      ) AND NOT EXISTS (
        SELECT 1 FROM memberships q_am
         WHERE q_am.employee_id = ${applicantEmployeeCol}
           AND q_am.tenant_id = ${t}::uuid
           AND q_am.status = 'active'
           AND q_am.user_id = ${me}::uuid
      )`;
    const parts: SQL[] = [];
    if (reviewer.employeeId) {
      parts.push(sql`EXISTS (
        SELECT 1 FROM employees q_dr
         WHERE q_dr.id = ${applicantEmployeeCol}
           AND q_dr.tenant_id = ${t}::uuid
           AND q_dr.reporting_manager_id = ${reviewer.employeeId}::uuid
           AND q_dr.deleted_at IS NULL
      )`);
      parts.push(
        sql`(${table.escalation_level} >= 1 AND ${table.escalated_to_employee_id} = ${reviewer.employeeId}::uuid)`,
      );
    }
    if (reviewer.orgWide) {
      parts.push(sql`${table.escalation_level} = 2`);
      parts.push(sql`NOT ${hasValidManagerSql(sql`${t}::uuid`, applicantEmployeeCol)}`);
    }
    if (parts.length === 0) return sql`false`;
    return sql`((${sql.join(parts, sql` OR `)}) AND ${notApplicant})`;
  }

  /**
   * The server guard every review path runs: the LIVE reporting manager
   * always may act; the L1 manager once the item was escalated to them;
   * owner/admin always (the "open directly" surface); the applicant never —
   * through employees.user_id AND the membership bridge, which also closes the
   * leave self-approval gap. Returns HOW the reviewer qualifies.
   */
  async assertMayActTx(
    tx: Db,
    tenantId: string,
    reviewer: ReviewerCtx,
    item: { applicantEmployeeId: string; level: number; escalatedTo: string | null },
    kind?: ApprovalKind,
  ): Promise<MayAct> {
    const [applicant] = await tx
      .select({ userId: employees.user_id, managerId: employees.reporting_manager_id })
      .from(employees)
      .where(and(eq(employees.id, item.applicantEmployeeId), eq(employees.tenant_id, tenantId)))
      .limit(1);
    if (!applicant) throw new NotFoundException('Applicant not found');

    const [selfBridge] = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(
        and(
          eq(memberships.tenant_id, tenantId),
          eq(memberships.employee_id, item.applicantEmployeeId),
          eq(memberships.user_id, reviewer.userId),
          eq(memberships.status, 'active'),
        ),
      )
      .limit(1);
    if (
      (applicant.userId && applicant.userId === reviewer.userId) ||
      selfBridge ||
      (reviewer.employeeId && reviewer.employeeId === item.applicantEmployeeId)
    ) {
      throw new ForbiddenException(
        `You cannot approve your own ${kind ? KIND_LABEL[kind] : 'request'} — another approver must review it.`,
      );
    }

    if (reviewer.employeeId && applicant.managerId === reviewer.employeeId) return 'manager';
    if (reviewer.employeeId && item.level >= 1 && item.escalatedTo === reviewer.employeeId) {
      return 'skip_manager';
    }
    if (reviewer.orgWide) return 'org';
    throw new ForbiddenException(
      `You can only review ${kind ? KIND_LABEL[kind] + 's' : 'requests'} from your direct reports, or ones escalated to you.`,
    );
  }

  // ─── Recipients ─────────────────────────────────────────────────────────

  /**
   * Who to tell when an item sits at `level`: L0 → the manager; L1 → the
   * skip-level manager; L2 → owner + admins minus the applicant and minus
   * anyone already told at L0/L1 (escalation notifies the NEW reviewers
   * only). A level whose reviewer does not exist (no manager; the L1 manager
   * removed) falls through to Owner + HR Admins — nobody is left holding
   * nothing (house rule 8). Deduped by user id.
   */
  recipientsFor(route: Route, level: number): Recipient[] {
    if (level <= 0 && route.l0) return [route.l0];
    if (level === 1 && route.l1) return [route.l1];
    const seen = new Set<string>();
    if (route.applicantUserId) seen.add(route.applicantUserId);
    if (route.l0?.userId) seen.add(route.l0.userId);
    if (route.l1?.userId) seen.add(route.l1.userId);
    const out: Recipient[] = [];
    for (const r of route.l2) {
      if (!r.userId || seen.has(r.userId)) continue;
      seen.add(r.userId);
      out.push(r);
    }
    return out;
  }

  // ─── Read / escalate ────────────────────────────────────────────────────

  /** The live routing columns of one item (null when gone). */
  async readStateTx(
    tx: Db,
    tenantId: string,
    kind: ApprovalKind,
    id: string,
  ): Promise<{
    status: string;
    employeeId: string;
    level: number;
    reason: string | null;
    escalatedAt: Date | null;
    escalatedTo: string | null;
    anchor: Date | null;
  } | null> {
    switch (kind) {
      case 'leave': {
        const [r] = await tx
          .select({
            status: leaveRequests.status,
            employeeId: leaveRequests.employee_id,
            level: leaveRequests.escalation_level,
            reason: leaveRequests.escalation_reason,
            escalatedAt: leaveRequests.escalated_at,
            escalatedTo: leaveRequests.escalated_to_employee_id,
            anchor: sql<Date | null>`COALESCE(${leaveRequests.applied_at}, ${leaveRequests.created_at})`,
          })
          .from(leaveRequests)
          .where(and(eq(leaveRequests.id, id), eq(leaveRequests.tenant_id, tenantId)))
          .limit(1);
        return r ? { ...r, anchor: toDate(r.anchor) } : null;
      }
      case 'regularization': {
        const [r] = await tx
          .select({
            status: attendanceRegularizations.status,
            employeeId: attendanceRegularizations.employee_id,
            level: attendanceRegularizations.escalation_level,
            reason: attendanceRegularizations.escalation_reason,
            escalatedAt: attendanceRegularizations.escalated_at,
            escalatedTo: attendanceRegularizations.escalated_to_employee_id,
            anchor: attendanceRegularizations.created_at,
          })
          .from(attendanceRegularizations)
          .where(
            and(eq(attendanceRegularizations.id, id), eq(attendanceRegularizations.tenant_id, tenantId)),
          )
          .limit(1);
        return r ? { ...r, anchor: toDate(r.anchor) } : null;
      }
      case 'timesheet': {
        const [r] = await tx
          .select({
            status: timesheetPeriods.status,
            employeeId: timesheetPeriods.employee_id,
            level: timesheetPeriods.escalation_level,
            reason: timesheetPeriods.escalation_reason,
            escalatedAt: timesheetPeriods.escalated_at,
            escalatedTo: timesheetPeriods.escalated_to_employee_id,
            anchor: timesheetPeriods.submitted_at,
          })
          .from(timesheetPeriods)
          .where(and(eq(timesheetPeriods.id, id), eq(timesheetPeriods.tenant_id, tenantId)))
          .limit(1);
        return r ? { ...r, anchor: toDate(r.anchor) } : null;
      }
    }
  }

  /**
   * Move one OPEN item from `prevLevel` to `target.level` — a guarded UPDATE
   * (`WHERE escalation_level = prev AND status = open`), so two sweeps or a
   * sweep racing a decision can never double-escalate. Returns the new state,
   * or null when the row moved on already.
   */
  async escalateTx(
    tx: Db,
    tenantId: string,
    kind: ApprovalKind,
    id: string,
    prevLevel: number,
    reason: EscalationReason,
    target: { level: 1 | 2; escalatedTo: string | null },
  ): Promise<RouteState | null> {
    const now = new Date();
    // `escalated_to_employee_id` is written on 0 → 1 only and left UNTOUCHED
    // on 1 → 2: the manager's manager keeps the item in their queue and may
    // still act once it is with HR (founder: earlier reviewers act "when not
    // closed"). A direct 0 → 2 never had an L1 reviewer.
    const set = {
      escalation_level: target.level,
      escalated_at: now,
      escalation_reason: reason,
      ...(target.level === 1 ? { escalated_to_employee_id: target.escalatedTo } : {}),
    };
    let rows: Array<{ level: number; at: Date | null; reason: string | null; to: string | null; routed: string | null }>;
    switch (kind) {
      case 'leave':
        rows = await tx
          .update(leaveRequests)
          .set({ ...set, updated_at: now })
          .where(
            and(
              eq(leaveRequests.id, id),
              eq(leaveRequests.tenant_id, tenantId),
              eq(leaveRequests.escalation_level, prevLevel),
              eq(leaveRequests.status, 'pending'),
            ),
          )
          .returning({
            level: leaveRequests.escalation_level,
            at: leaveRequests.escalated_at,
            reason: leaveRequests.escalation_reason,
            to: leaveRequests.escalated_to_employee_id,
            routed: leaveRequests.routed_manager_employee_id,
          });
        break;
      case 'regularization':
        rows = await tx
          .update(attendanceRegularizations)
          .set(set)
          .where(
            and(
              eq(attendanceRegularizations.id, id),
              eq(attendanceRegularizations.tenant_id, tenantId),
              eq(attendanceRegularizations.escalation_level, prevLevel),
              eq(attendanceRegularizations.status, 'pending'),
            ),
          )
          .returning({
            level: attendanceRegularizations.escalation_level,
            at: attendanceRegularizations.escalated_at,
            reason: attendanceRegularizations.escalation_reason,
            to: attendanceRegularizations.escalated_to_employee_id,
            routed: attendanceRegularizations.routed_manager_employee_id,
          });
        break;
      case 'timesheet':
        rows = await tx
          .update(timesheetPeriods)
          .set({ ...set, updated_at: now })
          .where(
            and(
              eq(timesheetPeriods.id, id),
              eq(timesheetPeriods.tenant_id, tenantId),
              eq(timesheetPeriods.escalation_level, prevLevel),
              eq(timesheetPeriods.status, 'submitted'),
            ),
          )
          .returning({
            level: timesheetPeriods.escalation_level,
            at: timesheetPeriods.escalated_at,
            reason: timesheetPeriods.escalation_reason,
            to: timesheetPeriods.escalated_to_employee_id,
            routed: timesheetPeriods.routed_manager_employee_id,
          });
        break;
    }
    const r = rows[0];
    if (!r) return null;
    return {
      level: r.level as EscalationLevel,
      reason: (r.reason ?? null) as EscalationReason | null,
      escalatedAt: r.at,
      escalatedTo: r.to,
      routedManager: r.routed,
    };
  }

  // ─── Notifications (after commit; best-effort) ──────────────────────────

  /**
   * Tell the NEW reviewers (recipientsFor(route, state.level)) that an item
   * landed with them: in-app `${kind}.escalated` (groupKey `${kind}:${id}`,
   * deep-linked) + the `approval-escalated` email (every string escaped in
   * the template). Never throws — house rule 6.
   */
  async notifyEscalation(
    tenantId: string,
    kind: ApprovalKind,
    id: string,
    state: RouteState,
    route: Route,
    summary: EscalationSummary,
  ): Promise<void> {
    const notifications = this.notifications;
    if (!notifications) {
      this.logger.warn(`notifyEscalation(${kind}/${id}) skipped: no NotificationsService bound`);
      return;
    }
    try {
      const recipients = this.recipientsFor(route, state.level);
      if (recipients.length === 0) return;
      const reason = state.reason ?? 'sla';
      const path = approvalDeepLink(kind, id);
      const reviewUrl = `${this.appUrl()}${path}`;
      const employeeName = summary.employeeName.trim() || 'An employee';
      const message = `${employeeName}'s ${KIND_LABEL[kind]} (${summary.what}) was escalated to you — ${REASON_TEXT[reason]}.`;
      const event =
        kind === 'leave'
          ? ('leave_requested' as const)
          : kind === 'regularization'
            ? ('regularization_requested' as const)
            : ('timesheet_submitted' as const);
      const levelLabel = state.level === 1 ? "as the manager's manager" : 'as Owner / HR Admin';

      for (const r of recipients) {
        if (r.userId) {
          await notifications
            .createInAppNotification(r.userId, `${kind}.escalated`, message, path, tenantId, {
              groupKey: `${kind}:${id}`,
            })
            .catch((err) => this.logger.warn(`Escalation in-app notification failed: ${err}`));
        }
        if (!r.email) continue;
        await notifications
          .sendEmail(
            'approval-escalated',
            r.email,
            {
              reviewerName: r.name || 'there',
              employeeName,
              kindLabel: KIND_LABEL[kind],
              summary: summary.what,
              reasonText: REASON_TEXT[reason],
              levelLabel,
              reviewUrl,
            },
            r.userId ? { userId: r.userId, event } : undefined,
          )
          .catch((err) => this.logger.warn(`Escalation email failed: ${err}`));
      }
    } catch (err) {
      this.logger.warn(`notifyEscalation(${kind}/${id}) failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * An item routed to a manager was decided over their head — by an
   * owner/HR admin who opened it directly, or by the skip-level manager after
   * escalation. Tell the routed manager (and the skip-level manager, once the
   * item had reached them) so "on your behalf" is never a surprise:
   * `${kind}.reviewed_on_behalf` — "Hema approved Asha's leave request on your
   * behalf." Never the decider, never the applicant. Best-effort.
   */
  async notifyDecidedOnBehalf(
    tenantId: string,
    kind: ApprovalKind,
    id: string,
    route: Route,
    level: number,
    decision: {
      deciderUserId: string;
      deciderName: string;
      employeeName: string;
      action: 'approve' | 'reject' | 'rework';
    },
  ): Promise<void> {
    const notifications = this.notifications;
    if (!notifications) return;
    try {
      const targets: RoutePerson[] = [];
      if (route.l0) targets.push(route.l0);
      if (level >= 1 && route.l1) targets.push(route.l1);
      const seen = new Set<string>([decision.deciderUserId, route.applicantUserId ?? '']);
      const verb =
        decision.action === 'approve'
          ? 'approved'
          : decision.action === 'reject'
            ? 'rejected'
            : 'sent back for rework';
      const link =
        kind === 'leave' ? '/team/leave' : kind === 'regularization' ? '/inbox?tab=approvals' : '/team/timesheets';
      const message = `${decision.deciderName.trim() || 'An approver'} ${verb} ${decision.employeeName.trim() || 'an employee'}'s ${KIND_LABEL[kind]} on your behalf.`;
      for (const t of targets) {
        if (!t.userId || seen.has(t.userId)) continue;
        seen.add(t.userId);
        await notifications
          .createInAppNotification(t.userId, `${kind}.reviewed_on_behalf`, message, link, tenantId, {
            groupKey: `${kind}:${id}`,
          })
          .catch((err) => this.logger.warn(`On-behalf notice failed: ${err}`));
      }
    } catch (err) {
      this.logger.warn(`notifyDecidedOnBehalf(${kind}/${id}) failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}

function toDate(v: Date | string | null | undefined): Date | null {
  if (!v) return null;
  return v instanceof Date ? v : new Date(v);
}
