import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  directoryCompanies,
  directoryPeople,
  leads,
  memberships,
  users,
} from '@flicks/db/schema';
import type { Db } from '@flicks/db';
import { DatabaseService } from '../../core/database/database.service';
import { AuditService } from '../audit/audit.service';
import { DomainEventsService } from '../../core/events/domain-events.service';
import { PresencePublicService } from '../presence/public';
import { DealsService } from './deals.service';

/**
 * Leads inbox (PRD v5 §5.1, C6) — a lead is a lightweight triage row from web
 * forms, the API, imports or manual adds. Converting creates/links directory
 * records + a deal in ONE action and never leaves a duplicate lead behind.
 * Discarded leads stay for source analytics.
 */

export interface CreateLeadDto {
  first_name?: string;
  last_name?: string;
  company_name?: string;
  email?: string;
  phone?: string;
  note?: string;
  source?: string;
  owner_user_id?: string;
  form_id?: string;
  utm?: Record<string, string>;
  extra?: Record<string, unknown>;
}

/** Rule-based score (§5.3) — deterministic, recomputed on every write. */
export function scoreLead(l: { email?: string | null; phone?: string | null; company_name?: string | null; note?: string | null; source?: string | null; utm?: Record<string, string> | null }) {
  let score = 0;
  if (l.email) score += 10;
  if (l.phone) score += 5;
  if (l.company_name) score += 10;
  if (l.source?.startsWith('form:')) score += 10;
  if (l.source === 'api') score += 5;
  if ((l.note ?? '').trim().length >= 20) score += 5;
  if (l.utm && Object.keys(l.utm).length > 0) score += 5;
  return score;
}

@Injectable()
export class LeadsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly domainEvents: DomainEventsService,
    private readonly presence: PresencePublicService,
    private readonly deals: DealsService,
  ) {}

  async list(tenantId: string, status?: string) {
    return this.db.withTenant(tenantId, async (tx) => {
      const wanted = ['new', 'working', 'converted', 'discarded'].includes(status ?? '') ? status! : 'new';
      const rows = await tx
        .select({
          lead: leads,
          owner_name: users.full_name,
        })
        .from(leads)
        .leftJoin(users, eq(users.id, leads.owner_user_id))
        .where(and(eq(leads.status, wanted), isNull(leads.deleted_at)))
        .orderBy(desc(leads.created_at))
        .limit(200);

      // Duplicate hint (§5.1): an existing person with the same email.
      const emails = rows.map((r) => r.lead.email?.toLowerCase()).filter(Boolean) as string[];
      const dupes = emails.length
        ? await tx
            .select({ id: directoryPeople.id, email: directoryPeople.email, display_name: directoryPeople.display_name })
            .from(directoryPeople)
            .where(and(inArray(sql`lower(${directoryPeople.email}::text)`, emails), isNull(directoryPeople.deleted_at)))
        : [];
      const dupeByEmail = new Map(dupes.map((d) => [d.email?.toLowerCase(), d]));

      const counts = await tx
        .select({ status: leads.status, n: sql<number>`count(*)::int` })
        .from(leads)
        .where(isNull(leads.deleted_at))
        .groupBy(leads.status);

      return {
        data: rows.map((r) => ({
          ...r.lead,
          owner_name: r.owner_name,
          dupe_person: r.lead.status === 'new' || r.lead.status === 'working'
            ? (dupeByEmail.get(r.lead.email?.toLowerCase() ?? '') ?? null)
            : null,
        })),
        counts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
      };
    });
  }

  async create(tenantId: string, userId: string | null, dto: CreateLeadDto) {
    const first = (dto.first_name ?? '').trim() || (dto.email ?? '').split('@')[0] || '';
    if (!first) throw new BadRequestException('A lead needs at least a name or an email');
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        if (dto.owner_user_id) await this.assertMember(tx, tenantId, dto.owner_user_id);
        const [row] = await tx
          .insert(leads)
          .values({
            tenant_id: tenantId,
            first_name: first,
            last_name: dto.last_name?.trim() || null,
            company_name: dto.company_name?.trim() || null,
            email: dto.email?.trim().toLowerCase() || null,
            phone: dto.phone?.trim() || null,
            note: dto.note ?? null,
            source: dto.source ?? 'manual',
            owner_user_id: dto.owner_user_id ?? null,
            form_id: dto.form_id ?? null,
            utm: dto.utm ?? {},
            extra: dto.extra ?? {},
            score: scoreLead({ ...dto, first_name: first } as never),
            status: dto.owner_user_id ? 'working' : 'new',
          })
          .returning();
        await this.audit.log({
          tenantId, actorUserId: userId ?? undefined, action: 'crm.lead.create', resourceType: 'lead', resourceId: row!.id,
        });
        await this.domainEvents.publish(
          { name: 'crm.lead.created', tenantId, actorUserId: userId ?? undefined, payload: { lead_id: row!.id, source: row!.source, score: row!.score, owner_user_id: row!.owner_user_id } },
          tx,
        );
        return { data: row! };
      },
      userId ?? undefined,
    );
  }

  /** Claim into "working" — assigns the acting user when unowned. */
  async claim(tenantId: string, userId: string, id: string) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const [row] = await tx
          .update(leads)
          .set({ status: 'working', owner_user_id: sql`coalesce(${leads.owner_user_id}, ${userId})`, updated_at: new Date() })
          .where(and(eq(leads.id, id), isNull(leads.deleted_at), sql`${leads.status} IN ('new','working')`))
          .returning();
        if (!row) throw new NotFoundException('Lead not found or already decided');
        return { data: row };
      },
      userId,
    );
  }

  /** Discard — no reason needed (§5.1); the row stays for source analytics. */
  async discard(tenantId: string, userId: string, id: string) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const [row] = await tx
          .update(leads)
          .set({ status: 'discarded', updated_at: new Date() })
          .where(and(eq(leads.id, id), isNull(leads.deleted_at), sql`${leads.status} IN ('new','working')`))
          .returning();
        if (!row) throw new NotFoundException('Lead not found or already decided');
        await this.audit.log({ tenantId, actorUserId: userId, action: 'crm.lead.discard', resourceType: 'lead', resourceId: id });
        await this.domainEvents.publish(
          { name: 'crm.lead.discarded', tenantId, actorUserId: userId, payload: { lead_id: id, source: row.source } },
          tx,
        );
        return { data: row };
      },
      userId,
    );
  }

  /**
   * Delete (round 9) — soft, like every other CRM entity. Works from any
   * status: deleting a converted lead does NOT touch the person/company/deal
   * it created (their FKs are SET NULL on the lead side, and the soft delete
   * never cascades anyway); the row simply leaves the inbox and the counts.
   */
  async remove(tenantId: string, userId: string, id: string) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const [row] = await tx
          .update(leads)
          .set({ deleted_at: new Date(), updated_at: new Date() })
          .where(and(eq(leads.id, id), eq(leads.tenant_id, tenantId), isNull(leads.deleted_at)))
          .returning({ id: leads.id });
        if (!row) throw new NotFoundException('Lead not found');
        await this.audit.log({ tenantId, actorUserId: userId, action: 'crm.lead.delete', resourceType: 'lead', resourceId: id });
        return { data: { deleted: true } };
      },
      userId,
    );
  }

  /**
   * Convert (§5.1): ONE action → person (link-or-create by email), company
   * (link-or-create by name), deal in the chosen pipeline/stage. The lead row
   * flips to converted with back-links; re-running is blocked by status.
   */
  async convert(
    tenantId: string,
    userId: string,
    id: string,
    dto: {
      link_person_id?: string;
      link_company_id?: string;
      person_name?: string;
      company_name?: string;
      deal_title?: string;
      pipeline_id?: string;
      stage_id?: string;
      value_amount?: number;
      currency?: string;
    },
  ) {
    // Step 1 — atomically CLAIM the lead, then resolve/create directory records
    // in one tenant tx. The claim is a guarded status flip: only one concurrent
    // convert can move it out of new/working, so a double-submit can't create
    // two deals. If a later step fails we revert the claim to 'working'.
    const resolved = await this.db.withTenant(
      tenantId,
      async (tx) => {
        const [lead] = await tx
          .update(leads)
          .set({ status: 'converted', updated_at: new Date() })
          .where(and(eq(leads.id, id), isNull(leads.deleted_at), inArray(leads.status, ['new', 'working'])))
          .returning();
        if (!lead) {
          // Either it doesn't exist, or it's already converted/discarded.
          const [exists] = await tx.select({ id: leads.id }).from(leads).where(eq(leads.id, id)).limit(1);
          if (!exists) throw new NotFoundException('Lead not found');
          throw new BadRequestException('This lead is already decided');
        }

        // Person: explicit link > exact-email match > create.
        let personId = dto.link_person_id ?? null;
        if (personId) {
          const [p] = await tx.select({ id: directoryPeople.id }).from(directoryPeople)
            .where(and(eq(directoryPeople.id, personId), isNull(directoryPeople.deleted_at))).limit(1);
          if (!p) throw new BadRequestException('Linked person not found');
        } else if (lead.email) {
          const [match] = await tx.select({ id: directoryPeople.id }).from(directoryPeople)
            .where(and(sql`lower(${directoryPeople.email}::text) = ${lead.email.toLowerCase()}`, isNull(directoryPeople.deleted_at))).limit(1);
          personId = match?.id ?? null;
        }

        // Company: explicit link > exact-name match > create when named.
        const companyName = (dto.company_name ?? lead.company_name ?? '').trim();
        let companyId = dto.link_company_id ?? null;
        if (companyId) {
          const [c] = await tx.select({ id: directoryCompanies.id }).from(directoryCompanies)
            .where(and(eq(directoryCompanies.id, companyId), isNull(directoryCompanies.deleted_at))).limit(1);
          if (!c) throw new BadRequestException('Linked company not found');
        } else if (companyName) {
          const [match] = await tx.select({ id: directoryCompanies.id }).from(directoryCompanies)
            .where(and(sql`lower(${directoryCompanies.name}) = ${companyName.toLowerCase()}`, isNull(directoryCompanies.deleted_at))).limit(1);
          companyId = match?.id ?? null;
          if (!companyId) {
            const [c] = await tx.insert(directoryCompanies)
              .values({ tenant_id: tenantId, name: companyName, created_by: userId })
              .returning();
            companyId = c!.id;
          }
        }

        if (!personId) {
          const nameParts = (dto.person_name ?? '').trim().split(/\s+/).filter(Boolean);
          const [p] = await tx.insert(directoryPeople)
            .values({
              tenant_id: tenantId,
              first_name: nameParts[0] || lead.first_name,
              last_name: nameParts.slice(1).join(' ') || lead.last_name,
              email: lead.email,
              phone: lead.phone,
              company_id: companyId,
              created_by: userId,
            })
            .returning();
          personId = p!.id;
        }
        return { lead, personId, companyId };
      },
      userId,
    );

    // Steps 2–3 run after the claim. If deal creation fails, revert the claim
    // so the lead returns to 'working' instead of being stuck 'converted' with
    // no deal.
    try {
      // Step 2 — deal via DealsService (FX snapshot, stage history, event).
      const title = (dto.deal_title ?? '').trim()
        || `${resolved.lead.company_name || resolved.lead.first_name} — new opportunity`;
      const deal = await this.deals.create(tenantId, userId, {
        title,
        pipeline_id: dto.pipeline_id,
        stage_id: dto.stage_id,
        company_id: resolved.companyId ?? undefined,
        primary_person_id: resolved.personId,
        value_amount: dto.value_amount,
        currency: dto.currency,
        source: resolved.lead.source,
      });

      // Step 3 — fill in the back-links (status is already 'converted' from the claim).
      const converted = await this.db.withTenant(
        tenantId,
        async (tx) => {
          const [row] = await tx
            .update(leads)
            .set({
              owner_user_id: sql`coalesce(${leads.owner_user_id}, ${userId})`,
              converted_person_id: resolved.personId,
              converted_company_id: resolved.companyId,
              converted_deal_id: deal.data.id,
              updated_at: new Date(),
            })
            .where(eq(leads.id, id))
            .returning();
          await this.domainEvents.publish(
            { name: 'crm.lead.converted', tenantId, actorUserId: userId, payload: { lead_id: id, deal_id: deal.data.id, person_id: resolved.personId, company_id: resolved.companyId } },
            tx,
          );
          return { data: { lead: row!, deal_id: deal.data.id, person_id: resolved.personId, company_id: resolved.companyId } };
        },
        userId,
      );
      // Round C: the audit call opens its OWN transaction, so awaiting it
      // INSIDE the one above nested two pool clients per convert. Hoisted
      // out and detached — the conversion is already durable.
      void this.audit.log({ tenantId, actorUserId: userId, action: 'crm.lead.convert', resourceType: 'lead', resourceId: id });
      return converted;
    } catch (err) {
      // Release the claim so the lead can be converted again.
      await this.db.withTenant(
        tenantId,
        (tx) => tx.update(leads).set({ status: 'working', updated_at: new Date() }).where(eq(leads.id, id)),
        userId,
      ).catch(() => undefined);
      throw err;
    }
  }

  /**
   * Round-robin assignment (§5.2/C6 caption): the active member who was
   * assigned a lead least recently; members whose presence is out-of-office
   * are skipped (falls back to the full roster when everyone is away).
   */
  async pickRoundRobinOwner(tenantId: string): Promise<string | null> {
    return this.db.withTenant(tenantId, async (tx) => {
      const roster = await tx
        .select({ user_id: memberships.user_id })
        .from(memberships)
        .where(and(eq(memberships.tenant_id, tenantId), eq(memberships.status, 'active'), sql`${memberships.role} NOT IN ('auditor', 'guest')`))
        .orderBy(asc(memberships.created_at));
      if (roster.length === 0) return null;

      const lastByOwner = await tx
        .select({ owner: leads.owner_user_id, last: sql<string>`max(${leads.created_at})` })
        .from(leads)
        .where(sql`${leads.owner_user_id} IS NOT NULL`)
        .groupBy(leads.owner_user_id);
      const lastMap = new Map(lastByOwner.map((r) => [r.owner, r.last]));

      const ordered = roster
        .map((m) => ({ id: m.user_id, last: lastMap.get(m.user_id) ?? '' }))
        .sort((a, b) => a.last.localeCompare(b.last));

      for (const candidate of ordered) {
        const status = await this.presence.statusOf(tenantId, candidate.id).catch(() => null);
        if (status !== 'out_of_office') return candidate.id;
      }
      return ordered[0]!.id; // everyone away → assign anyway, never drop a lead
    });
  }

  private async assertMember(tx: Db, tenantId: string, userId: string) {
    const [m] = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.tenant_id, tenantId), eq(memberships.user_id, userId), eq(memberships.status, 'active')))
      .limit(1);
    if (!m) throw new BadRequestException('owner_user_id is not an active member of this workspace');
  }
}
