import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac, randomBytes } from 'crypto';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { formSubmissions, leads, tenants, webForms } from '@flicks/db/schema';
import type { DbAdmin } from '@flicks/db';
import { DB_SERVICE_ROLE } from '../../core/database/database.module';
import { DatabaseService } from '../../core/database/database.service';
import { AuditService } from '../audit/audit.service';
import { DomainEventsService } from '../../core/events/domain-events.service';
import { NotificationsService } from '../notifications/notifications.service';
import { LeadsService, scoreLead } from './leads.service';
import { ActivitiesService } from './activities.service';

/**
 * Web forms (PRD v5 §5.2, C13) — hosted lead capture at /f/:token (and an
 * embed snippet). Submissions become leads. Spam defense is honeypot +
 * min-fill-time + 10/hr/IP — no CAPTCHAs, no third parties. The public
 * endpoints run on dbAdmin (no session) exactly like the hosted quote page;
 * everything they touch is resolved through the form's own tenant_id.
 */

const STANDARD_FIELDS = new Set(['name', 'email', 'company', 'phone', 'note']);
const MIN_FILL_MS = 3_000;
const MAX_FORM_AGE_MS = 2 * 3600_000; // signed render token is valid 2h (shortened from 24h)
const SUBMITS_PER_HOUR_PER_IP = 10;
const SUBMITS_PER_DAY_PER_FORM = 500; // per-tenant/per-form daily cap on top of per-IP
// Submission-body bounds (the public body is not a DTO, so enforce them here).
const MAX_FIELDS = 40;
const MAX_VALUE_LEN = 5_000;
const MAX_TOTAL_LEN = 20_000;

/** Coerce + bound the free-form submission values; rejects oversize payloads. */
function boundValues(raw: Record<string, unknown> | undefined): Record<string, string> {
  const entries = Object.entries(raw ?? {});
  if (entries.length > MAX_FIELDS) throw new BadRequestException('Too many fields in the submission');
  let total = 0;
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    if (typeof k !== 'string' || k.length > 100) continue;
    const s = v == null ? '' : String(v);
    if (s.length > MAX_VALUE_LEN) throw new BadRequestException(`Field "${k}" is too long`);
    total += k.length + s.length;
    if (total > MAX_TOTAL_LEN) throw new BadRequestException('Submission is too large');
    out[k] = s;
  }
  return out;
}

export interface FormField {
  key: string;
  label: string;
  type: 'text' | 'email' | 'phone' | 'textarea';
  required?: boolean;
}

@Injectable()
export class FormsService {
  private readonly logger = new Logger(FormsService.name);

  constructor(
    private readonly db: DatabaseService,
    @Inject(DB_SERVICE_ROLE) private readonly dbAdmin: DbAdmin,
    private readonly audit: AuditService,
    private readonly domainEvents: DomainEventsService,
    private readonly notifications: NotificationsService,
    private readonly leads: LeadsService,
    private readonly activities: ActivitiesService,
    private readonly config: ConfigService,
  ) {}

  // ─── Tenant-side management ──────────────────────────────────────────────────

  async list(tenantId: string) {
    return this.db.withTenant(tenantId, async (tx) => {
      const rows = await tx.select().from(webForms).orderBy(desc(webForms.created_at));
      const counts = await tx
        .select({ form_id: formSubmissions.form_id, n: sql<number>`count(*)::int` })
        .from(formSubmissions)
        .groupBy(formSubmissions.form_id);
      const countMap = new Map(counts.map((c) => [c.form_id, c.n]));
      return { data: rows.map((f) => ({ ...f, submission_count: countMap.get(f.id) ?? 0 })) };
    });
  }

  async create(
    tenantId: string,
    userId: string,
    dto: {
      name: string;
      title?: string;
      intro?: string;
      fields?: FormField[];
      source_tag?: string;
      assignment?: 'none' | 'round_robin';
      success_message?: string;
      redirect_url?: string;
    },
  ) {
    if (!dto.name?.trim()) throw new BadRequestException('Form name is required');
    const fields = this.validateFields(dto.fields ?? [
      { key: 'name', label: 'Name', type: 'text', required: true },
      { key: 'email', label: 'Work email', type: 'email', required: true },
      { key: 'company', label: 'Company', type: 'text' },
      { key: 'phone', label: 'Phone', type: 'phone' },
    ]);
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const [row] = await tx
          .insert(webForms)
          .values({
            tenant_id: tenantId,
            name: dto.name.trim(),
            token: randomBytes(5).toString('hex'), // hex — same reasoning as the BCC dropbox
            title: dto.title?.trim() || 'Talk to sales',
            intro: dto.intro ?? null,
            fields,
            source_tag: (dto.source_tag ?? dto.name).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 40) || 'form',
            assignment: dto.assignment ?? 'round_robin',
            success_message: dto.success_message?.trim() || "Thanks — we'll be in touch",
            redirect_url: dto.redirect_url ?? null,
            created_by: userId,
          })
          .onConflictDoNothing()
          .returning();
        if (!row) throw new BadRequestException(`A form named "${dto.name.trim()}" already exists`);
        await this.audit.log({ tenantId, actorUserId: userId, action: 'crm.form.create', resourceType: 'web_form', resourceId: row.id });
        return { data: row };
      },
      userId,
    );
  }

  async setActive(tenantId: string, userId: string, id: string, active: boolean) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const [row] = await tx.update(webForms).set({ active, updated_at: new Date() }).where(eq(webForms.id, id)).returning();
        if (!row) throw new NotFoundException('Form not found');
        return { data: row };
      },
      userId,
    );
  }

  async submissions(tenantId: string, formId: string) {
    return this.db.withTenant(tenantId, async (tx) => {
      const rows = await tx
        .select({ sub: formSubmissions, lead_status: leads.status })
        .from(formSubmissions)
        .leftJoin(leads, eq(leads.id, formSubmissions.lead_id))
        .where(eq(formSubmissions.form_id, formId))
        .orderBy(desc(formSubmissions.created_at))
        .limit(200);
      return { data: rows.map((r) => ({ ...r.sub, ip_hash: undefined, lead_status: r.lead_status })) };
    });
  }

  // ─── Public (hosted page + embed) ────────────────────────────────────────────

  /** Public form descriptor: fields + branding + a signed render timestamp. */
  async publicForm(token: string) {
    const [form] = await this.dbAdmin
      .select({
        id: webForms.id,
        tenant_id: webForms.tenant_id,
        title: webForms.title,
        intro: webForms.intro,
        fields: webForms.fields,
        active: webForms.active,
        tenant_name: tenants.name,
      })
      .from(webForms)
      .innerJoin(tenants, eq(tenants.id, webForms.tenant_id))
      .where(eq(webForms.token, token))
      .limit(1);
    if (!form || !form.active) throw new NotFoundException('This form is not available');
    const ts = Date.now().toString();
    return {
      data: {
        title: form.title,
        intro: form.intro,
        fields: form.fields as FormField[],
        tenant_name: form.tenant_name,
        ts,
        sig: this.signTs(token, ts),
      },
    };
  }

  /**
   * Public submit. Spam gates (silently accepted but dropped, so bots learn
   * nothing): honeypot filled, sub-3s fill time, forged/stale timestamp.
   * Hard gate: 10/hr/IP (429-shaped error). A passing submission becomes a
   * lead (round-robin assigned when configured) + an in-app ping.
   */
  async submit(
    token: string,
    body: { values?: Record<string, string>; ts?: string; sig?: string; website?: string; utm?: Record<string, string> },
    ip: string,
  ) {
    const [form] = await this.dbAdmin.select().from(webForms).where(eq(webForms.token, token)).limit(1);
    if (!form || !form.active) throw new NotFoundException('This form is not available');

    // Bound the free-form body before any DB work (the submit body is public
    // and not a DTO, so cap field count / value length / total size here).
    const values = boundValues(body.values);

    // Rate limit before any work: 10/hr/IP across all forms…
    const ipHash = createHash('sha256').update(ip || 'unknown').digest('hex');
    const [{ n }] = await this.dbAdmin
      .select({ n: sql<number>`count(*)::int` })
      .from(formSubmissions)
      .where(and(eq(formSubmissions.ip_hash, ipHash), gte(formSubmissions.created_at, new Date(Date.now() - 3600_000))));
    if (n! >= SUBMITS_PER_HOUR_PER_IP) {
      throw new BadRequestException({ code: 'RATE_LIMITED', message: 'Too many submissions — try again later' });
    }
    // …and a per-form daily cap so one form can't be flooded across many IPs.
    const [{ d }] = await this.dbAdmin
      .select({ d: sql<number>`count(*)::int` })
      .from(formSubmissions)
      .where(and(eq(formSubmissions.form_id, form.id), gte(formSubmissions.created_at, new Date(Date.now() - 24 * 3600_000))));
    if (d! >= SUBMITS_PER_DAY_PER_FORM) {
      throw new BadRequestException({ code: 'RATE_LIMITED', message: 'This form has reached its daily limit — try again later' });
    }

    // Spam gates — accept-and-drop so the page still shows success.
    const age = Date.now() - Number(body.ts ?? 0);
    const spam =
      Boolean(body.website?.trim()) || // honeypot
      !body.ts || !body.sig || body.sig !== this.signTs(token, body.ts) || // forged
      age < MIN_FILL_MS || age > MAX_FORM_AGE_MS; // too fast / stale
    if (spam) {
      this.logger.warn(`form ${form.id}: dropped spam submission (age=${age}ms)`);
      return { data: { ok: true, message: form.success_message, redirect_url: form.redirect_url } };
    }

    const fields = form.fields as FormField[];
    for (const f of fields) {
      if (f.required && !(values[f.key] ?? '').trim()) {
        throw new BadRequestException(`${f.label} is required`);
      }
    }

    const nameParts = (values.name ?? '').trim().split(/\s+/).filter(Boolean);
    const extra = Object.fromEntries(Object.entries(values).filter(([k]) => !STANDARD_FIELDS.has(k)));
    const utm = Object.fromEntries(
      Object.entries(body.utm ?? {}).filter(([k]) => k.startsWith('utm_')).slice(0, 8),
    ) as Record<string, string>;

    const owner = form.assignment === 'round_robin' ? await this.leads.pickRoundRobinOwner(form.tenant_id) : null;
    const lead = await this.leads.create(form.tenant_id, null, {
      first_name: nameParts[0],
      last_name: nameParts.slice(1).join(' ') || undefined,
      email: values.email?.trim() || undefined,
      phone: values.phone?.trim() || undefined,
      company_name: values.company?.trim() || undefined,
      note: values.note?.trim() || undefined,
      source: `form:${form.source_tag}`,
      owner_user_id: owner ?? undefined,
      form_id: form.id,
      utm,
      extra,
    });

    await this.dbAdmin.insert(formSubmissions).values({
      tenant_id: form.tenant_id,
      form_id: form.id,
      lead_id: lead.data.id,
      payload: values,
      utm,
      ip_hash: ipHash,
    });
    await this.domainEvents.publish({
      name: 'crm.form.submitted',
      tenantId: form.tenant_id,
      payload: { form_id: form.id, lead_id: lead.data.id, source: `form:${form.source_tag}`, score: lead.data.score, owner_user_id: owner },
    });
    if (owner) {
      const who = [nameParts[0], values.company ? `@ ${values.company}` : ''].filter(Boolean).join(' ');
      await this.notifications
        .createInAppNotification(owner, 'crm.lead.assigned', `New lead assigned to you: ${who || 'form submission'}`, '/crm/leads', form.tenant_id)
        .catch(() => undefined); // best-effort
      // Speed-to-lead follow-up: every assigned form lead gets a "Call within
      // 1h" task on the owner's plate (the C8 loop), so capture always ends
      // with a next step. Best-effort — a task hiccup must not fail the
      // public submit.
      await this.activities
        .create(form.tenant_id, owner, {
          type: 'call',
          subject: `Call within 1h — ${who || 'new form lead'}`,
          body: `Captured by the "${form.name}" form.`,
          assignee_user_id: owner,
          due_at: new Date(Date.now() + 3600_000).toISOString(),
        })
        .catch((err) => this.logger.warn(`follow-up task failed for lead ${lead.data.id}: ${err instanceof Error ? err.message : err}`));
    }
    return { data: { ok: true, message: form.success_message, redirect_url: form.redirect_url } };
  }

  // ─── Internals ───────────────────────────────────────────────────────────────

  private signTs(token: string, ts: string) {
    const secret = this.config.get<string>('JWT_SECRET') ?? 'dev';
    return createHmac('sha256', secret).update(`${token}.${ts}`).digest('hex').slice(0, 32);
  }

  private validateFields(fields: FormField[]): FormField[] {
    if (!Array.isArray(fields) || fields.length === 0) throw new BadRequestException('A form needs at least one field');
    if (fields.length > 12) throw new BadRequestException('Max 12 fields per form');
    const seen = new Set<string>();
    for (const f of fields) {
      const key = (f.key ?? '').trim();
      if (!/^[a-z0-9_]{1,40}$/.test(key)) throw new BadRequestException(`Bad field key "${f.key}"`);
      if (seen.has(key)) throw new BadRequestException(`Duplicate field key "${key}"`);
      seen.add(key);
      if (!f.label?.trim()) throw new BadRequestException('Every field needs a label');
      if (!['text', 'email', 'phone', 'textarea'].includes(f.type)) throw new BadRequestException(`Bad field type "${f.type}"`);
    }
    if (!fields.some((f) => f.key === 'email' || f.key === 'name')) {
      throw new BadRequestException('Include at least a name or email field');
    }
    return fields.map((f) => ({ key: f.key.trim(), label: f.label.trim(), type: f.type, required: Boolean(f.required) }));
  }
}
