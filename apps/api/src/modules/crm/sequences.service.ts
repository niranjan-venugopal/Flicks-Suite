import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import {
  deals,
  directoryPeople,
  emailMessages,
  sequenceEnrollments,
  sequenceSteps,
  sequences,
  users,
} from '@flicks/db/schema';
import type { DbAdmin } from '@flicks/db';
import { DB_SERVICE_ROLE } from '../../core/database/database.module';
import { DatabaseService } from '../../core/database/database.service';
import { AuditService } from '../audit/audit.service';
import { DomainEventsService } from '../../core/events/domain-events.service';
import { CrmEmailService } from './email.service';

const DAILY_SEND_CAP = 200; // §7.1 — per enrolling user per day
const LEASE_MINUTES = 15; // crash-safe claim: a failed step retries after this

/**
 * Sequences engine (PRD v5 §7.1 / C10) — timed multi-step follow-up email.
 * Enrollments advance on a 5-minute tick: due rows are claimed with
 * FOR UPDATE SKIP LOCKED + a lease bump (safe under inline + dedicated
 * workers), re-checked against §19.5 DNC and the deal's state, throttled to
 * 200 sends/user/day, clamped into the sequence's send window (its own
 * timezone), and sent through CrmEmailService — so variables, signatures,
 * tracking and the timeline all behave exactly like a hand-written email.
 * Exits: reply + DNC (wired in CrmEmailService), won/lost (event subscriber),
 * manual (API).
 */
@Injectable()
export class SequencesService {
  private readonly logger = new Logger(SequencesService.name);
  private ticking = false;

  constructor(
    private readonly db: DatabaseService,
    @Inject(DB_SERVICE_ROLE) private readonly dbAdmin: DbAdmin,
    private readonly audit: AuditService,
    private readonly domainEvents: DomainEventsService,
    private readonly email: CrmEmailService,
  ) {}

  // ─── CRUD ─────────────────────────────────────────────────────────────────────

  async list(tenantId: string) {
    return this.db.withTenant(tenantId, async (tx) => {
      const seqs = await tx.select().from(sequences).orderBy(asc(sequences.name));
      const steps = await tx.select().from(sequenceSteps).orderBy(asc(sequenceSteps.step_order));
      const active = await tx
        .select({ sequence_id: sequenceEnrollments.sequence_id, n: sql<number>`count(*)::int` })
        .from(sequenceEnrollments)
        .where(eq(sequenceEnrollments.status, 'active'))
        .groupBy(sequenceEnrollments.sequence_id);
      const activeBySeq = new Map(active.map((a) => [a.sequence_id, a.n]));
      return {
        data: seqs.map((s) => ({
          ...s,
          steps: steps.filter((st) => st.sequence_id === s.id),
          active_enrollments: activeBySeq.get(s.id) ?? 0,
        })),
      };
    });
  }

  async create(
    tenantId: string,
    userId: string,
    dto: {
      name: string;
      send_window_start?: string;
      send_window_end?: string;
      timezone?: string;
      steps: Array<{ subject: string; body_html: string; wait_days?: number }>;
    },
  ) {
    if (!dto.name?.trim()) throw new BadRequestException('Sequence name is required');
    if (!dto.steps?.length) throw new BadRequestException('A sequence needs at least one step');
    const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
    const start = dto.send_window_start ?? '09:00';
    const end = dto.send_window_end ?? '18:00';
    if (!hhmm.test(start) || !hhmm.test(end)) throw new BadRequestException('Send window must be HH:MM');
    if (start >= end) throw new BadRequestException('Send window must start before it ends');
    for (const s of dto.steps) {
      if (!s.subject?.trim() || !s.body_html?.trim()) throw new BadRequestException('Every step needs a subject and body');
      if ((s.wait_days ?? 0) < 0) throw new BadRequestException('wait_days cannot be negative');
    }

    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const [seq] = await tx
          .insert(sequences)
          .values({
            tenant_id: tenantId,
            name: dto.name.trim(),
            send_window_start: start,
            send_window_end: end,
            timezone: dto.timezone ?? 'Asia/Kolkata',
            created_by: userId,
          })
          .returning();
        await tx.insert(sequenceSteps).values(
          dto.steps.map((s, i) => ({
            tenant_id: tenantId,
            sequence_id: seq!.id,
            step_order: i,
            wait_days: s.wait_days ?? (i === 0 ? 0 : 3),
            subject: s.subject,
            body_html: s.body_html,
          })),
        );
        await this.audit.log({ tenantId, actorUserId: userId, action: 'crm.sequence.create', resourceType: 'sequence', resourceId: seq!.id });
        return { data: seq! };
      },
      userId,
    );
  }

  // ─── Enroll / exit ────────────────────────────────────────────────────────────

  async enroll(tenantId: string, userId: string, dto: { sequence_id: string; person_id: string; deal_id?: string }) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const [seq] = await tx.select().from(sequences).where(and(eq(sequences.id, dto.sequence_id), eq(sequences.is_active, true))).limit(1);
        if (!seq) throw new NotFoundException('Sequence not found or inactive');
        const [person] = await tx
          .select()
          .from(directoryPeople)
          .where(and(eq(directoryPeople.id, dto.person_id), isNull(directoryPeople.deleted_at)))
          .limit(1);
        if (!person) throw new BadRequestException('person_id does not belong to this workspace');
        if (!person.email) throw new BadRequestException('Contact has no email address');
        if (person.email_do_not_contact) {
          throw new BadRequestException(`${person.display_name ?? 'Contact'} is marked do-not-contact (${person.email_do_not_contact_reason ?? 'manual'})`);
        }
        if (dto.deal_id) {
          const [d] = await tx.select({ id: deals.id }).from(deals).where(and(eq(deals.id, dto.deal_id), isNull(deals.deleted_at))).limit(1);
          if (!d) throw new BadRequestException('deal_id does not belong to this workspace');
        }
        try {
          const [row] = await tx
            .insert(sequenceEnrollments)
            .values({
              tenant_id: tenantId,
              sequence_id: dto.sequence_id,
              person_id: dto.person_id,
              deal_id: dto.deal_id ?? null,
              enrolled_by: userId,
              current_step: 0,
              next_send_at: this.clampIntoWindow(new Date(), seq.timezone, seq.send_window_start, seq.send_window_end),
            })
            .returning();
          await this.audit.log({ tenantId, actorUserId: userId, action: 'crm.sequence.enroll', resourceType: 'sequence_enrollment', resourceId: row!.id });
          await this.domainEvents.publish(
            { name: 'crm.sequence.enrolled', tenantId, actorUserId: userId, payload: { enrollment_id: row!.id, sequence_id: dto.sequence_id, person_id: dto.person_id } },
            tx,
          );
          return { data: row! };
        } catch (err) {
          if ((err as { code?: string })?.code === '23505') {
            throw new ConflictException('This contact is already actively enrolled in that sequence');
          }
          throw err;
        }
      },
      userId,
    );
  }

  async exit(tenantId: string, userId: string, enrollmentId: string, reason = 'manual') {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const [row] = await tx
          .update(sequenceEnrollments)
          .set({ status: 'exited', exit_reason: reason, updated_at: new Date() })
          .where(and(eq(sequenceEnrollments.id, enrollmentId), eq(sequenceEnrollments.status, 'active')))
          .returning();
        if (!row) throw new NotFoundException('Active enrollment not found');
        await this.audit.log({ tenantId, actorUserId: userId, action: 'crm.sequence.exit', resourceType: 'sequence_enrollment', resourceId: enrollmentId, metadata: { reason } });
        await this.domainEvents.publish(
          { name: 'crm.sequence.exited', tenantId, actorUserId: userId, payload: { enrollment_id: enrollmentId, reason } },
          tx,
        );
        return { data: row };
      },
      userId,
    );
  }

  async listEnrollments(tenantId: string, sequenceId: string) {
    return this.db.withTenant(tenantId, async (tx) => {
      const rows = await tx
        .select({
          id: sequenceEnrollments.id,
          person_id: sequenceEnrollments.person_id,
          person_name: directoryPeople.display_name,
          person_email: directoryPeople.email,
          deal_id: sequenceEnrollments.deal_id,
          current_step: sequenceEnrollments.current_step,
          next_send_at: sequenceEnrollments.next_send_at,
          status: sequenceEnrollments.status,
          exit_reason: sequenceEnrollments.exit_reason,
          created_at: sequenceEnrollments.created_at,
        })
        .from(sequenceEnrollments)
        .innerJoin(directoryPeople, eq(directoryPeople.id, sequenceEnrollments.person_id))
        .where(eq(sequenceEnrollments.sequence_id, sequenceId))
        .orderBy(desc(sequenceEnrollments.created_at));
      return { data: rows };
    });
  }

  /** Event-subscriber hook: a won/lost deal exits its active enrollments. */
  async exitByDeal(tenantId: string, dealId: string, reason: 'won' | 'lost') {
    await this.dbAdmin
      .update(sequenceEnrollments)
      .set({ status: 'exited', exit_reason: reason, updated_at: new Date() })
      .where(and(eq(sequenceEnrollments.tenant_id, tenantId), eq(sequenceEnrollments.deal_id, dealId), eq(sequenceEnrollments.status, 'active')));
  }

  // ─── The engine tick ──────────────────────────────────────────────────────────

  /** Claim due enrollments (lease-bumped, SKIP LOCKED) and advance each. */
  async tick(now: Date): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    try {
      const claimed = await this.dbAdmin.transaction(async (tx) => {
        const due = await tx
          .select()
          .from(sequenceEnrollments)
          .where(and(eq(sequenceEnrollments.status, 'active'), lte(sequenceEnrollments.next_send_at, now)))
          .orderBy(asc(sequenceEnrollments.next_send_at))
          .limit(50)
          .for('update', { skipLocked: true });
        if (due.length) {
          // Lease: a crash mid-processing retries in LEASE_MINUTES, and no
          // concurrent tick (inline + worker) can double-claim.
          await tx
            .update(sequenceEnrollments)
            .set({ next_send_at: new Date(now.getTime() + LEASE_MINUTES * 60_000), updated_at: now })
            .where(inArray(sequenceEnrollments.id, due.map((d) => d.id)));
        }
        return due;
      });

      let sent = 0;
      for (const enr of claimed) {
        try {
          sent += (await this.advance(enr, now)) ? 1 : 0;
        } catch (err) {
          this.logger.error(`sequence advance failed for ${enr.id}: ${err instanceof Error ? err.message : err}`);
        }
      }
      return sent;
    } finally {
      this.ticking = false;
    }
  }

  private async advance(enr: typeof sequenceEnrollments.$inferSelect, now: Date): Promise<boolean> {
    const [seq] = await this.dbAdmin.select().from(sequences).where(eq(sequences.id, enr.sequence_id)).limit(1);
    if (!seq || !seq.is_active) {
      await this.finish(enr.id, 'exited', 'manual');
      return false;
    }

    // Re-check the recipient (§19.5) and the deal every step — the world moves.
    const [person] = await this.dbAdmin.select().from(directoryPeople).where(eq(directoryPeople.id, enr.person_id)).limit(1);
    if (!person || person.deleted_at || !person.email) {
      await this.finish(enr.id, 'exited', 'manual');
      return false;
    }
    if (person.email_do_not_contact) {
      await this.finish(enr.id, 'exited', 'dnc');
      return false;
    }
    if (enr.deal_id) {
      const [d] = await this.dbAdmin.select({ status: deals.status, deleted_at: deals.deleted_at }).from(deals).where(eq(deals.id, enr.deal_id)).limit(1);
      if (d && !d.deleted_at && d.status !== 'open') {
        await this.finish(enr.id, 'exited', d.status === 'won' ? 'won' : 'lost');
        return false;
      }
    }

    // Send window (the sequence's own timezone).
    const windowed = this.clampIntoWindow(now, seq.timezone, seq.send_window_start, seq.send_window_end);
    if (windowed.getTime() > now.getTime()) {
      await this.dbAdmin.update(sequenceEnrollments).set({ next_send_at: windowed, updated_at: now }).where(eq(sequenceEnrollments.id, enr.id));
      return false;
    }

    // §7.1 throttle: 200 sends per enrolling user per day.
    if (enr.enrolled_by) {
      const dayStart = new Date(now); dayStart.setUTCHours(0, 0, 0, 0);
      const [{ n }] = await this.dbAdmin
        .select({ n: sql<number>`count(*)::int` })
        .from(emailMessages)
        .where(and(eq(emailMessages.sender_user_id, enr.enrolled_by), eq(emailMessages.direction, 'out'), gte(emailMessages.created_at, dayStart)));
      if (Number(n) >= DAILY_SEND_CAP) {
        await this.dbAdmin
          .update(sequenceEnrollments)
          .set({ next_send_at: new Date(now.getTime() + 3600_000), updated_at: now })
          .where(eq(sequenceEnrollments.id, enr.id));
        this.logger.warn(`sequence throttle: user ${enr.enrolled_by} hit ${DAILY_SEND_CAP}/day — deferring ${enr.id}`);
        return false;
      }
    }

    const steps = await this.dbAdmin
      .select()
      .from(sequenceSteps)
      .where(eq(sequenceSteps.sequence_id, enr.sequence_id))
      .orderBy(asc(sequenceSteps.step_order));
    const step = steps[enr.current_step];
    if (!step) {
      await this.finish(enr.id, 'completed', null);
      return false;
    }

    // Send through the same pipeline as hand-written email.
    const res = await this.email.send(enr.tenant_id, enr.enrolled_by ?? person.created_by ?? person.id, {
      person_id: enr.person_id,
      deal_id: enr.deal_id ?? undefined,
      subject: step.subject,
      body_html: step.body_html,
      sequence_enrollment_id: enr.id,
    });
    await this.domainEvents.publish({
      name: 'crm.sequence.step_sent',
      tenantId: enr.tenant_id,
      payload: { enrollment_id: enr.id, sequence_id: enr.sequence_id, step: enr.current_step, message_id: res.data.id },
    });

    const nextIdx = enr.current_step + 1;
    if (nextIdx >= steps.length) {
      await this.finish(enr.id, 'completed', null);
      await this.domainEvents.publish({
        name: 'crm.sequence.completed',
        tenantId: enr.tenant_id,
        payload: { enrollment_id: enr.id, sequence_id: enr.sequence_id },
      });
    } else {
      const wait = steps[nextIdx]!.wait_days;
      const nextAt = this.clampIntoWindow(new Date(now.getTime() + wait * 86_400_000), seq.timezone, seq.send_window_start, seq.send_window_end);
      await this.dbAdmin
        .update(sequenceEnrollments)
        .set({ current_step: nextIdx, next_send_at: nextAt, updated_at: now })
        .where(eq(sequenceEnrollments.id, enr.id));
    }
    return true;
  }

  private async finish(enrollmentId: string, status: 'completed' | 'exited', reason: string | null) {
    await this.dbAdmin
      .update(sequenceEnrollments)
      .set({ status, exit_reason: reason, next_send_at: null, updated_at: new Date() })
      .where(eq(sequenceEnrollments.id, enrollmentId));
  }

  /** Earliest instant ≥ `at` that falls inside the send window in `tz`. */
  clampIntoWindow(at: Date, tz: string, start: string, end: string): Date {
    const [sh, sm] = start.split(':').map(Number);
    const [eh, em] = end.split(':').map(Number);
    const startMin = sh! * 60 + sm!;
    const endMin = eh! * 60 + em!;
    let local: { h: number; m: number };
    try {
      const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(at);
      const [h, m] = parts.split(':').map(Number);
      local = { h: h!, m: m! };
    } catch {
      local = { h: at.getUTCHours(), m: at.getUTCMinutes() };
    }
    const nowMin = local.h * 60 + local.m;
    if (nowMin < startMin) return new Date(at.getTime() + (startMin - nowMin) * 60_000);
    if (nowMin >= endMin) return new Date(at.getTime() + (1440 - nowMin + startMin) * 60_000);
    return at;
  }
}
