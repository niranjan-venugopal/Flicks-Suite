import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, count, desc, eq, gt, sql } from 'drizzle-orm';
import {
  feedbackSubmissions,
  npsResponses,
  productEvents,
  invoices,
  users,
  tenants,
  employees,
} from '@flicks/db/schema';
import type { DbAdmin } from '@flicks/db';
import { DB_SERVICE_ROLE } from '../../core/database/database.module';
import { DatabaseService } from '../../core/database/database.service';
import { AnalyticsService } from '../../core/analytics/analytics.service';
import { AuditService } from '../audit/audit.service';

const SURVEY_KEY = 'beta_nps_v1';
const NPS_MIN_ACCOUNT_AGE_DAYS = 21;
const NPS_MIN_ACTIVE_DAYS = 3;
const NPS_SNOOZE_DAYS = 14;

/**
 * In-app feedback + NPS (PRD v4 §7). Both work regardless of analytics
 * consent (user-initiated, §3.1). Feedback lands in the FAM inbox (D12);
 * NPS eligibility gates per §7.2, one response per user per survey key.
 */
@Injectable()
export class FeedbackService {
  constructor(
    @Inject(DB_SERVICE_ROLE) private readonly dbAdmin: DbAdmin,
    private readonly db: DatabaseService,
    private readonly analytics: AnalyticsService,
    private readonly audit: AuditService,
  ) {}

  // ─── Feedback (D10-R panel) ─────────────────────────────────────────────────

  async submit(
    tenantId: string,
    userId: string,
    dto: { category: string; message: string; contact_ok?: boolean; page_path?: string },
  ) {
    if (!dto.message?.trim()) throw new BadRequestException('Say something first');
    // 10/user/day (§7, rolling 24h window). Counted INSIDE the insert
    // transaction (self-visibility RLS shows the user their own rows) so
    // concurrent submits can't all read a stale pre-insert count.
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const row = await this.db.withTenant(
      tenantId,
      async (tx) => {
        const [{ n }] = await tx
          .select({ n: count() })
          .from(feedbackSubmissions)
          .where(
            and(
              eq(feedbackSubmissions.user_id, userId),
              gt(feedbackSubmissions.created_at, dayAgo),
            ),
          );
        if (Number(n) >= 10) {
          throw new HttpException(
            'Feedback limit reached for today — thank you for all of it!',
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }
        const [created] = await tx
          .insert(feedbackSubmissions)
          .values({
            tenant_id: tenantId,
            user_id: userId,
            category: dto.category,
            message: dto.message.slice(0, 4000),
            contact_ok: dto.contact_ok ?? false,
            page_path: dto.page_path?.slice(0, 300),
          })
          .returning();
        return created!;
      },
      userId,
    );
    void this.analytics.track({
      event: 'feedback_submitted',
      tenantId,
      userId,
      properties: { category: dto.category },
    });
    return { data: { id: row.id, status: row.status } };
  }

  // ─── NPS (D11) ──────────────────────────────────────────────────────────────

  /** §7.2 gates: age ≥21d · ≥3 distinct active days · tenant activity · no row. */
  async eligibility(tenantId: string, userId: string) {
    const existing = await this.db.withTenant(
      tenantId,
      (tx) =>
        tx
          .select()
          .from(npsResponses)
          .where(
            and(eq(npsResponses.user_id, userId), eq(npsResponses.survey_key, SURVEY_KEY)),
          )
          .limit(1),
      userId,
    );
    const row = existing[0];
    if (row) {
      const resnooze =
        row.status === 'snoozed' &&
        row.snoozed_until &&
        new Date(row.snoozed_until).getTime() < Date.now();
      if (!resnooze) return { data: { eligible: false, survey_key: SURVEY_KEY } };
      // snooze elapsed → prompt again
      return { data: { eligible: true, survey_key: SURVEY_KEY } };
    }

    // §7.2 gate 1 — TENANT age ≥ 21d (the workspace must be past its first
    // impressions; the user-familiarity gate is the active-days check below).
    const [tenant] = await this.dbAdmin
      .select({ created_at: tenants.created_at })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    const ageDays = tenant
      ? (Date.now() - new Date(tenant.created_at).getTime()) / (24 * 60 * 60 * 1000)
      : 0;
    if (ageDays < NPS_MIN_ACCOUNT_AGE_DAYS) {
      return { data: { eligible: false, survey_key: SURVEY_KEY } };
    }

    // Distinct active days: first_login_day is already deduped to one event
    // per user per day by the analytics listener, so the row count IS the
    // distinct-day count — recomputing ::date here would re-introduce a
    // day-boundary mismatch with the emitter.
    const [{ days }] = await this.dbAdmin
      .select({ days: count() })
      .from(productEvents)
      .where(
        and(
          eq(productEvents.user_id, userId),
          eq(productEvents.event_name, 'first_login_day'),
        ),
      );
    if (Number(days) < NPS_MIN_ACTIVE_DAYS) {
      return { data: { eligible: false, survey_key: SURVEY_KEY } };
    }

    // Tenant activity: ≥1 SENT invoice OR completed HRMS onboarding (any
    // employee past self-onboarding review). Quotes and drafted-then-
    // cancelled invoices don't count as "sent an invoice".
    const [sentInvoice] = await this.dbAdmin
      .select({ one: sql<number>`1` })
      .from(invoices)
      .where(
        and(
          eq(invoices.tenant_id, tenantId),
          eq(invoices.document_type, 'INVOICE'),
          sql`${invoices.status} IN ('SENT','VIEWED','PARTIALLY_PAID','PAID','OVERDUE')`,
        ),
      )
      .limit(1);
    let tenantActive = !!sentInvoice;
    if (!tenantActive) {
      const [onboarded] = await this.dbAdmin
        .select({ one: sql<number>`1` })
        .from(employees)
        .where(
          and(
            eq(employees.tenant_id, tenantId),
            sql`(${employees.custom_fields}->>'onboarding_submitted_for_review')::boolean = true`,
          ),
        )
        .limit(1);
      tenantActive = !!onboarded;
    }
    return { data: { eligible: tenantActive, survey_key: SURVEY_KEY } };
  }

  async respond(
    tenantId: string,
    userId: string,
    dto: { action: 'answer' | 'snooze' | 'dismiss'; score?: number; comment?: string },
  ) {
    if (dto.action === 'answer' && (dto.score === undefined || dto.score < 0 || dto.score > 10)) {
      throw new BadRequestException('Score must be 0–10');
    }
    const now = new Date();
    const row = await this.db.withTenant(
      tenantId,
      async (tx) => {
        // Answered and dismissed are TERMINAL (§7: one response per survey key;
        // × = permanent). Only a snoozed row may be acted on again — without
        // this, a stray 'dismiss' after answering would wipe the score via the
        // upsert, or a second 'answer' would rewrite it.
        const [existing] = await tx
          .select({ status: npsResponses.status })
          .from(npsResponses)
          .where(
            and(eq(npsResponses.user_id, userId), eq(npsResponses.survey_key, SURVEY_KEY)),
          )
          .limit(1);
        if (existing && existing.status !== 'snoozed') {
          return { status: existing.status, unchanged: true as const };
        }
        const values = {
          tenant_id: tenantId,
          user_id: userId,
          survey_key: SURVEY_KEY,
          score: dto.action === 'answer' ? dto.score : null,
          comment: dto.action === 'answer' ? dto.comment?.slice(0, 2000) : null,
          status:
            dto.action === 'answer'
              ? ('answered' as const)
              : dto.action === 'snooze'
                ? ('snoozed' as const)
                : ('dismissed' as const),
          prompted_at: now,
          responded_at: dto.action === 'answer' ? now : null,
          snoozed_until:
            dto.action === 'snooze'
              ? new Date(now.getTime() + NPS_SNOOZE_DAYS * 24 * 60 * 60 * 1000)
              : null,
        };
        const [upserted] = await tx
          .insert(npsResponses)
          .values(values)
          .onConflictDoUpdate({
            target: [npsResponses.user_id, npsResponses.survey_key],
            set: values,
          })
          .returning();
        return { status: upserted!.status, unchanged: false as const };
      },
      userId,
    );
    if (dto.action === 'answer' && !row.unchanged) {
      void this.analytics.track({
        event: 'nps_submitted',
        tenantId,
        userId,
        properties: { score: dto.score ?? null },
      });
    }
    return { data: { status: row.status } };
  }

  // ─── FAM inbox (D12) + NPS summary (D13) — service role ────────────────────

  async famList(filters: { category?: string; status?: string; tenantId?: string }) {
    const conds = [] as ReturnType<typeof eq>[];
    if (filters.category) conds.push(eq(feedbackSubmissions.category, filters.category));
    if (filters.status) conds.push(eq(feedbackSubmissions.status, filters.status));
    if (filters.tenantId) conds.push(eq(feedbackSubmissions.tenant_id, filters.tenantId));
    const rows = await this.dbAdmin
      .select({
        id: feedbackSubmissions.id,
        created_at: feedbackSubmissions.created_at,
        tenant_id: feedbackSubmissions.tenant_id,
        tenant_name: tenants.name,
        user_id: feedbackSubmissions.user_id,
        user_name: users.full_name,
        user_email: users.email,
        category: feedbackSubmissions.category,
        message: feedbackSubmissions.message,
        status: feedbackSubmissions.status,
        contact_ok: feedbackSubmissions.contact_ok,
        page_path: feedbackSubmissions.page_path,
        internal_note: feedbackSubmissions.internal_note,
      })
      .from(feedbackSubmissions)
      .innerJoin(tenants, eq(tenants.id, feedbackSubmissions.tenant_id))
      .innerJoin(users, eq(users.id, feedbackSubmissions.user_id))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(feedbackSubmissions.created_at))
      .limit(200);
    // Contact-ok gates the email in the payload (D12: "contact-ok exposes email").
    return {
      data: rows.map((r) => ({ ...r, user_email: r.contact_ok ? r.user_email : null })),
    };
  }

  async famUpdate(
    id: string,
    actorUserId: string,
    dto: { status?: string; internal_note?: string },
  ) {
    if (dto.status === undefined && dto.internal_note === undefined) {
      // Drizzle's update().set({}) throws at query-build time → 500 without this.
      throw new BadRequestException('Nothing to update');
    }
    const [existing] = await this.dbAdmin
      .select()
      .from(feedbackSubmissions)
      .where(eq(feedbackSubmissions.id, id))
      .limit(1);
    if (!existing) throw new NotFoundException('Feedback not found');
    const [updated] = await this.dbAdmin
      .update(feedbackSubmissions)
      .set({
        ...(dto.status ? { status: dto.status } : {}),
        ...(dto.internal_note !== undefined ? { internal_note: dto.internal_note } : {}),
        // Resolution stamp follows the status: set on resolve/close, CLEARED
        // when reopened — a 'triaged' row must not claim it was resolved.
        ...(dto.status === 'resolved' || dto.status === 'closed'
          ? { resolved_by: actorUserId, resolved_at: new Date() }
          : dto.status === 'new' || dto.status === 'triaged'
            ? { resolved_by: null, resolved_at: null }
            : {}),
      })
      .where(eq(feedbackSubmissions.id, id))
      .returning();
    await this.audit.logPlatform({
      actorUserId,
      action: 'fam.feedback_updated',
      targetTenantId: existing.tenant_id,
      metadata: { feedback_id: id, status: dto.status ?? existing.status },
    });
    return { data: updated };
  }

  /** D13 — score = %promoters(9–10) − %detractors(0–6). */
  async npsSummary() {
    const rows = await this.dbAdmin
      .select({ score: npsResponses.score })
      .from(npsResponses)
      .where(and(eq(npsResponses.survey_key, SURVEY_KEY), eq(npsResponses.status, 'answered')));
    const total = rows.length;
    const promoters = rows.filter((r) => (r.score ?? 0) >= 9).length;
    const passives = rows.filter((r) => (r.score ?? 0) >= 7 && (r.score ?? 0) <= 8).length;
    const detractors = rows.filter((r) => (r.score ?? -1) >= 0 && (r.score ?? 11) <= 6).length;
    const score =
      total > 0 ? Math.round((promoters / total) * 100 - (detractors / total) * 100) : 0;
    return {
      data: { survey_key: SURVEY_KEY, total, promoters, passives, detractors, score },
    };
  }
}
