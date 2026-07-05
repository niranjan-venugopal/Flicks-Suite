import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import {
  memberStatus,
  memberships,
  attendanceRecords,
  attendanceRegularizations,
  leaveRequests,
} from '@flicks/db/schema';
import type { DbAdmin } from '@flicks/db';
import { DB_SERVICE_ROLE } from '../../core/database/database.module';
import { DatabaseService } from '../../core/database/database.service';

export type PresenceStatus =
  | 'available'
  | 'busy'
  | 'dnd'
  | 'brb'
  | 'away'
  | 'offline'
  | 'in_office'
  | 'out_of_office'
  | 'ooo_available'
  | 'remote_available';

export const MANUAL_STATUSES = [
  'available',
  'busy',
  'dnd',
  'brb',
  'away',
  'offline',
] as const;
export type ManualStatus = (typeof MANUAL_STATUSES)[number];

export interface ResolvedPresence {
  userId: string;
  status: PresenceStatus;
  message: string | null;
  manual: boolean;
}

/** Live-activity snapshot the gateway feeds into resolution. */
export interface LiveActivity {
  connected: boolean;
  lastActivityAt: number | null; // epoch ms
}

const IDLE_MS = 10 * 60 * 1000; // §5: idle > 10 min → away
const GONE_MS = 30 * 60 * 1000; // §5: no heartbeat > 30 min → offline

/**
 * Presence & status (PRD v4 §5 + design two-axis revision).
 *
 * Resolution (pure, per tenant):
 *  1. unexpired MANUAL status wins;
 *  2. approved leave today → out_of_office ("Out of office = approved leave
 *     only"); if the user is nonetheless online → ooo_available (green dot,
 *     purple ring, "Available · Out of office");
 *  3. open attendance punch → in_office; with an approved WFH regularization
 *     for today → remote_available ("Available · Remote");
 *  4. socket connected + activity ≤ 10 min → available;
 *  5. idle > 10 min → away;  6. gone > 30 min / disconnected → offline.
 */
@Injectable()
export class PresenceService {
  constructor(
    @Inject(DB_SERVICE_ROLE) private readonly dbAdmin: DbAdmin,
    private readonly db: DatabaseService,
  ) {}

  // ─── Manual status CRUD (write-own; RLS enforces) ──────────────────────────

  async setStatus(
    tenantId: string,
    userId: string,
    input: { status: ManualStatus; message?: string; expires_at?: string | null },
  ) {
    if (!MANUAL_STATUSES.includes(input.status)) {
      throw new BadRequestException('Unknown status');
    }
    const message = input.message?.slice(0, 80) ?? null;
    const expiresAt = input.expires_at ? new Date(input.expires_at) : null;
    const row = await this.db.withTenant(
      tenantId,
      async (tx) => {
        const [updated] = await tx
          .insert(memberStatus)
          .values({
            tenant_id: tenantId,
            user_id: userId,
            manual_status: input.status,
            status_message: message,
            expires_at: expiresAt,
          })
          .onConflictDoUpdate({
            target: [memberStatus.tenant_id, memberStatus.user_id],
            set: {
              manual_status: input.status,
              status_message: message,
              expires_at: expiresAt,
              updated_at: new Date(),
            },
          })
          .returning();
        return updated!;
      },
      userId,
    );
    return { data: row };
  }

  /** Reset: clears manual status + message (auto states take over). */
  async clearStatus(tenantId: string, userId: string) {
    await this.db.withTenant(
      tenantId,
      (tx) =>
        tx
          .update(memberStatus)
          .set({
            manual_status: null,
            status_message: null,
            expires_at: null,
            updated_at: new Date(),
          })
          .where(
            and(
              eq(memberStatus.tenant_id, tenantId),
              eq(memberStatus.user_id, userId),
            ),
          ),
      userId,
    );
    return { data: { cleared: true } };
  }

  // ─── Batched resolution ─────────────────────────────────────────────────────

  async resolve(
    tenantId: string,
    userIds: string[],
    live: Map<string, LiveActivity>,
  ): Promise<ResolvedPresence[]> {
    if (!userIds.length) return [];
    const now = Date.now();
    const today = new Date().toISOString().slice(0, 10);

    // Manual statuses (service-role — the gateway resolves without a request ctx).
    const manualRows = await this.dbAdmin
      .select()
      .from(memberStatus)
      .where(
        and(
          eq(memberStatus.tenant_id, tenantId),
          inArray(memberStatus.user_id, userIds),
        ),
      );
    const manualByUser = new Map(manualRows.map((r) => [r.user_id, r]));

    // user → employee bridge for attendance/leave.
    const memberRows = await this.dbAdmin
      .select({
        user_id: memberships.user_id,
        employee_id: memberships.employee_id,
      })
      .from(memberships)
      .where(
        and(
          eq(memberships.tenant_id, tenantId),
          inArray(memberships.user_id, userIds),
          isNotNull(memberships.employee_id),
        ),
      );
    const employeeToUser = new Map(
      memberRows.map((m) => [m.employee_id as string, m.user_id]),
    );
    const employeeIds = [...employeeToUser.keys()];

    const [onLeave, openPunch, wfhToday] = employeeIds.length
      ? await Promise.all([
          this.dbAdmin
            .select({ employee_id: leaveRequests.employee_id })
            .from(leaveRequests)
            .where(
              and(
                eq(leaveRequests.tenant_id, tenantId),
                inArray(leaveRequests.employee_id, employeeIds),
                eq(leaveRequests.status, 'approved'),
                lte(leaveRequests.start_date, today),
                gte(leaveRequests.end_date, today),
              ),
            ),
          this.dbAdmin
            .select({ employee_id: attendanceRecords.employee_id })
            .from(attendanceRecords)
            .where(
              and(
                eq(attendanceRecords.tenant_id, tenantId),
                inArray(attendanceRecords.employee_id, employeeIds),
                eq(attendanceRecords.attendance_date, today),
                isNotNull(attendanceRecords.first_punch_in_at),
                isNull(attendanceRecords.last_punch_out_at),
              ),
            ),
          this.dbAdmin
            .select({ employee_id: attendanceRegularizations.employee_id })
            .from(attendanceRegularizations)
            .where(
              and(
                eq(attendanceRegularizations.tenant_id, tenantId),
                inArray(attendanceRegularizations.employee_id, employeeIds),
                eq(attendanceRegularizations.attendance_date, today),
                eq(attendanceRegularizations.request_type, 'wfh_request'),
                eq(attendanceRegularizations.status, 'approved'),
              ),
            ),
        ])
      : [[], [], []];

    const leaveUsers = new Set(
      onLeave.map((r) => employeeToUser.get(r.employee_id as string)),
    );
    const punchUsers = new Set(
      openPunch.map((r) => employeeToUser.get(r.employee_id as string)),
    );
    const wfhUsers = new Set(
      wfhToday.map((r) => employeeToUser.get(r.employee_id as string)),
    );

    return userIds.map((userId) => {
      const activity = live.get(userId);
      const activeMs = activity?.lastActivityAt
        ? now - activity.lastActivityAt
        : Number.POSITIVE_INFINITY;
      const online = !!activity?.connected && activeMs <= IDLE_MS;

      // 1 — manual wins while unexpired
      const manual = manualByUser.get(userId);
      if (
        manual?.manual_status &&
        (!manual.expires_at || new Date(manual.expires_at).getTime() > now)
      ) {
        return {
          userId,
          status: manual.manual_status as PresenceStatus,
          message: manual.status_message,
          manual: true,
        };
      }
      const message = manual?.status_message ?? null;

      // 2 — approved leave today
      if (leaveUsers.has(userId)) {
        return {
          userId,
          status: online ? 'ooo_available' : 'out_of_office',
          message,
          manual: false,
        };
      }

      // 3 — open punch (office vs WFH context)
      if (punchUsers.has(userId)) {
        return {
          userId,
          status: wfhUsers.has(userId) ? 'remote_available' : 'in_office',
          message,
          manual: false,
        };
      }

      // 4/5/6 — connection + activity
      if (online) return { userId, status: 'available', message, manual: false };
      if (activity?.connected && activeMs <= GONE_MS) {
        return { userId, status: 'away', message, manual: false };
      }
      return { userId, status: 'offline', message, manual: false };
    });
  }

  /** employee → user bridge (leave approvals emit with employeeId). */
  async userIdForEmployee(
    tenantId: string,
    employeeId: string,
  ): Promise<string | null> {
    const [row] = await this.dbAdmin
      .select({ user_id: memberships.user_id })
      .from(memberships)
      .where(
        and(
          eq(memberships.tenant_id, tenantId),
          eq(memberships.employee_id, employeeId),
        ),
      )
      .limit(1);
    return row?.user_id ?? null;
  }

  /** Daily hygiene: null out long-expired manual rows (resolution already ignores them). */
  async sweepExpired(): Promise<number> {
    const res = await this.dbAdmin
      .update(memberStatus)
      .set({ manual_status: null, status_message: null, expires_at: null })
      .where(
        and(
          isNotNull(memberStatus.expires_at),
          sql`${memberStatus.expires_at} < now() - interval '1 day'`,
        ),
      )
      .returning({ id: memberStatus.id });
    return res.length;
  }
}
