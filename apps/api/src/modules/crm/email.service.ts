import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  deals,
  directoryCompanies,
  directoryPeople,
  emailEvents,
  emailLinks,
  emailMessages,
  emailTemplates,
  resendWebhookEvents,
  sequenceEnrollments,
  tenantInboundAddresses,
  tenants,
  users,
} from '@flicks/db/schema';
import type { Db, DbAdmin } from '@flicks/db';
import { DB_SERVICE_ROLE } from '../../core/database/database.module';
import { DatabaseService } from '../../core/database/database.service';
import { AuditService } from '../audit/audit.service';
import { DomainEventsService } from '../../core/events/domain-events.service';
import { NotificationsService } from '../notifications/notifications.service';

const token = (bytes = 18) => randomBytes(bytes).toString('base64url');

/**
 * CRM Email Phase A (PRD v5 §7.1) — compose from a deal/contact with variable
 * rendering, per-user signatures (§19.4), do-not-contact enforcement (§19.5),
 * open/click tracking, the unsubscribe endpoint, and the Resend-webhook side
 * (delivery lifecycle + auto-DNC + the BCC dropbox). Sequences get their
 * engine in the next chunk — replies already exit active enrollments here.
 */
@Injectable()
export class CrmEmailService {
  private readonly logger = new Logger(CrmEmailService.name);

  constructor(
    private readonly db: DatabaseService,
    @Inject(DB_SERVICE_ROLE) private readonly dbAdmin: DbAdmin,
    private readonly audit: AuditService,
    private readonly domainEvents: DomainEventsService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  private appUrl(): string {
    return (this.config.get<string>('APP_URL') ?? 'http://localhost:3000').replace(/\/$/, '');
  }
  private apiUrl(): string {
    // Tracking endpoints are served by the API host.
    return (this.config.get<string>('PUBLIC_API_URL') ?? this.config.get<string>('API_URL') ?? 'http://localhost:4000').replace(/\/$/, '');
  }

  /** {{variable}} rendering over subject + body. Unknown variables blank out. */
  private render(input: string, vars: Record<string, string | null | undefined>): string {
    return input.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_, k: string) => vars[k.toLowerCase()] ?? '');
  }

  /** Wrap every href in tracked redirects + append the open pixel. */
  private async instrument(tx: Db, tenantId: string, messageId: string, html: string, openToken: string): Promise<string> {
    const base = `${this.apiUrl()}/api/v1`;
    const seen = new Map<string, string>();
    const hrefs = [...html.matchAll(/href="(https?:\/\/[^"]+)"/gi)].map((m) => m[1]!);
    for (const url of hrefs) {
      if (seen.has(url)) continue;
      const t = token();
      await tx.insert(emailLinks).values({ tenant_id: tenantId, message_id: messageId, token: t, url });
      seen.set(url, t);
    }
    let out = html.replace(/href="(https?:\/\/[^"]+)"/gi, (_m, url: string) => `href="${base}/t/c/${seen.get(url)}"`);
    out += `<img src="${base}/t/o/${openToken}" width="1" height="1" style="display:none" alt=""/>`;
    return out;
  }

  /**
   * Compose + send from a deal or contact. Resolves the recipient, enforces
   * §19.5 DNC, renders variables, appends the sender's signature, instruments
   * tracking, sends via Resend and files the message on the timeline.
   */
  async send(
    tenantId: string,
    userId: string,
    dto: {
      deal_id?: string;
      person_id?: string;
      to?: string;
      subject: string;
      body_html: string;
      template_id?: string;
      tracking?: boolean;
      /** Set by the sequences engine so the message links to its enrollment. */
      sequence_enrollment_id?: string;
    },
  ) {
    if (!dto.subject?.trim()) throw new BadRequestException('Subject is required');
    if (!dto.body_html?.trim() && !dto.template_id) throw new BadRequestException('Body is required');

    return this.db.withTenant(
      tenantId,
      async (tx) => {
        // Resolve the deal + person context.
        const [deal] = dto.deal_id
          ? await tx.select().from(deals).where(and(eq(deals.id, dto.deal_id), isNull(deals.deleted_at))).limit(1)
          : [undefined];
        if (dto.deal_id && !deal) throw new NotFoundException('Deal not found');
        const personId = dto.person_id ?? deal?.primary_person_id ?? null;
        const [person] = personId
          ? await tx.select().from(directoryPeople).where(and(eq(directoryPeople.id, personId), isNull(directoryPeople.deleted_at))).limit(1)
          : [undefined];
        const to = (dto.to ?? person?.email ?? '').trim().toLowerCase();
        if (!to) throw new BadRequestException('No recipient — link a contact with an email or pass `to`');

        // §19.5 — hard block. Do-not-contact is not a suggestion.
        if (person?.email_do_not_contact) {
          throw new BadRequestException(
            `${person.display_name ?? to} is marked do-not-contact (${person.email_do_not_contact_reason ?? 'manual'})`,
          );
        }

        // Optional template.
        let subject = dto.subject;
        let body = dto.body_html;
        if (dto.template_id) {
          const [tpl] = await tx.select().from(emailTemplates).where(and(eq(emailTemplates.id, dto.template_id), eq(emailTemplates.archived, false))).limit(1);
          if (!tpl) throw new NotFoundException('Template not found');
          subject = dto.subject?.trim() ? dto.subject : tpl.subject;
          body = dto.body_html?.trim() ? dto.body_html : tpl.body_html;
        }

        const [sender] = await tx.select({ name: users.full_name, email: users.email, signature: users.email_signature_html }).from(users).where(eq(users.id, userId)).limit(1);
        const [company] = person?.company_id
          ? await tx.select({ name: directoryCompanies.name }).from(directoryCompanies).where(eq(directoryCompanies.id, person.company_id)).limit(1)
          : [undefined];

        const openToken = token();
        const vars = {
          first_name: person?.first_name ?? person?.display_name?.split(' ')[0] ?? '',
          last_name: person?.last_name ?? '',
          name: person?.display_name ?? '',
          company: company?.name ?? '',
          deal_title: deal?.title ?? '',
          sender_name: sender?.name ?? '',
          unsubscribe_link: `${this.apiUrl()}/api/v1/u/${openToken}`,
        };
        subject = this.render(subject, vars);
        body = this.render(body, vars);
        if (sender?.signature) body += `<br/><br/>${sender.signature}`;

        const tracking = dto.tracking !== false;
        const [msg] = await tx
          .insert(emailMessages)
          .values({
            tenant_id: tenantId,
            direction: 'out',
            status: 'sent',
            to_email: to,
            from_email: sender?.email ?? null,
            subject,
            body_html: body,
            person_id: person?.id ?? null,
            deal_id: deal?.id ?? null,
            sender_user_id: userId,
            open_token: openToken,
            tracking,
            sequence_enrollment_id: dto.sequence_enrollment_id ?? null,
          })
          .returning();

        const htmlToSend = tracking ? await this.instrument(tx, tenantId, msg!.id, body, openToken) : body;

        const providerId = await this.notifications.sendRawEmail({
          to,
          subject,
          html: htmlToSend,
          fromName: sender?.name ?? undefined,
          replyTo: sender?.email ?? undefined,
        });
        await tx
          .update(emailMessages)
          .set({ provider_id: providerId, status: providerId ? 'sent' : 'failed' })
          .where(eq(emailMessages.id, msg!.id));

        // Timeline stamps.
        if (person?.id) await tx.update(directoryPeople).set({ last_activity_at: new Date() }).where(eq(directoryPeople.id, person.id));
        if (deal?.id) await tx.update(deals).set({ last_activity_at: new Date() }).where(eq(deals.id, deal.id));

        await this.audit.log({ tenantId, actorUserId: userId, action: 'crm.email.send', resourceType: 'email', resourceId: msg!.id, metadata: { deal_id: deal?.id ?? null } });
        await this.domainEvents.publish(
          { name: 'crm.email.sent', tenantId, actorUserId: userId, payload: { message_id: msg!.id, deal_id: deal?.id ?? null, person_id: person?.id ?? null } },
          tx,
        );
        if (!providerId) throw new BadRequestException('Email provider rejected the send — check RESEND_API_KEY');
        return { data: { id: msg!.id, status: 'sent', to } };
      },
      userId,
    );
  }

  /** Messages on a deal (outbound + BCC'd inbound), newest first. */
  async listForDeal(tenantId: string, dealId: string) {
    return this.db.withTenant(tenantId, async (tx) => {
      const rows = await tx
        .select({
          id: emailMessages.id,
          direction: emailMessages.direction,
          status: emailMessages.status,
          to_email: emailMessages.to_email,
          from_email: emailMessages.from_email,
          subject: emailMessages.subject,
          open_count: emailMessages.open_count,
          click_count: emailMessages.click_count,
          tracking: emailMessages.tracking,
          sender_name: users.full_name,
          created_at: emailMessages.created_at,
        })
        .from(emailMessages)
        .leftJoin(users, eq(users.id, emailMessages.sender_user_id))
        .where(eq(emailMessages.deal_id, dealId))
        .orderBy(desc(emailMessages.created_at));
      return { data: rows };
    });
  }

  // ─── Templates (compose picker; manager UI in chunk 2) ────────────────────────

  async listTemplates(tenantId: string) {
    return this.db.withTenant(tenantId, async (tx) => {
      const rows = await tx.select().from(emailTemplates).where(eq(emailTemplates.archived, false)).orderBy(emailTemplates.name);
      return { data: rows };
    });
  }

  async createTemplate(tenantId: string, userId: string, dto: { name: string; subject: string; body_html: string }) {
    if (!dto.name?.trim() || !dto.subject?.trim() || !dto.body_html?.trim()) {
      throw new BadRequestException('name, subject and body are required');
    }
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const [row] = await tx
          .insert(emailTemplates)
          .values({ tenant_id: tenantId, name: dto.name.trim(), subject: dto.subject, body_html: dto.body_html, created_by: userId })
          .returning();
        await this.audit.log({ tenantId, actorUserId: userId, action: 'crm.email_template.create', resourceType: 'email_template', resourceId: row!.id });
        return { data: row! };
      },
      userId,
    );
  }

  async archiveTemplate(tenantId: string, userId: string, id: string) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const [row] = await tx
          .update(emailTemplates)
          .set({ archived: true, updated_at: new Date() })
          .where(and(eq(emailTemplates.id, id), eq(emailTemplates.archived, false)))
          .returning({ id: emailTemplates.id });
        if (!row) throw new NotFoundException('Template not found');
        await this.audit.log({ tenantId, actorUserId: userId, action: 'crm.email_template.archive', resourceType: 'email_template', resourceId: id });
        return { data: { archived: true } };
      },
      userId,
    );
  }

  // ─── Signature (§19.4) ────────────────────────────────────────────────────────

  async getSignature(userId: string) {
    const [u] = await this.dbAdmin.select({ signature: users.email_signature_html }).from(users).where(eq(users.id, userId)).limit(1);
    return { data: { signature: u?.signature ?? null } };
  }

  async setSignature(userId: string, signature: string | null) {
    await this.dbAdmin.update(users).set({ email_signature_html: signature }).where(eq(users.id, userId));
    return { data: { saved: true } };
  }

  // ─── BCC dropbox address (§7.1) ───────────────────────────────────────────────

  async inboundAddress(tenantId: string) {
    return this.db.withTenant(tenantId, async (tx) => {
      let [row] = await tx.select().from(tenantInboundAddresses).where(eq(tenantInboundAddresses.tenant_id, tenantId)).limit(1);
      if (!row) {
        // HEX on purpose: the address format is {slug}-{token}@… and the
        // inbound router splits on the LAST '-'; base64url tokens can contain
        // '-' and would break their own parsing.
        ;[row] = await tx.insert(tenantInboundAddresses).values({ tenant_id: tenantId, token: randomBytes(5).toString('hex') }).returning();
      }
      const [t] = await tx.select({ slug: tenants.slug }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
      const domain = this.config.get<string>('INBOUND_EMAIL_DOMAIN') ?? 'in.flickssuite.com';
      return { data: { address: `${t!.slug}-${row!.token}@${domain}` } };
    });
  }

  // ─── Public tracking / unsubscribe (no auth — tokens scope to one message) ────

  async trackOpen(openToken: string): Promise<void> {
    const [msg] = await this.dbAdmin.select().from(emailMessages).where(eq(emailMessages.open_token, openToken)).limit(1);
    if (!msg) return; // silently swallow — pixels must never error
    await this.dbAdmin.update(emailMessages).set({ open_count: sql`${emailMessages.open_count} + 1` }).where(eq(emailMessages.id, msg.id));
    await this.dbAdmin.insert(emailEvents).values({ tenant_id: msg.tenant_id, message_id: msg.id, type: 'opened' });
  }

  async trackClick(linkToken: string): Promise<string | null> {
    const [link] = await this.dbAdmin.select().from(emailLinks).where(eq(emailLinks.token, linkToken)).limit(1);
    if (!link) return null;
    await this.dbAdmin.update(emailLinks).set({ click_count: sql`${emailLinks.click_count} + 1` }).where(eq(emailLinks.id, link.id));
    await this.dbAdmin.update(emailMessages).set({ click_count: sql`${emailMessages.click_count} + 1` }).where(eq(emailMessages.id, link.message_id));
    await this.dbAdmin.insert(emailEvents).values({ tenant_id: link.tenant_id, message_id: link.message_id, type: 'clicked', meta: { url: link.url } });
    return link.url;
  }

  /** {{unsubscribe_link}} target — marks the recipient do-not-contact (§19.5). */
  async unsubscribe(openToken: string): Promise<boolean> {
    const [msg] = await this.dbAdmin.select().from(emailMessages).where(eq(emailMessages.open_token, openToken)).limit(1);
    if (!msg?.person_id) return false;
    await this.setDoNotContact(msg.tenant_id, msg.person_id, 'unsubscribed');
    await this.dbAdmin.insert(emailEvents).values({ tenant_id: msg.tenant_id, message_id: msg.id, type: 'unsubscribed' });
    return true;
  }

  private async setDoNotContact(tenantId: string, personId: string, reason: string) {
    await this.dbAdmin
      .update(directoryPeople)
      .set({ email_do_not_contact: true, email_do_not_contact_reason: reason, updated_at: new Date() })
      .where(and(eq(directoryPeople.id, personId), eq(directoryPeople.tenant_id, tenantId)));
    // §19.5 — an unreachable/unwilling recipient exits every active sequence.
    await this.dbAdmin
      .update(sequenceEnrollments)
      .set({ status: 'exited', exit_reason: 'dnc', updated_at: new Date() })
      .where(and(eq(sequenceEnrollments.person_id, personId), eq(sequenceEnrollments.status, 'active')));
  }

  // ─── Resend webhook effects (service-role; verified by the controller) ────────

  /** Returns false when this svix message id was already processed. */
  async markWebhookSeen(svixId: string): Promise<boolean> {
    const inserted = await this.dbAdmin
      .insert(resendWebhookEvents)
      .values({ id: svixId })
      .onConflictDoNothing()
      .returning({ id: resendWebhookEvents.id });
    return inserted.length > 0;
  }

  async handleDeliveryEvent(type: 'delivered' | 'bounced' | 'complained', providerEmailId: string) {
    const [msg] = await this.dbAdmin.select().from(emailMessages).where(eq(emailMessages.provider_id, providerEmailId)).limit(1);
    if (!msg) return;
    await this.dbAdmin.update(emailMessages).set({ status: type }).where(eq(emailMessages.id, msg.id));
    await this.dbAdmin.insert(emailEvents).values({ tenant_id: msg.tenant_id, message_id: msg.id, type });
    // §19.5 — bounce/complaint auto-sets do-not-contact.
    if ((type === 'bounced' || type === 'complained') && msg.person_id) {
      await this.setDoNotContact(msg.tenant_id, msg.person_id, type);
      this.logger.log(`auto-DNC: person ${msg.person_id} after ${type}`);
    }
  }

  /**
   * BCC dropbox (§7.1): an inbound email addressed to {slug}-{token}@in.…
   * files itself onto the matching contact (by from-address) and their latest
   * open deal. A reply also exits active sequence enrollments.
   */
  async handleInbound(payload: { from?: string; to?: string[] | string; subject?: string; html?: string; text?: string }) {
    const tos = Array.isArray(payload.to) ? payload.to : payload.to ? [payload.to] : [];
    const domain = this.config.get<string>('INBOUND_EMAIL_DOMAIN') ?? 'in.flickssuite.com';
    const inboundAddr = tos
      .map((t) => /<([^>]+)>/.exec(t)?.[1] ?? t)
      .map((t) => t.trim().toLowerCase())
      .find((t) => t.endsWith(`@${domain}`));
    if (!inboundAddr) return { matched: false as const, reason: 'no dropbox address' };
    const local = inboundAddr.split('@')[0]!;
    const tokenPart = local.split('-').pop()!;
    const [inbound] = await this.dbAdmin.select().from(tenantInboundAddresses).where(eq(tenantInboundAddresses.token, tokenPart)).limit(1);
    if (!inbound) return { matched: false as const, reason: 'unknown dropbox token' };

    const fromEmail = (/<([^>]+)>/.exec(payload.from ?? '')?.[1] ?? payload.from ?? '').trim().toLowerCase();
    const [person] = fromEmail
      ? await this.dbAdmin
          .select()
          .from(directoryPeople)
          .where(and(eq(directoryPeople.tenant_id, inbound.tenant_id), sql`lower(${directoryPeople.email}::text) = ${fromEmail}`, isNull(directoryPeople.deleted_at)))
          .limit(1)
      : [undefined];
    const [deal] = person
      ? await this.dbAdmin
          .select()
          .from(deals)
          .where(and(eq(deals.tenant_id, inbound.tenant_id), eq(deals.primary_person_id, person.id), eq(deals.status, 'open'), isNull(deals.deleted_at)))
          .orderBy(desc(deals.updated_at))
          .limit(1)
      : [undefined];

    const [msg] = await this.dbAdmin
      .insert(emailMessages)
      .values({
        tenant_id: inbound.tenant_id,
        direction: 'in',
        status: 'received',
        from_email: fromEmail || null,
        to_email: inboundAddr,
        subject: payload.subject ?? '(no subject)',
        body_html: payload.html ?? payload.text ?? null,
        person_id: person?.id ?? null,
        deal_id: deal?.id ?? null,
      })
      .returning();

    if (person) {
      await this.dbAdmin.update(directoryPeople).set({ last_activity_at: new Date() }).where(eq(directoryPeople.id, person.id));
      // A reply exits active sequences (§7.1 exit-on-reply).
      await this.dbAdmin
        .update(sequenceEnrollments)
        .set({ status: 'exited', exit_reason: 'replied', updated_at: new Date() })
        .where(and(eq(sequenceEnrollments.person_id, person.id), eq(sequenceEnrollments.status, 'active')));
    }
    if (deal) await this.dbAdmin.update(deals).set({ last_activity_at: new Date() }).where(eq(deals.id, deal.id));
    await this.domainEvents.publish({
      name: 'crm.email.replied',
      tenantId: inbound.tenant_id,
      payload: { message_id: msg!.id, person_id: person?.id ?? null, deal_id: deal?.id ?? null },
    });
    return { matched: true as const, message_id: msg!.id, person_id: person?.id ?? null, deal_id: deal?.id ?? null };
  }
}
