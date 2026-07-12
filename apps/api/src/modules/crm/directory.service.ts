import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, ilike, isNull, ne, or, sql } from 'drizzle-orm';
import { directoryCompanies, directoryPeople } from '@flicks/db/schema';
import { DatabaseService } from '../../core/database/database.service';
import { AuditService } from '../audit/audit.service';
import { DomainEventsService } from '../../core/events/domain-events.service';

/**
 * Directory kernel service (PRD v5 §3). Owns companies & people — the shared
 * people/orgs CRM presents as Contacts/Companies. All access is tenant-scoped
 * via withTenant (RLS). Create-time dedup (§3.3): exact email/domain matches
 * BLOCK with an "open existing / merge" hint; fuzzy company-name matches
 * (trigram > 0.6) return a non-blocking warning with candidates.
 */
const FUZZY_THRESHOLD = 0.6;

function normalizeDomain(input?: string | null): string | null {
  if (!input) return null;
  let d = input.trim().toLowerCase();
  if (!d) return null;
  // Accept a bare domain or something paste-y like https://www.acme.com/x.
  d = d.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]!;
  return d || null;
}

interface ListQuery {
  q?: string;
  page?: number;
  limit?: number;
}

@Injectable()
export class DirectoryService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly domainEvents: DomainEventsService,
  ) {}

  // ─── Companies ──────────────────────────────────────────────────────────────

  async listCompanies(tenantId: string, query: ListQuery) {
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 25, 100);
    const offset = (page - 1) * limit;
    return this.db.withTenant(tenantId, async (tx) => {
      const where = and(
        isNull(directoryCompanies.deleted_at),
        query.q ? ilike(directoryCompanies.name, `%${query.q}%`) : undefined,
      );
      const rows = await tx
        .select()
        .from(directoryCompanies)
        .where(where)
        .orderBy(desc(directoryCompanies.last_activity_at), desc(directoryCompanies.created_at))
        .limit(limit)
        .offset(offset);
      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(directoryCompanies)
        .where(where);
      return { data: rows, pagination: { page, limit, total: count } };
    });
  }

  async getCompany(tenantId: string, id: string) {
    return this.db.withTenant(tenantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(directoryCompanies)
        .where(and(eq(directoryCompanies.id, id), isNull(directoryCompanies.deleted_at)))
        .limit(1);
      if (!row) throw new NotFoundException('Company not found');
      return { data: row };
    });
  }

  /**
   * Fuzzy-name candidates within a tenant (trigram similarity), excluding an
   * optional id (for the edit path). Powers the non-blocking dup warning.
   */
  async companyNameCandidates(tenantId: string, name: string, excludeId?: string) {
    if (!name?.trim()) return [];
    return this.db.withTenant(tenantId, async (tx) => {
      const rows = await tx
        .select({
          id: directoryCompanies.id,
          name: directoryCompanies.name,
          domain: directoryCompanies.domain,
          similarity: sql<number>`similarity(${directoryCompanies.name}, ${name})`,
        })
        .from(directoryCompanies)
        .where(
          and(
            isNull(directoryCompanies.deleted_at),
            excludeId ? ne(directoryCompanies.id, excludeId) : undefined,
            sql`similarity(${directoryCompanies.name}, ${name}) > ${FUZZY_THRESHOLD}`,
          ),
        )
        .orderBy(sql`similarity(${directoryCompanies.name}, ${name}) DESC`)
        .limit(5);
      return rows;
    });
  }

  async createCompany(
    tenantId: string,
    userId: string,
    dto: {
      name: string;
      domain?: string;
      website?: string;
      industry?: string;
      size_band?: string;
      phone?: string;
      address_line1?: string;
      address_line2?: string;
      city?: string;
      state?: string;
      postal_code?: string;
      country_code?: string;
      owner_user_id?: string;
      source?: string;
    },
    opts: { forceCreate?: boolean } = {},
  ) {
    if (!dto.name?.trim()) throw new BadRequestException('Company name is required');
    const domain = normalizeDomain(dto.domain);

    return this.db.withTenant(
      tenantId,
      async (tx) => {
        // Hard block: exact domain match (§3.3).
        if (domain) {
          const [dup] = await tx
            .select({ id: directoryCompanies.id, name: directoryCompanies.name })
            .from(directoryCompanies)
            .where(
              and(
                eq(directoryCompanies.domain, domain),
                isNull(directoryCompanies.deleted_at),
              ),
            )
            .limit(1);
          if (dup) {
            throw new ConflictException({
              message: `A company with domain ${domain} already exists`,
              code: 'DUPLICATE_DOMAIN',
              existing: dup,
            });
          }
        }

        const [row] = await tx
          .insert(directoryCompanies)
          .values({
            tenant_id: tenantId,
            name: dto.name.trim(),
            domain,
            website: dto.website,
            industry: dto.industry,
            size_band: dto.size_band,
            phone: dto.phone,
            address_line1: dto.address_line1,
            address_line2: dto.address_line2,
            city: dto.city,
            state: dto.state,
            postal_code: dto.postal_code,
            country_code: dto.country_code,
            owner_user_id: dto.owner_user_id ?? userId,
            source: dto.source ?? 'manual',
            created_by: userId,
            updated_by: userId,
          })
          .returning();

        await this.audit.log({
          tenantId,
          actorUserId: userId,
          action: 'crm.company.create',
          resourceType: 'directory_company',
          resourceId: row!.id,
        });
        await this.domainEvents.publish(
          { name: 'crm.company.created', tenantId, actorUserId: userId, payload: { company_id: row!.id } },
          tx,
        );
        return row!;
      },
      userId,
    ).then(async (row) => {
      // Non-blocking fuzzy-name warning (post-create, doesn't gate the insert).
      const warnings = opts.forceCreate
        ? []
        : (await this.companyNameCandidates(tenantId, dto.name, row.id)).map((c) => ({
            type: 'similar_name' as const,
            candidate: c,
          }));
      return { data: row, meta: { warnings } };
    });
  }

  async updateCompany(
    tenantId: string,
    userId: string,
    id: string,
    dto: Record<string, unknown>,
  ) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const [existing] = await tx
          .select()
          .from(directoryCompanies)
          .where(and(eq(directoryCompanies.id, id), isNull(directoryCompanies.deleted_at)))
          .limit(1);
        if (!existing) throw new NotFoundException('Company not found');

        const patch: Record<string, unknown> = { ...dto, updated_by: userId, updated_at: new Date() };
        if ('domain' in dto) patch.domain = normalizeDomain(dto.domain as string);
        delete patch.id;
        delete patch.tenant_id;

        const [row] = await tx
          .update(directoryCompanies)
          .set(patch)
          .where(eq(directoryCompanies.id, id))
          .returning();
        await this.audit.log({
          tenantId,
          actorUserId: userId,
          action: 'crm.company.update',
          resourceType: 'directory_company',
          resourceId: id,
        });
        await this.domainEvents.publish(
          { name: 'crm.company.updated', tenantId, actorUserId: userId, payload: { company_id: id } },
          tx,
        );
        return { data: row! };
      },
      userId,
    );
  }

  async deleteCompany(tenantId: string, userId: string, id: string) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const [row] = await tx
          .update(directoryCompanies)
          .set({ deleted_at: new Date(), updated_by: userId })
          .where(and(eq(directoryCompanies.id, id), isNull(directoryCompanies.deleted_at)))
          .returning({ id: directoryCompanies.id });
        if (!row) throw new NotFoundException('Company not found');
        await this.audit.log({
          tenantId,
          actorUserId: userId,
          action: 'crm.company.delete',
          resourceType: 'directory_company',
          resourceId: id,
        });
        return { data: { deleted: true } };
      },
      userId,
    );
  }

  // ─── People ─────────────────────────────────────────────────────────────────

  async listPeople(tenantId: string, query: ListQuery & { company_id?: string }) {
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 25, 100);
    const offset = (page - 1) * limit;
    return this.db.withTenant(tenantId, async (tx) => {
      const where = and(
        isNull(directoryPeople.deleted_at),
        query.company_id ? eq(directoryPeople.company_id, query.company_id) : undefined,
        query.q
          ? or(
              ilike(directoryPeople.display_name, `%${query.q}%`),
              ilike(directoryPeople.email, `%${query.q}%`),
            )
          : undefined,
      );
      const rows = await tx
        .select()
        .from(directoryPeople)
        .where(where)
        .orderBy(desc(directoryPeople.last_activity_at), desc(directoryPeople.created_at))
        .limit(limit)
        .offset(offset);
      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(directoryPeople)
        .where(where);
      return { data: rows, pagination: { page, limit, total: count } };
    });
  }

  async getPerson(tenantId: string, id: string) {
    return this.db.withTenant(tenantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(directoryPeople)
        .where(and(eq(directoryPeople.id, id), isNull(directoryPeople.deleted_at)))
        .limit(1);
      if (!row) throw new NotFoundException('Contact not found');
      return { data: row };
    });
  }

  async createPerson(
    tenantId: string,
    userId: string,
    dto: {
      first_name?: string;
      last_name?: string;
      email?: string;
      phone?: string;
      title?: string;
      company_id?: string;
      owner_user_id?: string;
      source?: string;
    },
  ) {
    if (!dto.first_name?.trim() && !dto.last_name?.trim() && !dto.email?.trim()) {
      throw new BadRequestException('A contact needs at least a name or an email');
    }
    const email = dto.email?.trim().toLowerCase() || null;

    return this.db.withTenant(
      tenantId,
      async (tx) => {
        // Hard block: exact email match (§3.3).
        if (email) {
          const [dup] = await tx
            .select({ id: directoryPeople.id, display_name: directoryPeople.display_name })
            .from(directoryPeople)
            .where(and(eq(directoryPeople.email, email), isNull(directoryPeople.deleted_at)))
            .limit(1);
          if (dup) {
            throw new ConflictException({
              message: `A contact with email ${email} already exists`,
              code: 'DUPLICATE_EMAIL',
              existing: dup,
            });
          }
        }

        const [row] = await tx
          .insert(directoryPeople)
          .values({
            tenant_id: tenantId,
            first_name: dto.first_name,
            last_name: dto.last_name,
            email,
            phone: dto.phone,
            title: dto.title,
            company_id: dto.company_id,
            owner_user_id: dto.owner_user_id ?? userId,
            source: dto.source ?? 'manual',
            created_by: userId,
            updated_by: userId,
          })
          .returning();

        await this.audit.log({
          tenantId,
          actorUserId: userId,
          action: 'crm.contact.create',
          resourceType: 'directory_person',
          resourceId: row!.id,
        });
        await this.domainEvents.publish(
          { name: 'crm.contact.created', tenantId, actorUserId: userId, payload: { person_id: row!.id } },
          tx,
        );
        return { data: row! };
      },
      userId,
    );
  }

  async updatePerson(tenantId: string, userId: string, id: string, dto: Record<string, unknown>) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const [existing] = await tx
          .select()
          .from(directoryPeople)
          .where(and(eq(directoryPeople.id, id), isNull(directoryPeople.deleted_at)))
          .limit(1);
        if (!existing) throw new NotFoundException('Contact not found');

        const patch: Record<string, unknown> = { ...dto, updated_by: userId, updated_at: new Date() };
        if ('email' in dto) patch.email = (dto.email as string)?.trim().toLowerCase() || null;
        // display_name is generated — never write it.
        delete patch.display_name;
        delete patch.id;
        delete patch.tenant_id;

        const [row] = await tx
          .update(directoryPeople)
          .set(patch)
          .where(eq(directoryPeople.id, id))
          .returning();
        await this.audit.log({
          tenantId,
          actorUserId: userId,
          action: 'crm.contact.update',
          resourceType: 'directory_person',
          resourceId: id,
        });
        await this.domainEvents.publish(
          { name: 'crm.contact.updated', tenantId, actorUserId: userId, payload: { person_id: id } },
          tx,
        );
        return { data: row! };
      },
      userId,
    );
  }

  async deletePerson(tenantId: string, userId: string, id: string) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const [row] = await tx
          .update(directoryPeople)
          .set({ deleted_at: new Date(), updated_by: userId })
          .where(and(eq(directoryPeople.id, id), isNull(directoryPeople.deleted_at)))
          .returning({ id: directoryPeople.id });
        if (!row) throw new NotFoundException('Contact not found');
        await this.audit.log({
          tenantId,
          actorUserId: userId,
          action: 'crm.contact.delete',
          resourceType: 'directory_person',
          resourceId: id,
        });
        return { data: { deleted: true } };
      },
      userId,
    );
  }
}
