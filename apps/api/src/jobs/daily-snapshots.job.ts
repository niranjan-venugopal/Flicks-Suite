import { Injectable, Logger, Inject } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { and, eq, gte, inArray, sql, isNull } from 'drizzle-orm';
import {
  tenants,
  employees,
  attendanceRecords,
  tenantHealthSnapshots,
} from '@flicks/db/schema';
import { DB_SERVICE_ROLE } from '../core/database/database.module';
import type { DbAdmin } from '@flicks/db';

const SPECFLICKS_TENANT_ID = '00000000-0000-0000-0000-000000000001';

// Attendance statuses that count as the employee having shown up.
const PRESENT_STATUSES = [
  'present',
  'late',
  'half_day',
  'work_from_home',
  'on_duty',
] as const;

/**
 * Computes one tenant_health_snapshots row per active tenant per day.
 * Idempotent: re-runs upsert on (tenant_id, snapshot_date).
 */
@Injectable()
export class DailySnapshotsJob {
  private readonly logger = new Logger(DailySnapshotsJob.name);

  constructor(@Inject(DB_SERVICE_ROLE) private readonly dbAdmin: DbAdmin) {}

  @Cron(CronExpression.EVERY_DAY_AT_1AM, {
    name: 'daily-snapshots',
    timeZone: 'UTC',
  })
  async computeDailySnapshots(): Promise<void> {
    const startedAt = Date.now();
    this.logger.log('Starting daily snapshot computation');

    try {
      const result = await this.runForDate(new Date());
      this.logger.log(
        `Daily snapshots: ${result.written} tenant(s) in ${Date.now() - startedAt}ms`,
      );
    } catch (err) {
      this.logger.error('Daily snapshot computation failed', err as Error);
      throw err;
    }
  }

  /** Exposed so it can be invoked manually / from a backfill script. */
  async runForDate(now: Date): Promise<{ written: number }> {
    const snapshotDate = now.toISOString().slice(0, 10);
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const cutoff7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const cutoff30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    // Real customer tenants only — exclude the Specflicks platform tenant and
    // anything fully cancelled.
    const activeTenants = await this.dbAdmin
      .select({ id: tenants.id })
      .from(tenants)
      .where(
        and(
          inArray(tenants.status, ['trialing', 'active', 'past_due', 'suspended']),
          sql`${tenants.id} <> ${SPECFLICKS_TENANT_ID}`,
        ),
      );

    let written = 0;
    for (const t of activeTenants) {
      const [headcount] = await this.dbAdmin
        .select({ n: sql<number>`count(*)::int` })
        .from(employees)
        .where(
          and(
            eq(employees.tenant_id, t.id),
            isNull(employees.deleted_at), // round 21 — not headcount any more
            inArray(employees.status, ['active', 'on_leave', 'notice_period']),
          ),
        );

      const [present] = await this.dbAdmin
        .select({ n: sql<number>`count(*)::int` })
        .from(attendanceRecords)
        .where(
          and(
            eq(attendanceRecords.tenant_id, t.id),
            eq(attendanceRecords.attendance_date, yesterday),
            inArray(attendanceRecords.attendance_status, [...PRESENT_STATUSES]),
          ),
        );

      const [active7] = await this.dbAdmin
        .select({
          n: sql<number>`count(distinct ${attendanceRecords.employee_id})::int`,
        })
        .from(attendanceRecords)
        .where(
          and(
            eq(attendanceRecords.tenant_id, t.id),
            gte(attendanceRecords.attendance_date, cutoff7),
            inArray(attendanceRecords.attendance_status, [...PRESENT_STATUSES]),
          ),
        );

      const [active30] = await this.dbAdmin
        .select({
          n: sql<number>`count(distinct ${attendanceRecords.employee_id})::int`,
        })
        .from(attendanceRecords)
        .where(
          and(
            eq(attendanceRecords.tenant_id, t.id),
            gte(attendanceRecords.attendance_date, cutoff30),
            inArray(attendanceRecords.attendance_status, [...PRESENT_STATUSES]),
          ),
        );

      const totalHeads = Number(headcount?.n ?? 0);
      const presentCount = Number(present?.n ?? 0);
      const compliance = totalHeads > 0 ? presentCount / totalHeads : 0;
      const activeUsers7d = Number(active7?.n ?? 0);
      const activeUsers30d = Number(active30?.n ?? 0);

      // Derive the health signal. New (no headcount/activity) vs the
      // compliance-banded states. Expansion/churn need trend data we don't
      // compute here, so we map to the three meaningful day-one states.
      let signal: 'healthy' | 'at_risk' | 'churning' | 'new';
      if (totalHeads === 0 || activeUsers30d === 0) {
        signal = 'new';
      } else if (compliance >= 0.8) {
        signal = 'healthy';
      } else if (compliance >= 0.5) {
        signal = 'at_risk';
      } else {
        signal = 'churning';
      }

      const healthScore = Math.round(compliance * 100);

      await this.dbAdmin
        .insert(tenantHealthSnapshots)
        .values({
          tenant_id: t.id,
          snapshot_date: snapshotDate,
          health_score: healthScore,
          active_users_7d: activeUsers7d,
          active_users_30d: activeUsers30d,
          attendance_compliance: compliance,
          signal,
          computed_at: new Date(),
        })
        .onConflictDoUpdate({
          target: [
            tenantHealthSnapshots.tenant_id,
            tenantHealthSnapshots.snapshot_date,
          ],
          set: {
            health_score: healthScore,
            active_users_7d: activeUsers7d,
            active_users_30d: activeUsers30d,
            attendance_compliance: compliance,
            signal,
            computed_at: new Date(),
          },
        });
      written += 1;
    }

    return { written };
  }
}
