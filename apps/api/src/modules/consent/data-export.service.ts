import {
  Injectable,
  Inject,
  Logger,
  HttpException,
  HttpStatus,
  Optional,
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
  pmTeams,
  pmIssues,
  pmProjects,
  pmLabels,
  pmCycles,
  assets,
  assetAssignments,
} from '@flicks/db/schema';
import type { DbAdmin } from '@flicks/db';
import { DB_SERVICE_ROLE } from '../../core/database/database.module';
import { DatabaseService } from '../../core/database/database.service';
import { R2Service } from '../../core/storage/r2.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditService } from '../audit/audit.service';
import { AnalyticsService } from '../../core/analytics/analytics.service';
// Round P R3: company policies join both exports — ONLY through the facade
// (module-boundary rule), and optionally (see the constructor).
import { PoliciesPublicService } from '../policies/public';

const LINK_TTL_SECONDS = 7 * 24 * 60 * 60; // 7-day signed links (§3.5)

/** Row shapes the policies facade hands back (contract P5). */
type PolicyAckExportRow = { policy_title: string; version: number; acknowledged_at: Date | string | null };
type PolicyOrgExport = {
  policies: Record<string, unknown>[];
  acknowledgements: Record<string, unknown>[];
};

/**
 * One CSV cell. Security audit 2026-10-06: names, titles and notes are
 * member-editable free text, and Excel / Sheets execute a cell that starts
 * with = + - @ (or a tab / CR) as a formula when the Owner opens the export
 * (CWE-1236). Such text gets a leading apostrophe, the same convention as the
 * policies and assets CSVs. Plain numbers ("-500.00") are data, not formulas,
 * and stay numeric so financial figures keep their sign.
 */
export function exportCsvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = v instanceof Date ? v.toISOString() : String(v);
  if (typeof v !== 'number' && /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Columns the organisation export never carries (security audit 2026-10-06).
 * The export is a ZIP behind an emailed 7-day link, so it must not hold live
 * credentials: Razorpay OAuth tokens + webhook secret, customer mandate
 * tokens, public invoice-view tokens. Application-encrypted columns (PAN,
 * passport, bank account) are dropped too — without the server key they are
 * unreadable ciphertext, and if the key were ever missing they would be the
 * plain values. Storage keys are internal paths, not data.
 */
export const EXPORT_SECRET_COLUMN =
  /(_encrypted$|token|secret|oauth_state|password|_hash$|^photo_key$|^logo_key$|^file_key$|_storage_key$)/i;

export function stripExportSecrets<T extends Record<string, unknown[]>>(data: T): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const [name, rows] of Object.entries(data)) {
    out[name] = (rows as Record<string, unknown>[]).map((row) => {
      const clean: Record<string, unknown> = {};
      for (const [col, value] of Object.entries(row)) {
        if (!EXPORT_SECRET_COLUMN.test(col)) clean[col] = value;
      }
      return clean;
    });
  }
  return out;
}

/** Flat rows → CSV with a UTF-8 BOM (Excel-friendly). */
function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return '﻿';
  const cols = Object.keys(rows[0]);
  const esc = exportCsvCell;
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
    // Optional on purpose: specs instantiate this service without the
    // policies module, and a workspace that never published a policy must
    // still get its export. When absent the policy files are written empty.
    @Optional() private readonly policies?: PoliciesPublicService,
  ) {}

  // ─── Company policies (Round P R3) — best-effort facade reads ──────────────
  //
  // A failure inside the policies module must not sink the whole export (the
  // build is fire-and-forget and the 1/day limit would make the user wait):
  // log it and ship the rest with the policy files empty.

  private async policyAcksForUser(tenantId: string, userId: string): Promise<PolicyAckExportRow[]> {
    if (!this.policies) return [];
    try {
      const rows = await this.policies.exportForUser(tenantId, userId);
      return Array.isArray(rows) ? (rows as PolicyAckExportRow[]) : [];
    } catch (err) {
      this.logger.error(
        `Policy acknowledgements for user ${userId} skipped in export: ${err instanceof Error ? err.message : err}`,
      );
      return [];
    }
  }

  private async policiesForTenant(tenantId: string): Promise<PolicyOrgExport> {
    const empty: PolicyOrgExport = { policies: [], acknowledgements: [] };
    if (!this.policies) return empty;
    try {
      const out = (await this.policies.exportForTenant(tenantId)) as Partial<PolicyOrgExport> | null;
      return {
        policies: Array.isArray(out?.policies) ? out!.policies : [],
        acknowledgements: Array.isArray(out?.acknowledgements) ? out!.acknowledgements : [],
      };
    } catch (err) {
      this.logger.error(
        `Policies for tenant ${tenantId} skipped in org export: ${err instanceof Error ? err.message : err}`,
      );
      return empty;
    }
  }

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

    // Round P R3: every company policy version this person agreed to in the
    // workspace they requested the export from (policy title, version, when).
    const policyAcks = await this.policyAcksForUser(tenantId, userId);

    const bundle = {
      exported_at: new Date().toISOString(),
      profile: {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        phone: user.phone,
        locale: user.locale,
        timezone: user.timezone,
        theme: user.theme,
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
      policy_acknowledgements: policyAcks,
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
    // Signed company policies as a flat sheet (policy_title, version,
    // acknowledged_at) — the same rows as bundle.policy_acknowledgements.
    zip.file(
      'policy_acknowledgements.csv',
      toCsv(policyAcks as unknown as Record<string, unknown>[]),
    );
    zip.file(
      'README.txt',
      'Flicks Suite personal data export.\nContents: profile, memberships, consent history, submitted feedback, company policy acknowledgements (also as policy_acknowledgements.csv), activity summary.\nQuestions: privacy@specflicks.com',
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
    // acceptance: "org export is tenant-scoped, RLS-verified") AND carries an
    // explicit tenant predicate (house rule 1, security audit 2026-10-06).
    const data = await this.db.withTenant(tenantId, async (tx) => ({
      employees: await tx.select().from(employees).where(eq(employees.tenant_id, tenantId)),
      attendance: await tx.select().from(attendanceRecords).where(eq(attendanceRecords.tenant_id, tenantId)),
      leave: await tx.select().from(leaveRequests).where(eq(leaveRequests.tenant_id, tenantId)),
      timesheets: await tx.select().from(timesheetEntries).where(eq(timesheetEntries.tenant_id, tenantId)),
      customers: await tx.select().from(customers).where(eq(customers.tenant_id, tenantId)),
      items: await tx.select().from(items).where(eq(items.tenant_id, tenantId)),
      invoices: await tx.select().from(invoices).where(eq(invoices.tenant_id, tenantId)),
      invoice_line_items: await tx.select().from(invoiceLineItems).where(eq(invoiceLineItems.tenant_id, tenantId)),
      payments: await tx.select().from(invoicePayments).where(eq(invoicePayments.tenant_id, tenantId)),
      credit_notes: await tx.select().from(creditNotes).where(eq(creditNotes.tenant_id, tenantId)),
      debit_notes: await tx.select().from(debitNotes).where(eq(debitNotes.tenant_id, tenantId)),
      subscriptions: await tx.select().from(invoiceSubscriptions).where(eq(invoiceSubscriptions.tenant_id, tenantId)),
      settings: await tx.select().from(invoicingSettings).where(eq(invoicingSettings.tenant_id, tenantId)),
      // PM (PRD v6 §19) — projects layer joins the org export.
      pm_teams: await tx.select().from(pmTeams).where(eq(pmTeams.tenant_id, tenantId)),
      pm_issues: await tx.select().from(pmIssues).where(eq(pmIssues.tenant_id, tenantId)),
      pm_projects: await tx.select().from(pmProjects).where(eq(pmProjects.tenant_id, tenantId)),
      pm_labels: await tx.select().from(pmLabels).where(eq(pmLabels.tenant_id, tenantId)),
      pm_cycles: await tx.select().from(pmCycles).where(eq(pmCycles.tenant_id, tenantId)),
      // Round P R4 — the equipment register and who held what.
      assets: await tx.select().from(assets).where(eq(assets.tenant_id, tenantId)),
      asset_assignments: await tx.select().from(assetAssignments).where(eq(assetAssignments.tenant_id, tenantId)),
    }));

    // Round P R3: company policies + every acknowledgement, via the policies
    // facade (its own tenant-scoped reads), AFTER the transaction above so
    // the two never nest. They land as policies.{json,csv} and
    // policy_acknowledgements.{json,csv} next to the other modules.
    const policyExport = await this.policiesForTenant(tenantId);
    const allData: Record<string, unknown[]> = {
      ...stripExportSecrets(data),
      policies: policyExport.policies,
      policy_acknowledgements: policyExport.acknowledgements,
    };

    const zip = new JSZip();
    const json = zip.folder('json')!;
    const csv = zip.folder('csv')!;
    for (const [name, rows] of Object.entries(allData)) {
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
