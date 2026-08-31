import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { activities, deals, directoryCompanies, directoryPeople, memberships, users } from '@flicks/db/schema';
import type { Db } from '@flicks/db';
import { DatabaseService } from '../../core/database/database.service';
import { AuditService } from '../audit/audit.service';
import { DomainEventsService } from '../../core/events/domain-events.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PresencePublicService } from '../presence/public';

const TYPES = ['task', 'call', 'meeting', 'note'] as const;
const CALL_OUTCOMES = ['connected', 'no_answer', 'busy', 'voicemail', 'wrong_number'] as const;

/** Cutoff for the activity purge — N days back from now. */
function purgeCutoff(days: number): Date {
  return new Date(Date.now() - days * 86_400_000);
}

/**
 * What the purge touches: live rows older than the cutoff. completedOnly
 * (the default posture) clears only finished history — completed before the
 * cutoff; otherwise anything CREATED before the cutoff goes, open or not.
 * Explicit tenant predicate as defence-in-depth on top of RLS.
 */
function purgePredicate(tenantId: string, cutoff: Date, completedOnly: boolean) {
  return and(
    eq(activities.tenant_id, tenantId),
    isNull(activities.deleted_at),
    completedOnly
      ? and(isNotNull(activities.completed_at), lt(activities.completed_at, cutoff))
      : lt(activities.created_at, cutoff),
  );
}

/**
 * Activities (PRD v5 §6) — the follow-up loop behind activity-based selling.
 * Every write keeps the parent deal's next_activity_at (earliest OPEN due) and
 * last_activity_at (latest completion/note) current, so the board's coral
 * "no next activity" doctrine line and idle detection stay index-cheap.
 */
@Injectable()
export class ActivitiesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly domainEvents: DomainEventsService,
    private readonly notifications: NotificationsService,
    private readonly presence: PresencePublicService,
  ) {}

  /**
   * In-app ping to the assignee of an activity someone ELSE scheduled (§6.3),
   * respecting Do-Not-Disturb: a dnd presence swallows the ping (the item is
   * still in their queue + morning digest, so nothing is lost). Best-effort —
   * a notification hiccup must never fail the activity write.
   */
  private async pingAssignee(tenantId: string, assigneeId: string, actorId: string, a: { type: string; subject: string; deal_id: string | null; id: string }) {
    if (assigneeId === actorId) return;
    try {
      const status = await this.presence.statusOf(tenantId, assigneeId);
      if (status === 'dnd') return; // respect Do-Not-Disturb
      await this.notifications.createInAppNotification(
        assigneeId,
        'crm.activity.assigned',
        `New ${a.type} assigned to you: “${a.subject}”`,
        a.deal_id ? `/crm/deals/${a.deal_id}` : '/crm/activities',
        tenantId,
      );
    } catch {
      /* best-effort */
    }
  }

  /** Recompute the deal's next/last activity stamps. Runs inside the caller's tx. */
  private async syncDealStamps(tx: Db, dealId: string) {
    await tx.execute(sql`
      UPDATE deals d SET
        next_activity_at = (
          SELECT min(a.due_at) FROM activities a
          WHERE a.deal_id = d.id AND a.completed_at IS NULL AND a.deleted_at IS NULL AND a.due_at IS NOT NULL
        ),
        last_activity_at = (
          SELECT max(coalesce(a.completed_at, a.created_at)) FROM activities a
          WHERE a.deal_id = d.id AND a.deleted_at IS NULL
            AND (a.completed_at IS NOT NULL OR a.type = 'note')
        )
      WHERE d.id = ${dealId}
    `);
  }

  async create(
    tenantId: string,
    userId: string,
    dto: {
      type: string;
      subject: string;
      body?: string;
      deal_id?: string;
      person_id?: string;
      company_id?: string;
      assignee_user_id?: string;
      due_at?: string;
      outcome?: string;
    },
  ) {
    if (!TYPES.includes(dto.type as never)) throw new BadRequestException('Invalid activity type');
    if (!dto.subject?.trim()) throw new BadRequestException('Subject is required');
    if (dto.type !== 'note' && !dto.due_at) throw new BadRequestException('Tasks, calls and meetings need a due time');
    if (dto.outcome && !CALL_OUTCOMES.includes(dto.outcome as never)) throw new BadRequestException('Invalid call outcome');

    return this.db.withTenant(
      tenantId,
      async (tx) => {
        // RLS-scoped reference validation (FK checks bypass RLS — house rule).
        if (dto.deal_id) {
          const [d] = await tx.select({ id: deals.id }).from(deals).where(and(eq(deals.id, dto.deal_id), isNull(deals.deleted_at))).limit(1);
          if (!d) throw new BadRequestException('deal_id does not belong to this workspace');
        }
        if (dto.person_id) {
          const [p] = await tx.select({ id: directoryPeople.id }).from(directoryPeople).where(and(eq(directoryPeople.id, dto.person_id), isNull(directoryPeople.deleted_at))).limit(1);
          if (!p) throw new BadRequestException('person_id does not belong to this workspace');
        }
        if (dto.company_id) {
          const [c] = await tx.select({ id: directoryCompanies.id }).from(directoryCompanies).where(and(eq(directoryCompanies.id, dto.company_id), isNull(directoryCompanies.deleted_at))).limit(1);
          if (!c) throw new BadRequestException('company_id does not belong to this workspace');
        }
        const assignee = dto.assignee_user_id ?? userId;
        if (assignee !== userId) {
          const [m] = await tx
            .select({ id: memberships.id })
            .from(memberships)
            .where(and(eq(memberships.tenant_id, tenantId), eq(memberships.user_id, assignee), eq(memberships.status, 'active')))
            .limit(1);
          if (!m) throw new BadRequestException('assignee is not an active member of this workspace');
        }

        // A logged note is born completed (it happened); everything else is open.
        const isNote = dto.type === 'note';
        const [row] = await tx
          .insert(activities)
          .values({
            tenant_id: tenantId,
            type: dto.type,
            subject: dto.subject.trim(),
            body: dto.body ?? null,
            deal_id: dto.deal_id ?? null,
            person_id: dto.person_id ?? null,
            company_id: dto.company_id ?? null,
            assignee_user_id: assignee,
            due_at: dto.due_at ? new Date(dto.due_at) : null,
            completed_at: isNote ? new Date() : null,
            completed_by: isNote ? userId : null,
            outcome: dto.outcome ?? null,
            created_by: userId,
          })
          .returning();

        if (dto.deal_id) await this.syncDealStamps(tx, dto.deal_id);
        await this.audit.log({ tenantId, actorUserId: userId, action: 'crm.activity.create', resourceType: 'activity', resourceId: row!.id });
        await this.domainEvents.publish(
          { name: 'crm.activity.created', tenantId, actorUserId: userId, payload: { activity_id: row!.id, type: dto.type, deal_id: dto.deal_id ?? null } },
          tx,
        );
        return { data: row! };
      },
      userId,
    ).then(async (res) => {
      // Outside the tx: ping the assignee when it isn't the creator (DND-aware).
      // Detached (round C): the ping is best-effort by contract; the activity
      // CTA shouldn't wait on a presence lookup + inbox write.
      void this.pingAssignee(tenantId, res.data.assignee_user_id, userId, res.data);
      return res;
    });
  }

  /** Activities on one deal (open first by due, then completed desc). */
  async listForDeal(tenantId: string, dealId: string) {
    return this.db.withTenant(tenantId, async (tx) => {
      const rows = await tx
        .select({
          id: activities.id,
          type: activities.type,
          subject: activities.subject,
          body: activities.body,
          due_at: activities.due_at,
          completed_at: activities.completed_at,
          outcome: activities.outcome,
          assignee_user_id: activities.assignee_user_id,
          assignee_name: users.full_name,
          created_at: activities.created_at,
        })
        .from(activities)
        .innerJoin(users, eq(users.id, activities.assignee_user_id))
        .where(and(eq(activities.deal_id, dealId), isNull(activities.deleted_at)))
        .orderBy(sql`${activities.completed_at} IS NOT NULL`, asc(activities.due_at));
      return { data: rows };
    });
  }

  /**
   * My Activities (C8): the signed-in user's open activities bucketed into
   * overdue / today / upcoming, plus recently completed.
   */
  /** Activities linked to a contact / company — the detail-page timeline. */
  async listForContact(tenantId: string, personId: string) {
    return this.listForRef(tenantId, eq(activities.person_id, personId));
  }

  async listForCompany(tenantId: string, companyId: string) {
    return this.listForRef(tenantId, eq(activities.company_id, companyId));
  }

  private async listForRef(tenantId: string, refWhere: ReturnType<typeof eq>) {
    return this.db.withTenant(tenantId, async (tx) => {
      const rows = await tx
        .select({
          id: activities.id,
          type: activities.type,
          subject: activities.subject,
          body: activities.body,
          due_at: activities.due_at,
          completed_at: activities.completed_at,
          outcome: activities.outcome,
          assignee_user_id: activities.assignee_user_id,
          assignee_name: users.full_name,
          deal_id: activities.deal_id,
          created_at: activities.created_at,
        })
        .from(activities)
        .innerJoin(users, eq(users.id, activities.assignee_user_id))
        .where(and(refWhere, isNull(activities.deleted_at)))
        .orderBy(sql`${activities.completed_at} IS NOT NULL`, asc(activities.due_at))
        .limit(50);
      return { data: rows };
    });
  }

  async mine(tenantId: string, userId: string) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        // Open buckets are the user's own queue (assignee = me); the completed
        // bucket ALSO includes activities the user completed for teammates
        // (completed_by = me) — e.g. closing a colleague's "Call within 1h"
        // from the deal timeline — so done work never vanishes from their view.
        const rows = await tx
          .select({
            id: activities.id,
            type: activities.type,
            subject: activities.subject,
            body: activities.body,
            due_at: activities.due_at,
            completed_at: activities.completed_at,
            completed_by: activities.completed_by,
            outcome: activities.outcome,
            assignee_user_id: activities.assignee_user_id,
            assignee_name: users.full_name,
            deal_id: activities.deal_id,
            deal_title: deals.title,
            person_id: activities.person_id,
            created_at: activities.created_at,
          })
          .from(activities)
          .leftJoin(deals, eq(deals.id, activities.deal_id))
          .leftJoin(users, eq(users.id, activities.assignee_user_id))
          .where(
            and(
              or(eq(activities.assignee_user_id, userId), eq(activities.completed_by, userId)),
              isNull(activities.deleted_at),
            ),
          )
          .orderBy(asc(activities.due_at));

        const now = new Date();
        const endOfToday = new Date(now); endOfToday.setHours(23, 59, 59, 999);
        const open = rows.filter((r) => !r.completed_at && r.assignee_user_id === userId);
        const done = rows
          .filter((r) => r.completed_at)
          .sort((a, b) => new Date(b.completed_at!).getTime() - new Date(a.completed_at!).getTime())
          .slice(0, 15);
        return {
          data: {
            overdue: open.filter((r) => r.due_at && new Date(r.due_at) < now),
            today: open.filter((r) => r.due_at && new Date(r.due_at) >= now && new Date(r.due_at) <= endOfToday),
            upcoming: open.filter((r) => !r.due_at || new Date(r.due_at) > endOfToday),
            completed: done,
          },
        };
      },
      userId,
    );
  }

  /** Complete an activity (optionally with a call outcome + note). */
  async complete(tenantId: string, userId: string, id: string, dto?: { outcome?: string; note?: string }) {
    if (dto?.outcome && !CALL_OUTCOMES.includes(dto.outcome as never)) throw new BadRequestException('Invalid call outcome');
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const [a] = await tx.select().from(activities).where(and(eq(activities.id, id), isNull(activities.deleted_at))).limit(1).for('update');
        if (!a) throw new NotFoundException('Activity not found');
        if (a.completed_at) return { data: a }; // idempotent
        const [row] = await tx
          .update(activities)
          .set({
            completed_at: new Date(),
            completed_by: userId,
            outcome: dto?.outcome ?? a.outcome,
            body: dto?.note ? (a.body ? `${a.body}\n\n${dto.note}` : dto.note) : a.body,
            updated_at: new Date(),
          })
          .where(eq(activities.id, id))
          .returning();
        if (a.deal_id) await this.syncDealStamps(tx, a.deal_id);
        await this.audit.log({ tenantId, actorUserId: userId, action: 'crm.activity.complete', resourceType: 'activity', resourceId: id });
        await this.domainEvents.publish(
          { name: 'crm.activity.completed', tenantId, actorUserId: userId, payload: { activity_id: id, type: a.type, deal_id: a.deal_id ?? null } },
          tx,
        );
        return { data: row! };
      },
      userId,
    );
  }

  /**
   * Bulk cleanup (round 9): count what a purge WOULD remove, so the Data
   * hygiene card can show "1,240 activities" before anyone commits.
   */
  async purgePreview(tenantId: string, days: number, completedOnly: boolean) {
    const cutoff = purgeCutoff(days);
    return this.db.withTenant(tenantId, async (tx) => {
      const [row] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(activities)
        .where(purgePredicate(tenantId, cutoff, completedOnly));
      return { data: { count: row?.n ?? 0, cutoff: cutoff.toISOString() } };
    });
  }

  /**
   * Clear activities older than N days (round 9) — at client volume the log
   * becomes a dump. One set-based soft delete in a tenant transaction with a
   * single audit row carrying the count (the import-undo pattern). Deal
   * stamps are recomputed for every touched deal so next/last-activity stay
   * truthful on the board.
   */
  async purgeOlderThan(
    tenantId: string,
    userId: string,
    opts: { days: number; completedOnly: boolean },
  ) {
    const cutoff = purgeCutoff(opts.days);
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const removed = await tx
          .update(activities)
          .set({ deleted_at: new Date(), updated_at: new Date() })
          .where(purgePredicate(tenantId, cutoff, opts.completedOnly))
          .returning({ id: activities.id, deal_id: activities.deal_id });

        const dealIds = [...new Set(removed.map((r) => r.deal_id).filter(Boolean))] as string[];
        for (const dealId of dealIds) await this.syncDealStamps(tx, dealId);

        await this.audit.log({
          tenantId,
          actorUserId: userId,
          action: 'crm.activities.purge',
          resourceType: 'activity',
          metadata: {
            days: opts.days,
            completedOnly: opts.completedOnly,
            cutoff: cutoff.toISOString(),
            removed: removed.length,
          },
        });
        return { data: { removed: removed.length, cutoff: cutoff.toISOString() } };
      },
      userId,
    );
  }

  async remove(tenantId: string, userId: string, id: string) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const [a] = await tx
          .update(activities)
          .set({ deleted_at: new Date(), updated_at: new Date() })
          .where(and(eq(activities.id, id), isNull(activities.deleted_at)))
          .returning({ id: activities.id, deal_id: activities.deal_id });
        if (!a) throw new NotFoundException('Activity not found');
        if (a.deal_id) await this.syncDealStamps(tx, a.deal_id);
        await this.audit.log({ tenantId, actorUserId: userId, action: 'crm.activity.delete', resourceType: 'activity', resourceId: id });
        return { data: { deleted: true } };
      },
      userId,
    );
  }
}
