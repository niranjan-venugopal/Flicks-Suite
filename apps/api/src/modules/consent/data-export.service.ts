import {
  Injectable,
  Inject,
  Logger,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import JSZip from 'jszip';
import { and, desc, eq, gt, sql } from 'drizzle-orm';
import {
  users,
  memberships,
  tenants,
  consentRecords,
  employees,
  attendanceRecords,
  leaveRequests,
  timesheetEntries,
  customers,
  items,
  invoices,
  invoiceLineItems,
  invoicePayments,
  creditNotes,
  debitNotes,
  invoiceSubscriptions,
  invoicingSettings,
  auditLog,
  feedbackSubmissions,
  productEvents,
} from '@flicks/db/schema';
import type { DbAdmin } from '@flicks/db';
import { DB_SERVICE_ROLE } from '../../core/database/database.module';
import { DatabaseService } from '../../core/database/database.service';
import { R2Service } from '../../core/storage/r2.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditService } from '../audit/audit.service';
import { AnalyticsService } from '../../core/analytics/analytics.service';

const LINK_TTL_SECONDS = 7 * 24 * 60 * 60; // 7-day signed links (§3.5)

/** Flat rows → CSV with a UTF-8 BOM (Excel-friendly). */
function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return '﻿';
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown) => {
    if (v === null || v === undefined) return '';
    const s = v instanceof Date ? v.toISOString() : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return (
    '﻿' +
    [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join(
      '\n',
    )
  );
}

/**
 * Self-service data exports (PRD v4 §3.5). Both flavors build a ZIP, upload it
 * to private R2 under exports/…, and email a 7-day signed link. Builds run
 * fire-and-forget in-process (single-instance beta; started/finished audit
 * pair records the outcome; a deploy restart loses at most one in-flight
 * build, which the 1/day limit lets the user simply re-request).
 */
@Injectable()
export class DataExportService {
  private readonly logger = new Logger(DataExportService.name);

  constructor(
    @Inject(DB_SERVICE_ROLE) private readonly dbAdmin: DbAdmin,
    private readonly db: DatabaseService,
    private readonly r2: R2Service,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
    private readonly analytics: AnalyticsService,
  ) {}

  /** 1/day guard via the audit-marker pattern (no extra table). */
  private async assertDailyLimit(userId: string, action: string) {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [recent] = await this.dbAdmin
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.actor_user_id, userId),
          eq(auditLog.action, action),
          gt(auditLog.created_at, dayAgo),
        ),
      )
      .limit(1);
    if (recent) {
      throw new HttpException(
        'You can request one export per day — your previous export link is in your email.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  // ─── Individual export (§3.5) ──────────────────────────────────────────────

  async requestMyExport(userId: string, tenantId: string) {
    if (!this.r2.isConfigured()) {
      throw new HttpException(
        'Exports need file storage, which is not configured on this server.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    await this.assertDailyLimit(userId, 'privacy.data_export_requested');
    await this.audit.log({
      tenantId,
      actorUserId: userId,
      action: 'privacy.data_export_requested',
      resourceType: 'user',
      resourceId: userId,
    });
    this.analytics.track({ event: 'data_export_requested', tenantId, userId }); // §6

    // Fire-and-forget: the request returns immediately; the link arrives by email.
    void this.buildMyExport(userId, tenantId).catch((err) => {
      this.logger.error(
        `Personal export failed for ${userId}: ${err instanceof Error ? err.message : err}`,
      );
    });
    return { data: { requested: true, delivery: 'email', link_ttl_days: 7 } };
  }

  private async buildMyExport(userId: string, tenantId: string) {
    const [user] = await this.dbAdmin
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user) return;

    const userMemberships = await this.dbAdmin
      .select({
        tenant: tenants.name,
        role: memberships.role,
        status: memberships.status,
        created_at: memberships.created_at,
      })
      .from(memberships)
      .innerJoin(tenants, eq(tenants.id, memberships.tenant_id))
      .where(eq(memberships.user_id, userId));

    const consentHistory = await this.dbAdmin
      .select()
      .from(consentRecords)
      .where(eq(consentRecords.user_id, userId))
      .orderBy(desc(consentRecords.occurred_at));

    // §3.5: the personal bundle must include the user's submitted feedback.
    const feedback = await this.dbAdmin
      .select({
        category: feedbackSubmissions.category,
        message: feedbackSubmissions.message,
        status: feedbackSubmissions.status,
        page_path: feedbackSubmissions.page_path,
        created_at: feedbackSubmissions.created_at,
      })
      .from(feedbackSubmissions)
      .where(eq(feedbackSubmissions.user_id, userId))
      .orderBy(desc(feedbackSubmissions.created_at));

    // §3.5 + §6.2: an activity summary — counts/timestamps only, no free text.
    const eventCounts = await this.dbAdmin
      .select({
        event_name: productEvents.event_name,
        count: sql<number>`count(*)::int`,
      })
      .from(productEvents)
      .where(eq(productEvents.user_id, userId))
      .groupBy(productEvents.event_name);
    const [activityBounds] = await this.dbAdmin
      .select({
        total: sql<number>`count(*)::int`,
        active_days: sql<number>`count(distinct date_trunc('day', ${productEvents.occurred_at}))::int`,
        first_at: sql<string | null>`min(${productEvents.occurred_at})`,
        last_at: sql<string | null>`max(${productEvents.occurred_at})`,
      })
      .from(productEvents)
      .where(eq(productEvents.user_id, userId));

    const bundle = {
      exported_at: new Date().toISOString(),
      profile: {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        phone: user.phone,
        locale: user.locale,
        timezone: user.timezone,
        created_at: user.created_at,
        last_login_at: user.last_login_at,
      },
      memberships: userMemberships,
      consent_history: consentHistory.map((c) => ({
        type: c.consent_type,
        granted: c.granted,
        policy_version: c.policy_version,
        source: c.source,
        region: c.region_code,
        occurred_at: c.occurred_at,
      })),
      feedback_submissions: feedback,
      activity_summary: {
        total_events: activityBounds?.total ?? 0,
        active_days: activityBounds?.active_days ?? 0,
        first_event_at: activityBounds?.first_at ?? null,
        last_event_at: activityBounds?.last_at ?? null,
        events_by_name: Object.fromEntries(
          eventCounts.map((e) => [e.event_name, e.count]),
        ),
      },
    };

    const zip = new JSZip();
    zip.file('my-data.json', JSON.stringify(bundle, null, 2));
    zip.file(
      'README.txt',
      'Flicks Suite personal data export.\nContents: profile, memberships, consent history, submitted feedback, activity summary.\nQuestions: privacy@specflicks.com',
    );
    const buf = await zip.generateAsync({ type: 'nodebuffer' });

    const key = `exports/users/${userId}/${randomUUID()}.zip`;
    await this.r2.putObject(key, buf, 'application/zip');
    const url = await this.r2.signedGetUrl(key, LINK_TTL_SECONDS);

    await this.notifications.sendEmail('data-export-ready', user.email, {
      userName: user.full_name ?? user.email,
      downloadUrl: url,
      expiryHours: 7 * 24,
    });
    await this.audit.log({
      tenantId,
      actorUserId: userId,
      action: 'privacy.data_export_completed',
      resourceType: 'user',
      resourceId: userId,
      metadata: { key },
    });
  }

  // ─── Organization export (§3.5, Owner/Admin, D17) ──────────────────────────

  async requestOrgExport(userId: string, tenantId: string) {
    if (!this.r2.isConfigured()) {
      throw new HttpException(
        'Exports need file storage, which is not configured on this server.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    await this.assertDailyLimit(userId, 'privacy.org_export_requested');
    await this.audit.log({
      tenantId,
      actorUserId: userId,
      action: 'privacy.org_export_requested',
      resourceType: 'tenant',
      resourceId: tenantId,
    });
    void this.buildOrgExport(userId, tenantId).catch((err) => {
      this.logger.error(
        `Org export failed for tenant ${tenantId}: ${err instanceof Error ? err.message : err}`,
      );
    });
    return { data: { requested: true, delivery: 'email', link_ttl_days: 7 } };
  }

  private async buildOrgExport(userId: string, tenantId: string) {
    // Every module read runs under the tenant context so RLS scopes it (§3.5
    // acceptance: "org export is tenant-scoped, RLS-verified").
    const data = await this.db.withTenant(tenantId, async (tx) => ({
      employees: await tx.select().from(employees),
      attendance: await tx.select().from(attendanceRecords),
      leave: await tx.select().from(leaveRequests),
      timesheets: await tx.select().from(timesheetEntries),
      customers: await tx.select().from(customers),
      items: await tx.select().from(items),
      invoices: await tx.select().from(invoices),
      invoice_line_items: await tx.select().from(invoiceLineItems),
      payments: await tx.select().from(invoicePayments),
      credit_notes: await tx.select().from(creditNotes),
      debit_notes: await tx.select().from(debitNotes),
      subscriptions: await tx.select().from(invoiceSubscriptions),
      settings: await tx.select().from(invoicingSettings),
    }));

    const zip = new JSZip();
    const json = zip.folder('json')!;
    const csv = zip.folder('csv')!;
    for (const [name, rows] of Object.entries(data)) {
      json.file(`${name}.json`, JSON.stringify(rows, null, 2));
      csv.file(`${name}.csv`, toCsv(rows as Record<string, unknown>[]));
    }
    zip.file(
      'README.txt',
      'Flicks Suite organization data export (CSV + JSON per module).\nGenerated on request of an Owner/Admin. Questions: privacy@specflicks.com',
    );
    const buf = await zip.generateAsync({ type: 'nodebuffer' });

    const key = `exports/tenants/${tenantId}/${randomUUID()}.zip`;
    await this.r2.putObject(key, buf, 'application/zip');
    const url = await this.r2.signedGetUrl(key, LINK_TTL_SECONDS);

    // Email owners + admins (design D17: "emailed to owners & admins").
    const recipients = await this.dbAdmin
      .select({ email: users.email, name: users.full_name })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.user_id))
      .where(
        and(
          eq(memberships.tenant_id, tenantId),
          eq(memberships.status, 'active'),
          sql`${memberships.role} IN ('owner','admin')`,
        ),
      );
    for (const r of recipients) {
      await this.notifications.sendEmail('data-export-ready', r.email, {
        userName: r.name ?? r.email,
        downloadUrl: url,
        expiryHours: 7 * 24,
      });
    }
    await this.audit.log({
      tenantId,
      actorUserId: userId,
      action: 'privacy.org_export_completed',
      resourceType: 'tenant',
      resourceId: tenantId,
      metadata: { key, recipients: recipients.length },
    });
  }

  /** Daily prune of export objects older than 30 days (PRD §10). */
  async pruneExports(): Promise<number> {
    if (!this.r2.isConfigured()) return 0;
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const objects = await this.r2.listObjects('exports/');
    const stale = objects
      .filter((o) => o.lastModified && o.lastModified.getTime() < cutoff)
      .map((o) => o.key);
    if (stale.length) await this.r2.deleteObjects(stale);
    return stale.length;
  }
}
